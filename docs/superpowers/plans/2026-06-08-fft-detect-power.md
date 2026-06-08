# FFT-Detect for Power Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Behind an off-by-default `scan.detectVia` flag, derive each channel's power (both the ~150 ms floor/open estimate and the ~30 ms fast-gate estimate) from the already-running Close Call FFT instead of 12 per-lane power probes, recovering ~0.5–0.7 cores while leaving the per-lane FM demod and the FM-quieting squelch untouched.

**Architecture:** Add two `moving_average_ff` vector integrations (long + short) over the existing 2048-bin `cc_mag` stream, each feeding a `probe_signal_vf`. In `fft` mode the poll loop reads per-channel power by summing each channel's FFT bin range from these vectors; the per-lane power front-end (`complex_to_mag_squared` + both moving-averages + both probes) is not built. The squelch state machine, fast-gate logic, leveler, gate, limiter, demod, quieting probe, and Close Call are all unchanged consumers — only the *source* of the two power scalars changes. `lane` mode (default) is the fully-intact fixed-12 fallback.

**Tech Stack:** TypeScript (Vite/`tsc` backend, Vitest), Python 3 + GNU Radio 3.10 (the DSP helper), Zod (config schema), numpy.

**Spec:** `docs/superpowers/specs/2026-06-08-fft-detect-power-design.md`

---

## File Structure

- **`kiosk/src/backend/config/schema.ts`** — add `scan.detectVia` enum field.
- **`kiosk/src/backend/engine/ScannerEngine.ts`** — add `detectVia?` to the `ScanConfig` interface (the engine's config shape).
- **`kiosk/src/backend/server.ts`** — `toScanConfig()` maps `config.scan.detectVia` → `ScanConfig.detectVia`.
- **`kiosk/src/backend/engine/WidebandEngine.ts`** — `helperArgs()` emits `--detect-via <mode>`.
- **`kiosk/src/backend/engine/wideband_dsp_math.py`** *(new)* — pure, gnuradio-free DSP math (`channel_bins`, `bin_power_db`) so it is unit-testable in CI without GNU Radio.
- **`kiosk/src/backend/engine/wideband_helper.py`** — argparse `--detect-via`; build the two FFT integrations + probes (fft mode only); make the per-lane power front-end conditional; per-channel bin caching in `tune()`/`park()`; route the SLOW/FAST power through Helper accessors in `poll()` and `power_levels()`.
- **`kiosk/test/detectVia.test.ts`** *(new)* — Vitest for schema round-trip + `helperArgs`.
- **`kiosk/test/wideband_dsp_math_test.py`** *(new)* — dependency-free Python asserts for the DSP math.

Each task produces a self-contained, committable change. Tasks 1–2 are pure-logic TDD. Tasks 3–5 are the helper changes (flowgraph wiring is build/smoke-verified, since GNU Radio flowgraphs are not CI-unit-testable; correctness of detection is gated by the bench A/B in Task 6).

---

### Task 1: Plumb the `detectVia` flag end-to-end (TypeScript)

**Files:**
- Modify: `kiosk/src/backend/config/schema.ts` (the `scan: z.object({...})` block, ~line 58)
- Modify: `kiosk/src/backend/engine/ScannerEngine.ts` (the `ScanConfig` interface)
- Modify: `kiosk/src/backend/server.ts` (`toScanConfig`)
- Modify: `kiosk/src/backend/engine/WidebandEngine.ts` (`helperArgs`, ~line 173)
- Test: `kiosk/test/detectVia.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `kiosk/test/detectVia.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { configSchema } from "../src/backend/config/schema.js";

describe("scan.detectVia", () => {
  it("defaults to absent (lane behavior) and accepts 'lane' | 'fft'", () => {
    const base = { sampleRate: 2_400_000, squelchLevel: 1800, gain: "auto" as const, dwellMs: 2000 };
    expect(configSchema.shape.scan.parse({ ...base }).detectVia).toBeUndefined();
    expect(configSchema.shape.scan.parse({ ...base, detectVia: "fft" }).detectVia).toBe("fft");
    expect(configSchema.shape.scan.parse({ ...base, detectVia: "lane" }).detectVia).toBe("lane");
    expect(() => configSchema.shape.scan.parse({ ...base, detectVia: "nope" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run detectVia.test.ts`
Expected: FAIL — `detectVia` not in schema (parse strips it, so `.detectVia` is `undefined` for the `"fft"` case → assertion fails).

- [ ] **Step 3: Add the schema field**

In `kiosk/src/backend/config/schema.ts`, inside the `scan: z.object({ ... })` block (after `closeCallDb`, before `sweepRanges`), add:

```ts
    // Power-detection source (ROADMAP DSP-efficiency): "lane" (default) reads
    // power from the 12 per-lane probes; "fft" derives it from the Close Call
    // FFT, shedding the per-lane power front-end (~0.5-0.7 cores). Quieting and
    // demod are unchanged in both. Default flips to "fft" only after the bench
    // A/B (see specs/2026-06-08-fft-detect-power-design.md).
    detectVia: z.enum(["lane", "fft"]).optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run detectVia.test.ts`
Expected: PASS.

- [ ] **Step 5: Thread it through ScanConfig + toScanConfig + helperArgs**

In `kiosk/src/backend/engine/ScannerEngine.ts`, add to the `ScanConfig` interface (near `openAboveFloorDb?`):

```ts
  // Power-detection source for the wideband engine ("lane" | "fft"). Others ignore it.
  detectVia?: "lane" | "fft";
```

In `kiosk/src/backend/server.ts`, in `toScanConfig` (where other optional scan fields like `openAboveFloorDb` are copied), add:

```ts
    ...(config.scan.detectVia !== undefined ? { detectVia: config.scan.detectVia } : {}),
```

In `kiosk/src/backend/engine/WidebandEngine.ts`, in `helperArgs()`, after the `--open-db` entry in the `args` array push (keep it inside the array literal or as a follow-up push):

```ts
    if (cfg.detectVia) args.push("--detect-via", cfg.detectVia);
```

- [ ] **Step 6: Add a helperArgs test**

Append to `kiosk/test/detectVia.test.ts`:

```ts
import { WidebandEngine } from "../src/backend/engine/WidebandEngine.js";

describe("WidebandEngine --detect-via", () => {
  const base = {
    channels: [], sampleRate: 2_400_000, squelchLevel: 1800, dwellMs: 2000,
    gain: "auto" as const, audioSink: "default",
  };
  function argsFor(cfg: object): string[] {
    const e = new WidebandEngine({});
    // helperArgs is private; reach it for the test (same pattern as other engine tests).
    (e as unknown as { config: unknown }).config = cfg;
    return (e as unknown as { helperArgs(): string[] }).helperArgs();
  }
  it("omits --detect-via by default and includes it when set", () => {
    expect(argsFor(base)).not.toContain("--detect-via");
    const a = argsFor({ ...base, detectVia: "fft" });
    expect(a).toContain("--detect-via");
    expect(a[a.indexOf("--detect-via") + 1]).toBe("fft");
  });
});
```

Run: `cd kiosk && npx vitest run detectVia.test.ts`
Expected: PASS. (If `helperArgs`/`config` access pattern differs from existing engine tests, mirror whatever `kiosk/test/WidebandEngine.test.ts` already does to construct and poke the engine.)

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/backend/config/schema.ts kiosk/src/backend/engine/ScannerEngine.ts kiosk/src/backend/server.ts kiosk/src/backend/engine/WidebandEngine.ts kiosk/test/detectVia.test.ts
git commit -m "feat(scan): add detectVia flag (lane|fft) plumbed to the helper"
```

---

### Task 2: Pure DSP math module (`channel_bins`, `bin_power_db`) with CI-runnable tests

**Files:**
- Create: `kiosk/src/backend/engine/wideband_dsp_math.py`
- Test: `kiosk/test/wideband_dsp_math_test.py` (new, dependency-free — only `numpy`)

The helper imports `from gnuradio import ...` at module top, so it can't be imported in a gnuradio-less CI. Extracting the pure math into its own module makes it testable anywhere and keeps the unit focused.

- [ ] **Step 1: Write the failing test**

Create `kiosk/test/wideband_dsp_math_test.py`:

```python
"""Dependency-free asserts for the wideband DSP math. Run: python3 this_file.py"""
import os, sys
import numpy as np
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src", "backend", "engine"))
from wideband_dsp_math import channel_bins, bin_power_db

RATE, NFFT = 2_400_000, 2048
BINW = RATE / NFFT            # ~1171.875 Hz
DC = NFFT // 2                # fft_vcc(shift=True) puts DC at the center bin

def approx(a, b, eps=2): return abs(a - b) <= eps

# A channel exactly at window center maps around the DC bin.
lo, hi = channel_bins(462_000_000, 462_000_000, RATE, NFFT, 8_000)
assert lo < DC < hi, (lo, DC, hi)
assert approx(hi - lo, 2 * round(8_000 / BINW) + 1), (lo, hi)

# A channel +300 kHz above center shifts right by ~300000/BINW bins.
lo2, hi2 = channel_bins(462_300_000, 462_000_000, RATE, NFFT, 8_000)
center2 = (lo2 + hi2 - 1) / 2
assert approx(center2, DC + 300_000 / BINW), center2

# Clamped at the window edges (no negative / out-of-range bins).
loE, hiE = channel_bins(462_000_000 - RATE / 2, 462_000_000, RATE, NFFT, 8_000)
assert loE >= 0 and hiE <= NFFT and loE < hiE, (loE, hiE)

# bin_power_db: sum of |.|^2 bins -> dB; empty/zero -> floor.
vec = np.zeros(NFFT); vec[DC - 2:DC + 3] = 1.0     # 5 bins of unit power
assert approx(bin_power_db(vec, DC - 2, DC + 3), 10 * np.log10(5.0), 0.01)
assert bin_power_db(np.zeros(NFFT), 0, 4) == -120.0

print("wideband_dsp_math: all asserts passed")
```

- [ ] **Step 2: Run to verify it fails**

Run: `python3 kiosk/test/wideband_dsp_math_test.py`
Expected: FAIL — `ModuleNotFoundError: No module named 'wideband_dsp_math'`.

- [ ] **Step 3: Write the module**

Create `kiosk/src/backend/engine/wideband_dsp_math.py`:

```python
"""Pure DSP math for FFT-based power detection — no GNU Radio import, so it is
unit-testable in CI. Shared by wideband_helper.py.

Bin convention matches the helper's Close Call FFT: fft_vcc(..., shift=True) puts
DC at index NFFT//2, and bin index for frequency f (Hz, absolute) at window
center center_hz is round((f - center_hz) / binw) + NFFT//2, with binw = rate/NFFT.
"""
import numpy as np


def channel_bins(freq_hz, center_hz, rate, nfft, half_hz):
    """[lo, hi) FFT bin range (clamped to [0, nfft)) covering a channel of
    half-bandwidth half_hz centered at freq_hz, for a window centered at
    center_hz. Returns (lo, hi) with lo < hi when any part is in-window."""
    binw = rate / nfft
    dc = nfft // 2
    center = int(round((freq_hz - center_hz) / binw)) + dc
    half = max(1, int(round(half_hz / binw)))
    lo = max(0, center - half)
    hi = min(nfft, center + half + 1)
    return (lo, hi)


def bin_power_db(mag_sq_vec, lo, hi):
    """dB of summed |.|^2 power over bins [lo, hi). -120.0 if empty/zero —
    mirrors the per-lane power_db() floor so downstream logic is unchanged."""
    if hi <= lo:
        return -120.0
    p = float(np.sum(mag_sq_vec[lo:hi]))
    return 10.0 * np.log10(p) if p > 0 else -120.0
```

- [ ] **Step 4: Run to verify it passes**

Run: `python3 kiosk/test/wideband_dsp_math_test.py`
Expected: `wideband_dsp_math: all asserts passed`.

- [ ] **Step 5: Wire the python test into the test runner**

Add an npm script in `kiosk/package.json` so CI runs it alongside Vitest:

```json
    "test:py": "python3 test/wideband_dsp_math_test.py",
```

(If a CI workflow lists test commands, add `npm run test:py` there. Vitest stays the JS test runner; this is a separate dependency-free check.)

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/backend/engine/wideband_dsp_math.py kiosk/test/wideband_dsp_math_test.py kiosk/package.json
git commit -m "feat(dsp): pure channel_bins + bin_power_db math, CI-tested"
```

---

### Task 3: Helper accepts `--detect-via` and stores the mode

**Files:**
- Modify: `kiosk/src/backend/engine/wideband_helper.py` (argparse in `main()` ~line 793; `Helper.__init__` ~line 343)

- [ ] **Step 1: Add the argparse option**

In `main()`, alongside the other `ap.add_argument(...)` calls:

```python
    ap.add_argument("--detect-via", choices=["lane", "fft"], default="lane",
                    help="power-detection source: per-lane probes (default) or "
                         "the Close Call FFT")
```

- [ ] **Step 2: Store it on the Helper**

In `Helper.__init__`, near the top (after `self.args = args`):

```python
        self.detect_via = args.detect_via
```

- [ ] **Step 3: Verify the helper still starts in lane mode (smoke)**

Run (no SDR needed if the engine has a fake path; otherwise rely on existing helper smoke/tests):

```bash
cd kiosk && python3 -c "import ast; ast.parse(open('src/backend/engine/wideband_helper.py').read()); print('parse OK')"
```

Expected: `parse OK` (syntax check; full run is exercised by Task 6 build + existing engine tests).

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/backend/engine/wideband_helper.py
git commit -m "feat(helper): accept --detect-via (default lane)"
```

---

### Task 4: Build the FFT integrations + make the per-lane power front-end conditional

**Files:**
- Modify: `kiosk/src/backend/engine/wideband_helper.py` (constants ~line 117; `Chain.__init__` ~line 144; `Helper.__init__` ~line 405)

- [ ] **Step 1: Add integration-length constants**

Near the Close Call constants (`CC_FFT = 2048`, ~line 117), add:

```python
# FFT-detect integrations (detect_via="fft"). cc_mag emits one CC_FFT-vector per
# CC_FFT input samples -> ~rate/CC_FFT = 1172 vectors/s. Lengths set the
# averaging window: long for floor/open (~150 ms), short for the fast audio gate
# (~30 ms, matching the per-lane fast probe it replaces).
FFT_SLOW_FRAMES = 176    # ~150 ms
FFT_FAST_FRAMES = 35     # ~30 ms
DETECT_HALF_HZ = 8_000   # half-bandwidth summed per channel (~16 kHz NFM)
```

- [ ] **Step 2: Make the Chain power front-end conditional**

Change `Chain.__init__` signature (line 144) to accept a flag:

```python
    def __init__(self, tb, src, taps, samp_rate, adder, port, same_fd=None,
                 build_power=True):
```

Then guard the power-probe block construction. The blocks `self.mag2`, `self.avg`, `self.probe`, `self.avg_fast`, `self.probe_fast` (lines 147–156) and their connections become conditional. Replace the unconditional connect line:

```python
        tb.connect(src, self.xlate, self.mag2, self.avg, self.probe)
        tb.connect(self.mag2, self.avg_fast, self.probe_fast)
```

with:

```python
        tb.connect(src, self.xlate)
        if build_power:
            self.mag2 = blocks.complex_to_mag_squared(1)
            self.avg = blocks.moving_average_ff(QUAD_RATE // 10, 10.0 / QUAD_RATE)
            self.probe = blocks.probe_signal_f()
            self.avg_fast = blocks.moving_average_ff(QUAD_RATE // 100, 100.0 / QUAD_RATE)
            self.probe_fast = blocks.probe_signal_f()
            tb.connect(self.xlate, self.mag2, self.avg, self.probe)
            tb.connect(self.mag2, self.avg_fast, self.probe_fast)
```

(Move the original `self.mag2 = ...`, `self.avg = ...`, `self.probe = ...`, `self.avg_fast = ...`, `self.probe_fast = ...` assignments from lines 147–156 into the `if build_power:` block above; delete them from their original location. Leave everything else in `Chain.__init__` — `xlate`, `demod`, AM chain, noise/quieting probe, audio probe, SAME tap — unchanged.)

- [ ] **Step 3: Guard `Chain.power_db` / `fast_power_db` against the missing probes**

So lane-mode telemetry still works and fft-mode never crashes if called, change (lines 322–328):

```python
    def power_db(self):
        if not hasattr(self, "probe"):
            return -120.0
        p = self.probe.level()
        return 10 * math.log10(p) if p > 0 else -120.0

    def fast_power_db(self):
        if not hasattr(self, "probe_fast"):
            return -120.0
        p = self.probe_fast.level()
        return 10 * math.log10(p) if p > 0 else -120.0
```

- [ ] **Step 4: Build the FFT integrations in `Helper.__init__` (fft mode only)**

Change the chain construction (lines 405–407) to pass `build_power`:

```python
        build_power = (self.detect_via == "lane")
        self.chains = [Chain(self, self.src, taps, args.rate, self.adder, i,
                             same_fd=(same_fd if i == MAX_CHANS - 1 else None),
                             build_power=build_power)
                       for i in range(MAX_CHANS)]
```

Then, immediately after the existing Close Call FFT wiring (`self.connect(self.src, self.cc_s2v, self.cc_fft, self.cc_mag, self.cc_probe)`, line 417), add:

```python
        # FFT-detect: long (floor/open) and short (fast gate) integrations over
        # the same |.|^2 spectrum the Close Call FFT already produces. Built only
        # in fft mode so lane mode pays nothing.
        self.slow_probe = None
        self.fast_probe = None
        if self.detect_via == "fft":
            self.cc_slow = blocks.moving_average_ff(
                FFT_SLOW_FRAMES, 1.0 / FFT_SLOW_FRAMES, 4000, CC_FFT)
            self.slow_probe = blocks.probe_signal_vf(CC_FFT)
            self.connect(self.cc_mag, self.cc_slow, self.slow_probe)
            self.cc_fast = blocks.moving_average_ff(
                FFT_FAST_FRAMES, 1.0 / FFT_FAST_FRAMES, 4000, CC_FFT)
            self.fast_probe = blocks.probe_signal_vf(CC_FFT)
            self.connect(self.cc_mag, self.cc_fast, self.fast_probe)
```

- [ ] **Step 5: Syntax-check**

Run: `cd kiosk && python3 -c "import ast; ast.parse(open('src/backend/engine/wideband_helper.py').read()); print('parse OK')"`
Expected: `parse OK`.

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/backend/engine/wideband_helper.py
git commit -m "feat(helper): build FFT slow/fast integrations; per-lane power front-end now lane-mode only"
```

---

### Task 5: Route SLOW + FAST power through FFT bins in `poll()`

**Files:**
- Modify: `kiosk/src/backend/engine/wideband_helper.py` (import ~line 14; `tune()`/`park()`/`assign()`; `poll()` ~line 503; `power_levels()` ~line 771)

- [ ] **Step 1: Import the math module and add bin caching**

At the top of `wideband_helper.py`, with the other local imports:

```python
from wideband_dsp_math import channel_bins, bin_power_db
```

Cache per-channel bin ranges where the lane is assigned. In `Helper.tune()`, right after each `chain.assign(...)` call (inside the `if c is not None:` branch, after the existing `chain.assign(...)`), add:

```python
                chain.bin_lo, chain.bin_hi = channel_bins(
                    c["freqHz"], center_hz, self.args.rate, CC_FFT, DETECT_HALF_HZ)
```

And in the `else:` branch (where `chain.park()` is called), the park path should clear them — add to `Chain.park()` and `Chain.__init__` so they always exist:

```python
        self.bin_lo = None
        self.bin_hi = None
```

**Also cache bins on the Close Call discovery path.** `close_call_check()` assigns a parked lane directly (`chain.assign(f"cc_{freq}", freq - self.center_hz, priority=True)`, ~line 705), bypassing `tune()` — so in fft mode that lane would have `bin_lo = None` and never detect. Right after that `chain.assign(...)`, add:

```python
                chain.bin_lo, chain.bin_hi = channel_bins(
                    freq, self.center_hz, self.args.rate, CC_FFT, DETECT_HALF_HZ)
```

(Monitor/weather mode never calls `poll()` — line 843 gates on `not self.monitor` — so its assigned lane needs no bins.)

- [ ] **Step 2: Add Helper power accessors that branch on mode**

Add these methods to `Helper` (near `group_floor_db`, ~line 498):

```python
    def chan_power_db(self, chain, slow_vec):
        if self.detect_via == "fft":
            if slow_vec is None or chain.bin_lo is None:
                return -120.0
            return bin_power_db(slow_vec, chain.bin_lo, chain.bin_hi)
        return chain.power_db()

    def chan_fast_power_db(self, chain, fast_vec):
        if self.detect_via == "fft":
            if fast_vec is None or chain.bin_lo is None:
                return -120.0
            return bin_power_db(fast_vec, chain.bin_lo, chain.bin_hi)
        return chain.fast_power_db()
```

- [ ] **Step 3: Read the FFT vectors once per poll and route power through the accessors**

At the very top of `Helper.poll(self, now)` (after the `g_*` locals, ~line 506), add:

```python
        slow_vec = fast_vec = None
        if self.detect_via == "fft":
            sv = self.slow_probe.level() if self.slow_probe else None
            fv = self.fast_probe.level() if self.fast_probe else None
            slow_vec = np.asarray(sv) if sv and len(sv) == CC_FFT else None
            fast_vec = np.asarray(fv) if fv and len(fv) == CC_FFT else None
```

Then change the two power reads in `poll()`:
- Line 513 `db = chain.power_db()` → `db = self.chan_power_db(chain, slow_vec)`
- Line 566 `fast_db = chain.fast_power_db()` → `fast_db = self.chan_fast_power_db(chain, fast_vec)`

Everything else in `poll()` (floor learning, open/close state machine, fast-gate carrier logic, quieting, leveler) is unchanged — it consumes `db` and `fast_db` exactly as before.

- [ ] **Step 4: Fix power telemetry for fft mode**

`power_levels()` (~line 771) currently calls `chain.power_db()` per chain. So it works in both modes without per-poll vectors, read the slow vector inside it. Replace its body to branch:

```python
    def power_levels(self):
        if self.detect_via == "fft":
            sv = self.slow_probe.level() if self.slow_probe else None
            vec = np.asarray(sv) if sv and len(sv) == CC_FFT else None
            return {c.channel_id: round(self.chan_power_db(c, vec), 1)
                    for c in self.chains if c.channel_id is not None}
        return {c.channel_id: round(c.power_db(), 1)
                for c in self.chains if c.channel_id is not None}
```

(If the existing `power_levels()` body differs in shape, preserve its exact return structure — just swap the per-chain power source as above. `noise_levels()` is unchanged: the quieting/noise probe stays on the demod path in both modes.)

- [ ] **Step 5: Add a focused unit test for the bin-sum routing math**

The state machine is unchanged and GR wiring isn't CI-testable, but the bin→power mapping is. Append to `kiosk/test/wideband_dsp_math_test.py`:

```python
# Two adjacent channels ~12 bins apart: a strong signal in one must not dominate
# the other's bin sum (adjacent-bleed sanity for DETECT_HALF_HZ).
RATE, NFFT = 2_400_000, 2048
a_lo, a_hi = channel_bins(462_000_000, 462_000_000, RATE, NFFT, 8_000)
b_lo, b_hi = channel_bins(462_012_500, 462_000_000, RATE, NFFT, 8_000)  # +12.5 kHz
spectrum = np.zeros(NFFT)
spectrum[(a_lo + a_hi)//2] = 100.0   # strong carrier in channel A's center bin
pa = bin_power_db(spectrum, a_lo, a_hi)
pb = bin_power_db(spectrum, b_lo, b_hi)
assert pa > pb + 10, (pa, pb)  # A reads far hotter than B despite some range overlap
print("adjacent-bleed sanity passed")
```

Run: `python3 kiosk/test/wideband_dsp_math_test.py`
Expected: both prior and this assert pass. (If the overlap is too large and the assert fails, that is real signal that `DETECT_HALF_HZ` must shrink or use a center-weighted sum — record it for the bench A/B.)

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/backend/engine/wideband_helper.py kiosk/test/wideband_dsp_math_test.py
git commit -m "feat(helper): poll() reads SLOW/FAST power from FFT bins in fft mode"
```

---

### Task 6: Validation — build, tests, and document the deferred bench A/B

**Files:**
- Modify: `docs/superpowers/specs/2026-06-08-fft-detect-power-design.md` (none required; this task only runs checks and writes the bench procedure note)
- Create: `docs/superpowers/specs/2026-06-08-fft-detect-bench-procedure.md` (the runnable A/B steps for the cool-box session)

- [ ] **Step 1: Build the app**

Run: `cd kiosk && npm run build`
Expected: clean (frontend + `tsc` backend), no type errors. The `detectVia` field and `--detect-via` plumbing compile.

- [ ] **Step 2: Run the full test suite**

Run: `cd kiosk && npm test && npm run test:py`
Expected: all Vitest files pass (including `detectVia.test.ts`); `wideband_dsp_math_test.py` prints its pass lines.

- [ ] **Step 3: Confirm the default path is unchanged**

Run: `cd kiosk && python3 -c "import ast; ast.parse(open('src/backend/engine/wideband_helper.py').read()); print('parse OK')"`
Confirm by reading: with no `detectVia` set, `build_power` is `True`, the FFT integrations are not built, `chan_power_db`/`chan_fast_power_db` fall through to `chain.power_db()`/`chain.fast_power_db()` — i.e. byte-for-byte today's behavior. **Do not deploy or restart the appliance in this task.**

- [ ] **Step 4: Write the bench A/B procedure (for the cool-box follow-up)**

Create `docs/superpowers/specs/2026-06-08-fft-detect-bench-procedure.md` documenting exactly how to run the GO/NO-GO gate on a cool, stable box:
- Set `scan.detectVia: "fft"` in a *copy* of config; run the helper with `--detect-via fft` against live RF for a sustained window (≥30 min spanning the busy 12-channel groups).
- Capture `open`/`audible` events and gate behavior from both `lane` and `fft` runs over comparable RF.
- Metrics + PASS criteria (from the spec): false-open ≤ current; no missed real transmissions; open-latency within budget; fast mute ≤ ~30 ms with no added chatter.
- Only on PASS: change the config default to `"fft"` and deploy.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-08-fft-detect-bench-procedure.md
git commit -m "docs: FFT-detect bench A/B GO/NO-GO procedure"
```

---

## Notes for the implementer

- **Do not flip the default to `fft` and do not deploy/restart the appliance in this plan.** Shipping `detectVia` (default `lane`) is a no-op for the live radio; the FFT path is exercised only by an explicit flag and validated by the bench A/B (Task 6, separate cool-box session).
- **GNU Radio flowgraph code is not CI-unit-testable.** TDD covers the pure logic (Tasks 1, 2, 5 step 5); the wiring is build/smoke-verified and its *detection correctness* is gated by the bench A/B. Do not claim the FFT path "works" from unit tests alone.
- **`FFT_SLOW_FRAMES` / `FFT_FAST_FRAMES` / `DETECT_HALF_HZ` are first estimates.** Expect to tune them during the bench A/B (the spec's top risk is the fast gate). Keep them as named constants for easy adjustment.
- Follow existing helper idioms (single space-free `--flag value` args, `emit({...})` events, monotonic-time polling).
