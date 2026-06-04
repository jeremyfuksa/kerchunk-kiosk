# Wideband Multi-Channel Scanner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-channel `rtl_fm` kill/respawn scanning with a `WidebandEngine`: one persistent GNU Radio helper samples a 2.4 MS/s I/Q window, demodulates every channel in the window simultaneously, detects per-channel activity, and plays the audible channel — group-hopping between frequency clusters with **zero device re-opens**. Drop-in behind the existing `ScannerEngine` interface; `RtlFmEngine` stays as fallback.

**Architecture:** `WidebandEngine` (Node) spawns ONE `wideband_helper.py` (GNU Radio, system python) at `start()` and never restarts it except on crash. Node owns grouping + group-hop timing and sends line-JSON `tune` commands on stdin; the helper owns DSP + within-group audible selection (first-active-wins) and emits line-JSON events on stdout, playing audio directly to ALSA. Spike-proven (see `kiosk/bench/RESULTS-2026-06-04-wideband-spike.md`): live `set_frequency` retune works across VHF↔UHF with no re-open; 7 simultaneous channelizers cost 169% of one core on the appliance.

**Tech Stack:** TypeScript, Zod, Vitest (Node side); GNU Radio 3.10 Python flowgraph (helper); fake-helper shell/python scripts for hardware-free engine tests (the `fake-rtl_fm-*.sh` pattern).

---

## Verified facts (from the code + spike, do not re-litigate)

- **Spike results** (`kiosk/bench/RESULTS-2026-06-04-wideband-spike.md`):
  appliance = Ubuntu 26.04 (NOT Fedora — ignore the spec's `dnf` notes), GNU
  Radio 3.10.12 importable ONLY from `/usr/bin/python3` (mise python shadows
  it), raw ALSA (no PipeWire) with built-in analog at `plughw:1,0`,
  `soapy.source.set_frequency()` retunes a *running* flowgraph with zero device
  re-opens, `gr-soapy` is built into the Ubuntu `gnuradio` package.
- `ScannerEngine` interface: `src/backend/engine/ScannerEngine.ts:23-31`;
  `EngineEvent` union lines 14-19 (`active` carries the full `Channel`);
  `ScanConfig` lines 3-10 (`channels, sampleRate, squelchLevel, dwellMs, gain,
  audioSink`).
- `RtlFmEngine` patterns to mirror: options object with `now?: () => number`
  for time control (`RtlFmEngine.ts:20-29`), stale-spawn guards
  (`this.rtl !== rtl`, line 234), `handleUnexpectedExit` with stderr-derived
  `NO_DEVICE` vs generic code (lines 297-334), `restartDelayMs` default 1000
  (line 92), volume/mute delegate to `amixer` via `../audio.js` (lines
  345-350). `start()` while running calls `stop()` first (line 136); zero
  enabled channels ⇒ state `running` with no pipeline (line 148).
- Engine selection: `src/backend/index.ts:16` (`USE_FAKE_ENGINE === "1"`),
  construction lines 24-29, engine start payload lines 45-52.
- Config schema: `src/backend/config/schema.ts` — `scan` object lines 14-19,
  `defaultConfig()` lines 40-50. Optional fields pattern: `mixerCard` line 28.
- Test conventions (`test/RtlFmEngine.test.ts`): fakes in `test/fakes/`,
  `chmodSync(..., 0o755)` in `beforeAll` (lines 21-27), `ch()`/`cfg()` builders
  (lines 29-35), `collect()` event harness + `waitFor()` poller (lines 49-60),
  spawn-counting via `FAKE_RTL_ARGS_FILE` env (see `fake-rtl_fm-loud.sh`),
  orphan-detection via `FAKE_SINK_FILE` (see `fake-sink.sh`).
- Build: `build:backend` is plain `tsc` (`package.json`) — it will NOT copy a
  `.py` file into `dist/`; a copy step must be added. `deploy.sh` ships
  `dist/` + `node_modules` to `/opt`, so the helper must land in `dist/`.
- `rtl_fm` engine demodulates `-M fm` regardless of `channel.mode`
  (`RtlFmEngine.ts:121`) — NFM-only parity is acceptable for the helper.

## Design decisions settled here (deviations from the spec, with reasons)

1. **Detection = per-channel filtered power + adaptive noise floor**, not a
   window-wide FFT/PSD. The channelizer already computes per-channel band
   power (spike probes showed two simultaneous stations separated by >10 dB
   from a −26…−31 dB floor). A window-wide FFT matters for finding *arbitrary*
   signals; we only ever care about configured channel offsets. The adaptive
   floor (slow EMA while closed) + open/close hysteresis in dB keeps the
   spec's robustness intent with far less machinery.
2. **Static flowgraph, dynamic offsets.** The helper builds `MAX_CHANS = 8`
   channelizer chains once; a `tune` command calls `set_center_freq()` on the
   source and on each chain's xlating filter (both runtime-safe), parking
   unused chains gated-off at offset 0. No GNU Radio lock/unlock topology
   changes, no respawn — group-hop is just two setter calls.
3. **Helper plays audio itself** (gr `audio.sink` straight to ALSA, proven in
   the spike) instead of piping PCM through Node→aplay. Volume/mute stay in
   Node via `amixer` exactly as today, so `setVolume`/`setMuted` are unchanged.
4. **Squelch config:** new optional `scan.openAboveFloorDb` (default 9) — dB
   above the learned floor to open, close at floor+(openAboveFloorDb−3) for
   hysteresis. The legacy raw-RMS `squelchLevel` keeps meaning only for
   `RtlFmEngine`. Hold/hang reuses existing `dwellMs` as the helper's hang
   time before declaring close (parity with RtlFm's `hangMs` mapping in
   `index.ts:27-28`).

## File Structure

- **Add** `src/backend/engine/grouping.ts` — pure channel→group clustering.
- **Add** `src/backend/engine/wideband_helper.py` — GNU Radio flowgraph helper.
- **Add** `src/backend/engine/WidebandEngine.ts` — the engine.
- **Modify** `src/backend/config/schema.ts` — `scan.windowBandwidthHz`,
  `scan.groupDwellMs`, `scan.openAboveFloorDb` (all optional with defaults).
- **Modify** `src/backend/index.ts` — `KERCHUNK_ENGINE=wideband|rtlfm|fake`.
- **Modify** `package.json` — copy the helper into `dist/` during build.
- **Add** `test/grouping.test.ts`, `test/WidebandEngine.test.ts`,
  `test/fakes/fake-wideband-helper.sh` (+ scenario variants via env).
- **Add** `scripts/setup-kiosk-ubuntu.sh` — apt packages + modprobe blacklist.

---

## Task 1: Channel grouping (pure)

**Files:**
- Create: `src/backend/engine/grouping.ts`
- Test: `test/grouping.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/grouping.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { groupChannels } from "../src/backend/engine/grouping.js";
import type { Channel } from "../src/backend/config/schema.js";

function ch(freq: number, over: Partial<Channel> = {}): Channel {
  return { id: `c${freq}`, freq, alphaTag: String(freq), mode: "nfm", enabled: true, ...over };
}
const WINDOW = 2_000_000;

describe("groupChannels", () => {
  it("clusters the operator's 6 channels into VHF / UHF-444 / UHF-464", () => {
    const groups = groupChannels(
      [ch(146_790_000), ch(147_330_000), ch(444_275_000), ch(464_175_000), ch(464_275_000), ch(464_425_000)],
      WINDOW,
    );
    expect(groups.map((g) => g.channels.map((c) => c.freq))).toEqual([
      [146_790_000, 147_330_000],
      [444_275_000],
      [464_175_000, 464_275_000, 464_425_000],
    ]);
  });

  it("centers each group between its min and max channel", () => {
    const [g] = groupChannels([ch(146_790_000), ch(147_330_000)], WINDOW);
    expect(g!.centerHz).toBe((146_790_000 + 147_330_000) / 2);
  });

  it("every channel sits within ±window/2 of its group center", () => {
    for (const g of groupChannels(
      [ch(146_790_000), ch(147_330_000), ch(148_700_000), ch(464_175_000)], WINDOW)) {
      for (const c of g.channels) {
        expect(Math.abs(c.freq - g.centerHz)).toBeLessThanOrEqual(WINDOW / 2);
      }
    }
  });

  it("a channel beyond the window starts a new group", () => {
    // 3 MHz apart > 2 MHz window
    const groups = groupChannels([ch(146_000_000), ch(149_000_000)], WINDOW);
    expect(groups).toHaveLength(2);
  });

  it("ignores disabled channels", () => {
    const groups = groupChannels([ch(146_790_000), ch(464_175_000, { enabled: false })], WINDOW);
    expect(groups).toHaveLength(1);
  });

  it("returns [] for no enabled channels", () => {
    expect(groupChannels([], WINDOW)).toEqual([]);
  });

  it("is deterministic regardless of input order", () => {
    const a = groupChannels([ch(464_175_000), ch(146_790_000), ch(464_425_000)], WINDOW);
    const b = groupChannels([ch(146_790_000), ch(464_425_000), ch(464_175_000)], WINDOW);
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd kiosk && npx vitest run test/grouping.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/backend/engine/grouping.ts`:
```ts
import type { Channel } from "../config/schema.js";

export interface ChannelGroup {
  /** Front-end tune frequency for this group (Hz). */
  centerHz: number;
  /** Enabled channels in this group, ascending by freq. */
  channels: Channel[];
}

// Greedy interval clustering: sort enabled channels ascending, start a new
// group whenever the span (current freq - group's lowest freq) would exceed
// the usable window. Center = midpoint of the group's min/max, so every
// member is within ±window/2 by construction. Deterministic, no device I/O.
export function groupChannels(channels: Channel[], windowHz: number): ChannelGroup[] {
  const enabled = channels.filter((c) => c.enabled).sort((a, b) => a.freq - b.freq);
  const groups: ChannelGroup[] = [];
  let current: Channel[] = [];

  for (const c of enabled) {
    if (current.length > 0 && c.freq - current[0]!.freq > windowHz) {
      groups.push(toGroup(current));
      current = [];
    }
    current.push(c);
  }
  if (current.length > 0) groups.push(toGroup(current));
  return groups;
}

function toGroup(channels: Channel[]): ChannelGroup {
  const lo = channels[0]!.freq;
  const hi = channels[channels.length - 1]!.freq;
  return { centerHz: (lo + hi) / 2, channels };
}
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd kiosk && npx vitest run test/grouping.test.ts`
Expected: PASS, all 7.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/engine/grouping.ts kiosk/test/grouping.test.ts
git commit -m "feat(engine): pure channel-grouping for wideband group-hop"
```

---

## Task 2: Config schema additions

**Files:**
- Modify: `src/backend/config/schema.ts`
- Test: `test/schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/schema.test.ts`:
```ts
describe("wideband scan fields", () => {
  it("are optional — existing configs still parse", () => {
    expect(configSchema.safeParse(defaultConfig()).success).toBe(true);
  });

  it("accepts explicit wideband tuning", () => {
    const cfg = structuredClone(defaultConfig()) as any;
    cfg.scan.windowBandwidthHz = 2_000_000;
    cfg.scan.groupDwellMs = 3000;
    cfg.scan.openAboveFloorDb = 9;
    expect(configSchema.safeParse(cfg).success).toBe(true);
  });

  it("rejects a non-positive windowBandwidthHz", () => {
    const cfg = structuredClone(defaultConfig()) as any;
    cfg.scan.windowBandwidthHz = 0;
    expect(configSchema.safeParse(cfg).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run to confirm fail**

Run: `cd kiosk && npx vitest run test/schema.test.ts -t wideband`
Expected: the explicit-tuning test FAILS (zod strips/rejects unknown keys —
verify which; the assertion drives the addition either way).

- [ ] **Step 3: Add the fields**

In `src/backend/config/schema.ts`, inside the `scan` object after `dwellMs`:
```ts
    // Wideband engine tuning (optional; RtlFmEngine ignores these).
    // Usable I/Q window for grouping — keep under the dongle's ~2.4 MHz
    // instantaneous bandwidth to leave guard band.
    windowBandwidthHz: z.number().int().positive().optional(),
    // Dwell per group before hopping to the next (hold-through overrides).
    groupDwellMs: z.number().int().positive().optional(),
    // Squelch: open when channel power exceeds its learned noise floor by
    // this many dB (close threshold sits 3 dB lower for hysteresis).
    openAboveFloorDb: z.number().positive().optional(),
```

- [ ] **Step 4: Run to confirm pass**

Run: `cd kiosk && npx vitest run test/schema.test.ts && npm run build:backend`
Expected: PASS + tsc clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/config/schema.ts kiosk/test/schema.test.ts
git commit -m "feat(config): optional wideband scan tuning fields"
```

---

## Task 3: GNU Radio helper (`wideband_helper.py`) + build copy step

**Files:**
- Create: `src/backend/engine/wideband_helper.py`
- Modify: `package.json` (copy helper into dist)

The helper is hardware-coupled; it is NOT exercised by vitest (CI has no GNU
Radio). It is verified by the live smoke test in Task 7. Keep ALL protocol
logic thin and mirrored by the fake in Task 4. Base the DSP on the proven
`bench/wideband-spike.py` (same source/channelizer/NBFM blocks).

- [ ] **Step 1: Write the helper**

Create `src/backend/engine/wideband_helper.py`:

```python
#!/usr/bin/env python3
"""Kerchunk wideband DSP helper — one persistent GNU Radio flowgraph.

Spawned by WidebandEngine with the SYSTEM python (/usr/bin/python3 — GNU Radio
lives in dist-packages). Protocol (line-delimited JSON):

  stdin  <- {"cmd":"tune","centerHz":N,"channels":[{"id":"...","freqHz":N},...]}
  stdout -> {"ev":"ready"}                               once, device open
  stdout -> {"ev":"tuned","centerHz":N}                  after each tune
  stdout -> {"ev":"open","id":...,"db":N}                channel went active
  stdout -> {"ev":"close","id":...}                      channel went idle
  stdout -> {"ev":"audible","id":...|null}               who owns the speaker
  stdout -> {"ev":"power","levels":{id: dB,...}}         ~5 Hz telemetry

Audio goes straight to ALSA (gr audio.sink). Audible selection is
first-active-wins, hold until close, then any other open channel.

DSP per chain (MAX_CHANS=8, built once, offsets retuned per group):
  soapy source 2.4 MS/s -> freq_xlating_fir (decim 50 -> 48k) ->
    [power: mag^2 -> moving_average -> probe]
    [audio: nbfm_rx(48k/48k, 5k dev) -> gate(multiply_const 0|1)] -> add -> sink

Detection (per chain, in the poll loop, ~50ms):
  floor_db: EMA (alpha 0.02) of power while closed; open when
  db > floor + open_db; close when db < floor + open_db - 3 sustained for
  hang_ms. Floors reset on tune.
"""
```

…followed by the implementation. Requirements (assert each before Task 7):
1. `--sink`, `--rate` (default 2_400_000), `--gain` (float dB or `auto`),
   `--open-db` (default 9.0), `--hang-ms` (default 2000) CLI args.
2. Build `MAX_CHANS = 8` chains as in the docstring; unused chains keep gate
   0 and are excluded from detection.
3. `tune`: `src.set_frequency(0, centerHz)`, per-chain
   `xlate.set_center_freq(freqHz - centerHz)`, reset floors/open state, gate
   everything off, emit `tuned`. More channels than `MAX_CHANS` ⇒ use the
   first 8 and emit `{"ev":"log","msg":"group truncated to 8 channels"}`.
4. Main loop: read stdin commands (non-blocking / reader thread), poll probes
   every 50 ms, run detection, emit `open`/`close`/`audible` transitions and
   `power` every 200 ms. Flush stdout on every write.
5. First-active-wins: gate exactly one open channel into the audio sink;
   when it closes pick another open channel else none (gate all off).
6. EOF on stdin or `{"cmd":"quit"}` ⇒ `tb.stop(); tb.wait(); exit 0`.
7. Top of file: `import sys; sys.stdout.reconfigure(line_buffering=True)`.

- [ ] **Step 2: Syntax-check with the system python**

Run: `/usr/bin/python3 -m py_compile kiosk/src/backend/engine/wideband_helper.py`
Expected: clean exit. (Import test needs hardware-free gnuradio import — also
run `/usr/bin/python3 -c "import ast,sys; ast.parse(open('kiosk/src/backend/engine/wideband_helper.py').read())"`.)

- [ ] **Step 3: Ship it in dist/**

In `package.json`, change `build:backend` to:
```json
    "build:backend": "tsc -p tsconfig.json && cp src/backend/engine/wideband_helper.py dist/backend/engine/",
```

Run: `cd kiosk && npm run build:backend && test -f dist/backend/engine/wideband_helper.py && echo shipped`
Expected: `shipped`.

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/backend/engine/wideband_helper.py kiosk/package.json
git commit -m "feat(dsp): GNU Radio wideband helper flowgraph + dist copy step"
```

---

## Task 4: Fake helper for hardware-free engine tests

**Files:**
- Create: `test/fakes/fake-wideband-helper.sh`

One fake, scenario-driven by env (mirrors `fake-rtl_fm-*.sh` + `FAKE_RTL_ARGS_FILE` conventions):

- [ ] **Step 1: Write the fake**

Create `test/fakes/fake-wideband-helper.sh`:
```bash
#!/usr/bin/env bash
# Fake wideband_helper.py for WidebandEngine tests. Speaks the line-JSON
# protocol on stdin/stdout. Scenarios via env:
#   FAKE_WB_ARGS_FILE   - append "$@" on launch (spawn counting)
#   FAKE_WB_TUNES_FILE  - append every received tune command (hop assertions)
#   FAKE_WB_SCRIPT      - newline-separated events to emit after first tune,
#                         each prefixed with "sleep:<ms>" optionally
#   FAKE_WB_MODE        - "nodevice" -> print device error to stderr, exit 1
#                         "crash"    -> emit ready, then exit 2 after 100ms
[ -n "${FAKE_WB_ARGS_FILE:-}" ] && echo "$@" >> "$FAKE_WB_ARGS_FILE"
if [ "${FAKE_WB_MODE:-}" = "nodevice" ]; then
  echo "RuntimeError: failed to open SoapySDR device" >&2
  exit 1
fi
echo '{"ev":"ready"}'
if [ "${FAKE_WB_MODE:-}" = "crash" ]; then sleep 0.1; exit 2; fi
emitted=0
while IFS= read -r line; do
  case "$line" in
    *'"cmd":"quit"'*) exit 0 ;;
    *'"cmd":"tune"'*)
      [ -n "${FAKE_WB_TUNES_FILE:-}" ] && echo "$line" >> "$FAKE_WB_TUNES_FILE"
      # Ack every tune; centerHz is echoed back opaquely (engine asserts order
      # via FAKE_WB_TUNES_FILE, not the ack payload).
      echo '{"ev":"tuned"}'
      if [ "$emitted" = 0 ] && [ -n "${FAKE_WB_SCRIPT:-}" ]; then
        emitted=1
        (
          while IFS= read -r ev; do
            case "$ev" in
              sleep:*) sleep "$(awk "BEGIN{print ${ev#sleep:}/1000}")" ;;
              *) echo "$ev" ;;
            esac
          done <<< "$FAKE_WB_SCRIPT"
        ) &
      fi
      ;;
  esac
done
```

- [ ] **Step 2: Smoke the fake by hand**

Run:
```bash
cd kiosk && chmod +x test/fakes/fake-wideband-helper.sh
printf '{"cmd":"tune","centerHz":1,"channels":[]}\n{"cmd":"quit"}\n' \
  | FAKE_WB_SCRIPT='{"ev":"open","id":"c1","db":-12}' test/fakes/fake-wideband-helper.sh
```
Expected: `ready`, `tuned`, and the scripted `open` event, exit 0.

- [ ] **Step 3: Commit**

```bash
git add kiosk/test/fakes/fake-wideband-helper.sh
git commit -m "test(engine): scenario-driven fake wideband helper"
```

---

## Task 5: `WidebandEngine`

**Files:**
- Create: `src/backend/engine/WidebandEngine.ts`
- Test: `test/WidebandEngine.test.ts`

Mirror `RtlFmEngine`'s shape: options object (incl. `now`), listeners set,
`setState` emitter, stale-spawn guards, `killChildren`-style teardown,
`handleUnexpectedExit` with ≥1s restart. Differences: ONE long-lived child;
hopping = writing a `tune` line, never killing.

**Engine contract (drives the tests):**
- `start(config)`: group via `groupChannels(config.channels,
  config.windowBandwidthHz ?? 2_000_000)` — extend `ScanConfig` usage by
  reading the new optional fields off the config the server passes (add
  `windowBandwidthHz?`, `groupDwellMs?`, `openAboveFloorDb?` to `ScanConfig`
  in `ScannerEngine.ts`; existing engines ignore them). Zero groups ⇒
  `running`, no child (parity). Else spawn helper ONCE
  (`/usr/bin/python3 dist/.../wideband_helper.py --sink <audioSink> ...`,
  overridable `helperCmd: string[]` option for tests), wait for `ready`,
  send tune for group 0.
- Helper events → engine events: `open` for channel id X ⇒ look up the
  `Channel` in the current group ⇒ emit `active` (+ `signal` with the dB).
  `close` of the last open channel ⇒ emit `idle`. `power` for the audible
  channel ⇒ throttled `signal`.
- Group-hop: when >1 group, after `groupDwellMs` (default 3000) with NO open
  channel in the current group, send tune for the next group (round-robin).
  Any open channel ⇒ hold (do not tune away) until `close`. 1 group ⇒ no
  timer at all.
- Helper exit unexpectedly ⇒ emit `error` (`NO_DEVICE` if stderr matched
  `/failed to open|SoapySDR|No supported devices/i`, else `HELPER_EXITED`),
  respawn whole helper after `restartDelayMs` (default 1000), retune to the
  current group.
- `stop()` ⇒ send `{"cmd":"quit"}`, SIGKILL after 500ms grace, state
  `stopped`. `setVolume`/`setMuted` ⇒ `amixer` exactly as `RtlFmEngine.ts:345-350`.

- [ ] **Step 1: Write the failing tests**

Create `test/WidebandEngine.test.ts` reusing the `ch()`/`cfg()`/`collect()`/
`waitFor()` patterns from `test/RtlFmEngine.test.ts` (import the fake via
`join(__dirname, "fakes", "fake-wideband-helper.sh")`, chmod in `beforeAll`,
`helperCmd: [FAKE]`, `restartDelayMs: 50`, `groupDwellMs: 100` for speed).
Cover at minimum:

1. **single spawn, no per-hop respawn** — 2 groups, run 600ms: exactly ONE
   line in `FAKE_WB_ARGS_FILE`, ≥3 lines in `FAKE_WB_TUNES_FILE` (it hopped
   without respawning). *This is the no-thrash regression test.*
2. **tune carries the group's channels** — first tune line includes both VHF
   channel ids and `centerHz` = midpoint.
3. **open ⇒ active + signal** — `FAKE_WB_SCRIPT` emits `open` for a known id;
   expect `active` with the full matching `Channel` and a `signal` event.
4. **close ⇒ idle** — script `open` then `sleep:100` then `close`; expect
   `idle` after `active`.
5. **hold-through** — script `open` (no close), 2 groups: after 400ms the
   tunes file still has only the initial tune (engine never tuned away while
   held).
6. **resume after close** — script `open`, `sleep:150`, `close`: a second
   tune appears after the close.
7. **single group ⇒ no hopping** — 1 group, 400ms: exactly 1 tune line.
8. **zero channels ⇒ running, nothing spawned** — state `running`,
   `FAKE_WB_ARGS_FILE` absent/empty.
9. **crash ⇒ error + respawn** — `FAKE_WB_MODE=crash`, `autoRestart` on:
   an `error` event with code `HELPER_EXITED`, then a second args-file line
   after ≥restartDelayMs.
10. **nodevice ⇒ NO_DEVICE** — `FAKE_WB_MODE=nodevice`: `error` with code
    `NO_DEVICE`.
11. **stop kills the helper** — start, stop, assert no `fake-wideband-helper`
    process remains (PID file or `FAKE_WB_ARGS_FILE` + `process.kill(pid, 0)`
    check, the `fake-sink.sh` orphan pattern).

- [ ] **Step 2: Run to confirm fail**

Run: `cd kiosk && npx vitest run test/WidebandEngine.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement `WidebandEngine.ts`**

Per the contract above. Key structure:
```ts
export interface WidebandEngineOptions {
  helperCmd?: string[];          // default ["/usr/bin/python3", <dist helper path>]
  autoRestart?: boolean;         // default true
  restartDelayMs?: number;       // default 1000 (>=1s — the thrash lesson)
  groupDwellMs?: number;         // default from config else 3000
  now?: () => number;
}
```
Helper path default: `new URL("./wideband_helper.py", import.meta.url)` →
`fileURLToPath` (works in `dist/` because of the Task 3 copy). Parse stdout
with `readline` + `JSON.parse` in a try/catch (ignore malformed lines, but
keep last stderr line for exit diagnosis — the `lastStderrLine` pattern).
Track `openIds: Set<string>` per group for hold-through and idle detection.
Guard every child event handler with `this.child !== child`.

- [ ] **Step 4: Run to confirm pass**

Run: `cd kiosk && npx vitest run test/WidebandEngine.test.ts && npm run build:backend`
Expected: all PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/engine/WidebandEngine.ts kiosk/src/backend/engine/ScannerEngine.ts kiosk/test/WidebandEngine.test.ts
git commit -m "feat(engine): WidebandEngine — persistent helper, group-hop, zero re-opens"
```

---

## Task 6: Engine selection + server plumbing

**Files:**
- Modify: `src/backend/index.ts`
- Modify: `src/backend/server.ts` (thread new scan fields through `toScanConfig`)
- Test: `test/api.test.ts` (toScanConfig passthrough only)

- [ ] **Step 1: Failing test**

Add to `test/api.test.ts`: saving a config with
`scan.windowBandwidthHz/groupDwellMs/openAboveFloorDb` set, then
`POST /api/scan/start`, passes them through to `engine.start` (monkeypatch
`engine.start`, the existing "restarts the scanner" pattern at
`test/api.test.ts:43`).

- [ ] **Step 2: Confirm fail, then implement**

- `toScanConfig` (`server.ts`): include the three optional fields in the
  returned `ScanConfig`.
- `index.ts`: replace the `useFake` ternary with:
```ts
const engineKind = process.env.KERCHUNK_ENGINE
  ?? (process.env.USE_FAKE_ENGINE === "1" ? "fake" : "rtlfm");
const engine =
  engineKind === "fake" ? new FakeEngine()
  : engineKind === "wideband" ? new WidebandEngine()
  : new RtlFmEngine({ openThreshold: config.scan.squelchLevel, hangMs: config.scan.dwellMs });
```
  and include the new fields in the boot-time `engine.start({...})` payload.
  Log the resolved kind in the listen banner.

- [ ] **Step 3: Verify**

Run: `cd kiosk && npx vitest run && npm run build:backend`
Expected: full suite green, tsc clean.

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/backend/index.ts kiosk/src/backend/server.ts kiosk/test/api.test.ts
git commit -m "feat(engine): KERCHUNK_ENGINE selector + wideband config passthrough"
```

---

## Task 7: Ubuntu appliance setup script + live smoke test

**Files:**
- Create: `scripts/setup-kiosk-ubuntu.sh` (alongside `setup-kiosk-pi.sh`)

- [ ] **Step 1: Write the script**

apt install `rtl-sdr soapysdr-tools soapysdr-module-rtlsdr gnuradio
python3-numpy`, write `/etc/modprobe.d/rtl-sdr-blacklist.conf`
(`blacklist dvb_usb_rtl28xxu`, `blacklist rtl2832`, `blacklist rtl2832_sdr`),
`rmmod` them if loaded (best-effort). Idempotent like `setup-kiosk-pi.sh`.
Do NOT touch display/lid config here (separate follow-up — see Notes).

- [ ] **Step 2: Run it on the appliance**

Run: `sudo scripts/setup-kiosk-ubuntu.sh && rtl_test -t 2>&1 | head -3`
Expected: idempotent re-run OK; `rtl_test` finds the R820T with NO
"Detached kernel driver" line once blacklisted (after replug/reboot it never
attaches).

- [ ] **Step 3: LIVE smoke test (hardware, this machine)**

```bash
cd kiosk && npm run build
KERCHUNK_ENGINE=wideband KERCHUNK_CONFIG=/tmp/wb-smoke.json PORT=8090 node dist/backend/index.js
```
With a config whose channels = the 7 NOAA WX frequencies (`sink` set to
`plughw:1,0`, one group ⇒ no hopping): expect audible weather audio within a
few seconds, `active`/`signal` events in the dashboard at `:8090`, and
`grep -c` of helper spawns in `ps` = 1 over a 5-minute run. Then a 2-group
config (WX + a local repeater) to observe group-hopping + hold-through live.

- [ ] **Step 4: Commit**

```bash
git add scripts/setup-kiosk-ubuntu.sh
git commit -m "feat(setup): Ubuntu appliance SDR toolchain + dvb blacklist"
```

---

## Final verification

- [ ] `cd kiosk && npm run build && npm test` — full suite green.
- [ ] Live smoke (Task 7 step 3) — audio + events + exactly one helper spawn.
- [ ] Spec coverage check: grouping (T1), config (T2), helper DSP +
  first-active-wins (T3), hardware-free engine tests incl. no-thrash
  regression (T4-T5), engine switch with `RtlFmEngine` fallback intact (T6),
  setup + live proof (T7).
- [ ] The dashboard required NO changes (same `EngineEvent` contract) —
  verify by loading it during the smoke test.

## Notes / explicitly deferred

- **Closed-lid HDMI + display units for the laptop appliance** — independent
  of the engine; do as its own task (logind `HandleLidSwitch=ignore`,
  compositor on HDMI, port `kerchunk-display.service`).
- **deploy.sh** still targets the Pi over SSH; this appliance runs the repo
  locally. Revisit deployment once the laptop is the blessed runtime.
- Richer multi-active dashboard UI; AM demod; trunking — out of scope (spec).
