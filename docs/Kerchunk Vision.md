---
title: "Kerchunk — Product Vision"
created: 2026-04-16
updated: 2026-05-07
vault: Tism
topic: kerchunk-vision
---
Summary:: A pocket-sized Bluetooth car scanner. A Raspberry Pi Zero 2 W and an RTL-SDR dongle on a sandwich carrier PCB, in a 3D-printed case, pairing with the car stereo and monitoring multiple channels in parallel. Analog FM/NFM/AM at launch; P25 Phase 1 in a v1.1 firmware update.
Next:: Build the M1 prototype on a stock Pi Zero 2 W: `rtl_fm` + `bluez-alsa` A2DP source streaming a local 2 m repeater to paired earbuds for 60 seconds clean.
Context:: April 2026 hyperfocus project. The product is a Bluetooth car scanner that uses an RTL-SDR's wide capture to monitor multiple channels in parallel rather than scanning serially. Originally architected around an ESP32-S3 USB host. May 2026 investigation found the S3's USB peripheral is Full-Speed only (12 Mbps) and cannot carry the RTL2832U's ~4.8 MB/s I/Q stream — a silicon-level ceiling. Pivoted to the Pi Zero 2 W, which has High-Speed USB host, on-chip Bluetooth Classic + BLE, and quad-core A53 headroom enough to run analog and P25 on the same chip. The pivot collapsed the previous Classic/Delta tier split into a single product. Build intent remains "decide later." This doc captures the thinking so the decision is informed whether it is made in a week or a year.

---

# Kerchunk

> *Kerchunk: ham radio slang for briefly keying up a repeater to verify it's there. The sound a repeater makes when someone checks in without saying anything. Also: what this scanner does continuously, across every channel in your list, simultaneously.*

A pocket-sized Bluetooth car scanner. A Raspberry Pi Zero 2 W and an RTL-SDR dongle, stacked on a sandwich carrier PCB, in a case the size of a playing card. No screen. No speaker. No buttons. Pairs with your car's stereo, streams audio over Bluetooth, displays channel metadata on your head unit. Monitors multiple channels in parallel. Built for hams and scanner hobbyists who want something the commercial market hasn't made in 20 years.

---

## Why this exists

The handheld scanner market has not meaningfully evolved since the Uniden BC125AT launched in 2002. The SDS100 (2018) added P25 Phase 2 and a color screen but kept the same industrial design language: rubberized body, numeric keypad, dot-matrix display, 3.5 mm headphone jack, proprietary programming cable. Scanning remains a serial operation, cycling through channels one at a time, with a 10 ms gap on each that occasionally clips the first syllable of brief transmissions.

Meanwhile, everything around the scanner has changed. Car stereos support Bluetooth audio with metadata display. Ham operators carry phones that can configure radios over BLE. RTL-SDR dongles exist for $25 and can capture 2.4 MHz of spectrum continuously, making parallel channel monitoring architecturally trivial. Power, audio, and data all converge on USB-C.

No scanner integrates any of these. The BC125AT still uses a proprietary USB-miniB programming cable, a speaker grille that rattles, and a physical keypad optimized for 2008 thumb ergonomics. It costs $130.

Kerchunk is the product that admits it's 2026.

### The core architectural insight

Traditional scanners scan. They hop from frequency to frequency, checking each in sequence, which means at any moment they're listening to exactly one channel. When they land on an active channel, they stop. When the transmission ends, they resume scanning. This is why you miss transmissions on adjacent channels — the scanner is busy elsewhere.

An SDR doesn't scan. It captures a wide slice of spectrum continuously and demodulates channels in software. Within a 2.4 MHz window, it can monitor 4–24 channels simultaneously depending on processor headroom. The concept of "scan speed" dissolves — there is no scanning, just listening.

For typical US ham repeater layouts this is an architectural match. Most metros cluster their repeaters into 2–5 band windows of 2.4 MHz each. Kansas City's 17 analog repeaters fit in 3 windows. Seattle's 21 fit in 5. Chicago's 32 fit in 4. Even Los Angeles with 309 repeaters fits in 11 windows. For rural areas like Manhattan KS (3 repeaters, 2 windows), the entire channel list can be monitored continuously with zero cycling.

This is the feature no hardware scanner can offer. It's not a better version of the BC125AT's architecture — it's a different architecture entirely.

### Why this audience, why now

The target user is a ham operator or scanner hobbyist who:
- Already owns at least one RTL-SDR dongle (roughly 400,000 sold globally; r/rtlsdr has 80,000+ members)
- Drives regularly and would benefit from hands-free Bluetooth audio
- Runs homebrew projects on Raspberry Pi, ESP32, or Arduino — the Pi-based architecture is on home turf for them
- Shops at Mouser, Digi-Key, LCSC, Adafruit, Nooelec, RTL-SDR Blog
- Reads Hackaday, follows QRP Labs, has a Tindie wishlist
- Is frustrated by commercial scanner UX but hasn't found a better option

This audience is well-served by forums and specialty retailers and catastrophically underserved by product design. Every option they currently use is either a laptop-tethered software setup (SDRTrunk, SDRsharp) or a firmware mod to cheap Chinese radios (Quansheng UV-K5). Nothing sits in the middle: a purpose-built, small, portable, daily-drivable scanner that uses modern interfaces.

Kerchunk fills that gap.

---

## What it is

A sandwich carrier PCB, roughly Pi-sized at ~65×30 mm, that mounts a Raspberry Pi Zero 2 W on its 40-pin header. The carrier presents a USB-A receptacle oriented so the dongle slides in *parallel* to the Pi rather than perpendicular off a cable — USB D+/D- come up from the Pi's `PP22`/`PP23` test points (a well-known Pi Zero mod that bypasses the micro-USB connector entirely). A USB-C port provides power. An optional 3.5 mm TRS jack drives wired audio output as a fallback alongside the primary Bluetooth path. The Pi, the carrier, and the dongle stack into a single rigid assembly inside a 3D-printed or injection-molded case. The SMA antenna connector on the dongle is exposed on one side.

Final footprint: roughly playing-card sized. ~75×30×15 mm with a Nooelec Nano 3, ~120×30×15 mm with the longer RTL-SDR Blog V3/V4. The Nano 3 is the size-optimized reference dongle; the V3/V4 is the reference for users who want HF direct sampling and a bias tee at the cost of length.

### The user's product experience

The user receives the unit and a dongle (assembled or as a bundle they snap together). They plug the dongle into the carrier's USB-A socket and connect power via USB-C. They pair their phone and their car stereo with the scanner's Bluetooth identity. They open the companion iOS or Android app and either import a channel list (RepeaterBook CSV, Chirp-compatible format, or manual entry) or pick from curated presets for their area. The app displays the channel list, lets them tag priority channels, and uploads the configuration over BLE.

From that point on, the scanner runs headlessly. In the car, they pair it with their head unit as a Bluetooth audio source. The head unit's track display shows the current active frequency's alpha tag and frequency. When a transmission ends, the display reverts to a scanning indicator. When the car is off, the scanner suspends. When the car is on, it resumes where it left off.

No screen. No buttons. No headphone jack to break. No proprietary programming cable. No firmware CDROM. No fighting with Uniden's Windows software that hasn't been updated since 2014.

### One product

Kerchunk is a single product. The Raspberry Pi Zero 2 W's quad-core A53 has enough headroom to run analog FM/NFM/AM and P25 Phase 1 on the same chip without a coprocessor or a tier upgrade. P25 ships in v1.1 as a free firmware update over Wi-Fi or USB; it is not a SKU you pay more for.

The product ships in two SKUs that are the same hardware in different states of assembly:

- **Bundle** — carrier PCB, Pi Zero 2 W, RTL-SDR dongle, microSD card, and case parts. User assembles, flashes the SD, and powers up. ~$120 retail.
- **Assembled** — same hardware, pre-built, pre-flashed, ready to power up. ~$150 retail.

There is no bare-PCB kit tier. The value increasingly lives in the SD card image, not the PCB; selling a PCB without it is selling the wrong half.

---

## Hardware architecture

### Block diagram

```
                  ┌─────────────────────────────┐
                  │   Antenna (SMA)             │
                  └──────────┬──────────────────┘
                             │
                  ┌──────────▼──────────────────┐
                  │   RTL-SDR Blog V3/V4 or     │
                  │   Nooelec Nano 3            │
                  │   R820T2 + RTL2832U         │
                  │   2.4 MSPS 8-bit complex    │
                  └──────────┬──────────────────┘
                             │ USB 2.0 High-Speed
                             │ (~4.8 MB/s I/Q)
                  ┌──────────▼──────────────────┐
                  │   USB-A Receptacle          │
                  │   (carrier PCB,             │
                  │    parallel to Pi)          │
                  └──────────┬──────────────────┘
                             │ tapped from Pi USB
                             │ test points (PP22/PP23)
                  ┌──────────▼──────────────────┐
                  │   Raspberry Pi Zero 2 W     │
                  │   Quad-core A53 @ 1 GHz     │
                  │   512 MB LPDDR2             │
                  │   On-chip BT Classic + BLE  │
                  │   On-chip 2.4 GHz Wi-Fi     │
                  │                             │
                  │   librtlsdr → DSP pipeline  │
                  │   → BlueZ A2DP source       │
                  └──────┬─────────────┬────────┘
                         │             │
         ┌───────────────┘             └──────────────┐
         │                                            │
  ┌──────▼────────┐      ┌──────────────┐     ┌──────▼──────┐
  │  Bluetooth    │      │  I²S Codec   │     │  USB-C       │
  │  Classic A2DP │      │  (optional   │     │  Power-path  │
  │  + AVRCP +    │      │   3.5 mm     │     │  + ignition  │
  │  BLE GATT     │      │   jack)      │     │  sense       │
  └───────────────┘      └──────────────┘     └──────────────┘
```

### Component rationale

**Raspberry Pi Zero 2 W** (~$15 retail). Quad-core Cortex-A53 at 1 GHz, 512 MB LPDDR2, on-chip 2.4 GHz Wi-Fi and Bluetooth 4.2 (Classic + BLE), micro-USB OTG with full High-Speed (480 Mbps) host capability. The High-Speed USB is the binding requirement — the RTL2832U streams ~4.8 MB/s of I/Q data, which a Full-Speed (12 Mbps) host cannot carry. The Zero 2 W has existing FCC/CE/IC modular approvals, simplifying certification on the radio side. The Foundation has held the $15 price point through three generations and maintains long-term availability commitments.

**RTL-SDR dongle** (~$30–40 retail). Any R820T2-based RTL-SDR works: enumeration is identical, the I/Q endpoint is identical. Recommended dongles: the **Nooelec Nano 3** for the smallest stacked footprint, or the **RTL-SDR Blog V3/V4** for HF direct sampling and bias tee at the cost of length. The V4 (R828D + improved front-end) is the current reference for new builds; V3 remains widely owned and works identically.

**Sandwich carrier PCB** (~$8–12 BOM). Mounts the Pi via the 40-pin header. USB D+/D- come up from the Pi's `PP22`/`PP23` test points (small solder pads on the back of the Pi, or pogo contacts on the carrier), eliminating the micro-USB connector and the perpendicular cable it would otherwise require. The carrier presents a USB-A receptacle oriented parallel to the Pi so the dongle stacks alongside it in-plane. Carrier also includes USB-C input with a power-path controller (LM66200 or similar), an ignition-sense input for clean automotive shutdown, status LED, and an optional I²S codec for the 3.5 mm jack. Four-layer board, RF-aware routing on the USB pair (~5 cm differential trace; well within USB 2.0 HS budget).

**Why not a bare RTL-SDR module on the carrier?** Considered and rejected for v1. Bare RTL2832U + R820T2 modules exist for OEM integration and would shave ~5 mm off the stack height, but they narrow the supply chain to a single vendor and prevent users from swapping dongles. Reconsider for a v2 hardware revision once volume justifies the sourcing.

**Why not just plug into the Pi's micro-USB OTG port?** That works mechanically only with a right-angle adapter, and even then the dongle hangs off the Pi's edge in an awkward L. The test-point USB tap costs essentially nothing on the carrier and gets the dongle in-plane.

**USB-C input + power-path controller** (~$1.50). 5 V power. The Zero 2 W draws ~150–250 mA idle and peaks higher under load; combined with the dongle's ~280–300 mA, plan for ~700 mA peak. A power-path IC plus an ignition-sense input from the car's accessory line cleanly handles "car off → scanner suspends" without leaving the Pi running on a dead 12 V rail.

**Optional I²S audio codec** (WM8960 or similar, ~$2). Wired audio output via 3.5 mm TRS jack. Kept cheap so it can be included by default rather than as an upgrade.

**microSD with read-only rootfs.** The Pi boots from microSD. The production image runs the rootfs read-only with a tmpfs overlay for `/var` and a small writable partition for `channels.csv`, `config.json`, scan logs, and firmware updates. This sidesteps SD-card corruption from sudden power loss in automotive use. BOM includes an industrial-grade card (~$10) rather than a consumer card.

**USB mass storage over USB-C (Pi gadget mode).** When the assembly is plugged into a host computer, the Pi exposes its writable config partition as a USB mass storage device. User drops `channels.csv` and `config.json` in, unplugs, scanner reloads with new config. This is the fallback configuration path that works without the companion app.

### What's deliberately omitted

**No screen.** A 0.96" OLED would add $3 BOM, board area, a driver subsystem, and a software display abstraction layer. The phone is the screen. The car head unit is the screen. Keeping the scanner screenless is how it stays small and cheap.

**No speaker.** Bluetooth audio to car stereos and earbuds is universal. Every possible use case for on-device audio is solved better by a $15 Bluetooth speaker than by a tiny tinny scanner speaker. Wired 3.5 mm is the fallback.

**No keypad.** The companion app is the keypad. This is the most audience-authentic choice: the r/amateurradio and r/rtlsdr users who want this product all carry phones and prefer app-based configuration.

**No battery.** USB-C power. The scanner is designed to live in a car (always on when ignition is hot) or on a desk (plugged in). Battery life is an obligation that requires charging circuitry, a battery holder, a power management IC, and software for state of charge — all of which add cost and complexity for a use case most users don't have. A battery-pack version can be a later variant or a 3D-printed case add-on with a commodity USB-C power bank.

**No built-in CTCSS/DCS encoder.** It's a scanner, not a transceiver. Receive-only, by design.

**No CarPlay or Android Auto UI in v1.** Kerchunk presents to the head unit as a Bluetooth Classic A2DP audio source — the same protocol a phone uses to stream music — which works on essentially every modern head unit including those that also support CarPlay/Auto. A *CarPlay dashboard UI* (showing scan activity, channel list, and metadata on the head unit screen rather than just AVRCP track info) is gated by Apple's entitlement process and would require rerouting audio through the iPhone. Documented as a v2 candidate, not a v1 deliverable. See §"v2 candidates."

---

## Software architecture

This is a Linux userspace application running on a custom Raspberry Pi OS image (or a buildroot-derived minimal image at production). The previous bare-metal firmware story is gone, and with it most of the firmware risk.

### Process layout

**`kerchunk-rxd`** — the SDR pipeline daemon. Written in C++ (or Rust) for the hot path, with a small Python control surface during prototyping.
- Opens the dongle via `librtlsdr`, sets sample rate to 2.4 MSPS
- Continuous I/Q ring buffer (512 KB in RAM)
- Real-time FFT every 10 ms via FFTW or a NEON-tuned alternative
- Energy detection across FFT bins → triggers channel demod allocation
- Pool of N parallel FM/NFM/AM demodulators (N=4 at launch, target N=8–12)
- Per-demod squelch, CTCSS/DCS decode, 400 ms pre-buffer ring
- Outputs PCM audio on a Unix socket or a named ALSA device

**`kerchunk-btd`** — the Bluetooth daemon.
- BlueZ 5 + bluez-alsa (or PipeWire's bluetooth module) provides the A2DP source
- Reads PCM from `kerchunk-rxd`, encodes SBC, transmits to the paired sink
- AVRCP target updates current frequency, alpha tag, and active channel count
- BLE GATT server for the companion app: channel list R/W, priority flags, status telemetry

**`kerchunk-cfgd`** — the config + USB mass storage daemon.
- Watches `/boot/kerchunk/channels.csv` and `/boot/kerchunk/config.json` for changes
- When the unit is plugged into a host PC, exposes those files as USB mass storage via the Pi's USB gadget mode
- Hot-reloads `kerchunk-rxd` on config change without losing Bluetooth pairing state

All three communicate via D-Bus (the native BlueZ idiom) and a small set of Unix sockets. systemd manages service lifecycle; a `kerchunk.target` ties them together.

### What's already solved upstream

Most of the previously-risky firmware work is now off-the-shelf:
- **USB host + RTL-SDR enumeration:** `librtlsdr`, kernel-managed.
- **2.4 MSPS I/Q streaming:** `librtlsdr`'s standard async read path.
- **FFT and FM demod:** GNU Radio blocks, or `rtl_fm` as a reference implementation.
- **A2DP source + AVRCP target:** BlueZ 5 + `bluez-alsa`, well-documented, ships in Raspberry Pi OS.
- **BLE GATT server:** BlueZ 5 with `python-dbus` or `sd-bus`.
- **USB mass storage gadget:** kernel `g_mass_storage` module on the Pi's OTG controller.
- **A/B firmware updates:** standard tools (`rauc`, `swupdate`).

The remaining custom work is the orchestration: parallel demod scheduling across 2.4 MHz windows, the rolling-window scanning strategy, the metadata-vs-audio timing for AVRCP, and the companion app.

### Critical risk: cold boot and resume latency

This is the highest-priority technical risk. Stock Raspberry Pi OS on a Zero 2 W boots in 15–30 seconds. The product UX wants "car starts → scanner is ready" in well under that. Mitigations, in increasing engineering cost:

1. **Suspend-to-RAM, not poweroff.** When ignition drops, the carrier's power-path controller maintains a low standby current from the always-hot 12 V line and signals the Pi to suspend. Resume on ignition wake is sub-second. This is the primary plan.
2. **Custom buildroot or Yocto image.** Trim to the kernel modules and userspace actually needed. 5–8 second cold boot is achievable with effort.
3. **Initramfs-only operation.** Aggressive: everything in initramfs, no rootfs pivot. Sub-3-second boot is documented in industrial Pi deployments.

If suspend-to-RAM works reliably across thermal and voltage variation, the cold-boot path matters mainly on first power-up and after firmware updates — both acceptable to be slow.

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
2. Remaining demod slots cycle through non-priority windows
3. Each window dwell: FFT the full 2.4 MHz, identify active channels via energy threshold, assign available demod slots to active channels in priority order
4. On squelch-close, free the demod slot
5. On window timeout, retune to next window (weighted by density)

**Exposed metrics (for companion app display):**
- Current cycle time (ms)
- Window occupancy (% of time each window is being monitored)
- Missed activity log (when more active channels than demod slots, which were skipped)
- Active demod slot count (real-time)
- CPU and thermal headroom

This transparency is genuinely novel. No hardware scanner tells you what it missed; they can't, because they don't know.

### Bluetooth audio pipeline and latency handling

A2DP SBC has 150–400 ms end-to-end latency. This is inherent to Bluetooth Classic and car head units' jitter buffers. Kerchunk's strategy:

1. Maintain a continuous A2DP stream (never stop transmitting; fill gaps with comfort noise or silence)
2. Pre-buffer 400 ms of RF audio per demod (ring buffer, overwritten when squelch stays closed)
3. On squelch open, flush the pre-buffer to the A2DP stream first, then live audio
4. User experiences a constant ~300 ms delay but never hears a clipped transmission start

This is the same trick aftermarket Bluetooth dongles use on BC125AT scanners. The ham/scanner audience already accepts 300 ms latency from that workflow.

**Design note:** The AVRCP metadata update should happen at squelch-open, not at flush-complete, so the user sees "145.130 MHz — KC0KW" slightly before they hear audio. This keeps the head unit display responsive rather than laggy.

### Configuration pathways

Three ways to configure Kerchunk, in priority order:

**1. iOS/Android companion app over BLE (primary).** Full channel list management, priority tagging, window visualization, scan activity log, firmware updates. Written in Flutter for single-codebase iOS + Android support. Estimated 150–200 hours of dev time.

**2. Web Bluetooth config page (alternate).** A static HTML/JS page hosted on GitHub Pages. Users visit the URL in Chrome or Edge, pair the scanner over Web Bluetooth, configure. No installation required. Does not work on iOS Safari or iOS Chrome (no Web Bluetooth support). Good fallback for desktop users who don't want an app.

**3. USB-C mass storage CSV (fallback).** Plug the scanner into any computer via USB-C, it mounts as a disk via the Pi's USB gadget mode, user edits `channels.csv` with any text editor or spreadsheet, saves, ejects, scanner reloads with new config. Works offline, no pairing required, no app needed. Compatible with Chirp-exported CSV format.

All three paths read and write the same underlying configuration files. The app is the primary path but every user can fall back to USB mass storage if Bluetooth isn't working.

### Update strategy

- A/B rootfs partitions managed by `rauc` or `swupdate`
- Updates delivered over Wi-Fi (when the Pi joins a known network) or via USB mass storage drop-in
- Companion-app-driven OTA over BLE for the writable config partition only, not for the rootfs
- Semantic versioning, image pinned to hardware revision
- Public changelog, public roadmap

---

## User experience

### Primary use case: car scanner

User drives to work. Car starts, scanner resumes from suspend in under a second, auto-connects to the car's Bluetooth (previously paired). Scanner resumes monitoring the channel list configured for the user's area. User hears no audio until a repeater activates; when one does, the car's speakers play the transmission and the head unit shows "145.130 MHz — KC0KW Gibbs Rd." User drives, listens, occasionally hears nets. Car stops, scanner suspends. Car starts again tomorrow, same thing.

**This is the 95% use case.** Every design decision defers to making this work reliably.

### Secondary use cases

- **Desk monitoring.** Scanner plugged into a USB-C power supply on a desk, connected to Bluetooth earbuds or speakers, used while working.
- **Travel.** Scanner in a bag with earbuds, used on trips to monitor local repeaters without bringing a full radio.
- **Scanner test bench.** Scanner tethered to a laptop via USB-C (mass storage mode), used for quick channel list experimentation while testing.
- **Multi-scanner setup.** Multiple Kerchunks running in parallel, each configured for a different band or geographic area, via a central BLE app dashboard.

### First-time setup flow

1. Unbox unit (and dongle if Bundle SKU)
2. Plug dongle into USB-A socket on the carrier
3. Plug USB-C into any 5 V power source (phone charger, car USB port, laptop)
4. LED indicates "discoverable" once the Pi finishes booting (~5–8 s on the production image)
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
| Bundle | Carrier + Pi Zero 2 W + RTL-SDR dongle + microSD + case parts; user assembles | ~$58 | $120 |
| Assembled | Same hardware, pre-built, pre-flashed, in case, ready to power up | ~$68 | $150 |

Two SKUs only. A no-carrier "kit" form (Pi + right-angle OTG adapter + dongle) was considered and rejected for shipping — the resulting assembly is too long and too mechanically fragile to call a product. A bare-PCB-only "Kit" tier was also rejected: the value increasingly lives in the SD card image, and selling the PCB without it is selling the wrong half.

### Competitive landscape

| Product | Price | Scan Architecture | Bluetooth | Kerchunk Advantage |
|---|---|---|---|---|
| Quansheng UV-K5 | $25 | Serial | None | Parallel monitoring, automotive integration |
| Uniden BC125AT | $130 | Serial @ 100 ch/s | None | Parallel, car Bluetooth, smaller, P25 included |
| Uniden SR30C | $130 | Serial | None | Better coverage, modern UX, P25 included |
| Uniden BCD325P2 | $380 | Serial | None | Parallel, $260 cheaper, P25 included |
| Uniden SDS100 | $650 | Serial | None | Parallel, $530 cheaper, P25 included |
| SDRTrunk on laptop | Free | Parallel | N/A | Portable, standalone, no laptop required |

**Competitive story.** Kerchunk Bundle at $120 sits below every Uniden P25-capable scanner ($380–$650) while also undercutting the BC125AT analog-only at $130. Compared to a laptop running SDRTrunk, it's a fixed-function, car-installable, hands-free device that doesn't need a tethered host.

### Audience segmentation

**Primary (first 100 units):**
- Active hams on r/amateurradio, r/rtlsdr, r/scanner, r/raspberry_pi
- Members of regional ham clubs who already mentor newer ops
- QRP Labs / (tr)uSDX / uBITX kit-building community crossover
- Tindie and Hackaday early adopters
- Pi-hole / home-server tinkerer crossover (familiarity with Pi tooling)

**Secondary (post-launch, after validation):**
- Non-ham public safety monitoring enthusiasts
- Aviation monitoring (airband via AM demod)
- Railroad monitoring
- ADS-B / AIS enthusiasts (crossover audience already owning dongles)

**Not targeted:**
- Professional / commercial scanner users (law enforcement, fire, EMS). They need tested, certified, warrantied hardware. Kerchunk is a hobbyist product.
- International customers at launch. FCC compliance limits US sales initially; ETSI / IC equivalents come later if warranted.

---

## Risks and open questions

### Technical risks

**1. Cold boot and resume latency.** Highest-priority risk. Stock Raspberry Pi OS boots in 15–30 s; the UX wants suspend-resume in under 1 s and cold boot under 5–8 s. Mitigation: suspend-to-RAM as the primary path (validated in M1.5), custom buildroot image for cold-boot path. Decision gate: if neither path hits target, reconsider always-on-with-low-power-mode (Pi stays running on a small standby current with the radio gated off).

**2. SD card reliability in automotive thermal/vibration.** Pi runs from microSD. Repeated power cuts and thermal cycling can corrupt cards. Mitigation: read-only rootfs with tmpfs overlay; small dedicated config partition; industrial-grade SLC-mode card recommended in BOM (~$10).

**3. Bluetooth audio latency in practice.** The 300 ms pre-buffer approach is theoretically sound but untested in combination with AVRCP metadata timing across BlueZ. Risk: user experience feels laggy or metadata lags audio. Mitigation: M2 validates with real car head units.

**4. RTL-SDR sensitivity in fringe conditions.** RTL-SDR is noisier than a dedicated scanner superhet. Users in rural areas monitoring distant repeaters may be disappointed. Mitigation: recommend external LNA (Nooelec SAWbird, RTL-SDR Blog LNA) in documentation. Consider LNA as an accessory in later product waves.

**5. AVRCP metadata compatibility.** AVRCP display behavior varies across head units. Some show only title, some truncate to 16 chars, some refresh slowly. Risk: marketing material promises "frequency shown on your dashboard" and some users see nothing. Mitigation: M2 tests across 5+ different car stereos and documents compatibility explicitly.

**6. CarPlay / Android Auto coexistence on the same head unit.** Most target users drive a vehicle where CarPlay or Android Auto is already paired to their phone. Adding Kerchunk as a second Bluetooth A2DP source can produce three different head-unit behaviors: clean source switching with audio ducking, manual source-select required, or refusal to maintain two A2DP pairings simultaneously. AVRCP metadata also competes — both sources fight for the "now playing" line. Risk: a user assumes Kerchunk works alongside CarPlay and gets a worse-than-expected experience that's actually the head unit's fault. Mitigation: M2 explicitly tests the multi-source case across the same 3–5 head units used for AVRCP validation; documentation calls out per-make behavior; the companion app surfaces a "head unit compatibility" note during pairing setup.

**7. Pi Zero 2 W supply.** The Foundation has had multi-month outages on Zero-class boards in the past. Risk: production stalls because the core part is unobtainable. Mitigation: the Foundation's 2024+ supply commitments are stronger; design the carrier so a Compute Module 4 IO breakout could substitute (~30% larger, otherwise drop-in via I²S/USB) if Zero 2 W goes unavailable.

**8. USB high-speed signal integrity over the test-point tap.** The carrier brings USB D+/D- up from the Pi's `PP22`/`PP23` test points via short pogo or solder traces. ~5 cm differential trace is well within the USB 2.0 HS budget, but the join from Pi pad to carrier is a discontinuity that can ring. Risk: dongle enumerates at HS but drops bulk packets under load. Mitigation: M4 step 2 explicitly bench-validates the tap on a hand-wired prototype with `usbmon` and `rtl_test` before fabbing the carrier.

**9. Scope creep.** The feature list grows naturally (trunked P25 Phase 2, DMR, POCSAG, digital voice ID, recording, etc.). Risk: never shipping because always adding features. Mitigation: ruthless v1 scoping to analog-only at launch; P25 Phase 1 in v1.1; everything else v2+.

### Regulatory risks

**1. FCC §15.101 certification requirement.** Even kit-form receivers may require FCC Part 15B testing when sold commercially in the US. Historical "kit exemptions" (§15.37) were largely deleted in FCC 25-85 (2026). Risk: $5,000–$8,000 testing cost before legal US sale, or legal exposure if skipped. Mitigation: budget $5–8K for testing, or limit initial runs to "fewer than 5 personal-use units" and evaluate after first batch. The Pi Zero 2 W carries existing FCC modular approval for its radios; the carrier PCB needs §15.101 testing for the unintentional radiator side and overall receiver performance.

**2. International compliance.** ETSI (EU), IC (Canada), ACMA (Australia) each have their own requirements. Not addressed in v1. US-only launch.

### Business risks

**1. "Just a Pi in a box" perception.** Some hobbyists discount Pi-based products as undifferentiated. Risk: perceived as a Raspberry Pi project, not a product. Mitigation: emphasize the carrier PCB, the integrated case, and the curated software image in marketing; the Pi is an implementation detail, not the brand story.

**2. Software dev time vs. hyperfocus cycle length.** Linux userspace cuts the software estimate roughly in half versus the prior bare-metal plan: ~250–400 hours total to launch. Historical hyperfocus cycles last 2–6 months. Risk remains real but materially smaller than the prior estimate. Mitigation: structure software in shippable increments; accept "analog-only at launch, P25 follows" staging; accept that a cycle ending mid-project is a valid outcome (the doc itself is the archived artifact).

**3. Support burden.** Every kit seller underestimates the support time per unit. Reddit/Discord support for 100 users of hardware they partially assembled can consume 10+ hours/week. Mitigation: launch Assembled as the primary SKU, offer Bundle as the price-conscious tier. Consider Tindie seller fees as a trade for their built-in support infrastructure.

**4. Pricing.** Bundle at $120 is well below the P25-capable competition but well above the BC125AT analog-only baseline. Risk: customers comparing only against analog-only options decide $120 is too much. Mitigation: lead with parallel monitoring + P25 included + automotive integration; deemphasize direct BC125AT comparison.

### Open questions

- Is there a case design that makes Kerchunk feel like a finished product rather than a Pi project?
- Should the first production run be 20 units (Reddit experiment) or 50–100 (serious product launch)?
- Pi Foundation partnership / volume pricing — worth pursuing once 100+ units/month is plausible?
- Is a Discord or forum the right community channel, or should this be a mailing list?
- Is the "home base" Wi-Fi mode interesting enough to expose in v1 (small web UI) or strictly v1.x?

---

## v2 candidates

Items deliberately deferred past v1. Each carries explicit gates so a future build/no-build decision is informed.

### CarPlay / Android Auto dashboard UI

The pitch: instead of (or in addition to) showing scan activity on the companion phone app, surface a live dashboard on the car's CarPlay or Android Auto screen — channel list, currently active demods, recent transmissions, priority flags. Same data the phone app shows, on the head unit instead of the dock-mounted phone.

**Why deferred:**
- **Apple gating.** A CarPlay UI requires an entitlement Apple grants individually by app category. The closest fit ("Audio") is historically reserved for commercial streaming services; hobbyist hardware accessories rarely receive it. Google's Android Auto has analogous gating.
- **Audio routing rework.** CarPlay Audio expects audio to come from the iPhone app, not directly from external hardware. To fit, Kerchunk would have to stream compressed audio to the iPhone over a custom BLE GATT path (Opus ~24 kbps fits BLE 4.2; the Pi Zero 2 W's BT 4.2 doesn't support LE Audio). The iPhone app then plays through CarPlay Audio. This trades the simple universal A2DP path for a phone-mediated path with worse audio quality and an iOS-only premium tier.
- **App-side complexity.** Flutter has limited CarPlay support; the CarPlay layer would likely need a native iOS module. Estimated +200 hours on top of the M3 Flutter app baseline.

**Gates to proceed:**
1. Apple grants the CarPlay Audio entitlement (or Apple opens a more permissive category that fits a scanner dashboard). Without this, the rest is moot.
2. Hardware revision retains BT 4.2 BLE bandwidth or moves to a chip with LE Audio — confirm BLE GATT audio streaming hits acceptable quality and battery cost in bench tests.
3. v1 has shipped and the user base is large enough that the engineering effort pays back.

**v1 stance.** The companion phone app shows the dashboard on the phone screen. Users mount the phone in a holder near the head unit, exactly as they already do. Audio flows scanner → Bluetooth A2DP → head unit, independent of whether the phone is connected to CarPlay/Auto.

### Other v2 candidates

- **Bare-RTL-SDR-module carrier** for a smaller, fully-integrated v2 form factor (rejected for v1 to keep dongles user-replaceable; reconsider once volume justifies single-vendor sourcing).
- **Trunked P25 Phase 2, DMR, NXDN, POCSAG** decoding — each gated on demand from the user base and DSP-headroom validation.
- **Battery-pack variant** as either a separate SKU or a 3D-printed-case-plus-USB-power-bank kit.
- **"Home base" Wi-Fi mode** — local web UI and Icecast streaming for desk use, leveraging the Pi's existing Wi-Fi.

---

## Prototyping roadmap

### Milestone 1: Feasibility (1 weekend)

**Goal:** Prove the Zero 2 W can host an RTL-SDR, demod one channel, and stream over Bluetooth A2DP to a paired sink. Most of this is already-working open source; the milestone is integration, not invention.

**Hardware:** Pi Zero 2 W, RTL-SDR Blog V3 (or any R820T2 dongle), right-angle micro-USB OTG adapter (used for prototype only — keeps the dongle in-plane with the Pi for handling, even though no carrier PCB exists yet), USB-C-to-micro-USB power adapter, microSD with Raspberry Pi OS Lite.

**Tasks:**
1. Boot stock Raspberry Pi OS Lite, install `rtl-sdr`, `bluez`, `bluez-alsa` packages
2. Confirm `rtl_test` succeeds and prints sample stream stats
3. `rtl_fm` tuned to a local 2 m repeater piped through `aplay` to a USB sound card — confirm audio
4. Pair Pi with Bluetooth earbuds; configure `bluez-alsa` as default sink
5. `rtl_fm | bluez-alsa-aplay` to the paired earbuds
6. Run for 60 seconds, listen for glitches

**Success:** Stream a local 2 m repeater to Bluetooth earbuds for 60 seconds without glitches.
**Failure decision:** If this doesn't work, the underlying assumption that off-the-shelf Linux SDR + BlueZ A2DP works on Zero 2 W is wrong, which would be surprising. Investigate; do not pivot architecture without strong evidence.

### Milestone 1.5: Suspend-resume validation (3–5 days)

**Goal:** Validate that suspend-to-RAM hits the < 1 s resume target and that Bluetooth pairing survives the suspend cycle.

**Tasks:**
1. Configure systemd to suspend on a GPIO trigger (simulating ignition drop)
2. Resume on a separate GPIO trigger (simulating ignition wake)
3. Measure resume time to "first audio packet sent over A2DP"
4. Cycle 100+ times, watch for failures (Bluetooth radio not coming back, USB host not re-enumerating dongle, etc.)

**Success:** < 1 s perceived resume, > 95% reliability over 100 cycles.
**Failure decision:** If suspend-to-RAM is unreliable, fall back to always-on-with-low-power-mode and accept ~50–100 mA continuous standby on the always-hot 12 V line.

### Milestone 2: Multi-channel and metadata (3–5 weeks)

**Goal:** Prove parallel monitoring + AVRCP metadata displays correctly on a car head unit.

**Tasks:**
1. Replace `rtl_fm` with custom `kerchunk-rxd` running 4 parallel FM demodulators
2. Add energy-detection channel allocation across a 2.4 MHz window
3. Implement AVRCP target with dynamic metadata updates via BlueZ
4. Test with real car head units (3–5 different makes), including the CarPlay / Android Auto multi-source coexistence case (Kerchunk + iPhone or Android phone paired to the same head unit simultaneously)
5. Measure actual end-to-end latency

**Success:** Park in car, hear parallel channel activity, see frequency display update correctly on dashboard.

### Milestone 3: Companion app MVP (4–6 weeks)

**Goal:** Ship a Flutter app that configures the prototype via BLE.

**Tasks:**
1. Flutter project with BLE library (`flutter_blue_plus`)
2. BLE GATT service in `kerchunk-btd` with defined characteristics
3. Channel list import from RepeaterBook CSV
4. Priority channel flagging
5. Window visualization
6. Configuration upload

**Success:** New user can go from unbox → scanning in under 10 minutes via the app.

### Milestone 4: Carrier PCB v0.1 (4–8 weeks)

**Goal:** First custom carrier PCB, populated by hand, in a 3D-printed case.

**Tasks:**
1. KiCad schematic: 40-pin header for the Pi, USB-A receptacle oriented for parallel dongle stacking, USB-C input with power-path IC, ignition-sense input, optional I²S codec, status LED
2. USB D+/D- routed from the carrier's USB-A pins to short pogo contacts (or solder pads + flying wires for v0.1) aligned with the Pi's `PP22`/`PP23` test points; bench-validate continuity and HS signal integrity on a hand-wired prototype before fabbing the carrier
3. Four-layer PCB layout with RF-aware routing on the USB pair
4. JLCPCB fabrication (5 boards, ~$50 total)
5. Hand-populate with reflow oven or hot air
6. Mount Pi to carrier via the 40-pin header, attach the USB tap (pogo or wire), flash SD with custom image, validate operation
7. 3D-print case around the stack

**Success:** One functional Kerchunk prototype, dongle stacked in-plane with the Pi, that matches dev-board performance.

### Milestone 5: Custom OS image (3–4 weeks, can run parallel to M4)

**Goal:** Replace Raspberry Pi OS with a buildroot-derived minimal image: read-only rootfs, fast boot, A/B partitions for OTA.

**Tasks:**
1. Buildroot configuration targeting the Pi Zero 2 W
2. Trim to required kernel modules (USB host, RTL2832U-relevant, brcmfmac for Wi-Fi/BT, USB gadget)
3. Read-only rootfs, tmpfs overlay, dedicated `/data` partition
4. `rauc` or `swupdate` for A/B updates
5. Cold-boot benchmark < 8 s

**Success:** Cold boot in < 8 s, suspend-resume in < 1 s, OTA updates work.

### Milestone 6: Pilot production (8–12 weeks)

**Goal:** 20 Assembled units shipped to beta testers.

**Tasks:**
1. JLCPCB PCBA service for 20 carrier boards (~$600 total)
2. Source 20 Pi Zero 2 W (~$300) and 20 RTL-SDR dongles (~$700)
3. Pre-flash SD cards with custom image
4. Ship in small boxes with QR code to setup docs
5. Recruit 20 beta testers from r/amateurradio and personal network
6. Gather feedback for 30 days

**Success:** 15+ of 20 units reach "working in a car" state with user-acceptable UX.
**Launch gate:** Proceed to public launch if success, iterate if not.

### Milestone 7: Public launch (1–2 weeks after pilot)

**Goal:** Open orders for 100 more units on a simple storefront (Tindie, Lemonsqueezy, or a Shopify store).

**Tasks:**
1. Product listing with photos, specs, clear docs
2. Reddit announcement on r/amateurradio, r/rtlsdr, and r/raspberry_pi
3. Hackaday submission
4. Engage Pi Foundation / Nooelec / RTL-SDR Blog about partnerships if traction justifies
5. Accept orders, fulfill from pilot supply + second production run

**Success:** First 100 units sell through in 90 days.

### Milestone 8 (post-launch): P25 Phase 1

**Goal:** Add P25 Phase 1 digital decode to the existing hardware via firmware update.

**Tasks:**
1. Integrate DSD-FME or OP25 decoder into the `kerchunk-rxd` demod pool
2. Validate CPU headroom — A53 should handle 2–4 P25 channels alongside analog
3. Update channel list schema to flag P25 channels
4. Update companion app to support P25 talkgroup display
5. Ship as v1.1 over OTA

**Success:** Existing customers receive P25 decode via update with no hardware change.

---

## Success criteria

**Short term (12 months from first build):**
- 100 units shipped to paying customers
- Documented software in a public repo under a permissive license
- Companion app on iOS and Android app stores
- Three positive Hackaday writeups
- Discord or forum with 200+ active users

**Medium term (24 months):**
- P25 Phase 1 shipping in v1.1 firmware
- 500+ total units
- Pi Foundation, Nooelec, or RTL-SDR Blog partnership (co-marketing or wholesale)
- First international customers (via user-reported compliance workarounds or intentional cert pursuit)
- Community-contributed software features

**Long term (36 months+):**
- Kerchunk is the reference hobbyist Bluetooth scanner
- A v2 hardware revision (CM4-based for industrial, or a custom SoC carrier if volume justifies)
- Adjacent products (a desk-optimized variant?)
- Exit or continuation decision made on real data

**Alternative success criteria:**
- Project archived to tism with thinking captured (this doc) and zero units shipped
- Partial completion (software open-sourced but no commercial product) accepted as valuable contribution to the RTL-SDR + Pi ecosystems

Any of these outcomes is acceptable. The product exists to exist, not to dominate a category. Commercial success is a nice-to-have, not the point.

---

## Naming and identity

**Kerchunk.** Ham radio slang for briefly keying up a repeater to verify it's there. Onomatopoeic. Unapologetically authentic to the hobby. Communicates insider status immediately to the target audience.

One product, one name. No tier split. No "Pro," no "Plus," no "Max."

**Tagline candidates:**
- "Pocket scanner. Modern stack."
- "Scanning, reconsidered."
- "The scanner your car deserves."
- "Finally, a scanner that admits it's 2026."

The last one remains the most on-brand. It's dry, direct, Gen-X, and tells you what's wrong with the competition without naming them.

**Visual identity:** Minimal. Brushed aluminum or matte black to match the dongle's aesthetic. Monospace typeface for anything printed on the carrier or case. Single-color silkscreen. The product shouldn't look like a toy or a cosplay radio; it should look like a tool.

**Community:**
- Reddit: `r/Kerchunk`
- Discord: `Kerchunk HQ`
- GitHub org: `kerchunk-radio`
- Website: `kerchunk.radio` (ham radio TLD, if available) or `kerchunkscanner.com`

---

## What this doc is not

This is not a commitment to build Kerchunk. This is the captured thinking from the April 2026 hyperfocus cycle plus the May 2026 architecture pivot, preserved in sufficient detail that the decision to build or not-build can be made later with full context.

If the decision is to build: this doc is the starting point. Everything in it is debatable, but nothing is unaddressed.

If the decision is to archive: this doc is the artifact. The intellectual work has value whether the product ships or not. The parallel-monitoring architectural insight (five US metros validated, windowing strategy worked out, BOM economics priced) is transferable to any future SDR scanner project, Kerchunk or otherwise.

If the decision is delayed: this doc remains the single source of truth. Update the frontmatter `updated:` field when revised. Add a revision log entry below.

---

## Revision log

**2026-05-07 (full rewrite)** — Doc rewritten end-to-end to reflect the Pi Zero 2 W architecture as native rather than as an addendum. All ESP32-S3, Bluedroid, ESP-IDF, ESP-DSP, TinyUSB, librtlsdr-port, and STM32H7-coprocessor framing removed. Classic/Delta two-tier marketing language deleted. Single-product pricing (Bundle / Assembled) and single-name identity (just "Kerchunk") committed throughout. CarPlay v2 candidacy and v2 candidates section retained. Test-point USB tap (PP22/PP23) and sandwich carrier form factor described in §"What it is" and §"Hardware architecture" rather than appended. Risk list refreshed to reflect Pi-era reality (boot/resume latency, SD reliability, USB-tap signal integrity replace the old S3-feasibility risks). Roadmap unchanged structurally but re-anchored. Build intent unchanged: "decide later."

**2026-05-07 (CarPlay scope)** — CarPlay / Android Auto dashboard UI documented as an explicit v1 non-goal and a v2 candidate with explicit gates (Apple Audio entitlement, audio routing rework via BLE GATT, ~200 hours of native iOS module work). M2 acceptance test now explicitly includes the dual-A2DP coexistence case. New §"v2 candidates" section captures CarPlay alongside other deferred items.

**2026-05-07 (carrier refinement)** — Carrier-PCB strategy committed: sandwich form-factor with USB D+/D- tapped from the Pi's `PP22`/`PP23` test points, USB-A receptacle oriented so the dongle stacks parallel/in-plane with the Pi rather than hanging off a perpendicular cable. Bare-RTL-SDR-module path considered and rejected for v1 (narrows supply chain, prevents user dongle swap). No-PCB right-angle-adapter form demoted to prototype-only — too long and mechanically fragile to ship. SKU lineup simplified to Bundle / Assembled (no PCB-less kit). Milestone 4 updated to call out the test-point USB tap as the key SI risk to bench-validate before fab.

**2026-05-07 (architecture pivot)** — Architecture pivot: ESP32-S3 → Raspberry Pi Zero 2 W. The S3's USB peripheral is Full-Speed only (12 Mbps) and cannot carry the RTL2832U's 2.4 MSPS / ~4.8 MB/s I/Q stream — a silicon-level ceiling that no firmware effort can clear. Pivoted to the Zero 2 W, which has High-Speed USB host, on-chip Bluetooth Classic + BLE, and a quad-core A53 with ample DSP headroom. Side effects: the previous Classic/Delta two-tier split collapses into a single SKU (Pi handles both analog and P25); firmware risk drops materially because most of the SDR + Bluetooth stack is off-the-shelf Linux userspace; new headline risk is Linux boot/resume latency rather than CPU feasibility. Pricing rebalanced: Bundle at $120, Assembled at $150. Roadmap rewritten around Linux userspace milestones. Prior firmware scaffold (`firmware/m1-feasibility/`, ESP-IDF) removed.

**2026-04-16** — Initial capture. Conversation in Claude consolidated into full vision doc. Five-city RF coverage analysis (KC, Seattle, Chicago, LA, Manhattan KS) complete. BOM validated (then for ESP32-S3 Classic + STM32H7 Delta tiers; superseded by the May 2026 pivot). Naming confirmed (Kerchunk). Build intent: "decide later." Filed in 🧠 Tism/Kerchunk/ as active project folder.
