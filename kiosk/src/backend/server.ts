import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { configSchema, channelSchema, type Config, type Channel } from "./config/schema.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import type { LookupProvider } from "./lookup.js";
import type { NwsWeather } from "./weather.js";
import type { HistoryStore } from "./history.js";
import { WsHub } from "./ws.js";
import type { EngineEvent, ScannerEngine, ScanConfig } from "./engine/ScannerEngine.js";
import { setVolume as amixerVolume, setMuted as amixerMuted, type AmixerOpts } from "./audio.js";
import { isScannable, isAudible, profileFor } from "./config/banks.js";
import { collides, findDuplicateSets } from "./config/channelDedup.js";
import { solveK, estimateWatts, distKm, type Anchor } from "./powerEstimator.js";
import { parseSame, fipsMatch, fipsNames, isTest } from "./same.js";
import { SystemStats } from "./systemStats.js";

export interface ServerDeps {
  /** Optional identification chain — enriches Close Call channel names. */
  lookup?: LookupProvider;
  /** Boot enrichment pass pacing (tests shrink these). */
  lookupPass?: { initialDelayMs?: number; spacingMs?: number };
  /** Optional current-conditions provider for the kiosk header. */
  weather?: Pick<NwsWeather, "current">;
  /** Optional durable activity history (ROADMAP Idea 5). */
  history?: Pick<HistoryStore, "record" | "release" | "query" | "sites" | "stats">
    & Partial<Pick<HistoryStore, "setRf">>;
  /** Dedicated weather radio engine (Idea 10): its SAME events feed the
   *  same tee as the main engine's. */
  weatherEngine?: ScannerEngine;
  configStore: ConfigStore;
  engine: ScannerEngine;
  activityLog: ActivityLog;
  wsHub: WsHub;
  staticDir: string;
  /** Request a supervised backend-process restart after the response is sent. */
  restartBackend?: () => void;
  /** Enable temporary thermal load-shedding on the appliance process. */
  selfProtect?: boolean;
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

export function toScanConfig(
  cfg: Config,
  mode: "scan" | "weather" | "monitor",
  monitorChannel: Channel | null = null,
): ScanConfig {
  const channels =
    mode === "weather"
      ? (cfg.weatherChannel ? [{ ...cfg.weatherChannel, enabled: true }] : [])
      : mode === "monitor"
        ? (monitorChannel ? [{ ...monitorChannel, enabled: true }] : [])
        // Individual channel state is authoritative. Banks are collections
        // whose admin controls apply explicit bulk edits, never hidden runtime
        // overrides. knownHz below intentionally still covers EVERY configured
        // channel so archived channels are not rediscovered by Close Call.
        : [
            ...cfg.channels
              .filter((c) => isScannable(c, cfg.banks ?? []))
              // Bank scan profiles (Idea 7) resolve here too — the engine and
              // helper only ever see concrete per-channel numbers.
              .map((c) => ({
                ...c,
                audible: isAudible(c, cfg.banks ?? []),
                ...profileFor(c, cfg.banks ?? []),
              })),
            // SAME (Idea 11): with a dedicated weather radio (Idea 10) the
            // decode moves there full-time (gold tier) and the scan stops
            // visiting; otherwise NWR rides along as a BACKGROUND channel —
            // its own group, demodulated into the decoder tap whenever the
            // hop visits, never opens/holds/speaks (visiting-slot tier).
            ...(cfg.weatherChannel && !cfg.radios?.some((r) => r.role === "weather")
              ? [{
                  ...cfg.weatherChannel,
                  id: "wx_same", alphaTag: "NWR (SAME decode)",
                  enabled: true, audible: false, background: true,
                }]
              : []),
          ];
  return {
    channels,
    sampleRate: cfg.scan.sampleRate,
    squelchLevel: cfg.scan.squelchLevel,
    dwellMs: cfg.scan.dwellMs,
    gain: cfg.scan.gain,
    audioSink: cfg.audio.sink,
    // Wideband engine tuning; RtlFmEngine/FakeEngine ignore these.
    windowBandwidthHz: cfg.scan.windowBandwidthHz,
    groupDwellMs: cfg.scan.groupDwellMs,
    openAboveFloorDb: cfg.scan.openAboveFloorDb,
    noiseQuietDb: cfg.scan.noiseQuietDb,
    sweepRanges: cfg.scan.sweepRanges,
    // Weather-only AND direct-tune both hold the lone channel open/audible
    // with no squelch — the operator chose to listen to exactly this.
    monitor: mode === "weather" || mode === "monitor",
    // Close Call suppression covers everything already known about:
    // configured channels, filed discoveries, and permanent lockouts.
    knownHz: [
      ...(cfg.weatherChannel ? [cfg.weatherChannel.freq] : []),
      ...cfg.channels.map((c) => c.freq),
      ...(cfg.discoveries ?? []).map((d) => d.freq),
      ...(cfg.scan.lockoutHz ?? []),
    ],
    closeCall: cfg.scan.closeCall,
    closeCallDb: cfg.scan.closeCallDb,
    lockoutHz: cfg.scan.lockoutHz,
    detectVia: cfg.scan.detectVia,
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function createServer(deps: ServerDeps): { server: Server } {
  const { configStore, engine, activityLog, staticDir } = deps;
  let config = configStore.load();
  // Runtime mode. Deliberately not read from or written to config: the kiosk
  // always boots into scan mode. "monitor" = direct tune (review a discovery
  // or any channel); its target lives only in memory.
  let mode: "scan" | "weather" | "monitor" = "scan";
  let monitorChannel: Channel | null = null;

  // One-time migration: earlier Close Call builds filed discoveries as
  // DISABLED cc_* channels in the main table. Move them where they belong.
  {
    const legacy = config.channels.filter((c) => c.id.startsWith("cc_") && !c.enabled);
    if (legacy.length > 0) {
      const existing = new Set((config.discoveries ?? []).map((d) => d.freq));
      config = {
        ...config,
        channels: config.channels.filter((c) => !(c.id.startsWith("cc_") && !c.enabled)),
        discoveries: [
          ...(config.discoveries ?? []),
          ...legacy.filter((c) => !existing.has(c.freq)).map((c) => ({
            id: c.id, freq: c.freq,
            alphaTag: c.alphaTag.replace(/ \(Close Call\)$/, ""),
            ts: Date.now(),
          })),
        ],
      };
      configStore.save(config);
    }
  }

  // Boot enrichment pass: fill location (and stamp lookedUpAt) for channels
  // that have never been identified. Sequential and paced — the providers
  // cache hard, but RadioReference still sees up to one query per county for
  // each NEW frequency, and their guidance is "don't hammer". Misses are
  // stamped too, so a frequency that matches nothing is asked about at most
  // once per 30 days, not on every boot.
  if (deps.lookup) {
    const LOOKUP_RETRY_MS = 30 * 24 * 3600 * 1000;
    const initialDelayMs = deps.lookupPass?.initialDelayMs ?? 15_000;
    const spacingMs = deps.lookupPass?.spacingMs ?? 1_000;
    const passTimer = setTimeout(async () => {
      const now = Date.now();
      const pending = config.channels.filter((c) =>
        !c.location && (!c.lookedUpAt || now - c.lookedUpAt > LOOKUP_RETRY_MS));
      for (const ch of pending) {
        try {
          // The channel's existing name is the hint FccProx needs to
          // name-gate license candidates before frequency-confirming.
          const hit = await deps.lookup!.lookup(ch.freq, { name: ch.alphaTag });
          config = {
            ...config,
            channels: config.channels.map((c) =>
              c.id === ch.id
                ? { ...c, lookedUpAt: Date.now(), ...(hit?.location ? { location: hit.location } : {}) }
                : c),
          };
          configStore.save(config);
        } catch { /* provider failure: try again next boot */ }
        await new Promise((r) => setTimeout(r, spacingMs));
      }
      // Discoveries too: anything filed before mode/location capture existed
      // (or that missed) gets one identification attempt per 30 days.
      const pendingDisc = (config.discoveries ?? []).filter((d) =>
        (!d.mode || !d.location) && (!d.lookedUpAt || now - d.lookedUpAt > LOOKUP_RETRY_MS));
      for (const disc of pendingDisc) {
        try {
          const hit = await deps.lookup!.lookup(disc.freq);
          config = {
            ...config,
            discoveries: (config.discoveries ?? []).map((d) =>
              d.id === disc.id
                ? {
                    ...d, lookedUpAt: Date.now(),
                    ...(hit ? { alphaTag: hit.tag } : {}),
                    ...(hit?.mode ? { mode: hit.mode } : {}),
                    ...(hit?.location ? { location: hit.location } : {}),
                    ...(hit?.listen ? { audible: hit.listen === "voice" } : {}),
                  }
                : d),
          };
          configStore.save(config);
        } catch { /* next boot */ }
        await new Promise((r) => setTimeout(r, spacingMs));
      }
    }, initialDelayMs);
    passTimer.unref?.();
  }

  // Cold-start readiness for the kiosk "WARMING UP" overlay. Tracked from the
  // engine's warm-up milestones, NOT engine.state (which flips to "running"
  // before the helper is up). A page that loads AFTER warm-up never receives
  // the WS warmup events, so it reads this flag once on mount to skip the
  // overlay; an actively-observed fresh boot drives the overlay over WS.
  let warmed = false;
  engine.on((ev) => {
    if (ev.type !== "warmup") return;
    if (ev.phase === "booting") warmed = false;
    else if (ev.phase === "ready") warmed = true;
  });

  // Durable history tee: every opening/discovery/release, enriched with the
  // channel's tags/location at the moment it happened.
  if (deps.history) {
    const history = deps.history;
    engine.on((ev) => {
      if (ev.type === "active") {
        history.record({
          ts: ev.ts, kind: "active", channelId: ev.channel.id,
          freq: ev.freq, alphaTag: ev.channel.alphaTag, mode: ev.channel.mode,
          tags: ev.channel.tags,
          lat: ev.channel.location?.lat, lon: ev.channel.location?.lon,
        });
      } else if (ev.type === "release") {
        history.release(ev.channelId, ev.ts);
      } else if (ev.type === "closecall") {
        history.record({
          ts: ev.ts, kind: "closecall", channelId: `cc_${ev.freqHz}`,
          freq: ev.freqHz, alphaTag: `Close Call ${(ev.freqHz / 1e6).toFixed(4)}`,
        });
      }
    });
  }

  // ── Alerts (ROADMAP Idea 6): a hit on a flagged channel, outside its
  // cooldown, flashes the kiosk (WS "alert"), lands in the alert feed
  // (history kind "alert"), optionally pushes to ntfy, and — when the channel
  // is see-only — pulls its audio into the speaker for the hold window.
  // Synthesized HERE, not in the engine: alert flags and knobs are config,
  // which the engine deliberately knows nothing about.
  const lastAlertTs = new Map<string, number>();
  engine.on((ev) => {
    if (ev.type !== "active") return;
    const ch = config.channels.find((c) => c.id === ev.channel.id);
    if (!ch?.alert) return;
    const cooldownMs = (config.alerts?.cooldownMinutes ?? 15) * 60_000;
    const last = lastAlertTs.get(ch.id);
    if (last !== undefined && ev.ts - last < cooldownMs) return;
    lastAlertTs.set(ch.id, ev.ts);
    const holdSeconds = config.alerts?.holdSeconds ?? 30;
    deps.wsHub.broadcast({ type: "alert", channel: ch, freq: ev.freq, holdSeconds, ts: ev.ts });
    deps.history?.record({
      ts: ev.ts, kind: "alert", channelId: ch.id, freq: ev.freq,
      alphaTag: ch.alphaTag, mode: ch.mode, tags: ch.tags,
      lat: ch.location?.lat, lon: ch.location?.lon,
    });
    // Pull-in: a see-only channel is demodulated but muted — break it into
    // the speaker. An audible channel is already playing; nothing to do.
    if (!isAudible(ch, config.banks ?? [])) {
      engine.alertUnmute?.(ch.id, holdSeconds);
    }
    const ntfyUrl = config.alerts?.ntfyUrl;
    if (ntfyUrl) {
      void fetch(ntfyUrl, {
        method: "POST",
        headers: { Title: `Kerchunk alert: ${ch.alphaTag}`, Priority: "high", Tags: "rotating_light" },
        body: `${ch.alphaTag} active on ${(ev.freq / 1e6).toFixed(4)} MHz`,
      }).catch(() => { /* push is best-effort */ });
    }
  });

  // Close Call discoveries persist as DISABLED channels for operator review.
  // Saved WITHOUT persistAndReload: a disabled channel doesn't affect
  // scanning, and an engine restart here would kill the live discovery audio
  // (the helper is playing the find on a spare lane right now).
  // Leveler trims: persist so they survive hops/restarts. Saved WITHOUT
  // reload — a trim is telemetry, not a scan-config change. cc lanes have no
  // config channel and are skipped.
  // Trim updates land in memory immediately but persist on a trailing
  // debounce: during an initial loudness correction the helper emits one
  // event per ~0.5 dB (~25/s) and each save() is a .bak copy + atomic write —
  // unthrottled, that's needless SSD wear for telemetry.
  let levelSaveTimer: NodeJS.Timeout | null = null;
  engine.on((ev) => {
    if (ev.type !== "level") return;
    const ch = config.channels.find((c) => c.id === ev.channelId);
    if (!ch || ch.levelTrimDb === ev.db) return;
    config = {
      ...config,
      channels: config.channels.map((c) =>
        c.id === ev.channelId ? { ...c, levelTrimDb: ev.db } : c),
    };
    if (levelSaveTimer) clearTimeout(levelSaveTimer);
    levelSaveTimer = setTimeout(() => {
      levelSaveTimer = null;
      configStore.save(config, { telemetry: true });
    }, 10_000);
    levelSaveTimer.unref?.();
  });

  // RF telemetry tee: per-transmission median received power -> channel.rfDb
  // (EMA, persisted on a trailing debounce like the leveler trims). This is
  // the ERP estimator's measurement input.
  let rfSaveTimer: NodeJS.Timeout | null = null;
  engine.on((ev) => {
    if (ev.type !== "rf") return;
    deps.history?.setRf?.(ev.channelId, ev.db);
    const ch = config.channels.find((c) => c.id === ev.channelId);
    if (!ch) return;
    const next = ch.rfDb === undefined ? ev.db : ch.rfDb + 0.3 * (ev.db - ch.rfDb);
    config = {
      ...config,
      channels: config.channels.map((c) =>
        c.id === ev.channelId ? { ...c, rfDb: Math.round(next * 10) / 10 } : c),
    };
    if (rfSaveTimer) clearTimeout(rfSaveTimer);
    rfSaveTimer = setTimeout(() => { rfSaveTimer = null; configStore.save(config, { telemetry: true }); }, 30_000);
    rfSaveTimer.unref?.();
  });

  // ── ERP estimator (operator idea): licensed channels are calibration
  // anchors; everything located + measured gets an estimated powerWatts so
  // its blips render at physical coverage. Estimates stay refreshable
  // (powerEstimated flag); licensed values are never touched.
  function runPowerEstimate(): { anchors: number; estimated: Array<{ alphaTag: string; watts: number }> } {
    const home = config.display
      ? { lat: config.display.weatherLat, lon: config.display.weatherLon }
      : null;
    if (!home) return { anchors: 0, estimated: [] };
    const anchors: Anchor[] = config.channels
      .filter((c) => c.rfDb !== undefined && c.location?.lat != null
        && c.location.powerWatts && !c.location.powerEstimated)
      .map((c) => ({
        rfDb: c.rfDb!, powerWatts: c.location!.powerWatts!,
        distKm: distKm(home, { lat: c.location!.lat!, lon: c.location!.lon! }),
        freqMhz: c.freq / 1e6,
      }));
    const k = solveK(anchors);
    if (k === null) return { anchors: anchors.length, estimated: [] };
    const estimated: Array<{ alphaTag: string; watts: number }> = [];
    config = {
      ...config,
      channels: config.channels.map((c) => {
        if (c.rfDb === undefined || c.location?.lat == null) return c;
        if (c.location.powerWatts && !c.location.powerEstimated) return c; // licensed
        const watts = estimateWatts(
          c.rfDb, distKm(home, { lat: c.location.lat, lon: c.location.lon! }),
          c.freq / 1e6, k);
        if (c.location.powerWatts === watts) return c;
        estimated.push({ alphaTag: c.alphaTag, watts });
        return { ...c, location: { ...c.location, powerWatts: watts, powerEstimated: true } };
      }),
    };
    if (estimated.length > 0) configStore.save(config);
    return { anchors: anchors.length, estimated };
  }
  const estTimer = setInterval(() => { runPowerEstimate(); }, 12 * 3600 * 1000);
  estTimer.unref?.();

  // ── System health (ROADMAP Idea 16): host + DSP-helper stats, sampled
  // into a 5-minute ring. openCount rides the engine's own events so a
  // spike correlates with what the radio was doing at that moment.
  const openIds = new Set<string>();
  engine.on((ev) => {
    if (ev.type === "active") openIds.add(ev.channel.id);
    else if (ev.type === "release") openIds.delete(ev.channelId);
    else if (ev.type === "status" || ev.type === "idle") openIds.clear();
  });
  let safetyMode = false;
  let safetyTransition = false;
  // True for the duration of a SAME weather break-in. While set, safetyMode
  // tracks the temperature but must NOT bounce the engine: a break-in is brief
  // (minutes), the operator needs the warning audio uninterrupted, and the
  // hardware thermal-throttle is the real backstop. (A live alert decoded at a
  // 89°C resting peak pushed the sustained-monitor break-in past 90°C and the
  // restart-to-shed cut the audio with a cold-start chop.)
  let breakIn = false;
  const sysStats = new SystemStats({
    helperPid: () => (engine as { helperPid?: number | null }).helperPid ?? null,
    openCount: () => openIds.size,
    dataDir: "/var/lib/kerchunk-kiosk",
    onSample: (sample) => {
      if (!deps.selfProtect) return;
      const shouldProtect = sample.tempC !== null && sample.tempC >= 90;
      const recovered = sample.tempC !== null && sample.tempC <= 78;
      if (safetyTransition || (shouldProtect === safetyMode) || (!safetyMode && !shouldProtect) || (safetyMode && !recovered)) return;
      safetyMode = shouldProtect; // track the flag for /api/system regardless
      console.error(`[safety] tempC=${sample.tempC} safetyMode=${safetyMode}${breakIn ? " (break-in active: not bouncing)" : ""}`);
      // Never tear the engine down mid weather break-in (see `breakIn` above).
      if (breakIn) return;
      // Only bounce the engine when shedding would actually change the running
      // config. With Close Call already off and no sweeps there is NOTHING to
      // shed, so a restart would just re-show the kiosk "WARMING UP" overlay and
      // add heat on every thermal blip — exactly the wrong move near the limit.
      const nothingToShed = config.scan.closeCall === false
        && (config.scan.sweepRanges?.length ?? 0) === 0;
      if (nothingToShed) return;
      safetyTransition = true;
      const effective = safetyMode
        ? { ...config, scan: { ...config.scan, closeCall: false, sweepRanges: [] } }
        : config;
      void engine.stop().then(() => engine.start(toScanConfig(effective, mode, monitorChannel)))
        .finally(() => { safetyTransition = false; });
    },
  });
  sysStats.start();

  // ── SAME / EAS (ROADMAP Idea 11): decoded headers off the NWR lane.
  // Visiting-slot tier — the decoder only hears NWR while its window is
  // tuned, so this catches SOME alert bursts, honestly supplementary.
  // Headers repeat 3x: dedupe by raw text for 90 s. Matching alerts ride
  // the existing alert plumbing (banner + feed + ntfy).
  let lastSame: { raw: string; ts: number } | null = null;
  let sameRevertTimer: NodeJS.Timeout | null = null;
  const onSameEvent = (ev: EngineEvent): void => {
    if (ev.type !== "same") return;
    const hdr = parseSame(ev.raw);
    if (!hdr) return;
    if (lastSame && lastSame.raw === hdr.raw && ev.ts - lastSame.ts < 90_000) return;
    lastSame = { raw: hdr.raw, ts: ev.ts };
    const covered = fipsMatch(hdr.fips, config.alerts?.sameFips);
    const counties = fipsNames(hdr.fips, config.alerts?.sameFips);
    const test = isTest(hdr.event);
    // Everything decoded lands in history (the proof the lossy tier works);
    // the banner fires for covered real alerts (tests only when asked).
    deps.history?.record({
      ts: ev.ts, kind: "alert", channelId: "same",
      freq: config.weatherChannel?.freq ?? 162_550_000,
      alphaTag: `${hdr.eventName} — ${hdr.sender}${covered ? "" : " (out of area)"}`,
      mode: "SAME", tags: ["same"],
    });
    if (!covered || (test && !config.alerts?.sameTests)) return;
    const holdSeconds = Math.min(300, Math.max(60, hdr.purgeMinutes * 60));
    // Break-in (the Idea 11 pitch's second behavior): preempt the scan so the
    // NWR voice message PLAYS, then revert — consumer weather-radio break-in.
    // Applied via retune (re-point the live graph) not stop()+start(): a
    // restart replayed the WARMING UP overlay and cold-start audio chop every
    // time. retune hops in place — no overlay, no chop. The helperless RtlFm
    // fallback path keeps the old stop()+start(). Never preempts a monitor.
    const switchMode = (cfg: ScanConfig): void => {
      if (engine.retune) void engine.retune(cfg);
      else void engine.stop().then(() => engine.start(cfg));
    };
    if (!test && mode === "scan" && config.weatherChannel) {
      mode = "weather";
      monitorChannel = null;
      breakIn = true;   // freeze safetyMode bounces until we revert
      switchMode(toScanConfig(config, "weather"));
      if (sameRevertTimer) clearTimeout(sameRevertTimer);
      sameRevertTimer = setTimeout(() => {
        sameRevertTimer = null;
        breakIn = false;                  // break-in over; thermal management resumes
        if (mode !== "weather") return;   // operator changed it; leave alone
        mode = "scan";
        switchMode(toScanConfig(config, "scan"));
      }, Math.min(10 * 60_000, Math.max(120_000, hdr.purgeMinutes * 60_000)));
      sameRevertTimer.unref?.();
    }
    deps.wsHub.broadcast({
      type: "alert",
      channel: {
        id: "same", freq: config.weatherChannel?.freq ?? 162_550_000,
        alphaTag: hdr.eventName, mode: "nfm", enabled: true,
      },
      freq: config.weatherChannel?.freq ?? 162_550_000,
      holdSeconds, ts: ev.ts,
      // Affected counties (the matched ones) ride the banner so the operator
      // sees WHERE at a glance, not just the alert type.
      ...(counties ? { counties } : {}),
    });
    const ntfyUrl = config.alerts?.ntfyUrl;
    if (ntfyUrl) {
      void fetch(ntfyUrl, {
        method: "POST",
        headers: { Title: `SAME: ${hdr.eventName}`, Priority: "urgent", Tags: "warning" },
        body: `${hdr.eventName} from ${hdr.sender}, ${hdr.purgeMinutes} min — ${hdr.raw}`,
      }).catch(() => { /* push is best-effort */ });
    }
  };
  engine.on(onSameEvent);
  deps.weatherEngine?.on(onSameEvent);

  // Persistence-before-filing: one FFT transient used to file a discovery
  // forever; now a frequency must hit TWICE (helper cooldown spaces hits
  // >=5 min) before it earns a row. Real signals come back; junk doesn't.
  // Every hit still plays live and lands in history regardless.
  const ccSeen = new Map<number, number>();
  const CC_FILE_AFTER = 2;
  engine.on((ev) => {
    if (ev.type !== "closecall") return;
    // Channels are the operator's choices; discoveries are the radio's finds.
    if (config.channels.some((c) => c.freq === ev.freqHz)) return;
    const existing = (config.discoveries ?? []).find((d) => d.freq === ev.freqHz);
    if (existing) {
      const hitCount = (existing.hitCount ?? CC_FILE_AFTER) + 1;
      const unidentified = existing.alphaTag.startsWith("Close Call ") && !existing.location && !existing.mode;
      config = {
        ...config,
        discoveries: (config.discoveries ?? []).map((d) => d.id === existing.id ? {
          ...d, hitCount, lastSeenAt: ev.ts,
          ...(unidentified && hitCount >= 6 && !d.suppressedAt
            ? { suppressedAt: ev.ts, suppressionReason: "Repeated unidentified carrier" } : {}),
        } : d),
      };
      configStore.save(config);
      return;
    }
    const seen = (ccSeen.get(ev.freqHz) ?? 0) + 1;
    ccSeen.set(ev.freqHz, seen);
    if (seen < CC_FILE_AFTER) return;
    const discovery = {
      id: `cc_${randomUUID().slice(0, 8)}`,
      freq: ev.freqHz,
      alphaTag: `Close Call ${(ev.freqHz / 1e6).toFixed(4)}`,
      ts: Date.now(),
      hitCount: seen,
      lastSeenAt: ev.ts,
    };
    config = { ...config, discoveries: [...(config.discoveries ?? []), discovery] };
    configStore.save(config);
    // Best-effort identification — a miss or API failure keeps the plain name.
    if (deps.lookup) {
      void deps.lookup.lookup(ev.freqHz).then((hit) => {
        if (!hit) return;
        config = {
          ...config,
          discoveries: (config.discoveries ?? []).map((d) =>
            d.id === discovery.id
              ? {
                  ...d, alphaTag: hit.tag,
                  ...(hit.mode ? { mode: hit.mode } : {}),
                  ...(hit.location ? { location: hit.location } : {}),
                  // Listenability triage (operator rule): identified data/
                  // paging/digital files as seen-not-heard.
                  ...(hit.listen ? { audible: hit.listen === "voice" } : {}),
                }
              : d),
        };
        configStore.save(config);
      }).catch(() => { /* enrichment is optional */ });
    }
  });

  // Persist config AND restart the scanner so changes (e.g. editing channels in
  // the admin) take effect immediately, instead of only after a service restart.
  async function persistAndReload(): Promise<void> {
    configStore.save(config);
    await engine.stop();
    await engine.start(toScanConfig(config, mode, monitorChannel));
  }

  // amixer target from config: volume/mute must hit the card+control that
  // actually drives the configured sink (e.g. headphone jack = card 2 / "PCM";
  // HDMI typically has none). Undefined fields fall back to amixer's defaults.
  function mixerOpts(): AmixerOpts {
    return { card: config.audio.mixerCard, control: config.audio.mixerControl };
  }

  const server = httpCreateServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/api/")) {
        await handleApi(method, path, req, res);
        return;
      }
      serveStatic(path, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  async function handleApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (method === "GET" && path === "/api/config") return json(res, 200, config);

    if (method === "PUT" && path === "/api/config") {
      const body = await readBody(req);
      const parsed = configSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid config", issues: parsed.error.issues });
      const prev = config;
      config = parsed.data;
      configStore.save(config);
      // Monitor orphan cleanup: if the monitored frequency was removed from
      // every list by this update, fall back to scanning instead of sitting
      // on a frequency that no longer exists anywhere.
      if (mode === "monitor" && monitorChannel) {
        const f = monitorChannel.freq;
        const stillKnown = config.channels.some((c) => c.freq === f)
          || (config.discoveries ?? []).some((d) => d.freq === f);
        if (!stillKnown) { mode = "scan"; monitorChannel = null; }
      }
      // Restart the engine only when the change is scan-RELEVANT. Pure
      // metadata (dismissing discoveries, lockout edits) only moves knownHz —
      // push that to the helper live instead of bouncing audio for ~1s.
      const before = toScanConfig(prev, mode, monitorChannel);
      const after = toScanConfig(config, mode, monitorChannel);
      const scanChanged = JSON.stringify({ ...before, knownHz: [] })
        !== JSON.stringify({ ...after, knownHz: [] });
      if (scanChanged) {
        await engine.stop();
        await engine.start(after);
      } else if (JSON.stringify(before.knownHz) !== JSON.stringify(after.knownHz)) {
        engine.updateKnownHz?.(after.knownHz ?? []);
      }
      return json(res, 200, config);
    }

    if (method === "GET" && path === "/api/channels") return json(res, 200, config.channels);

    if (method === "POST" && path === "/api/channels") {
      const body = await readBody(req);
      const parsed = channelSchema.omit({ id: true }).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid channel", issues: parsed.error.issues });
      const conflict = config.channels.find((c) => collides(c, { ...parsed.data, id: "" }));
      if (conflict) return json(res, 409, {
        error: `frequency already used by ${conflict.alphaTag || conflict.freq}`,
        conflictsWith: { id: conflict.id, alphaTag: conflict.alphaTag },
      });
      const channel: Channel = { id: `ch_${randomUUID().slice(0, 8)}`, ...parsed.data };
      config = { ...config, channels: [...config.channels, channel] };
      await persistAndReload();
      return json(res, 201, channel);
    }

    if (method === "GET" && path === "/api/channels/duplicates") {
      return json(res, 200, findDuplicateSets(config.channels));
    }

    if (method === "POST" && path === "/api/channels/duplicates/resolve") {
      const sets = findDuplicateSets(config.channels);
      // Losers = every row in each set except the richest (index 0).
      const remove = new Set<string>();
      for (const set of sets) for (const entry of set.channels.slice(1)) remove.add(entry.channel.id);
      if (remove.size > 0) {
        config = { ...config, channels: config.channels.filter((c) => !remove.has(c.id)) };
        await persistAndReload();
      }
      return json(res, 200, { removed: remove.size, setsResolved: sets.length });
    }

    const chMatch = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (chMatch) {
      const id = chMatch[1]!;
      if (method === "PUT") {
        if (!config.channels.some((c) => c.id === id)) return json(res, 404, { error: "unknown channel" });
        const body = await readBody(req);
        const parsed = channelSchema.partial().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "invalid channel" });
        const existing = config.channels.find((c) => c.id === id)!;
        const candidate = { ...existing, ...parsed.data } as Channel;
        const conflict = config.channels.find((c) => c.id !== id && collides(c, candidate));
        if (conflict) return json(res, 409, {
          error: `frequency already used by ${conflict.alphaTag || conflict.freq}`,
          conflictsWith: { id: conflict.id, alphaTag: conflict.alphaTag },
        });
        config = { ...config, channels: config.channels.map((c) => c.id === id ? { ...c, ...parsed.data, id } : c) };
        await persistAndReload();
        return json(res, 200, config.channels.find((c) => c.id === id));
      }
      if (method === "DELETE") {
        config = { ...config, channels: config.channels.filter((c) => c.id !== id) };
        await persistAndReload();
        return json(res, 204, null);
      }
    }

    if (method === "POST" && path === "/api/scan/skip") {
      const body = await readBody(req).catch(() => undefined);
      const holdoff = Number(body?.holdoffSeconds);
      engine.skip?.(Number.isFinite(holdoff) && holdoff > 0 ? holdoff : undefined);
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/scan/start") { await engine.start(toScanConfig(config, mode, monitorChannel)); return json(res, 200, { state: engine.state }); }
    if (method === "POST" && path === "/api/scan/stop") { await engine.stop(); return json(res, 200, { state: engine.state }); }

    if (method === "POST" && path === "/api/audio/volume") {
      const body = await readBody(req);
      const percent = Number(body?.percent);
      config = { ...config, audio: { ...config.audio, volume: percent } };
      await amixerVolume(percent, mixerOpts());
      configStore.save(config);
      return json(res, 200, { volume: config.audio.volume });
    }
    if (method === "POST" && path === "/api/audio/mute") {
      const body = await readBody(req);
      const muted = Boolean(body?.muted);
      config = { ...config, audio: { ...config.audio, muted } };
      await amixerMuted(muted, mixerOpts());
      configStore.save(config);
      return json(res, 200, { muted: config.audio.muted });
    }

    if (method === "GET" && path === "/api/weather-channel") {
      return json(res, 200, { weatherChannel: config.weatherChannel ?? null });
    }
    if (method === "PUT" && path === "/api/weather-channel") {
      const body = await readBody(req);
      const parsed = channelSchema.omit({ id: true }).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid weather channel", issues: parsed.error.issues });
      const weatherChannel: Channel = { id: `wx_${randomUUID().slice(0, 8)}`, ...parsed.data };
      config = { ...config, weatherChannel };
      configStore.save(config);
      return json(res, 200, { weatherChannel });
    }
    if (method === "POST" && path === "/api/mode") {
      const body = await readBody(req);
      const next = body?.mode;
      if (next !== "scan" && next !== "weather") return json(res, 400, { error: "invalid mode" });
      if (next === "weather" && !config.weatherChannel) {
        return json(res, 400, { error: "no weather channel configured" });
      }
      mode = next;
      monitorChannel = null;
      await engine.stop();
      await engine.start(toScanConfig(config, mode));
      return json(res, 200, { mode, state: engine.state });
    }

    if (method === "POST" && path === "/api/monitor") {
      const body = await readBody(req);
      const freq = Number(body?.freq);
      if (!Number.isInteger(freq) || freq <= 0) return json(res, 400, { error: "invalid freq" });
      // Demod mode: explicit request > the configured channel/discovery at
      // this frequency > nfm. Auditioning AM airband must not demod as FM.
      // (Discovery modes are identification strings — DMR, NFM, AM — so only
      // the demodulatable ones count.)
      const asDemod = (m: unknown): Channel["mode"] | undefined => {
        const low = typeof m === "string" ? m.toLowerCase() : "";
        return low === "fm" || low === "nfm" || low === "am" ? low : undefined;
      };
      const known = config.channels.find((c) => c.freq === freq)
        ?? (config.discoveries ?? []).find((d) => d.freq === freq);
      const mode_ = asDemod(body?.mode) ?? asDemod(known?.mode) ?? "nfm";
      monitorChannel = {
        id: "mon_direct", freq,
        alphaTag: typeof body?.alphaTag === "string" ? body.alphaTag : (freq / 1e6).toFixed(4),
        mode: mode_, enabled: true,
      };
      mode = "monitor";
      await engine.stop();
      await engine.start(toScanConfig(config, mode, monitorChannel));
      return json(res, 200, { mode, monitor: monitorChannel });
    }

    if (method === "POST" && path === "/api/monitor/stop") {
      mode = "scan";
      monitorChannel = null;
      await engine.stop();
      await engine.start(toScanConfig(config, mode));
      return json(res, 200, { mode, state: engine.state });
    }

    if (method === "POST" && path === "/api/power/estimate") {
      return json(res, 200, runPowerEstimate());
    }

    if (method === "GET" && path === "/api/system") {
      return json(res, 200, { ...sysStats.snapshot(), safetyMode });
    }

    if (method === "GET" && path === "/api/recommendations/archive") {
      if (!deps.history) return json(res, 404, { error: "no history store" });
      const cutoff = Date.now() - 30 * 86_400_000;
      const heard = new Set(deps.history.query({ sinceMs: cutoff, kind: "active", limit: 5000 }).map((r) => r.freq));
      const heardBefore = new Set(deps.history.query({ untilMs: cutoff, kind: "active", limit: 5000 }).map((r) => r.freq));
      return json(res, 200, config.channels
        .filter((c) => c.enabled && !c.priority && c.location?.source !== "operator"
          && heardBefore.has(c.freq) && !heard.has(c.freq))
        .map((c) => ({ id: c.id, freq: c.freq, alphaTag: c.alphaTag, audible: c.audible !== false })));
    }

    if (method === "GET" && path === "/api/stream.wav") {
      // Remote listening (ROADMAP stretch): the live speaker feed as an
      // endless WAV. 48 kHz mono s16 = ~94 KB/s — trivial on the LAN.
      const onAudio = (engine as { onAudio?: (l: (c: Buffer) => void) => () => void }).onAudio?.bind(engine);
      if (!onAudio) return json(res, 404, { error: "engine has no audio tee" });
      const hdr = Buffer.alloc(44);
      hdr.write("RIFF", 0); hdr.writeUInt32LE(0xffffffff, 4); hdr.write("WAVE", 8);
      hdr.write("fmt ", 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20);
      hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(48000, 24);
      hdr.writeUInt32LE(48000 * 2, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34);
      hdr.write("data", 36); hdr.writeUInt32LE(0xffffffff, 40);
      res.writeHead(200, {
        "Content-Type": "audio/wav",
        "Cache-Control": "no-store",
        Connection: "close",
      });
      res.write(hdr);
      const unsub = onAudio((chunk) => {
        // Slow client: drop chunks rather than buffer unboundedly — live
        // audio has no business being seconds behind.
        if (res.writableLength < 256 * 1024) res.write(chunk);
      });
      req.on("close", unsub);
      return;
    }

    if (method === "POST" && path === "/api/kiosk/reload") {
      // Soft kiosk reload: the dashboard WS client reloads its page —
      // fresh bundle + re-fetched Maps script/style, no systemd involved.
      deps.wsHub.broadcast({ type: "reload", ts: Date.now() });
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && path === "/api/backend/restart") {
      if (!deps.restartBackend) return json(res, 503, { error: "backend restart unavailable" });
      json(res, 202, { ok: true });
      setTimeout(() => deps.restartBackend?.(), 100).unref?.();
      return;
    }

    if (method === "GET" && path === "/api/history") {
      if (!deps.history) return json(res, 404, { error: "no history store" });
      const sp = new URL(req.url ?? "/", "http://localhost").searchParams;
      const num = (k: string) => sp.has(k) ? Number(sp.get(k)) : undefined;
      return json(res, 200, deps.history.query({
        sinceMs: num("since"), untilMs: num("until"), freq: num("freq"),
        tag: sp.get("tag") ?? undefined,
        kind: sp.get("kind") ?? undefined,
        limit: num("limit"),
      }));
    }

    if (method === "GET" && path === "/api/history/sites") {
      if (!deps.history) return json(res, 404, { error: "no history store" });
      return json(res, 200, deps.history.sites());
    }

    if (method === "GET" && path === "/api/stats") {
      if (!deps.history) return json(res, 404, { error: "no history store" });
      const sp = new URL(req.url ?? "/", "http://localhost").searchParams;
      const since = sp.has("since") ? Number(sp.get("since")) : Date.now() - 86_400_000;
      return json(res, 200, deps.history.stats(since));
    }

    if (method === "GET" && path === "/api/weather") {
      if (!deps.weather) return json(res, 404, { error: "no weather configured" });
      return json(res, 200, await deps.weather.current());
    }

    if (method === "GET" && path === "/api/status") {
      return json(res, 200, {
        state: engine.state, mode, monitor: monitorChannel,
        // How many channels the current mode actually scans — 0 with every
        // bank muted, where the kiosk should say "standby", not "scanning".
        scanCount: toScanConfig(config, mode, monitorChannel).channels.length,
        // The kiosk shows a MUTED badge — mute doesn't restart the engine,
        // so the dashboard polls this instead of waiting for a WS event.
        muted: config.audio.muted,
        // Cold-start readiness: false until the engine completes its first warm
        // sweep. Lets a late-loading kiosk page skip the WARMING UP overlay.
        warmed,
      });
    }
    if (method === "GET" && path === "/api/logs") return json(res, 200, activityLog.entries());

    return json(res, 404, { error: "not found" });
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(staticDir, safe === "/" || safe === "/map" ? "index.html" : safe);
    if (!existsSync(filePath) || !extname(filePath)) filePath = join(staticDir, "index.html");
    if (!existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    // Cache discipline: HTML must revalidate every load (it names the
    // hashed bundles — a cached copy resurrects the OLD UI after deploys,
    // bitten 2026-06-07); the hashed assets themselves are immutable.
    const hashed = /assets\//.test(filePath);
    res.writeHead(200, {
      "content-type": mime,
      "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(readFileSync(filePath));
  }

  return { server };
}
