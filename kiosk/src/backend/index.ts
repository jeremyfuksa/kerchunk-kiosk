import { WebSocketServer } from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import { WsHub } from "./ws.js";
import { RtlFmEngine } from "./engine/RtlFmEngine.js";
import { FakeEngine } from "./engine/FakeEngine.js";
import { WidebandEngine } from "./engine/WidebandEngine.js";
import type { EngineEvent } from "./engine/ScannerEngine.js";

const PORT = Number(process.env.PORT ?? 8080);
const CONFIG_PATH = process.env.KERCHUNK_CONFIG ?? "/var/lib/kerchunk-kiosk/config.json";
const STATIC_DIR = process.env.KERCHUNK_STATIC
  ?? join(fileURLToPath(new URL("../frontend", import.meta.url)));
// Engine selection: KERCHUNK_ENGINE=wideband|rtlfm|fake. USE_FAKE_ENGINE=1 is
// honored as the legacy spelling of "fake". Default stays the proven rtl_fm
// engine so wideband rolls out behind an explicit switch.
const engineKind = process.env.KERCHUNK_ENGINE
  ?? (process.env.USE_FAKE_ENGINE === "1" ? "fake" : "rtlfm");

const configStore = new ConfigStore(CONFIG_PATH);
const config = configStore.load();
const activityLog = new ActivityLog(500);
const wsHub = new WsHub();
// Map persisted scan tuning onto the engine's PCM-energy squelch: squelchLevel
// is the RMS open-threshold, dwellMs is the silence hang time before hopping.
const engine =
  engineKind === "fake" ? new FakeEngine()
  : engineKind === "wideband" ? new WidebandEngine()
  : new RtlFmEngine({
      openThreshold: config.scan.squelchLevel,
      hangMs: config.scan.dwellMs,
    });

engine.on((ev: EngineEvent) => {
  if (ev.type === "active") {
    activityLog.add({ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts });
  }
  wsHub.broadcast(ev);
});

const { server } = createServer({ configStore, engine, activityLog, wsHub, staticDir: STATIC_DIR });

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => wsHub.attach(ws));

server.listen(PORT, () => {
  console.log(`kerchunk-kiosk listening on :${PORT} (engine: ${engineKind})`);
  engine.start({
    channels: config.channels,
    sampleRate: config.scan.sampleRate,
    squelchLevel: config.scan.squelchLevel,
    dwellMs: config.scan.dwellMs,
    gain: config.scan.gain,
    audioSink: config.audio.sink,
    windowBandwidthHz: config.scan.windowBandwidthHz,
    groupDwellMs: config.scan.groupDwellMs,
    openAboveFloorDb: config.scan.openAboveFloorDb,
  })
    // Re-apply persisted volume/mute to the hardware mixer on boot, so the saved
    // setting actually takes effect instead of inheriting the OS mixer state.
    .then(() => engine.setVolume(config.audio.volume))
    .then(() => engine.setMuted(config.audio.muted))
    .catch((err) => console.error("engine start failed:", err));
});

process.on("SIGTERM", async () => { await engine.stop(); server.close(); process.exit(0); });
process.on("SIGINT", async () => { await engine.stop(); server.close(); process.exit(0); });
