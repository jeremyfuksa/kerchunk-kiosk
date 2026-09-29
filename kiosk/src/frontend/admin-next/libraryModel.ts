// Library logic, pure (no DOM, no fetch) so it is unit-tested headless: search,
// bank chips, row text, suggestions, discovery facts, form parsing, bank rules
// and the analytics series. The DOM modules (library*.ts, channelDetail.ts)
// only render what these return.
import type { Bank, Channel, Config } from "../../backend/config/schema.js";
import { matchesBank, serviceFor } from "../../backend/config/banks.js";
import { fmtFreq } from "../lib/format.js";
import type { ArchiveRec, DuplicateSet } from "../lib/api.js";
import { ago } from "./time.js";
import type { Detail } from "./route.js";

export type Discovery = NonNullable<Config["discoveries"]>[number];
export type Mode = Channel["mode"];
type Loc = NonNullable<Channel["location"]>;

export const MODES: ReadonlyArray<[Mode, string]> = [["nfm", "NFM"], ["fm", "FM"], ["am", "AM"]];
export function modeLabel(m: Mode): string { return MODES.find(([v]) => v === m)?.[1] ?? m.toUpperCase(); }

/** Modulations the lookup chain names that this radio can't demodulate. */
export const DIGITAL = ["DMR", "P25", "NXDN", "D-STAR", "YSF", "TETRA"] as const;
export function isDigital(mode: string | undefined): boolean {
  const m = (mode ?? "").toUpperCase();
  return DIGITAL.some((d) => m.includes(d));
}

/** VHF airband (118–137 MHz) is AM; everything else defaults to NFM. */
export function defaultMode(freq: number): Mode {
  return freq >= 118_000_000 && freq <= 137_000_000 ? "am" : "nfm";
}

// ── Search and chips ──────────────────────────────────────────────────────────

/** Name, frequency as MHz text ("146.52") or raw Hz, and tags. */
export function matchesQuery(c: Channel, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return c.alphaTag.toLowerCase().includes(q)
    || fmtFreq(c.freq).includes(q)
    || String(c.freq).includes(q)
    || (c.tags ?? []).some((t) => t.toLowerCase().includes(q));
}

export const CHIP_ALL = "all";
export const CHIP_ARCHIVED = "archived";
/** Bank chip ids are prefixed so a bank can never collide with All/Archived. */
export const bankChip = (id: string): string => `bank:${id}`;

export interface Chip { id: string; label: string; count: number }

/** All (tracked channels), one chip per bank (its tracked members), then
 *  Archived — only when something is archived. */
export function chipsFor(channels: Channel[], banks: Bank[]): Chip[] {
  const tracked = channels.filter((c) => c.enabled);
  const archived = channels.length - tracked.length;
  return [
    { id: CHIP_ALL, label: "All", count: tracked.length },
    ...banks.map((b) => ({ id: bankChip(b.id), label: b.name, count: tracked.filter((c) => matchesBank(c, b)).length })),
    ...(archived > 0 ? [{ id: CHIP_ARCHIVED, label: "Archived", count: archived }] : []),
  ];
}

/** A chip that no longer exists (bank deleted, nothing archived) → All. */
export function validChip(chip: string, chips: Chip[]): string {
  return chips.some((c) => c.id === chip) ? chip : CHIP_ALL;
}

export function visibleChannels(channels: Channel[], banks: Bank[], o: { chip: string; query: string }): Channel[] {
  const bank = banks.find((b) => bankChip(b.id) === o.chip);
  return channels
    .filter((c) => (o.chip === CHIP_ARCHIVED ? !c.enabled : c.enabled))
    .filter((c) => !bank || matchesBank(c, bank))
    .filter((c) => matchesQuery(c, o.query))
    .sort((a, b) => a.freq - b.freq);
}

// ── Row and LCD text ──────────────────────────────────────────────────────────

export function placeText(loc?: { city?: string; state?: string }): string {
  return [loc?.city, loc?.state].filter(Boolean).join(", ");
}
export function channelName(c: { alphaTag: string; freq: number }): string {
  return c.alphaTag.trim() || `${fmtFreq(c.freq)} MHz`;
}
export function rowMeta(c: Channel): string {
  return [fmtFreq(c.freq), modeLabel(c.mode), placeText(c.location)].filter(Boolean).join(" · ");
}
/** The detail LCD's meta line: mode · service · place. */
export function lcdMeta(c: { freq: number; mode: Mode; location?: { city?: string; state?: string } }): string {
  return [modeLabel(c.mode), serviceFor(c.freq) ?? "", placeText(c.location)].filter(Boolean).join(" · ");
}

// ── Suggestions ───────────────────────────────────────────────────────────────

/** "3 suggestions: 1 duplicate, 2 to archive", or null when there are none.
 *  A duplicate is an extra row (the set keeps its richest one). */
export function suggestionSummary(dups: DuplicateSet[], recs: ArchiveRec[]): string | null {
  const d = dups.reduce((n, s) => n + Math.max(0, s.channels.length - 1), 0);
  const a = recs.length;
  const total = d + a;
  if (total === 0) return null;
  const parts = [d ? `${d} duplicate${d === 1 ? "" : "s"}` : "", a ? `${a} to archive` : ""].filter(Boolean);
  return `${total} suggestion${total === 1 ? "" : "s"}: ${parts.join(", ")}`;
}

// ── Discoveries ───────────────────────────────────────────────────────────────

export function pendingDiscoveries(cfg: Pick<Config, "discoveries">): Discovery[] {
  return (cfg.discoveries ?? []).filter((d) => !d.suppressedAt).sort((a, b) => b.ts - a.ts);
}
export function suppressedDiscoveries(cfg: Pick<Config, "discoveries">): Discovery[] {
  return (cfg.discoveries ?? []).filter((d) => d.suppressedAt).sort((a, b) => b.ts - a.ts);
}

/** Bring a suppressed discovery back to triage. Clears ALL suppression
 *  bookkeeping (schema.ts: "Restoring clears these fields") — leaving a stale
 *  hitCount would let the server re-suppress it on the very next hit. */
export function restoreDiscovery<T extends Partial<Discovery>>(d: T): T {
  return { ...d, hitCount: undefined, lastSeenAt: undefined, suppressedAt: undefined, suppressionReason: undefined };
}

export function hitsText(d: Discovery, now: number = Date.now()): string {
  return `${d.hitCount ?? 1}× · heard ${ago(d.lastSeenAt ?? d.ts, now)}`;
}

/** Close Call's placeholder names ("Close Call 462.5625") say nothing. */
export function isGenericName(name: string): boolean {
  return name.trim() === "" || /^close call\b/i.test(name.trim());
}

export function milesBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number): number => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3958.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Likely Walmart · biz/PS · Kansas City · 1.2 mi" — the identification
 *  chain's best guess, or "Unidentified". */
export function guessLine(d: Discovery, home?: { lat: number; lon: number }): string {
  const bits: string[] = [];
  if (!isGenericName(d.alphaTag)) bits.push(`Likely ${d.alphaTag.trim()}`);
  const svc = serviceFor(d.freq);
  if (svc) bits.push(svc);
  const place = placeText(d.location);
  if (place) bits.push(place);
  if (home && d.location?.lat != null && d.location.lon != null) {
    const mi = milesBetween(home, { lat: d.location.lat, lon: d.location.lon });
    bits.push(`${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`);
  }
  return bits.join(" · ") || "Unidentified";
}

/** One caution line for a card, or "". */
export function discoveryNote(d: Discovery): string {
  if (isDigital(d.mode)) return `${d.mode!.toUpperCase()} — digital, can't be played here`;
  if (d.audible === false) return "Data or paging — added as a silent channel";
  return "";
}

/** What the detail's new-channel form starts from. */
export interface ChannelDraft {
  freq: number | null;
  alphaTag: string;
  mode: Mode;
  audible: boolean;
  tags: string[];
  location?: Loc;
}

export function emptyDraft(o: { freq?: number; tag?: string } = {}): ChannelDraft {
  return {
    freq: o.freq ?? null, alphaTag: "", mode: o.freq ? defaultMode(o.freq) : "nfm",
    audible: true, tags: o.tag ? [o.tag] : [],
  };
}

/** A discovery as a new channel: its identified mode mapped onto what we can
 *  demodulate (unknown in the airband = AM), silent until the operator says
 *  otherwise (classic promoteDiscovery's rule), located if the chain found it. */
export function draftFromDiscovery(d: Discovery): ChannelDraft {
  const m = (d.mode ?? "").toUpperCase();
  const mode: Mode = m === "FM" ? "fm" : m === "AM" ? "am" : m === "" ? defaultMode(d.freq) : "nfm";
  return {
    freq: d.freq, alphaTag: isGenericName(d.alphaTag) ? "" : d.alphaTag.trim(), mode, audible: false, tags: [],
    ...(d.location ? { location: d.location } : {}),
  };
}

// ── Form parsing (each throws a message fit to show under the field) ──────────

export function parseMhz(raw: string): number {
  const t = raw.trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n) || n <= 0) throw new Error("Enter the frequency in MHz, like 146.5200");
  return Math.round(n * 1e6);
}

export function parseTags(raw: string): string[] {
  return [...new Set(raw.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** "lat, lon" → coordinates; blank → null (clear the site). */
export function parseSite(raw: string): { lat: number; lon: number } | null {
  if (!raw.trim()) return null;
  const trimmed = raw.split(",").map((x) => x.trim());
  const [latRaw, lonRaw] = trimmed;
  // Number("") is 0, not NaN — an empty part ("39.1," or ", -94") must fail,
  // not silently coordinate-zero the missing half.
  if (trimmed.length !== 2 || !latRaw || !lonRaw) {
    throw new Error("Site must be 'lat, lon', like 39.1755, -94.4861");
  }
  const lat = Number(latRaw);
  const lon = Number(lonRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error("Site must be 'lat, lon', like 39.1755, -94.4861");
  }
  return { lat, lon };
}

/** The channel's new `location` for a site edit. The channel PUT replaces
 *  `location` whole, so clearing sends it without lat/lon (keeping what the
 *  lookup chain found); an operator-set site is sourced "operator". */
export function siteLocation(loc: Loc | undefined, site: { lat: number; lon: number } | null): Loc | undefined {
  if (site) return { ...(loc ?? {}), lat: site.lat, lon: site.lon, source: "operator" };
  if (!loc) return undefined;
  const { lat: _lat, lon: _lon, ...rest } = loc;
  return rest;
}

/** The tone select's value: "" none, "100.0" CTCSS, "dcs:023N" DCS. */
export function toneValue(c: { ctcssHz?: number; dcsCode?: string }): string {
  if (c.dcsCode !== undefined) return `dcs:${c.dcsCode}`;
  if (c.ctcssHz !== undefined) return c.ctcssHz.toFixed(1);
  return "";
}
/** Select value → the PUT fields; null clears (one scheme at a time). */
export function toneFromValue(v: string): { ctcssHz: number | null; dcsCode: string | null } {
  if (v.startsWith("dcs:")) return { ctcssHz: null, dcsCode: v.slice(4) };
  if (v === "") return { ctcssHz: null, dcsCode: null };
  return { ctcssHz: Number(v), dcsCode: null };
}

/** POST /api/channels body from a completed draft. */
export function newChannelBody(d: ChannelDraft & { freq: number }): Omit<Channel, "id"> {
  return {
    freq: d.freq, alphaTag: d.alphaTag.trim(), mode: d.mode, enabled: true, audible: d.audible,
    ...(d.tags.length ? { tags: d.tags } : {}),
    ...(d.location ? { location: d.location } : {}),
  };
}

// ── Banks ─────────────────────────────────────────────────────────────────────

/** What a bank matches, in words. */
export function bankRule(b: Bank): string {
  const bits: string[] = [];
  if (b.band) bits.push(`${b.band.toUpperCase()} band`);
  if (b.loHz !== undefined || b.hiHz !== undefined) {
    const mhz = (hz: number | undefined): string => (hz === undefined ? "…" : String(hz / 1e6));
    bits.push(`${mhz(b.loHz)}–${mhz(b.hiHz)} MHz`);
  }
  if (b.tags?.length) bits.push(`Tagged ${b.tags.join(", ")}`);
  return bits.join(" · ") || "Every channel";
}

/** The bank's scan-profile overrides in words, or "" (all global). */
export function profileText(b: Bank): string {
  const bits: string[] = [];
  if (b.openAboveFloorDb !== undefined) bits.push(`Opens at ${b.openAboveFloorDb} dB`);
  if (b.hangMs !== undefined) bits.push(`hang ${b.hangMs / 1000} s`);
  if (b.dwellWeight !== undefined) bits.push(`dwell ×${b.dwellWeight}`);
  return bits.join(" · ");
}

export interface BankForm { name: string; band: string; lo: string; hi: string; tags: string }

export function bankFromForm(f: BankForm, id: string): Bank {
  const name = f.name.trim();
  if (!name) throw new Error("Give the bank a name");
  const mhz = (raw: string, label: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be in MHz, like 144`);
    return Math.round(n * 1e6);
  };
  const loHz = mhz(f.lo, "From");
  const hiHz = mhz(f.hi, "To");
  if (loHz !== undefined && hiHz !== undefined && hiHz <= loHz) throw new Error("To must be above From");
  const tags = parseTags(f.tags);
  return {
    id, name, enabled: true,
    ...(f.band ? { band: f.band as NonNullable<Bank["band"]> } : {}),
    ...(loHz !== undefined ? { loHz } : {}),
    ...(hiHz !== undefined ? { hiHz } : {}),
    ...(tags.length ? { tags } : {}),
  };
}

export interface ProfileForm { open: string; hang: string; dwell: string }
export type Profile = Pick<Bank, "openAboveFloorDb" | "hangMs" | "dwellWeight">;

/** Blank = inherit the global setting; otherwise a number above 0. */
export function profileFromForm(f: ProfileForm): Profile {
  const num = (raw: string, label: string): number | undefined => {
    if (!raw.trim()) return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be a number above 0`);
    return n;
  };
  const open = num(f.open, "Squelch open");
  const hang = num(f.hang, "Hang time");
  const dwell = num(f.dwell, "Dwell weight");
  return {
    ...(open !== undefined ? { openAboveFloorDb: open } : {}),
    ...(hang !== undefined ? { hangMs: hang } : {}),
    ...(dwell !== undefined ? { dwellWeight: dwell } : {}),
  };
}

export function withProfile(b: Bank, p: Profile): Bank {
  const { openAboveFloorDb: _o, hangMs: _h, dwellWeight: _d, ...rest } = b;
  return { ...rest, ...p };
}

/** One chip per bank in the detail. `next` = the channel's tags after a tap,
 *  or null when a tag change can't flip membership (band/range-only banks, or
 *  a channel outside the bank's band). */
export interface BankToggle { id: string; name: string; member: boolean; next: string[] | null }

export function bankToggles(c: Channel, banks: Bank[]): BankToggle[] {
  const tags = c.tags ?? [];
  return banks.map((b) => {
    const member = matchesBank(c, b);
    let next: string[] | null = null;
    if (b.tags?.length) {
      const candidate = member ? tags.filter((t) => !b.tags!.includes(t)) : [...tags, b.tags[0]!];
      if (matchesBank({ ...c, tags: candidate }, b) !== member) next = candidate;
    }
    return { id: b.id, name: b.name, member, next };
  });
}

/** A bank-wide edit (make audible / silent / archive all), with a snapshot of
 *  what every member of the bank had before the patch (whether or not the
 *  patch actually changed that member's value) — Undo restores that, not a
 *  default. */
export function bulkPatch(
  channels: Channel[], bank: Bank, patch: Partial<Pick<Channel, "enabled" | "audible">>,
): { channels: Channel[]; before: Map<string, Pick<Channel, "enabled" | "audible">> } {
  const before = new Map<string, Pick<Channel, "enabled" | "audible">>();
  const next = channels.map((c) => {
    if (!matchesBank(c, bank)) return c;
    before.set(c.id, { enabled: c.enabled, audible: c.audible });
    return { ...c, ...patch };
  });
  return { channels: next, before };
}

// ── Channel analytics (last 24 h) ─────────────────────────────────────────────

export interface HistRow { ts: number; durationMs: number | null; rfDb: number | null; alphaTag: string }

/** Transmissions (rows with a duration or a level), airtime, and the signal
 *  line oldest→newest scaled into W×H with 2 dB headroom. */
export function signalSeries(rows: HistRow[], W: number, H: number): {
  active: HistRow[]; airtimeMs: number; samples: number; min: number; max: number; points: string;
} {
  const active = rows.filter((r) => r.durationMs !== null || r.rfDb !== null);
  const sig = active.filter((r) => r.rfDb !== null).reverse();
  const levels = sig.map((r) => r.rfDb!);
  const min = levels.length ? Math.min(...levels) - 2 : -40;
  const max = levels.length ? Math.max(...levels) + 2 : 0;
  const points = sig.map((r, i) => {
    const x = sig.length === 1 ? W / 2 : (i * W) / (sig.length - 1);
    const y = H - ((r.rfDb! - min) / Math.max(1, max - min)) * H;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  return { active, airtimeMs: active.reduce((n, r) => n + (r.durationMs ?? 0), 0), samples: sig.length, min, max, points };
}

// ── Detail ────────────────────────────────────────────────────────────────────

export type Resolved =
  | { kind: "edit"; channel: Channel }
  | { kind: "add"; draft: ChannelDraft; from?: Discovery }
  | { kind: "gone"; message: string };

export function resolveDetail(d: Detail, data: { channels: Channel[]; cfg: Pick<Config, "discoveries"> }): Resolved {
  switch (d.kind) {
    case "ch": {
      const c = data.channels.find((x) => x.id === d.id);
      return c ? { kind: "edit", channel: c } : { kind: "gone", message: "This channel is no longer in the library." };
    }
    case "hz": {
      const at = data.channels.filter((x) => x.freq === d.hz);
      const c = at.find((x) => x.enabled) ?? at[0];
      if (c) return { kind: "edit", channel: c };
      // No channel, but Close Call heard it: offer the newest pending discovery.
      const disc = pendingDiscoveries(data.cfg).find((x) => x.freq === d.hz);
      return disc ? { kind: "add", draft: draftFromDiscovery(disc), from: disc } : { kind: "add", draft: emptyDraft({ freq: d.hz }) };
    }
    case "add": {
      if (d.from) {
        const disc = (data.cfg.discoveries ?? []).find((x) => x.id === d.from);
        return disc ? { kind: "add", draft: draftFromDiscovery(disc), from: disc }
          : { kind: "gone", message: "That discovery was already added, dismissed or locked out." };
      }
      return { kind: "add", draft: emptyDraft({ tag: d.tag }) };
    }
  }
}

/** Detail fields, by the id the DOM uses, and how to read each from a channel. */
export const DETAIL_FIELDS: Record<string, (c: Channel) => string> = {
  audible: (c) => String(c.audible !== false),
  priority: (c) => String(!!c.priority),
  alert: (c) => String(!!c.alert),
  archive: (c) => String(!c.enabled),
  name: (c) => c.alphaTag,
  mode: (c) => c.mode,
  freq: (c) => String(c.freq),
  tone: (c) => toneValue(c),
  tags: (c) => (c.tags ?? []).join(", "),
  site: (c) => (c.location?.lat != null ? `${c.location.lat}, ${c.location.lon}` : ""),
};

/** After a poll, which fields to repaint from `next`: those whose value
 *  changed and that the operator isn't focused on, hasn't edited unsaved,
 *  and isn't saving right now. */
export function detailFieldsToPatch(
  c: Channel, next: Channel, o: { focused: string | null; dirty: ReadonlySet<string>; inflight: ReadonlySet<string> },
): string[] {
  return Object.entries(DETAIL_FIELDS)
    .filter(([id, read]) => read(c) !== read(next) && id !== o.focused && !o.dirty.has(id) && !o.inflight.has(id))
    .map(([id]) => id);
}

/** What a lockout will change, so Undo restores exactly that (classic
 *  lockoutFreq's snapshot): the discoveries it drops, each channel's prior
 *  enabled flag at the frequency, and whether the frequency was already on
 *  the lockout list (then Undo leaves it there). */
export function lockoutSnapshot(cfg: Config, freq: number): {
  discoveries: Discovery[]; enabled: Map<string, boolean>; wasLocked: boolean;
} {
  const enabled = new Map<string, boolean>();
  for (const c of cfg.channels) if (c.freq === freq) enabled.set(c.id, c.enabled);
  return {
    discoveries: (cfg.discoveries ?? []).filter((d) => d.freq === freq), enabled,
    wasLocked: (cfg.scan.lockoutHz ?? []).includes(freq),
  };
}
