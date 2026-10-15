# CB 38 LSB: an SSB lane

Status: spec — awaiting operator review.
Depends on CB mode (PR #296) and the CB wall (PR #297).

## Why

Channel 38 LSB (27.385 MHz) is the US CB SSB calling channel and "has good
stuff occasionally." Today CB mode never hears it: the default set is channels
1–32 (`cbDefaultChannels`, 32 lanes on the box), and even if 38 were listed it
would land on an AM lane — SSB has no carrier, so AM demod is unintelligible
"Donald Duck" audio that still trips the squelch now and then.

Goal: in CB mode, 38 is demodulated as LSB, opens on real SSB voice, and stays
shut on an empty channel. Judged by ear on the wall speaker.

## Decisions (operator, 2026-10-15)

- **38 LSB only.** It takes channel 32's lane in the default set (32 lanes
  stay 32). Other channels can be switched by config later (`cb.modes`).
- **Approach A:** a per-lane LSB path in the demod, not a sideband mask in the
  shared channelizer (lane bins are 390 Hz — too coarse for a 300 Hz edge, and
  it would touch every lane's hot path).
- **Out of scope:** USB, a clarifier / fine-tune knob for drifting stations,
  SSB anywhere outside CB mode, calibrating KIOSK03.

## What the code does today (why this isn't just a mode string)

1. **Squelch needs FM quieting.** `Scanner::poll` opens only when
   `db > floor + open_db && L.quiet`, and closes on lost quieting. Quieting is
   the HF-noise power of the FM discriminator, computed on *every* lane — AM
   passes because a carrier pins the phase. SSB voice has no carrier, so it
   would never pass.
2. **Lane power is ±8 kHz wide.** `power_[i]` meters the raw lane
   (`CHAN_CUTOFF_HZ` 8 kHz, one shared filter). An LSB voice occupies ~2.5 kHz
   below the dial; the wide meter adds ~8 dB of noise to the reading and lets
   the bottom of channel 39's LSB leak into 38's.
3. **The squelch floor is shared.** `floor` is the *minimum* `floor_db` over
   all assigned lanes. A narrower sideband meter reads ~8 dB lower than the
   wide lanes, so letting it into that minimum would lower every AM lane's
   threshold and make them all open easier.
4. **No frequency correction exists.** No `ppm` in `config.radios`, no CLI
   flag, no `rtlsdr_set_freq_correction`. SSB is pitch-sensitive: past
   ~±50 Hz it sounds wrong. At 27 MHz, 1 ppm = 27 Hz; KIOSK01 has never been
   measured.
5. **The speaker has two sources.** `SpeakerPath::set_source(lane, am)` picks
   AM (envelope × AM gain) or FM (de-emphasis → LPF → CTCSS HPF), then the
   shared AGC + limiter.

## Design

### Native helper (`kiosk/native/`) — PR 1

- **Lane demod becomes three-valued.** `LaneState.am` (bool) →
  `LaneState.demod` (`Fm | Am | Lsb`), parsed from the `tune` channel's
  `mode` (`"am"`, `"lsb"`, anything else FM — as today). `txstat.mode` reports
  `"lsb"`. Sub-audible squelch stays FM-only.
- **`SsbDemod` (new, `demod.cpp/.hpp`).** Per LSB lane, at `LANE_RATE` in and
  out: decimate 50 k → 12.5 k, complex band-pass −`SSB_HI_HZ`…−`SSB_LO_HZ`
  (the lower sideband only), interpolate back to 50 k. Outputs the filtered
  complex sideband signal; audio is its real part. Constants in
  `constants.hpp`: `SSB_LO_HZ` 300, `SSB_HI_HZ` 2850, transition widths, the
  decimation factor. Budget: well under 1 % of a core for one lane — measured
  in the native perf test, not assumed.
- **LSB lanes meter the sideband.** For an LSB lane `power_[i]` is pushed the
  `SsbDemod` output, not the raw lane, so the squelch sees in-band energy only.
  The FM discriminator / quieting meter still runs (cheap, keeps the code
  path uniform) but is ignored.
- **LSB squelch is energy-only.**
  - `L.quiet` is forced true (no quieting gate to open or close on).
  - The lane uses **its own** `floor_db` for its open/close/gate thresholds and
    is **excluded from the shared floor minimum** (finding 3).
  - Open/close/hang logic is otherwise unchanged and honours the per-channel
    `open_db` / `hang_ms` the `tune` already carries (`openDb` / `hangMs`).
    SSB speech has gaps between syllables, so the defaults below are a longer
    hang than FM's.
  - Floor adapts only while closed, as today; the per-lane warm-up seeds it.
- **Speaker: a third source.** `set_source(lane, Demod)`. FM audio is
  normalized by deviation and AM by its carrier; SSB has neither, so its audio
  amplitude follows RF level (~30 dB between stations) — more than the speaker
  AGC's 15 dB max gain can absorb. An LSB source therefore goes through
  `SsbLevel` (new): `Re(ssb)` divided by a peak-tracking envelope of `|ssb|`
  (fast attack `SSB_ENV_ATTACK_MS` 5, slow release `SSB_ENV_RELEASE_MS` 1000,
  re-primed on gate open like the AM carrier tracker), × `SSB_GAIN` 0.5 ×
  `--ssb-gain-db`, then the existing AGC + limiter — no de-emphasis, no FM LPF,
  no CTCSS HPF (the band-pass already bounds it). The fade-on-park path keeps
  running the LSB demod like it does the discriminator.
- **`--ssb-gain-db`** ([−30, 20], default 0): the LSB pre-gain into the AGC,
  the by-ear balance against AM — mirrors `--am-gain-db`.
- **`--ppm <int>`** → `rtlsdr_set_freq_correction` at open (`rtl_source.cpp`),
  range ±200, default 0. Ignored for `--iq-file`.
- **`txstat.offsetHz`** (FM and AM lanes): the mean discriminator output over
  the episode's open, quieted polls × `FM_MAX_DEV_HZ` — the carrier's offset from the tuned frequency,
  i.e. receiver error plus transmitter error. This is the calibration probe.

### Node / config — PR 2

- `config.radios[].ppm` (int, −200…200, optional = 0) → `--ppm` on that
  radio's helper. `radios` is read once at boot (`index.ts`), so a change takes
  a `kerchunk-kiosk` restart — like every other `radios` field.
- `config.scan.nativeSsbGainDb` ([−30, 20], optional) → `--ssb-gain-db`,
  plumbed exactly like `nativeAmGainDb` (ScanConfig field, spawn arg, respawn
  on change via the existing scan diff).
- `config.cb.modes`: record of channel number → `"am" | "lsb"`. Absent =
  `CB_MODES_DEFAULT` = `{"38": "lsb"}`; an explicit value replaces the map
  (like `cb.names`).
- `cbDefaultChannels(lanes, modes)`: the always-in set is `CB_CORE` (6/9/19)
  **plus every non-AM channel in `modes`**, then the rest counting up from 1.
  At 32 lanes that is 1–31 + 38 (32 is cut). An explicit `cb.channels` still
  wins.
- `cbChannels()` gives each channel its mode; LSB channels also carry
  `openAboveFloorDb = cb.ssbOpenDb` and `hangMs = cb.ssbHangMs` when set.
  `cb.ssbOpenDb` absent = no override (the scanner's `--open-db`); tuned by
  ear from there. `cb.ssbHangMs` absent = `CB_SSB_HANG_MS` 1500.
- Schema: channel `mode` enum gains `"lsb"` (CB-generated channels only in
  practice; the admin channel editor does not offer it — out of scope).
- `WidebandEngine` copies `offsetHz` into the txstat JSONL record
  (`TXSTAT_FIELDS`). `RtlFmEngine` ignores LSB (CB mode is wideband-only
  already).
- Docs: CLAUDE.md knob list (`radios[].ppm`, `cb.modes`, `cb.ssbOpenDb`,
  `cb.ssbHangMs`), `docs/API.md` if the config/mode payload docs list CB fields,
  ROADMAP entry.

### Calibration — after PR 1 ships

1. Let the scanner run normally for a while; FM repeaters and business
   channels produce txstats with `offsetHz`.
2. Median `offsetHz / freqMHz` across FM channels = KIOSK01's ppm error
   (transmitter errors average out; NWR, if a break-in happens, is a clean
   cross-check). Target: ±1 ppm (±27 Hz at CB).
3. Set `radios[KIOSK01].ppm` to −median(offsetHz/freqMHz) (a fast crystal
   tunes high, so carriers read low → negative offset → positive ppm), restart,
   and confirm the median moves to ~0 — that settles the sign empirically.

## Testing

- **Native unit tests** (`npm run test:native`):
  - `SsbDemod`: a synthetic LSB tone (carrier − 1 kHz) produces a 1 kHz real
    tone at the output; an upper-sideband tone (carrier + 1 kHz) and a tone
    10 kHz away (channel 39's sideband) are rejected by ≥ 40 dB.
  - Scanner: an LSB lane opens on sideband energy with no quieting, stays shut
    on noise, honours `hang_ms`, and its floor never enters the shared minimum
    (an AM lane's threshold is unchanged by adding an LSB lane).
  - `txstat.offsetHz` reports a synthetic FM carrier's known offset.
  - CLI: `--ppm` range checks.
- **Vitest:** `cbDefaultChannels` with default/explicit modes, `cbChannels`
  carrying mode and squelch overrides, schema accepts `radios[].ppm` and
  `cb.modes`, ppm reaches the helper args and a change respawns.
- **On hardware:** after calibration, CB mode on the wall: 38 stays closed on
  an empty channel (the `power` event's level for the 38 lane near its floor);
  when someone talks, it opens and sounds like voice. 38 is quiet most of the
  time, so the by-ear proof may wait for real traffic — that gets flagged
  honestly, not claimed.

## Knobs (where they live)

| Knob | Where | Default |
|---|---|---|
| ppm correction | `config.radios[].ppm` → `--ppm` | 0 (set after calibration; restart) |
| LSB loudness vs AM | `config.scan.nativeSsbGainDb` → `--ssb-gain-db` | 0 dB |
| which channels are LSB | `config.cb.modes` | `{"38":"lsb"}` |
| LSB open threshold | `config.cb.ssbOpenDb` | scanner `--open-db` |
| LSB hang | `config.cb.ssbHangMs` | 1500 ms |
| sideband edges, normalizer | `native/src/constants.hpp` `SSB_*` | 300 / 2850 Hz, 5 / 1000 ms, ×0.5 |
