# HF mode — design

Date: 2026-11-02 · Status: awaiting operator review

Inspired by [NightDX](https://github.com/marcozennaro/nightdx) (MIT), which does
unattended shortwave and medium-wave listening on an Airspy HF+. Kerchunk takes
the idea of a night of band scanning and logging, not the software.

## Why

The kiosk has a map mode for VHF/UHF and a CB mode. The operator owns an Airspy
HF+ Discovery on an 80 m loop that can hear far more than CB, and it sits unused
for the whole night. CB mode becomes **HF mode**: it sweeps shortwave broadcasts,
plays what it finds and logs everything it hears, and it drops into CB whenever
the CB band is actually active.

## Operator decisions

- **HF replaces CB.** It is a manual mode, switched the same way CB is today. It
  is not a background service: VHF/UHF scanning and the map stay off until the
  operator switches back.
- **The HF+ is reached through SpyServer**, not FernSDR, because FernSDR only
  offers its two configured bands. Server: `sdr://airspy.local:5555`.
- **The speaker plays stations the HF scanner hits.**
- **The wall uses the "Station first" layout**: broadcast info as the headline,
  an inset map showing the transmitter, a short heard-tonight list and a band
  dial. Mockup: "A" in the 2026-11-02 brainstorm screens; the layout is restated
  under "Wall" below.
- **The inset map uses the Simplemaps world SVG**
  (<https://simplemaps.com/resources/svg-world>).
- **It moves on automatically after a set period**, so one clear station can't
  park the scanner all night.
- **Propagation decides between CB and shortwave, by measurement.** Activity on
  the CB band triggers the switch, not the clock and not a prediction. Local CB
  chatter counts as activity.
- **When listening and logging compete, logging wins.** Hearing a transmission is
  fun, but it gets old when it's in a language the operator can't understand. The
  sweep sets the pace, and the speaker takes what's in the current window.
- **Reception data only.** No audio is kept.
- **The log is read on the admin side.** Shortwave does not reach jeremyfuksa.com
  at this time.
- **The active mode survives a reboot or restart**, for every mode.
- **Up to about 2 s of silence is acceptable at a SAME break-in.**
- **Schedules come from EiBi, Aoki and HFCC directly.** short-wave.info is not a
  data source: per the operator it uses Aoki, and it offers no download or API.

## Goals

1. One manual HF mode that follows the band: CB while CB is active, shortwave the
   rest of the time.
2. A reception record for every station heard, whether or not it reached the
   speaker, kept across restarts and mode changes.
3. An unattended night that keeps moving through the bands and keeps running
   through a restart.
4. A wall that shows the current station, candidate identity and location at a
   glance.

## Non-goals

- NightDX's terminal UI, QSL tracking, reception-report e-mail, recordings and
  AI classification or transcription.
- Medium wave (builder's call to design so it can be added, but not built).
- Shortwave on jeremyfuksa.com. While HF mode runs overnight, the site's "last
  heard" will sit unchanged, and that is accepted.
- A propagation model. Kerchunk logs what it measures rather than predicting.

## Anti-goals

These would make it a failure even if it technically worked:

- A station name presented as a confirmed identification. Names come from a
  schedule, so they are always shown as likely.
- Breaking SAME weather alerts in HF mode.
- Pushing the appliance into its 90 °C trip, or adding standing animation.
- Changing map-mode behaviour, including its `maxHoldMs` cap.

## Behaviour

### CB or shortwave

There are no day and night states. Entering HF mode starts the sweep, and the CB
band is one more stop on it, checked on every pass.

- **To CB:** carriers on the CB band stay above a threshold for a configurable
  time.
- **Back to the sweep:** CB stays quiet for a configurable time, 20 minutes by
  default *(my call)*. Skip in the admin tool also ends a CB hold *(my call)*.

Both times are there so a single passing signal can't make it flip back and
forth. Measurements on the CB stop don't create shortwave reception records.

No solar data or propagation model is used. This can mean shortwave all day when
CB is dead, and CB at night when it's active.

**While on CB:** the current CB behaviour and wall carry over: `config.cb.channels`,
names, `cb.modes` (38 LSB) and the dial. CB fits a single window, about 440 kHz
inside SpyServer's 660 kHz. CB hits keep logging as they do today; only the
shortwave sweep pauses.

**While sweeping (shortwave):**

1. **Sweep.** Step through the bands one window at a time, on a fixed timer. The
   sweep never waits for the speaker.
2. **Log.** While on a window, measure carriers against the local noise floor.
   Every carrier above the threshold updates a reception record.
3. **Listen.** While on a window, the speaker plays one station from that window
   and the wall shows it. If nothing qualifies, the speaker is quiet.
4. **Move on.** When the window timer ends, go to the next window. Skip in the
   admin tool (`POST /api/scan/skip`) moves on early.

Listening and measuring in the same window at once is proven: a 60-minute run did
both with no drops (`docs/bench/2026-11-hf-proofs.md`).

### Choices left to my judgment (marked for review)

- **Window timer:** 60 seconds, configurable and live. At about a dozen windows
  (an estimate), that is a full pass every 12 minutes or so.
- **Which station plays:** within the current window, schedule-matched carriers
  not yet on the speaker tonight first, strongest signal first among them, like
  NightDX's discovery mode. A station can't repeat until a configurable cooldown
  ends, so one strong station can't dominate. Unidentified carriers are always
  logged, but they reach the speaker only when no matched carrier is left, so a
  steady local noise source can't take a turn ahead of real stations.
- **Fades:** if the playing signal drops below the threshold for a configurable
  period, the speaker switches to the next qualifying station in the window. The
  sweep timer doesn't change.
- **Bands:** the broadcast bands from 120 m to 13 m, configurable, since the
  sweep can now run in daylight when the higher bands are open. A band wider
  than 660 kHz takes several windows. Edges follow where Aoki and HFCC list
  broadcasters, not the ITU allocations: 49 m starts at 5800, 41 m ends at 7800,
  31 m runs 9260 to 9990 and 25 m ends at 12180.
- **Demodulation:** AM for shortwave broadcasts.

### SAME break-ins

These work from HF mode as they do from CB today: EOM and the 8 s grace window
return to where it was. Detection doesn't depend on the scanner radio: the weather
monitor (KIOSK03, `kiosk/src/backend/index.ts:129`) keeps decoding NWR in every
mode and raises the event (`server.ts:680`). The scanner path is only how the
alert's audio reaches the speaker.

The do-not-undo invariants apply, with the one narrow exception under constraint 1:
moving between radios can't be a `retune()`. The `breakIn` guard stays. The sweep pauses during a
break-in and picks up where it left off.

The operator accepts up to about 2 s of silence while the audio source changes,
with no warm-up overlay and the alert banner kept. That timing assumes the header
arrives ahead of the voice message, which needs measuring on hardware.

## Reception log

One record per station per night, not per sighting, so a station seen on every
pass stays one row. *(My call.)* A "station" is what's measured plus its top
schedule candidate: the key is night + frequency (with a tolerance) + top
candidate at that time. When the top candidate changes on a frequency, a new row
starts. Unidentified carriers key on night + frequency.

| Field | Notes |
| --- | --- |
| Night | Which listening night the record belongs to |
| First heard / last heard | UTC |
| Frequency, band | From the measurement |
| Peak signal | dB above the local noise floor |
| Times seen | Number of passes |
| Was on speaker | Whether it was ever the listened-to station |
| Likely station, country, language | From schedules; marked as candidate |
| Other candidates | Other schedule matches for that frequency and time |
| Transmitter site, lat/lon, power, distance | When the schedule data has them |

- A carrier with no schedule match is still logged as **unidentified**, with its
  frequency and signal.
- Records live in SQLite beside the config (`node:sqlite`, as `history.ts` does)
  and are kept indefinitely, since they are small text rows. They must not be
  removed by `history.prune()`. *(My call.)*
- CB hits stay in the existing history path; this log is shortwave only.

## Schedule data

- **EiBi and Aoki** decide who may be on a frequency at a time.
- **HFCC** adds power, beam and antenna data. HFCC lines are registrations, not
  confirmed broadcasts, so they enrich an EiBi or Aoki entry and never add a
  station alone. NightDX does the same.
- **Downloads** run on a schedule on the appliance and keep the last good copy
  when a fetch fails. An expired certificate on eibispace.de was observed on
  2026-11-02, so this case is real.
- **Licensing.** EiBi's README allows free use, copying and use in third-party software.
  Aoki and HFCC state no redistribution terms, so schedule data is fetched at runtime
  and not committed to the repo.

## Wall

A new stage state alongside the current CB stage, reusing the same stage swap
(`.cbStage`, `MapHandle.pause()`):

- **Tag:** "HF mode · Shortwave", top left.
- **Readout well, left, largest element:** band, mode and Live; signal in dB;
  frequency in kHz as the headline; likely station; a "Likely · from schedule"
  label; language, site, power, distance; segment meter.
- **Inset map, top right:** Simplemaps world map, with the transmitter's country
  tinted, a dot at the transmitter, a dot at the QTH and a great-circle line.
- **Heard tonight, below the map:** count and the latest rows.
- **Band dial, across the bottom:** the current window, with carriers as ticks
  and a needle on the current station.

Other states the builder must design: hunting (nothing on the speaker yet),
unidentified station (no map path, shown plainly), and receiver offline.

Thermal rule: static between events, no animation, no `backdrop-filter`. Only
changes of station, or a slow tick, cause redraws.

### Inset map

- Simplemaps `world.svg` (152 KB, MIT, `viewbox="0 0 2000 857"`), committed with
  its license notice intact.
- It is a **Robinson** projection, so markers need a Robinson forward transform,
  not a linear scale. Measured calibration from 2026-11-02, with residuals under
  1 unit:
  `x = 985.70 + 5.6579 · X`, `y = 501.94 − 518.393 · Y`, where `X` and `Y` come
  from the standard Robinson table (`X = PLEN(lat) · lon`, `Y = ±PDFE(lat)`).
- The great-circle path is sampled and projected, then drawn as a polyline.

## Admin

A new place to read the log, by night, showing the fields above. Sorting,
filtering and exact placement are the builder's to design, following the existing
admin structure, then shown to the operator. HF status (hunting, listening,
offline) and Skip are visible in the admin tool. Icons are `lucide-static` only.

## Receiver: SpyServer

Measured from the server on 2026-11-02:

| | |
| --- | --- |
| Server | `192.168.1.30:5555`, protocol v2.0.1922 |
| Device | Type 2 (Airspy HF+) |
| Control | `CanControl: 1` |
| Rate | 768 kHz, 660 kHz usable, 8 decimation stages |
| Format | 16-bit |
| Reported range | 0–1.7 GHz; don't trust this for limits |

- The native helper already reads IQ through an `IqSource` interface
  (`native/src/live.hpp:31`), which `RtlSource` implements. A `SpyServerSource`
  is the seam, so CB and shortwave reuse the existing channelizer, lanes, AGC,
  limiter and ALSA path.
- **Proven in Plan 1.** `SpyServerSource` works through this seam. `Channelizer` only
  accepts multiples of 50 kHz, so HF IQ is resampled to 750 kHz. `IqBlock` stays u8,
  with SpyServer digital gain: at the server's default level u8 is nearly empty. WWV was received and
  demodulated correctly on 2.5, 5, 10 and 15 MHz, and tuning error is about 0.09 ppm,
  so no frequency correction is needed. Gain is a required knob, default 32, with no
  clipping and only marginal stations missed against 16-bit, in daylight. Re-measure
  after dark.
- **Window centres go off the 5 kHz raster.** The survey can't see the exact centre, so a
  centre on the raster loses that channel on every visit.
- **Squelch needs an HF rule.** The existing squelch was open in only 94 of 179
  reports, so "plays stations the scanner hits" needs a rule based on the survey.
- FernSDR and SpyServer can't share the radio. FernSDR did not answer on port
  8073 on 2026-11-02, and the operator has moved the Pi to SpyServer.

## Constraints and known problems

1. **SAME break-in audio: respawn the helper, approved by the operator on 2026-11-02**
   (`docs/bench/2026-11-hf-proofs.md`). Moving from SpyServer to KIOSK01 is a helper
   respawn, measured through Node at about 1.0 s to NWR audio, inside the operator's 2 s.
   Fallback if that stops holding: KIOSK03 supplies the audio (0.115 s, needs
   `--pcm-in-fd` ported).
   This is a deliberate, narrow exception to "a break-in is a `retune()`, never
   `stop()+start()`", for HF mode only, because a retune can't change the radio. The
   invariant's reasons still bind: no warm-up overlay, banner kept, `breakIn` guard
   kept. Map mode and every other break-in stay retunes. KIOSK01 stays idle in HF mode.
2. **The `mode` value is public, but renaming it looks safe.** `/api/status`
   returns `"mode": "cb"` today, and jeremyfuksa.com polls that endpoint. In the
   local checkout the site only passes the value through
   (`src/pages/api/tinkering.json.ts:341`), with no comparison found in
   `Kerchunk.astro` or `signals.ts`. Its type (`:211`) already omits `"cb"`, so
   `"hf"` is no worse, though the type should be widened. Update `docs/API.md`.
3. **`feat/cb-fernsdr` is unmerged and conflicts with `main`.** It removes the
   native LSB demod that `main` merged in #299. With SpyServer most of that branch
   is obsolete, so the plan is to build from `main` and retire it. CB parts worth
   keeping, such as watching all 40 channels from one window, are the builder's
   to port. The kiosk may be running that branch, and with FernSDR gone its CB
   mode is likely offline until this ships.
4. **Heat.** The helper alone ran 27% of a core, and the box averaged 52 °C for an
   hour, but with the service stopped, so no wall updates and no weather helper. That
   doesn't show HF runs cooler than map mode. The A/B with the real wall stage ran
   on 2026-11-03: HF peaked 51 °C against 64 °C for map mode (bench notes).
5. **Audio gaps over Wi-Fi.** The link stays on Wi-Fi, per the operator on 2026-11-02. A
   500 ms speaker buffer removes the gaps from bursty arrival in the bench. One unexplained
   2 s stall also happened before the soak, so Node's respawn after exit 3 must stay graceful.
6. **Config.** All behaviour knobs go in config (window timer, cooldown,
   thresholds, bands, CB switch times, SpyServer address). `radios[]` is read once at
   boot.
7. **Mode persistence is new.** Mode is in memory and starts as `"scan"`
   (`server.ts:242`). Persisting it applies to all modes and changes today's
   behaviour, where a restart returns to map mode. Boot must still go through
   `toScanConfig`. A SAME break-in's temporary `"weather"` mode must not be saved
   as the active mode, so a restart mid-alert returns to the mode the operator set.

## Verifying

- `npm test`, `npm run test:native`, `npm run typecheck`, `npm run build`.
- Pure logic (band stepping, station choice, the CB switch, record merging, schedule
  matching, Robinson transform) is unit-tested headless.
- On hardware, by ear and on the live wall: a full night run, a switch to CB and
  back, a SAME test break-in from both CB and shortwave, a SpyServer
  outage, and a thermal A/B.

## Left to the builder

- Whether SpyServer is read in the native helper or elsewhere, given constraint 1.
- SpyServer protocol details, with `CanControl` handled when false.
- Schema, table and config names; admin layout; how the first pass orders bands.
- Whether the CB code and config are renamed in one change or in stages.
- Order of work and PR slicing (small PRs per repo convention).
