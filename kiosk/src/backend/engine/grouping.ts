import type { Channel } from "../config/schema.js";

export interface ChannelGroup<T extends Channel = Channel> {
  /** Front-end tune frequency for this group (Hz). */
  centerHz: number;
  /** Enabled channels in this group, ascending by freq. */
  channels: T[];
}

export interface GroupingOptions {
  /** Width of the SDR's flat passband (Hz). The RTL front-end rolls off toward
   *  the window edges (measured 2026-09-26: noise floor -1.4 dB at +-1.0 MHz,
   *  -4.8 dB at +-1.2 MHz), so channels are kept inside +-flatHz/2 of their
   *  group's center wherever that costs no extra group. Default: the window. */
  flatHz?: number;
  /** Keep every channel at least this far from the tune center: the RTL DC
   *  spike sits exactly there. Default DEFAULT_DC_CLEAR_HZ. */
  dcClearHz?: number;
}

export const DEFAULT_DC_CLEAR_HZ = 25_000;
const CENTER_STEP_HZ = 5_000;

// Minimum-group partition of the sorted enabled channels (a group spans at most
// windowHz and holds at most maxPerGroup — the helper's lane count; splitting
// beats silently truncating). Among partitions with that minimum count, a small
// DP picks the one whose groups (scored at their midpoints) put the fewest channels
// outside the flat passband; ties keep the greedy split. Each group's center is then chosen
// freely inside [hi - window/2, lo + window/2] (every member stays within
// +-window/2) by the same priorities, ties going to the plain midpoint — so a
// group that already fits keeps exactly its old center. Deterministic, no I/O.
export function groupChannels<T extends Channel>(
  channels: T[],
  windowHz: number,
  maxPerGroup: number = Infinity,
  opts: GroupingOptions = {},
): Array<ChannelGroup<T>> {
  const enabled = channels.filter((c) => c.enabled).sort((a, b) => a.freq - b.freq);
  const n = enabled.length;
  if (n === 0) return [];
  const flat = Math.min(opts.flatHz ?? windowHz, windowHz);
  const dcClear = opts.dcClearHz ?? DEFAULT_DC_CLEAR_HZ;
  // best[j]: optimal partition of enabled[0..j) as (groups, channels outside flat).
  type Cost = { g: number; edge: number; from: number };
  const best: Array<Cost | undefined> = new Array(n + 1);
  best[0] = { g: 0, edge: 0, from: -1 };
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      if (j - i > maxPerGroup) break;
      if (enabled[j - 1]!.freq - enabled[i]!.freq > windowHz) break;
      const prev = best[i];
      if (!prev) continue;
      // Midpoint scoring inside the DP keeps it O(n * lanes * log lanes); the free center
      // search below runs only on the chosen groups.
      const pick = scoreAt(enabled, i, j, (enabled[i]!.freq + enabled[j - 1]!.freq) / 2, flat, dcClear);
      const cand: Cost = { g: prev.g + 1, edge: prev.edge + pick.edge, from: i };
      const cur = best[j];
      // DC isn't scored here: the final center search clears the spike with a small shift
      // whenever the group spans less than the window, so only the edge count competes.
      if (!cur || cand.g < cur.g || (cand.g === cur.g && cand.edge < cur.edge)) {
        best[j] = cand;
      }
    }
  }
  const groups: Array<ChannelGroup<T>> = [];
  for (let j = n; j > 0;) {
    const c = best[j]!;
    groups.unshift({ centerHz: placeCenter(enabled, c.from, j, windowHz, flat, dcClear).center, channels: enabled.slice(c.from, j) });
    j = c.from;
  }
  return groups;
}

// Channels of enabled[i..j) within dcClear of center c, and outside +-flat/2 of
// it. Members are sorted, so both counts are binary searches.
function scoreAt<T extends Channel>(
  ch: T[], i: number, j: number, c: number, flatHz: number, dcClearHz: number,
): { dc: number; edge: number } {
  const firstAtLeast = (f: number): number => {   // first k in [i, j) with freq >= f
    let a = i, b = j;
    while (a < b) { const m = (a + b) >> 1; if (ch[m]!.freq < f) a = m + 1; else b = m; }
    return a;
  };
  const firstAbove = (f: number): number => {     // first k in [i, j) with freq > f
    let a = i, b = j;
    while (a < b) { const m = (a + b) >> 1; if (ch[m]!.freq <= f) a = m + 1; else b = m; }
    return a;
  };
  return {
    dc: firstAtLeast(c + dcClearHz) - firstAbove(c - dcClearHz),
    edge: (firstAtLeast(c - flatHz / 2) - i) + (j - firstAbove(c + flatHz / 2)),
  };
}

// Best center for enabled[i..j): fewest channels within dcClear of it, then
// fewest outside +-flat/2, then nearest the midpoint.
function placeCenter<T extends Channel>(
  ch: T[], i: number, j: number, windowHz: number, flatHz: number, dcClearHz: number,
): { center: number; dc: number; edge: number } {
  const lo = ch[i]!.freq, hi = ch[j - 1]!.freq, mid = (lo + hi) / 2;
  const score = (c: number) => scoreAt(ch, i, j, c, flatHz, dcClearHz);
  let bestC = mid, bestS = score(mid);
  if (bestS.dc === 0 && bestS.edge === 0) return { center: mid, ...bestS };
  const minC = hi - windowHz / 2, maxC = lo + windowHz / 2;
  for (let c = Math.ceil(minC / CENTER_STEP_HZ) * CENTER_STEP_HZ; c <= maxC; c += CENTER_STEP_HZ) {
    const s = score(c);
    const better = s.dc < bestS.dc || (s.dc === bestS.dc && (s.edge < bestS.edge
      || (s.edge === bestS.edge && Math.abs(c - mid) < Math.abs(bestC - mid))));
    if (better) { bestC = c; bestS = s; }
  }
  return { center: bestC, ...bestS };
}

// Close Call band-sweep (ROADMAP stretch, phase 2 of the CC spec): when
// configured, the scanner spends one stop per rotation parked on an EMPTY
// window inside the operator's sweep ranges, letting the CC FFT hunt for
// activity away from every programmed channel. Centers step across each
// range; windows already covered by a real group are skipped (the FFT
// watches those every cycle anyway).
export function sweepCenters(
  ranges: Array<{ loHz: number; hiHz: number }>,
  windowHz: number,
  groups: ChannelGroup[],
): number[] {
  const out: number[] = [];
  for (const r of ranges) {
    if (r.hiHz <= r.loHz) continue;
    for (let c = r.loHz + windowHz / 2; c - windowHz / 2 < r.hiHz; c += windowHz) {
      const covered = groups.some((g) => Math.abs(g.centerHz - c) < windowHz / 2);
      if (!covered) out.push(Math.round(c));
    }
  }
  return out;
}
