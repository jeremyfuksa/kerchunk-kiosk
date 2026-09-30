// kiosk/src/backend/config/schema.ts
import { z } from "zod";
import { isCtcssTone } from "./ctcss.js";
import { isDcsCode } from "./dcs.js";
import { wallWatchdogSchema } from "../wallWatchdog.js";

// airplanes.live REST base, over HTTPS. The endpoint 301s http -> https, so a
// cleartext base spent two requests and two TCP connections per poll — double
// the rate-limit budget the 5s cadence is sized against, and double the surface
// for the transient connection errors that surface as an opaque "fetch failed".
export const AIRPLANES_LIVE_URL = "https://api.airplanes.live/v2/point";
/** The superseded cleartext base. Persisted in every config written before the
 *  fix, where it shadows the new default — migrated on load (see `aircraft`). */
export const LEGACY_AIRPLANES_LIVE_URL = "http://api.airplanes.live/v2/point";

// Where a transmitter lives, when an identification source knows. Captured
// from RepeaterBook (lat/lon/city/state) or RadioReference; source records
// which database said so.
export const locationSchema = z.object({
  lat: z.number().optional(),
  lon: z.number().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  source: z.string(),
  // FCC license data (fccprox): transmitter power and antenna height feed
  // the map's coverage-radius blips.
  powerWatts: z.number().positive().optional(),
  antennaHaatM: z.number().positive().optional(),
  // true = powerWatts is the RF estimator's guess, not a license — kept
  // refreshable (estimates update as rfDb accumulates; licenses never move).
  powerEstimated: z.boolean().optional(),
});

// The channel fields as a plain object schema (server PUT/POST use .partial()
// / .omit(), which a refined schema lacks); channelSchema adds the cross-field
// rules.
export const channelObjectSchema = z.object({
  id: z.string().min(1),
  freq: z.number().int().positive(),
  alphaTag: z.string(),
  mode: z.enum(["fm", "nfm", "am"]),
  enabled: z.boolean(),
  // Audibility: an enabled channel with audible:false gets
  // a DSP lane (hits land in history/Recent/map) but never owns the speaker.
  // Absent = true. enabled:false means archived: identity/location remain, but
  // the channel stops consuming scanner capacity.
  audible: z.boolean().optional(),
  // Priority channels preempt the speaker from non-priority ones when both
  // are active in the same group (hardware-scanner "priority scan").
  priority: z.boolean().optional(),
  // Alerts (ROADMAP Idea 6): a hit on this channel flashes the kiosk, lands
  // in the alert feed, and temporarily plays a silent tracked channel through
  // the speaker. An archived channel is never demodulated, so it cannot alert.
  alert: z.boolean().optional(),
  // Median received RF power (dB, helper units), EMA over transmissions —
  // the ERP estimator's measurement input. Server-owned telemetry.
  rfDb: z.number().optional(),
  // CTCSS tone squelch: when set, the helper opens this channel only while
  // this sub-audible tone is present (co-channel users on other tones, or
  // none, stay silent). Must be one of the 50 standard tones (./ctcss.ts).
  // FM only — the helper ignores it on AM channels.
  ctcssHz: z.number().refine(isCtcssTone, { message: "ctcssHz must be a standard CTCSS tone" }).optional(),
  // The last CTCSS tone the helper heard on this channel while open.
  // Server-owned telemetry like rfDb — shown in the channel drawer so the
  // operator can fill ctcssHz.
  heardCtcssHz: z.number().optional(),
  // DCS (Digital-Coded Squelch): "023N" / "023I" — one of the 104 standard
  // codes (./dcs.ts) plus polarity. When set, the helper opens this channel
  // only while that code is present. FM only; never together with ctcssHz.
  dcsCode: z.string().refine(isDcsCode, { message: "dcsCode must be a standard DCS code like 023N" }).optional(),
  // The last DCS code the helper heard on this channel while open, in the
  // on-air normal form (an inverted code reads as its normal twin, ./dcs.ts).
  // Server-owned telemetry like heardCtcssHz.
  heardDcs: z.string().optional(),
  // (levelTrimDb — the retired per-channel loudness trim — is gone: the
  // helper's speaker AGC levels every transmission instead. Old config files
  // that still carry it parse fine; zod strips the unknown key.)
  // Service tags — the operator-defined axis banks pivot on ("air", "rail").
  tags: z.array(z.string().min(1)).optional(),
  location: locationSchema.optional(),
  // When identification last ran for this channel (hit OR miss) — misses are
  // recorded so the boot enrichment pass doesn't re-query every restart.
  lookedUpAt: z.number().optional(),
});

/** A channel squelches on at most one sub-audible scheme: CTCSS or DCS. */
export function oneSubAudible(c: { ctcssHz?: number; dcsCode?: string }): boolean {
  return c.ctcssHz === undefined || c.dcsCode === undefined;
}
const SUB_AUDIBLE_MSG = { message: "ctcssHz and dcsCode are mutually exclusive", path: ["dcsCode"] };

export const channelSchema = channelObjectSchema.refine(oneSubAudible, SUB_AUDIBLE_MSG);
/** POST body shape: a channel without its server-assigned id. */
export const newChannelSchema = channelObjectSchema.omit({ id: true }).refine(oneSubAudible, SUB_AUDIBLE_MSG);

// Scanner front-end defaults and limits live in engineDefaults.ts (zod-free,
// so the admin bundle can import them); re-exported for existing importers.
import {
  DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_FLAT_BANDWIDTH_HZ, LANE_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
} from "./engineDefaults.js";
export {
  DEFAULT_WINDOW_BANDWIDTH_HZ, DEFAULT_LANES_PER_GROUP, DEFAULT_SAMPLE_RATE_HZ,
  DEFAULT_FLAT_BANDWIDTH_HZ, MAX_LANES_PER_GROUP, MIN_SAMPLE_RATE_HZ, MAX_SAMPLE_RATE_HZ,
};

export const configSchema = z.object({
  version: z.literal(1),
  scan: z.object({
    sampleRate: z.number().int().positive(),
    squelchLevel: z.number().int().nonnegative(),
    gain: z.union([z.number(), z.literal("auto")]),
    dwellMs: z.number().int().positive(),
    // Wideband engine tuning (optional; RtlFmEngine ignores these).
    // Usable I/Q window for grouping — keep under the dongle's ~2.4 MHz
    // instantaneous bandwidth to leave guard band.
    // Flat part of the SDR passband (Hz): grouping keeps channels inside
    // +-flat/2 of the tune center wherever it costs no extra group, and every
    // channel >= 25 kHz off the DC spike. Default 2 000 000 (measured roll-off).
    flatBandwidthHz: z.number().int().positive().optional(),
    windowBandwidthHz: z.number().int().positive().optional(),
    // kerchunk-dsp lane slots per group (--lanes). Grouping caps each group at
    // this many channels; more lanes = fewer groups = a shorter scan cycle.
    // Omitted = 12 (the GNU-Radio-era cost cap; native lanes are cheap).
    // Changing it respawns the scanner helper (spawn arg).
    lanesPerGroup: z.number().int().min(1).max(MAX_LANES_PER_GROUP).optional(),
    // Scanner front-end sample rate (Hz, --rate). Must be a whole number of
    // 50 kHz lanes and fit the RTL-SDR's range. windowBandwidthHz must be at
    // most (sampleRateHz - 50 kHz) — see the refine below. Omitted = 2.4 Msps.
    // Changing it respawns the scanner helper (spawn arg).
    sampleRateHz: z.number().int().min(MIN_SAMPLE_RATE_HZ).max(MAX_SAMPLE_RATE_HZ)
      .refine((r) => r % LANE_HZ === 0, { message: "sampleRateHz must be a multiple of 50000" })
      .optional(),
    // Dwell per group before hopping to the next (hold-through overrides).
    groupDwellMs: z.number().int().positive().optional(),
    // Activity-weighted dwell: each group's quiet dwell (groupDwellMs x bank
    // dwellWeight) is scaled by its recent traffic — factor = clamp((a+1) /
    // (mean+1), minFactor, maxFactor), a = opens decayed with halfLifeMin.
    // Never shrinks a dwell below 1 s. Node-side scheduling: a PUT applies it
    // live (no helper respawn). Omitted = enabled, 30 min, 0.5, 2.0.
    autoDwell: z.object({
      enabled: z.boolean().optional(),
      halfLifeMin: z.number().min(1).max(1440).optional(),
      minFactor: z.number().min(0.2).max(1).optional(),
      maxFactor: z.number().min(1).max(5).optional(),
    }).optional(),
    // Priority revisit: every everyMs of quiet dwell on non-priority groups,
    // peek at a priority channel's group (round-robin) for lookMs, then resume
    // the interrupted group. An open during the look holds as usual. lookMs
    // must cover the ~0.64 s post-hop warm-up before a lane can open. Live
    // like autoDwell. Omitted = enabled, 8000, 700.
    priorityRevisit: z.object({
      enabled: z.boolean().optional(),
      everyMs: z.number().int().min(1000).max(60_000).optional(),
      lookMs: z.number().int().min(300).max(5000).optional(),
    }).optional(),
    // Ceiling on ONE continuous hold-through (default 180 s). A lane that
    // reads open past this is treated as stuck and abandoned so it can't park
    // the scanner. Applied at engine construction — changing it needs a
    // backend restart, not just a config PUT.
    maxHoldMs: z.number().int().positive().optional(),
    // Ceiling on the DSP helper's respawn backoff (default 30 s). Consecutive
    // failed spawns double the delay up to this; a helper whose SDR is absent
    // must not respawn every second. Also engine-construction
    // time — needs a backend restart.
    maxRestartDelayMs: z.number().int().positive().optional(),
    // Helper liveness watchdogs (both helpers). Ready: no "ready" this long
    // after spawn = wedged device open (default 10 s). Silence: no helper
    // event other than a log line this long after ready = hung DSP (default
    // 5 s; the helper emits power every 200 ms). Either kills + respawns the
    // helper. Engine-construction time — needs a backend restart.
    helperReadyTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    helperSilenceTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    // Squelch: open when channel power exceeds its learned noise floor by
    // this many dB (close threshold sits 3 dB lower for hysteresis).
    openAboveFloorDb: z.number().positive().optional(),
    // Quieting squelch: discriminator HF-noise level (dB) BELOW which a
    // channel counts as carrier-quieted. Power without quieting never opens
    // (rejects spurs/AGC pumping/broadband bursts — non-voice junk). On
    // kerchunk-dsp's own scale: lower = more quieted; dead channels read ~-2,
    // keyed carriers ~-30. Passed as --quiet-db. Omitted = the helper's
    // QUIET_DB_DEFAULT (-7). (Legacy configs may still carry the retired
    // GNU-Radio-scale `noiseQuietDb` — the schema strips it on load.)
    nativeQuietDb: z.number().optional(),
    // AM speaker gain offset (dB): balances airband loudness against FM by
    // ear (normalized AM audio vs de-emphasized FM don't naturally match).
    // Passed as --am-gain-db. Omitted = 0 dB (the helper's AM_GAIN).
    nativeAmGainDb: z.number().min(-30).max(20).optional(),
    // FM speaker audio low-pass cutoff (Hz). FM hiss rises with frequency, so
    // this is the weak-signal hiss knob: lower = less hiss, duller voice.
    // Passed as --audio-lpf-hz. Omitted = 2700 (GR nbfm_rx parity).
    fmAudioLpfHz: z.number().min(1000).max(24000).optional(),
    // FM speaker high-pass cutoff (Hz): strips the sub-audible CTCSS tone
    // (67-254 Hz) repeaters send under the voice. 0 = off. Passed as
    // --audio-hpf-hz. Omitted = 300 (6th-order Butterworth in the helper).
    fmAudioHpfHz: z.number().refine((v) => v === 0 || (v >= 50 && v <= 1000), "0 (off) or 50-1000 Hz").optional(),
    // Close Call: discover strong transmissions in the tuned window on
    // non-configured frequencies. Plays them (priority preempt) and auto-adds
    // them as DISABLED channels for operator review. Default ON (wideband).
    closeCall: z.boolean().optional(),
    // Discovery threshold: dB over the window's median noise floor. Eager by
    // default (15) per operator preference.
    closeCallDb: z.number().positive().optional(),
    // Close Call sample recording (#222): capture a short clip of each Close
    // Call hit so a discovery can be triaged by ear instead of by retuning the
    // live radio at a frequency that is usually quiet. Flipping this is an
    // ENGINE RESTART — it changes a helper spawn arg (the fd-3 PCM tee).
    recordCloseCalls: z.boolean().optional(),
    // Per-clip length cap, seconds. The clip includes a 2 s pre-roll, so the
    // floor (PREROLL_SECONDS + 1 = 3) guarantees at least 1 s of actual hit
    // audio survives the cap — below that the "clip" would be pre-roll only,
    // recorded before the Close Call lane ever took the speaker.
    // The ceiling is a memory guard, not taste: the in-flight clip is held in
    // RAM at the tee's rate (~96 kB/s), inside the audio callback, so an
    // unbounded value would mean a multi-hundred-MB Buffer.concat on the one
    // path that must never stall. Two minutes of a single transmission is
    // already far past what triage needs.
    closeCallSampleSeconds: z.number().min(3).max(120).optional(),
    // Total budget for the clip directory, MB. Oldest clips are evicted first.
    // Capped so a typo can't hand the sweep a budget the state partition
    // cannot honour.
    closeCallSampleMaxMb: z.number().positive().max(2_000).optional(),
    // Close Call band-sweep ranges (stretch phase 2): one empty-window
    // stop per rotation hunts inside these. Empty/absent = no sweeping.
    sweepRanges: z.array(z.object({
      loHz: z.number().int().positive(),
      hiHz: z.number().int().positive(),
    })).optional(),
    // Close Call lockouts: frequencies that must NEVER trigger discovery
    // again (noise sources, data links the operator dismissed).
    lockoutHz: z.array(z.number().int().positive()).optional(),
  }).superRefine((s, ctx) => {
    // A window wider than (rate - one lane) can't place its edge channels.
    const rate = s.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ;
    const window = s.windowBandwidthHz ?? DEFAULT_WINDOW_BANDWIDTH_HZ;
    if (window > rate - LANE_HZ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["windowBandwidthHz"],
        message: `windowBandwidthHz ${window} exceeds sampleRateHz ${rate} minus ${LANE_HZ} (edge channels can't be placed)`,
      });
    }
  }),
  audio: z.object({
    sink: z.string().min(1),
    volume: z.number().int().min(0).max(100),
    muted: z.boolean(),
    // Remote listening (/api/stream.wav, ROADMAP stretch): when OFF (default)
    // the helper builds no PCM tee — the post-limiter float->s16 conversion and
    // fd-write are skipped, saving idle CPU on every box. Opt-in because the
    // feed is rarely listened to. Toggling it respawns the helper (the tee is a
    // helper spawn arg).
    remoteListening: z.boolean().default(false),
    // Speaker loudness (kerchunk-dsp's AGC/compressor + peak limiter; they
    // replaced the per-channel level trims). All optional: omitted = the
    // helper's defaults (native/src/constants.hpp). Scanner helper only — the
    // weather helper has no speaker. Changing any of them respawns the scanner
    // helper (they are spawn args); volume/mute stay live.
    // Output level the AGC steers every talker to (mean-square dBFS). Default -18.
    agcTargetDb: z.number().min(-40).max(-3).optional(),
    // Most boost for a quiet talker / weak AM (dB). Default 15.
    agcMaxGainDb: z.number().min(0).max(30).optional(),
    // Most cut for a hot talker (dB). Default -20.
    agcMinGainDb: z.number().min(-40).max(0).optional(),
    // Envelope time constant while the level rises / falls (ms). Defaults 10 / 400.
    agcAttackMs: z.number().min(1).max(200).optional(),
    agcReleaseMs: z.number().min(20).max(5000).optional(),
    // Below this short-term level (dBFS) the AGC treats audio as a pause and
    // freezes, so gaps between words never pump the gain up. Default -50.
    agcHoldBelowDb: z.number().min(-90).max(-20).optional(),
    // Peak limiter ceiling (linear full scale, <= the 0.8 hard rail) and its
    // release (ms). Defaults 0.7 / 50.
    limiterCeiling: z.number().gt(0).max(0.8).optional(),
    limiterReleaseMs: z.number().min(5).max(1000).optional(),
    // ALSA mixer target for volume/mute. amixer addresses controls by card
    // INDEX or NAME + control NAME, which differ per device (e.g. HDMI exposes
    // no volume control; the Pi headphone jack is card 2 / "PCM"). Prefer the
    // NAME ("PCH"): card indices are assigned in probe order and can swap
    // across boots when multiple controllers race (bit the Ubuntu laptop on
    // its first appliance boot). Optional so existing configs default to
    // card 0 / "Master".
    mixerCard: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
    // ALSA control volume/mute drive. Omitted or "auto" = the live output
    // (Headphone when the jack is plugged, else Master) — see audio.ts.
    mixerControl: z.string().min(1).optional(),
  }),
  // Banks (ROADMAP Idea 1): channel collections. A bank is a predicate over
  // derived band and/or service tags. Its controls apply explicit bulk edits;
  // individual channel state remains authoritative. See config/banks.ts.
  banks: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    // Legacy bank-state fields remain parseable for existing configs but no
    // longer override individual channels.
    audible: z.boolean().optional(),
    band: z.enum(["hf", "vhf", "uhf", "shf"]).optional(),
    // Explicit frequency range (Hz) — finer than band: "2m" = 144-148 MHz,
    // "70cm" = 420-450. Lets the bank rail show WHICH slice of spectrum is
    // being swept, and makes outband activity obvious by omission.
    loHz: z.number().int().positive().optional(),
    hiHz: z.number().int().positive().optional(),
    tags: z.array(z.string().min(1)).optional(),
    // Per-bank scan profile (ROADMAP Idea 7) — overrides the global scan
    // block for this bank's channels. Resolution: field-wise first-match
    // in config order among enabled banks; absent = global. Squelch pair
    // (openAboveFloorDb/hangMs) applies per CHANNEL (windows can mix banks); dwellWeight applies
    // per WINDOW (max across its channels — the busiest bank dominates).
    openAboveFloorDb: z.number().positive().optional(),
    hangMs: z.number().positive().optional(),
    dwellWeight: z.number().positive().optional(),
  })).optional(),
  // Kiosk header extras: clock is always on; weather needs a location
  // (NWS gridpoint resolution wants lat/lon — the operator's zip resolved
  // once at config time).
  display: z.object({
    weatherLat: z.number(),
    weatherLon: z.number(),
    // Maps JavaScript API key for the /map view (operator-chosen provider).
    googleMapsApiKey: z.string().optional(),
    // Server-side Google Places key for business-frequency guessing (the
    // BusinessGuess lookup provider searches "is this chain near the QTH?").
    // Absent = reuse googleMapsApiKey. Split it out only if the map key is
    // HTTP-referrer-restricted (server calls send no Referer): supply an
    // unrestricted/IP-restricted key here with Places API (New) enabled.
    placesApiKey: z.string().optional(),
    // Cloud-console Map ID: switches /map to a VECTOR map with fractional
    // zoom so auto-fit lands exactly on the pin field (raster maps floor to
    // integer zoom — z9.7 becomes z9, double the area). Dark cartography
    // then lives in the console style; absent = raster + in-code style.
    googleMapsMapId: z.string().optional(),
    // Map framing (defaults to the QTH at zoom 10). The operator framed the
    // metro from a google.com/maps URL: @lat,lon,zoom.
    mapLat: z.number().optional(),
    mapLon: z.number().optional(),
    mapZoom: z.number().int().optional(),
    // Radar overlay product (defaults to "n0q").
    //   "n0q" — IEM's cached NEXRAD base-reflectivity mosaic. Familiar green
    //     dBZ palette, but raw: paints clear-air green (bugs, ground clutter,
    //     AP) on dry days.
    //   "mrms-reflectivity" — NOAA's MRMS quality-controlled 1 km base
    //     reflectivity. Same green palette as n0q, but dual-pol QC strips the
    //     clear-air clutter, so dry days stay clean. Best of both.
    //   "mrms-preciprate" — IEM MRMS Q3 2-minute precipitation. Fully
    //     precip-gated (empty over clear air), but a rainfall-rate palette
    //     (blue = light) with low 2-minute dynamic range.
    radarProduct: z
      .enum(["n0q", "mrms-reflectivity", "mrms-preciprate"])
      .optional(),
  }).optional(),
  // Aircraft overlay (network ADS-B): plots airborne targets near the QTH on
  // the kiosk map from the airplanes.live public feed (no SDR, no DSP). Off by
  // default; see docs/superpowers/specs/2026-06-18-aircraft-overlay-design.md.
  aircraft: z.object({
    enabled: z.boolean().default(false),
    // Coverage radius around the QTH (km). airplanes.live /v2/point takes
    // nautical miles; the poller converts. 75 km ≈ 40 nm.
    radiusKm: z.number().positive().default(75),
    pollIntervalMs: z.number().int().positive().default(5000),
    // Nearest-N cap: with "all within radius" a busy metro can return many
    // targets; keep the nearest this-many to bound marker churn.
    maxTargets: z.number().int().positive().default(60),
    // airplanes.live REST base. The poller appends /{lat}/{lon}/{radiusNm}.
    // Migrates the superseded cleartext default (which every config written
    // before the fix has persisted, where it would otherwise shadow the new
    // one) — but only that exact value: a custom http:// base is a self-hosted
    // receiver on the LAN and must keep its scheme.
    url: z.string().url()
      .default(AIRPLANES_LIVE_URL)
      .transform((u) => (u === LEGACY_AIRPLANES_LIVE_URL ? AIRPLANES_LIVE_URL : u)),
    // Comet trails: a short, fading line behind each aircraft, accumulated
    // client-side from the snapshots and redrawn only on the poll tick (no
    // animation). Off by default — keeps the wall uncluttered.
    trails: z.boolean().default(false),
  }).optional(),
  // Wall watchdog (src/backend/wallWatchdog.ts): restarts kerchunk-display
  // when the wall page stops heartbeating. Absent = every default (on).
  wallWatchdog: wallWatchdogSchema.optional(),
  // Multi-SDR (ROADMAP Idea 10): role assignments by device identity.
  // Prefer SERIAL (e.g. "KIOSK01") — the helper resolves it to the exact dongle
  // regardless of librtlsdr enumeration order, which the USB PORT->index map
  // got wrong with two dongles on a hub. PORT ("1-1.2") remains as a fallback
  // for dongles with no usable serial. At least one of serial/port is required.
  // scan = the group-hopping voice radio; weather = parked on NWR 24/7 (SAME
  // gold tier, decode-only, no speaker); adsb = reserved for the dump1090
  // sidecar. Absent = single-radio behavior, first device found.
  radios: z.array(z.object({
    serial: z.string().min(1).optional(),          // e.g. "KIOSK01" (preferred)
    port: z.string().min(1).optional(),            // e.g. "1-1.2" (fallback)
    role: z.enum(["scan", "weather", "adsb"]),
    label: z.string().optional(),
  }).refine((r) => r.serial !== undefined || r.port !== undefined, {
    message: "radio needs a serial or a port",
  })).optional(),
  // Alert behavior (ROADMAP Idea 6) — deliberately a couple of knobs, not a
  // rules engine. cooldownMinutes: a channel re-alerts only after this quiet
  // window (first hit fires, repeats don't). holdSeconds: how long a see-only
  // alert channel keeps the speaker. ntfyUrl: optional push — POST the alert
  // text to an ntfy topic (or any webhook that accepts a text body).
  alerts: z.object({
    cooldownMinutes: z.number().positive().optional(),
    holdSeconds: z.number().positive().optional(),
    ntfyUrl: z.string().url().optional(),
    // SAME/EAS scoping: county FIPS codes (5-digit SSCCC or 6-digit
    // PSSCCC). Empty = every decoded alert fires. Tests (RWT/RMT) always
    // land in the feed but only banner when sameTests is true.
    sameFips: z.array(z.string()).optional(),
    sameTests: z.boolean().optional(),
  }).optional(),
  // RepeaterBook lookup (Close Call enrichment). userAgent must be the
  // string REGISTERED with RepeaterBook; states are full names ("Missouri").
  lookup: z.object({
    userAgent: z.string().min(1),
    // App token issued on RepeaterBook API approval (March 2026 policy:
    // token + approved User-Agent are BOTH required). Sent as the
    // X-RB-App-Token header. Absent = provider stays dormant (their
    // endpoint 401s with auth_missing without it).
    apiToken: z.string().optional(),
    states: z.array(z.string().min(1)).min(1),
    // RadioReference fallback (business band / public safety). Requires an
    // approved developer appKey + the OPERATOR'S premium credentials; all
    // stay in this config file on the appliance, never in the repo.
    radioReference: z.object({
      appKey: z.string().min(1),
      username: z.string().min(1),
      password: z.string().min(1),
      // Empty = configured but dormant (counties not resolved yet). A min(1)
      // here once silently invalidated an operator's whole hand-edited
      // config (load fell back to .bak and ate his credentials — twice).
      countyIds: z.array(z.number().int().positive()),
    }).optional(),
  }).optional(),
  // Close Call discoveries pending operator review — deliberately SEPARATE
  // from channels (the table is what the operator chose; this is what the
  // radio found). Reviewed in admin: Listen / Add / Lockout / Dismiss.
  discoveries: z.array(z.object({
    id: z.string().min(1),
    freq: z.number().int().positive(),
    alphaTag: z.string(),
    ts: z.number(),
    // Modulation as identified by the lookup chain (FMN, DMR, P25, ...) —
    // tells the operator whether a discovery is even decodable as analog.
    mode: z.string().optional(),
    location: locationSchema.optional(),
    lookedUpAt: z.number().optional(),
    // Listenability triage (Close Call pipeline): false = identified as
    // paging/data/undecodable digital — promote as seen-not-heard.
    audible: z.boolean().optional(),
    // Repeated unidentified carriers can be hidden from normal triage without
    // being forgotten or rediscovered. Restoring clears these fields.
    hitCount: z.number().int().positive().optional(),
    lastSeenAt: z.number().optional(),
    suppressedAt: z.number().optional(),
    suppressionReason: z.string().optional(),
  })).optional(),
  // One channel designated as "the weather channel", stored separately from the
  // scan list. Weather-only mode (server runtime) holds this channel.
  weatherChannel: channelSchema.optional(),
  channels: z.array(channelSchema),
});

export type Channel = z.infer<typeof channelSchema>;
export type Bank = NonNullable<z.infer<typeof configSchema>["banks"]>[number];
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return {
    version: 1,
    // squelchLevel is an RMS open-threshold. Bench-measured noise floor ~150,
    // noise spikes ~1436, real signal ~2900. 1800 clears the noise spikes with
    // margin while staying below signal, avoiding constant false squelch-opens.
    scan: { sampleRate: 12000, squelchLevel: 1800, gain: "auto", dwellMs: 2000 },
    audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false, remoteListening: false },
    channels: [],
  };
}
