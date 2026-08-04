// kiosk/src/backend/config/schema.ts
import { z } from "zod";

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

export const channelSchema = z.object({
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
  // the ERP estimator's measurement input. Telemetry like levelTrimDb.
  rfDb: z.number().optional(),
  // Learned loudness trim (dB) from the per-channel leveler. Persisted by the
  // server from helper telemetry so trims survive group hops and restarts —
  // without this the first ~second of every transmission after a hop played
  // unleveled ("audio jumps", operator-reported).
  levelTrimDb: z.number().optional(),
  // Service tags — the operator-defined axis banks pivot on ("air", "rail").
  tags: z.array(z.string().min(1)).optional(),
  location: locationSchema.optional(),
  // When identification last ran for this channel (hit OR miss) — misses are
  // recorded so the boot enrichment pass doesn't re-query every restart.
  lookedUpAt: z.number().optional(),
});

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
    windowBandwidthHz: z.number().int().positive().optional(),
    // Dwell per group before hopping to the next (hold-through overrides).
    groupDwellMs: z.number().int().positive().optional(),
    // Ceiling on ONE continuous hold-through (default 180 s). A lane that
    // reads open past this is treated as stuck and abandoned so it can't park
    // the scanner. Applied at engine construction — changing it needs a
    // backend restart, not just a config PUT.
    maxHoldMs: z.number().int().positive().optional(),
    // Ceiling on the DSP helper's respawn backoff (default 30 s). Consecutive
    // failed spawns double the delay up to this; a helper whose SDR is absent
    // must not rebuild its flowgraph every second. Also engine-construction
    // time — needs a backend restart.
    maxRestartDelayMs: z.number().int().positive().optional(),
    // Squelch: open when channel power exceeds its learned noise floor by
    // this many dB (close threshold sits 3 dB lower for hysteresis).
    openAboveFloorDb: z.number().positive().optional(),
    // Quieting squelch: discriminator HF-noise level (dB) BELOW which a
    // channel counts as carrier-quieted. Power without quieting never opens
    // (rejects spurs/AGC pumping/broadband bursts — non-voice junk). Bench
    // default in the DSP helper: -86 (static ~-82, voice carrier -94..-96).
    noiseQuietDb: z.number().negative().optional(),
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
    // Power-detection source (ROADMAP DSP-efficiency): "lane" (default) reads
    // power from the 12 per-lane probes; "fft" derives it from the Close Call
    // FFT, shedding the per-lane power front-end (~0.5-0.7 cores). Quieting and
    // demod are unchanged in both. Default flips to "fft" only after the bench
    // A/B (see specs/2026-06-08-fft-detect-power-design.md).
    detectVia: z.enum(["lane", "fft"]).optional(),
    // Close Call band-sweep ranges (stretch phase 2): one empty-window
    // stop per rotation hunts inside these. Empty/absent = no sweeping.
    sweepRanges: z.array(z.object({
      loHz: z.number().int().positive(),
      hiHz: z.number().int().positive(),
    })).optional(),
    // Close Call lockouts: frequencies that must NEVER trigger discovery
    // again (noise sources, data links the operator dismissed).
    lockoutHz: z.array(z.number().int().positive()).optional(),
  }),
  audio: z.object({
    sink: z.string().min(1),
    volume: z.number().int().min(0).max(100),
    muted: z.boolean(),
    // Remote listening (/api/stream.wav, ROADMAP stretch): when OFF (default)
    // the helper builds no PCM tee — the post-limiter float->s16 conversion and
    // fd-write are skipped, saving idle CPU on every box. Opt-in because the
    // feed is rarely listened to. Toggling it respawns the helper (the tee is a
    // flowgraph block, built at spawn).
    remoteListening: z.boolean().default(false),
    // ALSA mixer target for volume/mute. amixer addresses controls by card
    // INDEX or NAME + control NAME, which differ per device (e.g. HDMI exposes
    // no volume control; the Pi headphone jack is card 2 / "PCM"). Prefer the
    // NAME ("PCH"): card indices are assigned in probe order and can swap
    // across boots when multiple controllers race (bit the Ubuntu laptop on
    // its first appliance boot). Optional so existing configs default to
    // card 0 / "Master".
    mixerCard: z.union([z.number().int().nonnegative(), z.string().min(1)]).optional(),
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
    // in config order among enabled banks; absent = global. Squelch trio
    // applies per CHANNEL (windows can mix banks); dwellWeight applies
    // per WINDOW (max across its channels — the busiest bank dominates).
    openAboveFloorDb: z.number().positive().optional(),
    noiseQuietDb: z.number().negative().optional(),
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
  // Multi-SDR (ROADMAP Idea 10): role assignments by device identity.
  // Prefer SERIAL (e.g. "KIOSK01") — SoapySDR resolves it to the exact dongle
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
