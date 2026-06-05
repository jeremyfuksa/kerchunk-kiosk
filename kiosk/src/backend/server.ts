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
import type { ScannerEngine, ScanConfig } from "./engine/ScannerEngine.js";
import { setVolume as amixerVolume, setMuted as amixerMuted, type AmixerOpts } from "./audio.js";
import { isScannable, isAudible, profileFor } from "./config/banks.js";

export interface ServerDeps {
  /** Optional identification chain — enriches Close Call channel names. */
  lookup?: LookupProvider;
  /** Boot enrichment pass pacing (tests shrink these). */
  lookupPass?: { initialDelayMs?: number; spacingMs?: number };
  /** Optional current-conditions provider for the kiosk header. */
  weather?: Pick<NwsWeather, "current">;
  /** Optional durable activity history (ROADMAP Idea 5). */
  history?: Pick<HistoryStore, "record" | "release" | "query" | "sites" | "stats">;
  configStore: ConfigStore;
  engine: ScannerEngine;
  activityLog: ActivityLog;
  wsHub: WsHub;
  staticDir: string;
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
        // Banks gate scanning here, the same chokepoint as channel.enabled;
        // hear-vs-see resolves to a concrete audible flag per channel so the
        // engine/helper need no bank knowledge. knownHz below intentionally
        // still covers EVERY configured channel — muting a bank must not make
        // Close Call rediscover its frequencies.
        : cfg.channels
            .filter((c) => isScannable(c, cfg.banks ?? []))
            // Bank scan profiles (Idea 7) resolve here too — the engine and
            // helper only ever see concrete per-channel numbers.
            .map((c) => ({
              ...c,
              audible: isAudible(c, cfg.banks ?? []),
              ...profileFor(c, cfg.banks ?? []),
            }));
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
    // Weather-only AND direct-tune both hold the lone channel open/audible
    // with no squelch — the operator chose to listen to exactly this.
    monitor: mode === "weather" || mode === "monitor",
    // Close Call suppression covers everything already known about:
    // configured channels, filed discoveries, and permanent lockouts.
    knownHz: [
      ...cfg.channels.map((c) => c.freq),
      ...(cfg.discoveries ?? []).map((d) => d.freq),
      ...(cfg.scan.lockoutHz ?? []),
    ],
    closeCall: cfg.scan.closeCall,
    closeCallDb: cfg.scan.closeCallDb,
    lockoutHz: cfg.scan.lockoutHz,
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
      configStore.save(config);
    }, 2000);
    levelSaveTimer.unref?.();
  });

  engine.on((ev) => {
    if (ev.type !== "closecall") return;
    // Channels are the operator's choices; discoveries are the radio's finds.
    if (config.channels.some((c) => c.freq === ev.freqHz)) return;
    if ((config.discoveries ?? []).some((d) => d.freq === ev.freqHz)) return;
    const discovery = {
      id: `cc_${randomUUID().slice(0, 8)}`,
      freq: ev.freqHz,
      alphaTag: `Close Call ${(ev.freqHz / 1e6).toFixed(4)}`,
      ts: Date.now(),
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
      const channel: Channel = { id: `ch_${randomUUID().slice(0, 8)}`, ...parsed.data };
      config = { ...config, channels: [...config.channels, channel] };
      await persistAndReload();
      return json(res, 201, channel);
    }

    const chMatch = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (chMatch) {
      const id = chMatch[1]!;
      if (method === "PUT") {
        if (!config.channels.some((c) => c.id === id)) return json(res, 404, { error: "unknown channel" });
        const body = await readBody(req);
        const parsed = channelSchema.partial().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "invalid channel" });
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

    if (method === "POST" && path === "/api/kiosk/reload") {
      // Soft kiosk reload: the dashboard WS client reloads its page —
      // fresh bundle + re-fetched Maps script/style, no systemd involved.
      deps.wsHub.broadcast({ type: "reload", ts: Date.now() });
      return json(res, 200, { ok: true });
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
    res.writeHead(200, { "content-type": mime });
    res.end(readFileSync(filePath));
  }

  return { server };
}
