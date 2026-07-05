# Kerchunk Go — Car-Device Hardware Feasibility Study

> **STATUS (2026-07-05):** research study, no hardware built yet. This is the
> feasibility layer for the tiny in-car scanner described in
> [`Kerchunk Vision.md`](Kerchunk%20Vision.md) — updated for what the operator
> actually wants in 2026: a handful of NBFM channels (2m/70cm ham + NOAA),
> no screen (or a 1.5" OLED at most), Bluetooth Classic A2DP + AVRCP channel
> metadata direct to the car head unit, powered from a standard car USB port,
> as small as possible. Personal device first; product thinking later.
> Companion sizing tool: [`bench/go_dsp_budget.py`](../bench/go_dsp_budget.py).

## TL;DR

**Yes, a device dramatically smaller than the Pi Zero 2 W stack is feasible —
but only by giving up wideband parallel monitoring.** The two requirements
that actually size this device are not CPU: they are **USB 2.0 High-Speed
host** (to feed an RTL-SDR ~4.8 MB/s of I/Q) and **Bluetooth Classic BR/EDR**
(A2DP is a Classic profile; no BLE radio can ever do it, and automotive LE
Audio is still vaporware in 2026). Raw DSP arithmetic is comfortably available
on everything down to a microcontroller — `bench/go_dsp_budget.py` shows even
an ESP32-P4 fits a 12-lane channelizer at 2.4 MS/s inside ~54% of its SIMD
budget. The constraint lattice sorts every candidate into three tracks:

| Track | Architecture | Wideband? | Size | Car USB | Verdict |
|---|---|---|---|---|---|
| **A — tiny serial** | ESP32 + 2× SA818S NBFM modules | No (serial scan, ~25–50 ch/s) | ~½ the Pi stack's volume; matchbox + SMA | **Any port ever made** (~120 mA avg) | **GO — build this first** |
| **B — wideband Linux** | Pi Zero 2 W + RTL-SDR (per the vision doc) | Yes (2.4 MHz window) | Playing-card stack, 75–120×30×15 mm | 1.5 A+ charge port or lighter-socket adapter only | Viable, known-good, **not smaller** |
| **C — wideband MCU** | ESP32-P4 + RTL-SDR + BT audio chip | Yes (proven to 2.0 MS/s!) | Could eventually beat Track A with a bare-module SDR | Middling (~450 mA) | **Credible v2** — real prior art exists, but 3-chip BT audio and novel channelizer work |

**Recommended path:** Sprint 0 de-risks the one component every track shares —
ESP32-class Bluetooth A2DP + AVRCP metadata against your actual head unit —
for about $10. Sprint 1 benchmarks SA818 scan-hop latency (a number nobody on
the internet has published). Sprint 2 integrates the Track A prototype. Track
B remains the zero-invention fallback; Track C is the "smallest wideband
device possible" future once Track A proves the product.

---

## The two binding constraints

**1. USB 2.0 High-Speed host.** An RTL-SDR at 2.4 MS/s streams ~4.8 MB/s over
a bulk endpoint — 40× what a Full-Speed (12 Mbps) host can carry. This
eliminates classic ESP32, ESP32-S2/S3, and RP2350 (FS-only) from the SDR path
outright. (Escape hatch: the RTL2832U's valid rate range includes
225–300 kS/s, and driving one at 240–300 kS/s from a Full-Speed ESP32-S2 has
actually been done by the [xtrsdr](https://github.com/XTR1984/xtrsdr) project
— a ~250 kHz "mini window" covering one repeater cluster. Interesting, but it
buys neither track anything today.)

**2. Bluetooth Classic (BR/EDR).** A2DP + AVRCP are Classic profiles.
Consequences that shaped everything below:

- Every Espressif chip after the original ESP32 (S2, S3, C3, C6, P4) is
  BLE-only. **The 2016-era original ESP32 is the only MCU in the mainstream
  hobby ecosystem with BT Classic**, and it's still in production with an
  official A2DP-source API.
- LE Audio/Auracast in cars: still demo-stage in 2026; no head unit lineup
  ships a BAP sink. A2DP direct-to-dash means BR/EDR, full stop.
- On the Linux side, the only same-footprint boards with *proven* BlueZ A2DP
  source are the Broadcom/AMPAK-radio boards — i.e. the Pi Zero 2 W. The
  faster clones (Radxa Zero 3W's AIC8800, Orange Pi Zero 2W's UWE5622) have
  documented BT bring-up failures and **zero published A2DP success reports**.

**Not a constraint: compute.** The `go_dsp_budget.py` paper model (MAC/s of
the mix + polyphase FIR + demod chain vs. derated sustained platform
throughput) puts a 12-lane 2.4 MS/s channelizer at ~644 MMAC/s — 11% of a
Pi Zero 2 W, 54% of an ESP32-P4, 43% of a single RV1106 Cortex-A7. Field
evidence agrees: [RTLSDR-Airband](https://github.com/rtl-airband/RTLSDR-Airband)
runs an 8-channel NFM/AM channelizer at full dongle bandwidth in <15% of a
Pi 3 and ~50% of a dual Cortex-A7 @ 1 GHz using hand-written NEON. The kiosk's
GNU Radio flowgraph is heavy; the *math* is not.

---

## Track A — ESP32 + SA818S serial scanner (recommended first build)

### Architecture

```
2m/70cm dual-band whip (SMA)
        │
   VHF/UHF diplexer (~$15, doubles as band filtering)
    │             │
SA818S-V       SA818S-U          134–174 MHz (2m + NOAA) / 400–480 MHz (70cm)
(UART1, SQ→GPIO) (UART2, SQ→GPIO)  PTT strapped high = physically RX-only
    │ analog AF     │ analog AF
    └────┬──────────┘
    audio mux / codec ADC (I2S)
         │
      ESP32 (original, WROOM-32)
      · scan scheduler (S+ probes / RSSI? polls, SQ-pin interrupts)
      · BT Classic A2DP source → car head unit (SBC, 44.1 kHz)
      · AVRCP TG → "146.520 — KC0ABC" as track title (see risk #1)
      · BLE GATT server → phone config app (BTDM coexistence is supported)
         │
      USB-C, 5 V, any car port
```

### Why this shape

- **One SA818 covers one band.** Despite the dual-band RDA1846S die inside,
  each module's PA/LNA/filtering is band-split: SA818-V = 134–174 MHz (2m
  *and* NOAA 162 MHz ride the same module), SA818-U = 400–480 MHz (70cm). Two
  modules also buy a better scanner: park VHF on priority (NOAA + favorite
  repeater) with its squelch pin armed as a hardware interrupt while UHF
  round-robins, then swap roles. ~$8–14 each, 35.6×19×3.2 mm, actively
  manufactured (NiceRF added CE and "Pro" +4 dB LNA variants), RX draw 60 mA.
- **Scanning is host-driven and fits the need.** The UART command set has a
  purpose-built scan probe (`S+<freq>` → carrier yes/no) plus `RSSI?`
  readback (SA818/868; not the old Dorji DRA818) and a squelch-detect output
  pin. Estimated hop cost is a ~18 ms UART floor + PLL/measure settle ≈
  **40–80 ms/probe → ~12–25 ch/s per module, ~25–50 ch/s aggregate** — a
  BC125AT does 80 ch/s, and for a 5–15 channel list the full-cycle revisit is
  sub-second. **Nobody has published a measured number; Sprint 1 measures it.**
  If stock firmware proves too slow, [OpenRTX sa8x8-fw](https://github.com/OpenRTX/sa8x8-fw)
  reflashes the module for raw AT1846S register access (~10–30 ms/hop class).
- **Sensitivity is a genuine *upgrade* over the RTL-SDR in a car.** SA818
  class: −122 dBm (12 dB SINAD), Pro variant ≈ −126 dBm — better than the
  BC125AT's 0.3 µV spec, with real band front-ends and hardware squelch. An
  unfiltered 8-bit RTL-SDR in a mobile RF environment (broadcast FM, paging,
  cellular) needs added filtering to compete.
- **Power: works on any car USB port ever made.** ~110–130 mA average,
  ~250–300 mA worst case at 5 V — >40% margin inside even a legacy 500 mA
  head-unit data port. Espressif's own measurement for A2DP streaming is
  ~103 mA avg at 3.3 V.
- **Automotive robustness is free.** ESP32 is rated −40…+85 °C (a Kansas
  dashboard soak is survivable; the Pi is rated to +70 °C and the R820T2
  demonstrably loses PLL lock when hot). No filesystem to corrupt at
  ignition-cut — config lives in NVS flash with atomic writes. Cold boot to
  audio ≈ 1–3 s (BT reconnect dominates).
- **Existing proof points:** LilyGO's T-TWR Plus is a commercial ESP32-S3 +
  SA868 board (the OpenEdition is the natural dev platform for the sa8x8-fw
  experiment); ESP32 + two SA818s wiring is proven (Simple FM Repeater);
  AllStar node builds document the audio/COS interface at scale;
  [pschatzmann/ESP32-A2DP](https://github.com/pschatzmann/ESP32-A2DP) +
  live-I2S-input A2DP source projects cover the audio path.

### The two real risks (both live in Bluetooth, not RF)

1. **AVRCP metadata — "channel name on the dash" — is NOT in stock ESP-IDF.**
   The AVRCP Target role on ESP32 can't answer `GetElementAttributes` (no API
   exists) and whitelists only volume-change notifications, so a head unit
   asking "what's playing?" gets nothing. It **has been done** by patching
   Bluedroid's `bta_av_act.c` to serve title strings — demonstrated once on
   the Espressif forum ([t=13751](https://www.esp32.com/viewtopic.php?t=13751)),
   never packaged as a library. Kerchunk Go would carry that patch, plus a
   TRACK_CHANGED unlock so the head unit re-queries on every channel hit.
   **Fallback if it won't generalize: Microchip BM83 module** (~$13,
   UART-controlled, A2DP source + AVRCP 1.6 TG per datasheet, I2S input) as a
   dedicated BT audio chip next to the ESP32.
2. **Head-unit pairing compatibility.** ESP32 A2DP source is proven against
   speakers; car head units have documented failure modes (legacy PIN-code
   pairing, [esp-idf #12334](https://github.com/espressif/esp-idf/issues/12334),
   closed without a public fix; "pairing mode first" quirks). Auto-reconnect
   on ignition is app-side logic with per-head-unit tuning. This is exactly
   why Sprint 0 exists — test against *your car* before anything else.

Also known: A2DP end-to-end latency is 200–500 ms (SBC + head-unit jitter
buffer). Same class as the aftermarket BT dongles hams already tolerate; push
the AVRCP metadata at squelch-open so the dash leads the audio. Keep Wi-Fi
off while streaming (BR/EDR + Wi-Fi coexistence is the known-bad combo;
A2DP + BLE GATT together is fine).

### Rejected/deferred front-end options

- **Bare AT1846S chip** (one $2 chip, both bands, I2C, ~10–30 ms hops): this
  is rebuilding [HamShield](https://github.com/EnhancedRadioDevices/HamShield)
  — RF layout, 12.8 MHz reference, matching, band switching — to save $10 and
  a few cm². Wrong trade for a one-off; right trade only if a custom PCB run
  happens anyway (v2).
- **Quansheng UV-K5 gutted as receiver** (BK4819: 18–660 MHz RX, huge open
  firmware scene): legitimate plan B — a $25 radio donates the whole RF
  section — but means owning custom firmware on the K5's MCU.
- **Si4732/35:** confirmed out — FM is broadcast-band (64–108 MHz) only.
- **CC1101:** confirmed out — packet-data only, no analog FM voice path, and
  doesn't even cover 144/162 MHz.

### Estimated BOM (personal build)

| Item | Cost |
|---|---|
| ESP32-WROOM-32 devkit (later: bare module) | $6–10 |
| 2× SA818S (-V, -U) | $20–28 |
| I2S codec/ADC (PCM1808 or ES8388 board) | $5–8 |
| VHF/UHF diplexer | $15 |
| Dual-band mag-mount whip (Nagoya UT-72 class) | $25 |
| USB-C power/misc/PCB | $10 |
| **Total** | **~$80–95** (≈$55 without antenna) |

Size estimate: a single stacked PCB ~45×30×15 mm plus SMA — half the volume
of the Pi Zero 2 W sandwich, no dongle protruding, nothing socketed.

---

## Track B — wideband Linux (the vision-doc architecture, re-verified)

The core question was "is there anything smaller than a Pi Zero 2 W that can
do this?" After sweeping the 2025–2026 small-Linux-board landscape: **no.**

- **Boards smaller than 65×30 mm with USB-HS host exist (Luckfox Pico
  RV1103/RV1106 class, Milk-V Duo, LicheeRV Nano) but none has BT Classic**,
  and adding it costs a USB hub + dongle (bigger than the Pi) or a UART-HCI
  combo module on a custom carrier (a v2-scale project). Their single
  ~1 GHz cores could run a hand-written 4-lane channelizer (~43% of an A7 by
  the budget model; RTLSDR-Airband's Cubieboard2 datapoint agrees) but BlueZ
  on their uClibc buildroot SDKs is documented pain, and no one has ever
  published RTL-SDR running on an RV1106.
- **The two near-misses, for the record.** The NanoPi NEO Air (40×40 mm,
  quad-A7, AP6212 — the same Broadcom BT-Classic family as the Pi) is the
  *only* smaller board with battle-tested A2DP silicon, but it's a 2016
  design at ~$36 that buys ~18% board area for more heat and DIY-soldered
  USB host pads — a marginal win, not a category change. The Milk-V Duo S
  (43×43 mm, A53, USB-A host, nominal "BT5") is tantalizing on paper, but
  its Bluetooth doesn't even enumerate an `hci0` on shipped images. And the
  freshly-announced **Raspberry Pi CM0** (the Zero 2 W's RP3A0 silicon as a
  ~$20 solder-down castellated module) is the honest future answer to
  "smaller wideband Linux": same proven SDR + BlueZ A2DP stack on a custom
  carrier sized exactly to this product — a v2 PCB project, not a first
  build.
- **Same-size-but-faster clones lose on the one thing that matters.** Radxa
  Zero 3W (RK3566, 4×A55@1.6 GHz, up to 8 GB): real CPU/RAM/USB upgrade, but
  the AIC8800 BT driver is vendor-blob, frequently dead on boot, with zero
  A2DP success stories found, ~2 W idle (3–4× the Pi), and it throttles bare
  within minutes. Orange Pi Zero 2W (H618 + UWE5622): BT sometimes takes
  "10–15 reboots" to enumerate. The Pi Zero 2 W's BCM43436 is the only radio
  in the footprint with boring, works-first-boot BlueZ A2DP source — and the
  AVRCP metadata story on Linux is *solved* (BlueZ `Media1.RegisterPlayer` /
  `mpris-proxy` serves title/artist to the head unit; a small Python player
  registration is all Kerchunk needs).
- **Corrections to the vision doc, from this research:**
  - **Suspend-to-RAM on the Pi Zero 2 W does not exist and never will**
    ([raspberrypi/firmware#1635](https://github.com/raspberrypi/firmware/issues/1635):
    the VPU is the bootloader; there is no resume path). The vision doc's
    "primary plan" (M1.5) is dead. The good news: it doesn't matter — most
    car USB ports cut power at ignition-off anyway, so the design point is
    **fast cold boot + read-only rootfs**, both proven: 3.5–8 s trimmed
    boots are documented on Zero 2 W-class hardware, and an automated rig
    survived 2,100+ random power cuts on RO-root with zero failures.
  - **Power: a legacy 500 mA port cannot host this track.** Measured stack
    draw is ~400–460 mA sustained (Pi 100–180 idle/250–350 working + V3
    dongle 270–280) with 700–900 mA peaks; the Pi's undervolt threshold
    (4.63 V) trips on thin car wiring well before the amp limit. Design
    assumption: **BC1.2 1.5 A charge port, 15 W USB-C, or an included
    lighter-socket adapter.**
  - **Thermal is the quiet disqualifier for dash mounting.** Pi rated to
    +70 °C ambient; parked-car dashboards hit 69–71 °C; the R820T family
    self-heats to ~85 °C at *room* ambient and demonstrably loses PLL lock /
    drifts with heat. A Track B build wants a TCXO dongle (V3/V4), a
    footwell/console mount, and thermal mass — solvable, but it's real
    engineering the ESP32 track simply doesn't have.
  - **GNU Radio is optional.** RTLSDR-Airband proves a NEON channelizer at
    full dongle bandwidth costs <15% of a Pi 3; a lean C engine (or
    RTLSDR-Airband itself as the DSP core) makes the Zero 2 W comfortable
    where the kiosk's Python flowgraph would strain it. The existing
    `kiosk/bench/pi_dsp_bench.py` measures exactly this gap on real hardware.

**Verdict:** unchanged from the vision doc in shape, corrected in detail. It
is the zero-invention path and the only *today* path to wideband-in-the-car —
at playing-card size, on the right USB port, mounted out of the sun.

---

## Track C — ESP32-P4 + RTL-SDR (the wildcard that turned out to be real)

The research surprise: **MCU-hosted RTL-SDR is not hypothetical.**

- [tab5-sdr](https://github.com/hardparking/tab5-sdr) is a complete standalone
  receiver on the M5Stack Tab5 (ESP32-P4): librtlsdr ported onto ESP-IDF's
  USB host stack, PSRAM I/Q ring, NFM/WFM demod, FFT waterfall, squelch, I2S
  audio — running at 1.152 MS/s. GPL, forkable today; a Tab5 ($55–60) + dongle
  reproduces it with zero hardware work.
- [xtrsdr](https://github.com/XTR1984/xtrsdr) sustains **2.0 MS/s (4.0 MB/s)
  of RTL-SDR bulk-IN on a P4** while re-streaming over rtl_tcp.
- Compute: P4's PIE SIMD is integer-only but strong (~490M 16-bit MAC/s/core
  measured via esp-dsp benchmarks); a fixed-point polyphase channelizer for
  4–12 NBFM lanes fits in one core with the second free for USB/audio/control.
  The channelizer itself is novel work — no GNU Radio safety net — call it
  2–4 careful sprints beyond the single-channel fork.
- **The gap is, again, Bluetooth Classic.** P4 has no radio; its standard
  companion (ESP32-C6) is BLE-only. The paths: (a) three-chip design — P4 +
  C6 + original ESP32 as BR/EDR controller (Espressif ships a Hosted-HCI
  Bluedroid example proving Classic profiles from a P4, though not A2DP
  source specifically), (b) P4 → I2S → original ESP32 running the whole A2DP
  stack (lowest risk), or (c) P4 + BM83 module. Every one of these reuses the
  exact BT work Track A does first — which is why Track A isn't a detour;
  it's Track C's Sprint 0 and 1.

**Verdict:** the credible "tiniest wideband Kerchunk" — a custom P4 + bare
RTL2832U/R828D module + ESP32/BM83 board could eventually undercut even Track
A's volume while keeping parallel monitoring. Not the first build: it stacks
novel DSP + a 3-chip BT story on top of every unproven-in-car risk. Revisit
after Track A ships and if the serial compromise starts to chafe.

---

## Cross-cutting: the car as an environment

| Question | Answer | Design consequence |
|---|---|---|
| What can car USB ports deliver? | Legacy data ports: 500 mA (some 100 mA pre-enumeration). BC1.2 charge ports: 1.5 A. Factory USB-C: typically 5 V/3 A, PD rare. Same car often mixes all three. | Track A targets "any port"; Track B ships with a 2.4 A lighter adapter and says so. |
| Do ports stay hot at ignition-off? | Varies wildly (hard-off, minutes of retained power, always-on). | Treat power-cut-as-normal: cold-boot every drive; deep-sleep politely in always-on cars. No suspend dependency. |
| Hardwire 12 V instead? | Raw automotive 12 V carries load-dump/cold-crank transients (ISO 7637). | Don't. A quality lighter-socket USB adapter is a pre-certified automotive buck. Stay a 5 V USB device. |
| Parked-car heat? | Dashboards: ~70 °C measured; cabin air ~47 °C. | ESP32 (+85 °C) fine; SA818 rated to +70/85; Pi (+70 °C) + R820T2 marginal on the dash — mount low, TCXO mandatory. |
| Boot-to-audio budget? | Track A: ~1–3 s (BT reconnect dominates). Track B: 5–8 s with a trimmed Buildroot image (3.5 s heroic), 20–45 s stock. | Track A wins the "car starts → scanner's on" feel for free. |
| Receive-only legality | RX-only device, PTT strapped high on Track A (cannot key up). Personal-use build has no certification burden; a future product needs FCC Part 15B like any receiver (see vision doc §regulatory). | No change to personal-first plan. |

---

## Hardware design sprints

Protocols in the spirit of `bench/README.md` — each with a pass gate and a
failure decision, ordered so the cheapest test kills the biggest risk first.

### Sprint 0 — Bluetooth truth test (1 weekend, ~$10, no radio hardware)

*De-risks every track at once: the head unit is the least-controllable
component in the system, and both A and C stand on ESP32-class A2DP.*

**Hardware:** any ESP32-WROOM devkit; your actual car; one spare BT speaker;
ideally one borrowed second car.

1. Flash the ESP-IDF `a2dp_source` example (or ESP32-A2DP library) streaming
   a generated tone/sample loop. Pair with the BT speaker — baseline.
2. Pair with your car head unit. Document the pairing dance (PIN? SSP?
   pairing-mode-first?).
3. Ignition-cycle auto-reconnect test: 20 cycles, measure time-to-audio,
   count failures. (App-side reconnect logic: aggressive direct connect to
   bonded MAC for 60 s + stay connectable.)
4. Apply the Bluedroid AVRCP-TG patch (per esp32.com t=13751): serve a track
   title, unlock TRACK_CHANGED, update the title every 10 s. Does the dash
   display it? Does it *refresh*?
5. Run A2DP + a trivial BLE GATT server simultaneously; confirm no audio
   glitches.

**Pass:** stable audio + auto-reconnect ≥18/20 + title visible and refreshing
on your head unit.
**Fail on audio/pairing:** order a BM83 EVB and rerun steps 2–4 over UART
control — decision point between "ESP32 does BT" and "BM83 does BT."
**Fail on metadata only:** decide whether dash text is a must-have; BM83
fallback or ship without it.

### Sprint 1 — SA818 scan-latency bench (1 weekend, ~$30)

*Produces a number that exists nowhere on the internet and sizes the whole
scan scheduler.*

**Hardware:** one SA818S-V breakout, the Sprint 0 ESP32, logic analyzer (or
just `esp_timer` instrumentation); local 2 m repeater + NOAA as live signals.

1. Wire UART + SQ pin + PD + PTT-high (RX-only). `AT+DMOCONNECT` handshake.
2. Measure, over 1,000 iterations each: `S+<freq>` round-trip (quiet channel
   vs active channel), `RSSI?` round-trip, `AT+DMOSETGROUP` park time, SQ-pin
   assertion latency after a carrier appears (key up an HT on low power into
   a dummy load nearby).
3. Script a 10-channel scan list (2 m + NOAA); measure full-cycle revisit
   time and first-syllable clipping on a real repeater kerchunk.
4. Audio: AF_OUT → coupling cap → codec/ADC → headphones. Judge noise floor,
   de-emphasis settings (`AT+SETFILTER`), level into the ESP32 I2S path.

**Pass:** ≤150 ms/probe (→ ≤1.5 s revisit at 10 channels), clean audio, SQ
interrupt reliable.
**Fail on hop speed:** try `RSSI?`-based probing, then the OpenRTX sa8x8-fw
reflash (raw register hops) on a LilyGO T-TWR Plus OpenEdition before
abandoning the module route.

### Sprint 2 — Track A integration prototype (1–2 weeks)

**Hardware:** Sprint 0 + Sprint 1 pieces, second SA818S (-U), diplexer,
dual-band whip, codec board, USB-C breakout.

1. Two-module scheduler: VHF parks on priority (NOAA/favorite) with SQ
   interrupt; UHF round-robins; swap roles on activity. Wire both AF_OUTs
   through the mux/codec.
2. Full pipeline in the car: scan → squelch-open → audio on car speakers +
   channel name on dash. Measure end-to-end latency (RF keyup → speaker).
3. Power: measure at the USB-C input (idle / scanning / streaming) on a USB
   meter; verify on the car's weakest port.
4. Thermal soak: closed car, sunny afternoon, device on dash logging a
   temp sensor; verify function at peak and after cool-down.
5. 30-day daily-driver burn-in. Log every missed transmission, reconnect
   failure, and annoyance.

**Pass:** the 95% use case from the vision doc — car starts, audio in ≤5 s,
kerchunks arrive un-clipped, dash shows the channel — for a month.

### Sprint 3 (optional, parallel) — Track C spike (~$75)

M5Stack Tab5 + RTL-SDR V4: fork tab5-sdr, add a second NFM lane and a
fixed-point 4-lane channelizer at 1.024 MS/s, feed audio out over I2S to the
Sprint-0 ESP32 as A2DP. Success = 4 channels monitored in parallel on
MCU-class hardware with car audio. This is the future-product scout, not the
personal-device critical path.

### Track B fallback (already documented)

The original `bench/01…03` M1 protocol (Pi Zero 2 W + dongle + bluez-alsa)
remains valid as-written, with three amendments from this study: skip M1.5
(suspend-to-RAM is unsupported — go straight to fast-boot + RO rootfs),
require a TCXO dongle, and test on a BC1.2/USB-C port or lighter adapter,
never a 500 mA data port. Run `kiosk/bench/pi_dsp_bench.py` on the Pi to size
lanes before committing to GNU Radio vs an RTLSDR-Airband-style C engine.

---

## Decision summary for the operator

- **"Can we use something smaller than a Pi Zero 2 W?"** Yes — Track A is
  roughly half the volume, cheaper, tougher, and instant-on, by trading
  wideband parallel monitoring for ~25–50 ch/s serial scanning across your
  handful of channels. For wideband, nothing smaller than the Pi exists
  today with a working BT Classic story; the ESP32-P4 path (Track C) is the
  first realistic future exception.
- **"Can standard car USB power it?"** Track A: any port, including 500 mA
  legacy ports. Track B: only charge-class ports (1.5 A BC1.2 / USB-C) or a
  lighter-socket adapter. Track C: comfortably inside 1 A.
- **"Small AND powerful — is it feasible?"** The tension is real but it has
  a seam: *small + serial* is easy (Track A), *big-ish + parallel* is proven
  (Track B), and *small + parallel* (Track C) is genuinely emerging — the
  hard half (RTL-SDR on a microcontroller) is already public GPL code; what
  remains is the channelizer and the BT audio chip, both of which Track A's
  sprints de-risk anyway. Build A now; let C ripen.

## Source notes

Full citations live in the research transcripts backing this doc; the
load-bearing ones are linked inline. Key unverified numbers called out as
estimates: SA818 `S+` hop latency (Sprint 1 exists to measure it), BM83
UART-settable AVRCP title strings (verify on EVB before relying on it),
ESP32 A2DP-source average draw in *source* role (datasheet-derived).
