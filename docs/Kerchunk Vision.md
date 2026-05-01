---
title: "Kerchunk — Product Vision"
created: 2026-04-16
updated: 2026-04-16
vault: Tism
topic: kerchunk-vision
---
Summary:: A pocket-sized Bluetooth scanner brain PCB that turns an RTL-SDR dongle into a headless, car-optimized analog and P25 scanner with parallel channel monitoring.
Next:: Decide whether to prototype. Validate ESP32-S3 USB OTG host + librtlsdr + A2DP concurrency before committing to PCB design.
Context:: Emerged from an April 2026 hyperfocus cycle on ham radio hardware gaps. Scanner category hasn't been meaningfully rethought since the Uniden BC125AT (2002). Kerchunk addresses that by reframing scanning as a parallel-SDR problem rather than a serial-hardware problem. Build intent is "decide later" — this doc captures the thinking so the decision is informed whether it's made in a week or a year.

---

# Kerchunk

> *Kerchunk: ham radio slang for briefly keying up a repeater to verify it's there. The sound a repeater makes when someone checks in without saying anything. Also: what this scanner does continuously, across every channel in your list, simultaneously.*

A bare PCB kit that turns any RTL-SDR dongle into a Bluetooth car scanner. Pocket-sized. No screen. No speaker. No buttons. Pairs with your car's stereo, streams audio over Bluetooth, displays channel metadata on your head unit. Monitors multiple channels in parallel. Built for hams and scanner hobbyists who want something the commercial market hasn't made in 20 years.

---

## Why this exists

The handheld scanner market has not meaningfully evolved since the Uniden BC125AT launched in 2002. The SDS100 (2018) added P25 Phase 2 and a color screen but kept the same industrial design language: rubberized body, numeric keypad, dot-matrix display, 3.5mm headphone jack, proprietary programming cable. Scanning remains a serial operation, cycling through channels one at a time, with a 10ms gap on each that occasionally clips the first syllable of brief transmissions.

Meanwhile, everything around the scanner has changed. Car stereos support Bluetooth audio with metadata display. Ham operators carry phones that can configure radios over BLE. RTL-SDR dongles exist for $25 and can capture 2.4 MHz of spectrum continuously, making parallel channel monitoring architecturally trivial. Power, audio, and data all converge on USB-C.

No scanner integrates any of these. The BC125AT still uses a proprietary USB-miniB programming cable, a speaker grille that rattles, and a physical keypad optimized for 2008 thumb ergonomics. It costs $130.

Kerchunk is the product that admits it's 2026.

### The core architectural insight

Traditional scanners scan. They hop from frequency to frequency, checking each in sequence, which means at any moment they're listening to exactly one channel. When they land on an active channel, they stop. When the transmission ends, they resume scanning. This is why you miss transmissions on adjacent channels — the scanner is busy elsewhere.

An SDR doesn't scan. It captures a wide slice of spectrum continuously and demodulates channels in software. Within a 2.4 MHz window, it can monitor 4 to 24 channels simultaneously depending on processor headroom. The concept of "scan speed" dissolves — there is no scanning, just listening.

For typical US ham repeater layouts, this is an architectural match. Most metros cluster their repeaters into 2-5 band windows of 2.4 MHz each. Kansas City's 17 analog repeaters fit in 3 windows. Seattle's 21 fit in 5. Chicago's 32 fit in 4. Even Los Angeles with 309 repeaters fits in 11 windows, though with real demodulator pressure in the densest 70cm slice. For rural areas like Manhattan KS (3 repeaters, 2 windows), the entire channel list can be monitored continuously with zero cycling.

This is the feature no hardware scanner can offer. It's not a better version of the BC125AT's architecture — it's a different architecture entirely.

### Why this audience, why now

The target user is a ham operator or scanner hobbyist who:
- Already owns at least one RTL-SDR dongle (roughly 400,000 sold globally; the r/rtlsdr subreddit has 80,000+ members)
- Drives regularly and would benefit from hands-free Bluetooth audio
- Runs homebrew projects on ESP32, Raspberry Pi, or Arduino
- Shops at Mouser, Digi-Key, LCSC, or directly from Nooelec
- Reads Hackaday, follows QRP Labs, has a Tindie wishlist
- Is frustrated by commercial scanner UX but hasn't found a better option

This audience is well-served by forums and specialty retailers and catastrophically underserved by product design. Every project they currently use is either a laptop-tethered software setup (SDRTrunk, SDRsharp) or a firmware mod to cheap Chinese radios (Quansheng UV-K5). Nothing sits in the middle: a purpose-built, small, portable, daily-drivable scanner that uses modern interfaces.

Kerchunk fills that gap.

---

## What it is

A bare PCB kit, approximately 45×30mm, centered on an ESP32-S3 microcontroller. A USB-A socket on one edge accepts a Nooelec Nano 3 RTL-SDR dongle (17×20×8mm, aluminum-cased, 0.5 PPM TCXO, recommended but any R820T2-based dongle works). A USB-C port provides power. An optional 3.5mm TRS jack supports wired audio output alongside the primary Bluetooth path.

Assembled with the Nano 3 plugged in, the final footprint is roughly Tic Tac box sized (~55×30×12mm). A 3D-printed or injection-molded case unifies the two pieces into a single unit with the SMA antenna connector exposed on one side.

### The user's product experience

The user receives the PCB (optionally pre-assembled, optionally bundled with a Nano 3 and a case). They plug the dongle into the USB-A socket and connect power via USB-C. They pair their phone and their car stereo with the scanner's Bluetooth identity. They open the companion iOS or Android app and either import a channel list (RepeaterBook CSV, Chirp-compatible format, or manual entry) or pick from curated presets for their area. The app displays the channel list, lets them tag priority channels, and uploads the configuration over BLE.

From that point forward, the scanner runs headlessly. In the car, they pair it with their head unit as a Bluetooth audio source. The head unit's track display shows the current active frequency's alpha tag and frequency. When a transmission ends, the display reverts to a scanning indicator. When the car is off, the scanner powers down. When the car is on, it resumes where it left off.

No screen. No buttons. No headphone jack to break. No proprietary programming cable. No firmware CDROM. No fighting with Uniden's Windows software that hasn't been updated since 2014.

### Product tiers

**Base — Kerchunk Classic.** ESP32-S3 only. 4-6 parallel channels within the active 2.4 MHz window. Analog FM/NFM/AM demodulation. Covers 25-1750 MHz via the RTL-SDR. Sufficient for 95% of US ham operators and non-trunked scanner users. Target retail: $50 kit, $80 with Nano 3 bundle, $110 assembled-with-case.

**Pro — Kerchunk Delta.** STM32H743 primary DSP plus ESP32-S3 Bluetooth coprocessor. 16-24 parallel channels. P25 Phase 1 digital decoding via open-source mbelib-neo. Targets dense metros (LA, NYC, SF Bay, Chicago, DFW) and public-safety monitoring. Target retail: $100 kit, $130 with Nano 3, $160 assembled-with-case.

The Pro variant's name "Delta" references the callsign letter D (for Digital, for Decoder) and carries phonetic weight without cuteness. Classic and Delta feel like siblings in a product family.

---

## Hardware architecture

### Block diagram — Base (Classic)

```
                  ┌─────────────────────────────┐
                  │   Antenna (SMA)             │
                  └──────────┬──────────────────┘
                             │
                  ┌──────────▼──────────────────┐
                  │   Nooelec Nano 3 RTL-SDR    │
                  │   R820T2 tuner + RTL2832U   │
                  │   0.5 PPM TCXO              │
                  └──────────┬──────────────────┘
                             │ USB 2.0 (I/Q stream,
                             │  2.4 MSPS, 8-bit complex)
                  ┌──────────▼──────────────────┐
                  │   USB-A Host Socket         │
                  └──────────┬──────────────────┘
                             │
                  ┌──────────▼──────────────────┐
                  │   ESP32-S3-WROOM-1-N8R2     │
                  │   Dual-core @ 240 MHz       │
                  │   8 MB PSRAM, 8 MB Flash    │
                  │                             │
                  │   Core 0: USB host + SDR    │
                  │           driver + FFT      │
                  │   Core 1: Parallel demod +  │
                  │           A2DP + BLE config │
                  └──────┬─────────────┬────────┘
                         │             │
         ┌───────────────┘             └──────────────┐
         │                                            │
  ┌──────▼────────┐      ┌──────────────┐     ┌──────▼──────┐
  │  Bluetooth    │      │  I²S Codec   │     │  USB-C       │
  │  Classic +    │      │  (optional   │     │  Power +     │
  │  BLE radio    │      │   3.5mm jack)│     │  Config      │
  │  (on-chip)    │      └──────────────┘     │  Storage     │
  └───────────────┘                            └──────────────┘
```

### Block diagram — Pro (Delta)

Same as Classic, but with an additional STM32H743 Cortex-M7 processor between the RTL-SDR and the ESP32-S3. The STM32 handles the heavy DSP (FFT, C4FM demod, P25 framing, IMBE vocoding) and passes decoded audio to the ESP32-S3 over I²S. The ESP32-S3 is reduced to its best-at role: Bluetooth coprocessor plus companion app interface.

### Component rationale

**ESP32-S3-WROOM-1-N8R2** (~$4.50 at qty 100): Only hobbyist-accessible part with mature Bluetooth Classic (A2DP source + AVRCP target) plus BLE concurrent, USB OTG host capability, DSP-capable dual-core with vector extensions, and 8 MB external PSRAM for I/Q buffering and channel list storage. Modular FCC certification already done. ESP32-C6 is BLE-only (no Classic). Nordic nRF parts are BLE-only. The S3 is the only answer for Bluetooth Classic hobbyist work.

**Nooelec Nano 3 RTL-SDR** (~$30-35 retail, recommended): R820T2 tuner with 25-1750 MHz range, 0.5 PPM TCXO for drift-free operation, 2.4 MHz sampling bandwidth, aluminum enclosure for automotive thermal management. Nooelec's own marketing language positions this product for "EMI sensitive environments like automotive applications" — they've already validated the automotive use case. Any R820T2-based RTL-SDR works; the Nano 3 is the reference dongle for its thermal and TCXO specs.

**STM32H743VIT6** (Pro only, ~$12): Cortex-M7 at 480 MHz with DSP extensions, FPU, 2 MB flash, 1 MB RAM. Only commonly-available MCU that can run full P25 Phase 1 decode (C4FM + Reed-Solomon + IMBE) in real-time alongside parallel channel monitoring. Mature open-source toolchain, cheap Blue Pill-class dev boards for prototyping.

**USB-A right-angle socket** (~$0.80): Accepts any standard USB dongle, right-angle orientation keeps the assembly flat.

**USB-C + PD controller** (~$0.50): Power only. No negotiation needed; 5V USB power is sufficient for the ESP32-S3 and the RTL-SDR combined (peak ~500mA).

**I²S audio codec** (WM8960 or similar, ~$2): Optional path for wired audio output via 3.5mm TRS jack. Kept cheap so it can be included by default rather than as an upgrade.

**Mass storage over USB-C**: The ESP32-S3's TinyUSB stack can expose a FAT32 mass storage device containing `channels.csv`, `config.json`, and firmware update files. User drops files in, unplugs, scanner restarts with new config. This is the fallback configuration path that works without the companion app.

### What's deliberately omitted

**No screen.** A 0.96" OLED would add $3 BOM, board area, a driver subsystem, and a firmware display abstraction layer. The phone is the screen. The car head unit is the screen. Keeping the scanner screenless is how it stays small and cheap.

**No speaker.** Bluetooth audio to car stereos and earbuds is universal. Every possible use case for on-device audio is solved better by a $15 Bluetooth speaker than by a tiny tinny scanner speaker. Wired 3.5mm is the fallback.

**No keypad.** The companion app is the keypad. This is the most audience-authentic choice: the r/amateurradio and r/rtlsdr users who want this product all carry phones and prefer app-based configuration.

**No battery on the base model.** USB-C power. The scanner is designed to live in a car (always on when engine runs) or on a desk (plugged in). Battery life is an obligation that requires charging circuitry, a battery holder, a power management IC, and firmware for state of charge — all of which add cost and complexity for a use case most users don't have. A battery pack version can be a later variant or a 3D-printed case add-on with a commodity LiPo pack.

**No built-in CTCSS/DCS encoder.** It's a scanner, not a transceiver. Receive-only, by design.

---

## Firmware architecture

This is the highest-risk portion of the design. It's also the least-prototyped. The following is a reasoned plan, not validated code.

### Real-time task map (Base / Classic)

ESP32-S3 has two Xtensa LX7 cores at 240 MHz. Task allocation:

**Core 0 (SDR pipeline):**
- USB host driver (TinyUSB + custom RTL2832U bulk endpoint handler)
- I/Q buffer management (ring buffer in PSRAM, 512KB)
- Real-time FFT on 2.4 MSPS I/Q stream (2048-point, every 10ms, via ESP-DSP library)
- Energy detection across FFT bins → triggers channel demod allocation

**Core 1 (demod + Bluetooth):**
- Parallel FM/NFM demodulators (up to 6 active)
- Squelch evaluation per demod
- CTCSS/DCS decoders per demod
- Audio buffer pre-squelch ring (400ms, per demod)
- Active demod audio mix and routing
- A2DP SBC encoder and stream
- AVRCP metadata updates
- BLE GATT server for companion app

**Shared:**
- PSRAM for channel list (up to 1000 channels), scan logs, config
- Wake-on-activity logic (power saving when no channels active for N seconds)
- OTA firmware update handler (over BLE or USB mass storage)

### Critical risk: does this fit on an S3?

**Honest answer: unknown.** No published project runs the full pipeline on a bare ESP32-S3. Individual pieces have been demonstrated:
- ESP32-S3 as USB host for other USB devices: proven
- ESP32 running librtlsdr-compatible drivers: partial, experimental projects exist
- ESP32-S3 A2DP source with AVRCP: proven (pschatzmann's library, ESP-ADF examples)
- ESP32-S3 running FFT at 2.4 MSPS: borderline, depends on implementation
- ESP32-S3 running multiple FM demodulators in parallel: theoretical

The integration of all of these simultaneously is the question. The first prototype milestone (see Prototyping Roadmap) is specifically designed to answer it.

**Contingency:** If the S3 can't handle the full base pipeline, three fallback options exist:
1. Reduce to 2-3 parallel demods instead of 6 (acceptable for most users, bad for LA)
2. Move to ESP32-P4 when widely available (newer Espressif chip with dedicated DSP, reduces risk)
3. Base model adopts the Pro architecture (STM32H7 + ESP32-S3), eliminating the two-tier distinction and pushing base price to $75-85

Option 3 is the safest but eliminates the $50 entry point. Decision comes after Milestone 1 prototyping.

### Rolling window scanning strategy

The parallel monitoring architecture creates a fundamentally different scanning model. Implementation:

**At channel list import time:**
1. Group channels by frequency proximity into 2.4 MHz windows
2. Compute window density (channels per window)
3. Weight window dwell times by density and priority settings
4. Identify "priority" channels (user-flagged for always-on monitoring)
5. Validate: total window count × base dwell time ≤ acceptable cycle time
6. If too many windows, surface suggestion to user: curate list or enable sparse-window skipping

**At runtime:**
1. Continuously monitor priority channels using dedicated demod slots (up to 4)
2. Remaining demod slots (2 on base, 12-20 on Pro) cycle through non-priority windows
3. Each window dwell: FFT the full 2.4 MHz, identify active channels via energy threshold, assign available demod slots to active channels in priority order
4. On squelch-close, free the demod slot
5. On window timeout, retune to next window (weighted by density)

**Firmware-exposed metrics (for companion app display):**
- Current cycle time (ms)
- Window occupancy (% of time each window is being monitored)
- Missed activity log (when more active channels than demod slots, which were skipped)
- Active demod slot count (real-time)

This transparency is genuinely novel. No hardware scanner tells you what it missed; they can't, because they don't know.

### Bluetooth audio pipeline and latency handling

A2DP SBC has 150-400ms end-to-end latency. This is inherent to Bluetooth Classic and car head units' jitter buffers. Kerchunk's strategy:

1. Maintain a continuous A2DP stream (never stop transmitting, fill gaps with comfort noise or silence)
2. Pre-buffer 400ms of RF audio per demod (ring buffer, overwritten when squelch stays closed)
3. On squelch open, flush the pre-buffer to A2DP stream first, then live audio
4. User experiences a constant ~300ms delay but never hears a clipped transmission start

This is the same trick aftermarket Bluetooth dongles use on BC125AT scanners. The ham/scanner audience already accepts 300ms latency from that workflow.

**Design note:** The AVRCP metadata update should happen at squelch-open, not at flush-complete, so the user sees "145.130 MHz — KC0KW" slightly before they hear audio. This keeps the head unit display responsive rather than laggy.

### Configuration pathways

Three ways to configure Kerchunk, in priority order:

**1. iOS/Android companion app over BLE (primary):** Full channel list management, priority tagging, window visualization, scan activity log, firmware updates. Written in Flutter for single-codebase iOS + Android support. Estimated 150-200 hours of dev time.

**2. Web Bluetooth config page (alternate):** A static HTML/JS page hosted on GitHub Pages. Users visit the URL in Chrome or Edge, pair the scanner over Web Bluetooth, configure. No installation required. Does not work on iOS Safari or iOS Chrome (no Web Bluetooth support). Good fallback for desktop users who don't want an app.

**3. USB-C mass storage CSV (fallback):** Plug the scanner into any computer via USB-C, it mounts as a disk, user edits `channels.csv` with any text editor or spreadsheet, saves, ejects, scanner reboots with new config. Works offline, no pairing required, no app needed. Compatible with Chirp-exported CSV format.

All three paths read and write the same underlying configuration file format. The app is the primary path but every user can fall back to USB mass storage if Bluetooth isn't working.

### Firmware update strategy

- OTA updates over BLE via the companion app (primary)
- USB-C mass storage drop-in firmware files (fallback)
- Dual-partition flash layout for safe rollback if update fails
- Semantic versioning, firmware pinned to hardware revision
- Public changelog, public roadmap

---

## User experience

### Primary use case: car scanner

User drives to work. Car starts, scanner powers on, auto-connects to car's Bluetooth (previously paired). Scanner resumes monitoring the channel list configured for the user's area. User hears no audio until a repeater activates; when one does, the car's speakers play the transmission and the head unit shows "145.130 MHz — KC0KW Gibbs Rd." User drives, listens, occasionally hears nets. Car stops, scanner sleeps. Car starts again tomorrow, same thing.

**This is the 95% use case.** Every design decision defers to making this work reliably.

### Secondary use cases

- **Desk monitoring:** Scanner plugged into a USB-C power supply on a desk, connected to Bluetooth earbuds or speakers, used while working.
- **Travel:** Scanner in a bag with earbuds, used on trips to monitor local repeaters without bringing a full radio.
- **Scanner test bench:** Scanner tethered to a laptop via USB-C (mass storage mode), used for quick channel list experimentation while testing.
- **Multi-scanner setup:** Multiple Kerchunks running in parallel, each configured for a different band or geographic area, via a central BLE app dashboard.

### First-time setup flow

1. Unbox PCB (and Nano 3 if bundled)
2. Plug Nano 3 into USB-A socket on PCB
3. Plug USB-C into any 5V power source (phone charger, car USB port, laptop)
4. LED indicates "discoverable" state
5. Open Kerchunk app on phone, scan for nearby devices, pair
6. App prompts: "First time setup. Where are you?" — user enters ZIP code or picks from map
7. App offers: "Import 17 local analog repeaters from RepeaterBook? [Yes] [Customize]"
8. User accepts. App uploads channel list via BLE.
9. App shows: "Setup complete. Pair Kerchunk with your car's Bluetooth to start scanning."
10. User pairs with car stereo, drives, hears activity.

**Time to first success: ~5 minutes from opening the box.**

### Channel management UX principles

- **Show the windowing.** Users see their channel list grouped by 2.4 MHz window with a per-window density indicator. This makes the architecture visible and educational.
- **Prioritize without penalty.** "Priority" channels stay continuously monitored. The app shows how many priority slots are used and available.
- **Help with curation.** When users import 100+ channels, the app suggests: "You have 12 channels that fall outside your main clusters. These add 2 seconds to your cycle time. Keep, deprioritize, or remove?"
- **Log what's missed.** Even if the hardware missed a transmission (too many active at once), log it. Users can review later and adjust priorities.

### Anti-patterns to avoid

- Don't require the app to operate. USB mass storage config is a first-class citizen.
- Don't hide the window architecture. Making it visible is educational and builds trust.
- Don't auto-optimize silently. Tell users when the app is changing their config.
- Don't blame the user when RF conditions are bad. Show sensitivity data and suggest an LNA.

---

## Pricing and positioning

### Target pricing

| SKU | Description | BOM (qty 100) | Target Retail |
|---|---|---|---|
| Classic Kit | PCB only | ~$17 | $50 |
| Classic Bundle | PCB + Nano 3 | ~$47 | $80 |
| Classic Assembled | PCB + Nano 3 + case | ~$58 | $110 |
| Delta Kit | PCB only (Pro) | ~$33 | $100 |
| Delta Bundle | PCB + Nano 3 | ~$63 | $130 |
| Delta Assembled | PCB + Nano 3 + case | ~$74 | $160 |

### Competitive landscape

| Product | Price | Scan Architecture | Bluetooth | Kerchunk Advantage |
|---|---|---|---|---|
| Quansheng UV-K5 | $25 | Serial | None | Parallel monitoring, automotive integration |
| Uniden BC125AT | $130 | Serial @ 100 ch/s | None | Parallel, car Bluetooth, pocket form factor |
| Uniden SR30C | $130 | Serial | None | Better coverage, modern UX, smaller |
| Uniden BCD325P2 | $380 | Serial | None | Parallel, $250 cheaper, P25 in Delta at $160 |
| Uniden SDS100 | $650 | Serial | None | Parallel, $490 cheaper (Delta), modern UX |
| SDRTrunk on laptop | Free | Parallel | N/A | Portable, standalone, no laptop required |
| kv4p HT | $90 DIY | N/A (transceiver) | No A2DP | Receive-only scanner specialization |

**Classic's competitive story:** You can get a BC125AT for the same price ($130 vs Classic Bundle at $80). But Classic is half the size, has parallel monitoring, works with your car's Bluetooth, and doesn't have a speaker to blow out in a hot car. For $80.

**Delta's competitive story:** You can get a BCD325P2 for $380 or an SDS100 for $650 to monitor P25. Or you can spend $130 on Delta Bundle and get parallel P25 monitoring in a device that fits in your center console, streams to your car stereo, and configures via your phone. Delta saves $250-$520 versus its direct competition.

### Audience segmentation

**Primary (first 100 units):**
- Active hams on r/amateurradio, r/rtlsdr, r/scanner
- Members of regional ham clubs who already mentor newer ops
- QRP Labs / (tr)uSDX / uBITX kit-building community crossover
- Tindie and Hackaday early adopters
- Expected: 60-80% Classic, 20-40% Delta

**Secondary (post-launch, after validation):**
- Non-ham public safety monitoring enthusiasts
- Aviation monitoring (airband via AM demod)
- Railroad monitoring
- ADS-B / AIS enthusiasts (crossover audience already owning dongles)

**Not targeted:**
- Professional / commercial scanner users (law enforcement, fire, EMS). They need tested, certified, warrantied hardware. Kerchunk is a hobbyist kit.
- International customers at launch. FCC compliance limits US sales initially; ETSI / IC equivalents come later if warranted.

---

## Risks and open questions

### Technical risks

**1. ESP32-S3 feasibility for full Base pipeline.** Highest-priority risk. Mitigation: Milestone 1 prototype validates this before PCB design. If it fails, Base becomes Pro-architecture ($75-85 entry) or waits for ESP32-P4 availability.

**2. Bluetooth audio latency in practice.** The 300ms pre-buffer approach is theoretically sound but untested in combination with AVRCP metadata timing. Risk: user experience feels laggy or metadata lags audio. Mitigation: Milestone 2 validates with real car head units.

**3. RTL-SDR sensitivity in fringe conditions.** RTL-SDR is noisier than a dedicated scanner superhet. Users in rural areas monitoring distant repeaters may be disappointed. Mitigation: recommend external LNA (Nooelec SAWbird, RTL-SDR Blog LNA) in documentation. Consider LNA as an accessory in later product waves.

**4. Car head unit AVRCP metadata compatibility.** AVRCP display behavior varies across head units. Some show only title, some truncate to 16 chars, some refresh slowly. Risk: marketing material promises "frequency shown on your dashboard" and some users see nothing. Mitigation: Milestone 2 tests across 5+ different car stereos and documents compatibility explicitly.

**5. Firmware scope creep.** The feature list grows naturally (trunked P25, DMR, POCSAG, digital voice ID, recording, etc.). Risk: never shipping because always adding features. Mitigation: ruthless v1 scoping to analog-only Classic first. Everything else is v2+.

### Regulatory risks

**1. FCC §15.101 certification requirement.** Even kit-form receivers may require FCC Part 15B testing when sold commercially in the US. Historical "kit exemptions" (§15.37) were largely deleted in FCC 25-85 (2026). Risk: $5,000-$8,000 testing cost before legal US sale, or legal exposure if skipped. Mitigation: budget $5-8K for testing, or limit initial runs to "fewer than 5 personal-use units" and evaluate after first batch. Consider launching as assembled product via a partner with existing FCC certification.

**2. ESP32-S3-WROOM modular approval.** The WROOM module carries its own FCC modular approval, which simplifies the intentional-radiator side of certification. The scanner PCB as a whole still needs §15.101 testing for the unintentional radiator and receiver performance.

**3. International compliance.** ETSI (EU), IC (Canada), ACMA (Australia) each have their own requirements. Not addressed in v1. US-only launch.

### Business risks

**1. Base model market squeeze.** Classic Kit at $50 sits uncomfortably close to the UV-K5 ($25 hackable transceiver) below and BC125AT ($130 assembled scanner) above. Risk: "why wouldn't I just buy a BC125AT" from customers who don't value the Bluetooth or parallel monitoring. Mitigation: marketing lead with the parallel monitoring + automotive integration story; de-emphasize direct BC125AT comparison.

**2. Delta variant as the actual product.** Realistic analysis suggests Delta has a much stronger competitive position ($130 vs $380+ P25 scanners) than Classic does. Risk: you spend engineering effort on Classic when Delta is the real product. Mitigation: consider making Delta the launch SKU and Classic a later lower-cost variant. Revisit after Milestone 1.

**3. Firmware dev time vs hyperfocus cycle length.** Estimated 400-600 hours for Classic firmware, 1000-1500 for Delta. Historical hyperfocus cycles last 2-6 months. Risk: cycle ends before firmware ships. Mitigation: structure firmware in shippable increments, embrace "Classic first, Delta later" staging, accept that a cycle-ending mid-project is a valid outcome (the doc itself is the archived artifact).

**4. Support burden for kit buyers.** Every kit seller underestimates the support time per unit. Reddit/Discord support for 100 users of a kit they partially assembled can consume 10+ hours/week. Mitigation: launch assembled SKU as primary, offer kit as optional advanced tier. Consider Tindie seller fees as a trade for their built-in support infrastructure.

### Open questions

- Will Nooelec engage in a partnership or wholesale conversation?
- Should the first production run be 20 units (Reddit experiment) or 50-100 (serious product launch)?
- Is there a case design that makes Classic feel like a finished product rather than a kit?
- Does the audience actually want Delta's P25 capability, or is analog-only Classic enough?
- Is a Discord or forum the right community channel, or should this be a mailing list?

---

## Prototyping roadmap

### Milestone 1: Feasibility (2-4 weeks of evening work)

**Goal:** Prove the ESP32-S3 can host an RTL-SDR, pull I/Q samples, demod one channel, and simultaneously stream audio over Bluetooth A2DP.

**Hardware:** ESP32-S3-DevKitC-1 (~$15), existing Nano 3, USB OTG adapter cable.

**Tasks:**
1. ESP-IDF project with TinyUSB host + classic Bluedroid A2DP source
2. Custom USB driver for RTL2832U (port from librtlsdr, adapt for ESP-IDF)
3. Pull 2.4 MSPS I/Q stream into a ring buffer
4. Basic FM demodulator on one fixed frequency
5. Feed demodulated audio to A2DP SBC encoder
6. Pair with phone, verify audio

**Success:** Stream a local 2m repeater to Bluetooth earbuds for 60 seconds without glitches.
**Failure decision:** If S3 can't sustain this, pivot to STM32H7+ESP32-S3 architecture for Base.

### Milestone 2: Multi-channel and metadata (2-4 weeks)

**Goal:** Prove parallel monitoring + AVRCP metadata displays correctly on a car head unit.

**Tasks:**
1. Extend to 4 parallel FM demodulators
2. Add energy-detection channel allocation
3. Implement AVRCP target with dynamic metadata updates
4. Test with real car head units (3-5 different makes)
5. Measure actual end-to-end latency

**Success:** Park in car, hear parallel channel activity, see frequency display update correctly on dashboard.
**Adjustments:** Calibrate firmware metrics against measured performance. Update vision doc with reality.

### Milestone 3: Companion app MVP (4-6 weeks)

**Goal:** Ship a Flutter app that configures the prototype via BLE.

**Tasks:**
1. Flutter project with BLE library
2. BLE GATT service on ESP32-S3 side with defined characteristics
3. Channel list import from RepeaterBook CSV
4. Priority channel flagging
5. Window visualization
6. Configuration upload

**Success:** New user can go from unbox → scanning in under 10 minutes via the app.

### Milestone 4: PCB v0.1 (4-8 weeks)

**Goal:** First custom PCB, populated by hand, in a 3D-printed case.

**Tasks:**
1. KiCad schematic matching dev board architecture
2. 4-layer PCB layout with RF-aware routing
3. JLCPCB fabrication (5 boards, $50 total)
4. Hand populate with reflow oven or hot air
5. Flash firmware, validate operation
6. 3D print case around it

**Success:** One functional Kerchunk Classic prototype that matches or exceeds dev board performance.

### Milestone 5: Pilot production (8-12 weeks)

**Goal:** 20 units shipped to beta testers.

**Tasks:**
1. JLCPCB PCBA service for 20 boards (~$800 total)
2. Bundle with Nooelec Nano 3 (purchased at retail, no partnership yet)
3. Ship in small boxes with QR code to setup docs
4. Recruit 20 beta testers from r/amateurradio and personal network
5. Gather feedback for 30 days

**Success:** 15+ of 20 units reach "working in a car" state with user-acceptable UX.
**Launch gate:** Proceed to public launch if success, iterate if not.

### Milestone 6: Public launch (1-2 weeks after pilot)

**Goal:** Open orders for 100 more units on a simple storefront (Tindie, Lemonsqueezy, or a Shopify store).

**Tasks:**
1. Product listing with photos, specs, clear docs
2. Reddit announcement on r/amateurradio and r/rtlsdr
3. Hackaday submission
4. Engage Nooelec about partnership if traction justifies
5. Accept orders, fulfill from pilot supply + second production run

**Success:** First 100 units sell through in 90 days.
**Ongoing:** Delta variant development kicks off in parallel once Classic is shipping.

---

## Success criteria

**Short term (12 months from first build):**
- 100 Classic units shipped to paying customers
- Documented firmware in public repo under permissive license
- Companion app on iOS and Android app stores
- Three positive Hackaday writeups
- Discord or forum with 200+ active users

**Medium term (24 months):**
- Delta variant shipping
- 500+ total units across both SKUs
- Nooelec partnership (co-marketing or wholesale)
- First international customers (via user-reported compliance workarounds or intentional cert pursuit)
- Community-contributed firmware features

**Long term (36 months+):**
- Kerchunk is the reference hobbyist Bluetooth scanner
- A v2 hardware revision with integrated RTL-SDR (if Nooelec partnership allows)
- Adjacent products (Kerchunk Desk — non-automotive desk-optimized variant?)
- Exit or continuation decision made on real data

**Alternative success criteria:**
- Project archived to tism with thinking captured (this doc) and zero units shipped
- Partial completion (firmware open-sourced but no commercial product) accepted as valuable contribution to the RTL-SDR ecosystem

Any of these outcomes is acceptable. The product exists to exist, not to dominate a category. Commercial success is a nice-to-have, not the point.

---

## Naming and identity

**Kerchunk.** Ham radio slang for briefly keying up a repeater to verify it's there. Onomatopoeic. Unapologetically authentic to the hobby. Communicates insider status immediately to the target audience.

**Product tiers:**
- **Kerchunk Classic** — Base model. Analog FM/NFM/AM. Entry tier.
- **Kerchunk Delta** — Pro model. Classic features plus P25 Phase 1 digital. Delta references the D phonetic (Digital, Decoder) and carries technical weight.

**Tagline candidates:**
- "Pocket scanner. Modern stack."
- "Scanning, reconsidered."
- "The scanner your car deserves."
- "Finally, a scanner that admits it's 2026."

The last one is the most on-brand. It's dry, direct, Gen-X, and tells you what's wrong with the competition without naming them.

**Visual identity:** Minimal. Brushed aluminum to match the Nano 3's aesthetic. Monospace typeface for anything printed on the board or case. Single-color silkscreen. The product shouldn't look like a toy or a cosplay radio; it should look like a tool.

**Community:**
- Reddit: `r/Kerchunk`
- Discord: `Kerchunk HQ`
- GitHub org: `kerchunk-radio`
- Website: `kerchunk.radio` (ham radio TLD, if available) or `kerchunkscanner.com`

---

## What this doc is not

This is not a commitment to build Kerchunk. This is the captured thinking from the April 2026 hyperfocus cycle, preserved in sufficient detail that the decision to build or not-build can be made later with full context.

If the decision is to build: this doc is the starting point. Everything in it is debatable, but nothing is unaddressed.

If the decision is to archive: this doc is the artifact. The intellectual work has value whether the product ships or not. The parallel-monitoring architectural insight (five US metros validated, windowing strategy worked out, BOM economics priced) is transferable to any future SDR scanner project, Kerchunk or otherwise.

If the decision is delayed: this doc remains the single source of truth. Update the frontmatter `updated:` field when revised. Add a revision log at the bottom when meaningful changes happen.

---

## Revision log

**2026-04-16** — Initial capture. Conversation in Claude consolidated into full vision doc. Five-city RF coverage analysis (KC, Seattle, Chicago, LA, Manhattan KS) complete. BOM validated for Classic and Delta tiers. Naming confirmed (Kerchunk / Classic / Delta). Build intent: "decide later." Filed in 🧠 Tism/Kerchunk/ as active project folder.
