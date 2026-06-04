import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { configSchema, channelSchema, type Config, type Channel } from "./config/schema.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import type { LookupProvider } from "./lookup.js";
import { WsHub } from "./ws.js";
import type { ScannerEngine, ScanConfig } from "./engine/ScannerEngine.js";
import { setVolume as amixerVolume, setMuted as amixerMuted, type AmixerOpts } from "./audio.js";

export interface ServerDeps {
  /** Optional identification chain — enriches Close Call channel names. */
  lookup?: LookupProvider;
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

function toScanConfig(cfg: Config, mode: "scan" | "weather"): ScanConfig {
  const channels =
    mode === "weather"
      ? (cfg.weatherChannel ? [{ ...cfg.weatherChannel, enabled: true }] : [])
      : cfg.channels;
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
    // Weather-only = monitor: hold the lone channel open/audible, no squelch
    // (a continuous NOAA carrier can't be squelched against its own floor).
    monitor: mode === "weather",
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
  // Runtime scan/weather mode. Deliberately not read from or written to config:
  // the kiosk always boots into scan mode.
  let mode: "scan" | "weather" = "scan";

  // Close Call discoveries persist as DISABLED channels for operator review.
  // Saved WITHOUT persistAndReload: a disabled channel doesn't affect
  // scanning, and an engine restart here would kill the live discovery audio
  // (the helper is playing the find on a spare lane right now).
  // Leveler trims: persist so they survive hops/restarts. Saved WITHOUT
  // reload — a trim is telemetry, not a scan-config change. cc lanes have no
  // config channel and are skipped.
  engine.on((ev) => {
    if (ev.type !== "level") return;
    const ch = config.channels.find((c) => c.id === ev.channelId);
    if (!ch || ch.levelTrimDb === ev.db) return;
    config = {
      ...config,
      channels: config.channels.map((c) =>
        c.id === ev.channelId ? { ...c, levelTrimDb: ev.db } : c),
    };
    configStore.save(config);
  });

  engine.on((ev) => {
    if (ev.type !== "closecall") return;
    if (config.channels.some((c) => c.freq === ev.freqHz)) return;
    const mhz = (ev.freqHz / 1e6).toFixed(4);
    const channel: Channel = {
      id: `cc_${randomUUID().slice(0, 8)}`,
      freq: ev.freqHz,
      alphaTag: `Close Call ${mhz}`,
      mode: "nfm",
      enabled: false,
    };
    config = { ...config, channels: [...config.channels, channel] };
    configStore.save(config);
    // Best-effort identification (RepeaterBook): rename the filed channel if
    // the frequency matches a known ham/GMRS repeater. Fire-and-forget — a
    // miss or API failure leaves the plain "Close Call <MHz>" name.
    if (deps.lookup) {
      void deps.lookup.lookup(ev.freqHz).then((hit) => {
        if (!hit) return;
        config = {
          ...config,
          channels: config.channels.map((c) =>
            c.id === channel.id ? { ...c, alphaTag: `${hit.tag} (Close Call)` } : c),
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
    await engine.start(toScanConfig(config, mode));
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
      config = parsed.data;
      configStore.save(config);
      await engine.stop();
      await engine.start(toScanConfig(config, mode));
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

    if (method === "POST" && path === "/api/scan/start") { await engine.start(toScanConfig(config, mode)); return json(res, 200, { state: engine.state }); }
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
      await engine.stop();
      await engine.start(toScanConfig(config, mode));
      return json(res, 200, { mode, state: engine.state });
    }

    if (method === "GET" && path === "/api/status") return json(res, 200, { state: engine.state, mode, config });
    if (method === "GET" && path === "/api/logs") return json(res, 200, activityLog.entries());

    return json(res, 404, { error: "not found" });
  }

  function serveStatic(path: string, res: ServerResponse): void {
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(staticDir, safe === "/" ? "index.html" : safe);
    if (!existsSync(filePath) || !extname(filePath)) filePath = join(staticDir, "index.html");
    if (!existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(readFileSync(filePath));
  }

  return { server };
}
