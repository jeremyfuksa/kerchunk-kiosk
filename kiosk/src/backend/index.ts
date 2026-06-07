import { WebSocketServer } from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, toScanConfig } from "./server.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import { WsHub } from "./ws.js";
import { RtlFmEngine } from "./engine/RtlFmEngine.js";
import { FakeEngine } from "./engine/FakeEngine.js";
import { WidebandEngine } from "./engine/WidebandEngine.js";
import { rtlIndexForPort } from "./radios.js";
import { setVolume, setMuted } from "./audio.js";
import { RepeaterBook } from "./repeaterbook.js";
import { RadioReference } from "./radioreference.js";
import { MyGmrs } from "./mygmrs.js";
import { FccProx } from "./fccprox.js";
import { composeLookups, type LookupProvider } from "./lookup.js";
import { NwsWeather } from "./weather.js";
import { HistoryStore } from "./history.js";
import { dirname } from "node:path";
import type { EngineEvent } from "./engine/ScannerEngine.js";

const PORT = Number(process.env.PORT ?? 8080);
const CONFIG_PATH = process.env.KERCHUNK_CONFIG ?? "/var/lib/kerchunk-kiosk/config.json";
const STATIC_DIR = process.env.KERCHUNK_STATIC
  ?? join(fileURLToPath(new URL("../frontend", import.meta.url)));
// Engine selection: KERCHUNK_ENGINE=wideband|rtlfm|fake. USE_FAKE_ENGINE=1 is
// honored as the legacy spelling of "fake". Default is the wideband engine —
// burned in on the appliance (simultaneous multi-channel, zero device
// re-opens); rtlfm remains selectable as the fallback for Pi-class hardware
// without GNU Radio.
const engineKind = process.env.KERCHUNK_ENGINE
  ?? (process.env.USE_FAKE_ENGINE === "1" ? "fake" : "wideband");

const configStore = new ConfigStore(CONFIG_PATH);
const config = configStore.load();
const activityLog = new ActivityLog(500);
const wsHub = new WsHub();
// Map persisted scan tuning onto the engine's PCM-energy squelch: squelchLevel
// is the RMS open-threshold, dwellMs is the silence hang time before hopping.
// Multi-SDR (Idea 10): roles bind to USB PORTS (these clones ignore EEPROM
// serials). The librtlsdr index is resolved fresh at every helper spawn —
// devnums shuffle on replug, the port never does.
const scanPort = config.radios?.find((r) => r.role === "scan")?.port;
const weatherPort = config.radios?.find((r) => r.role === "weather")?.port;
const engine =
  engineKind === "fake" ? new FakeEngine()
  : engineKind === "wideband" ? new WidebandEngine(
      scanPort ? { rtlIndex: () => rtlIndexForPort(scanPort) } : {})
  : new RtlFmEngine({
      openThreshold: config.scan.squelchLevel,
      hangMs: config.scan.dwellMs,
    });

// Dedicated weather radio: parked on NWR 24/7, decode-only (null audio
// sink — no speaker claim until the cross-device arbiter exists). SAME
// jumps from the visiting-slot tier to gold: every burst is heard.
const weatherEngine = engineKind === "wideband" && weatherPort && config.weatherChannel
  ? new WidebandEngine({ rtlIndex: () => rtlIndexForPort(weatherPort) })
  : undefined;

engine.on((ev: EngineEvent) => {
  if (ev.type === "active") {
    activityLog.add({ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts });
  }
  wsHub.broadcast(ev);
});

// Close Call identification chain: RepeaterBook (ham/GMRS, registered UA)
// then RadioReference (curated county DB, operator's premium credentials).
// Either or both may be configured; first hit wins.
const providers: LookupProvider[] = [];
if (config.lookup) {
  providers.push(new RepeaterBook({
    userAgent: config.lookup.userAgent,
    apiToken: config.lookup.apiToken,
    states: config.lookup.states,
    cacheDir: dirname(CONFIG_PATH),
  }));
  // GMRS repeaters: myGMRS is the authority (keyless). Needs the QTH for
  // nearest-wins on the eight shared channels.
  if (config.display) {
    providers.push(new MyGmrs({
      states: config.lookup.states,
      home: { lat: config.display.weatherLat, lon: config.display.weatherLon },
      userAgent: config.lookup.userAgent,
      cacheDir: dirname(CONFIG_PATH),
    }));
  }
  if (config.lookup.radioReference) {
    providers.push(new RadioReference(config.lookup.radioReference));
  }
  // FCC license proximity (stretch item): location backfill for business
  // channels RadioReference names but can't place. Same credentials; only
  // consulted when earlier providers left a hit location-less.
  if (config.lookup.radioReference && config.display) {
    const fcc = new FccProx({
      appKey: config.lookup.radioReference.appKey,
      username: config.lookup.radioReference.username,
      password: config.lookup.radioReference.password,
      home: { lat: config.display.weatherLat, lon: config.display.weatherLon },
      cacheDir: dirname(CONFIG_PATH),
    });
    providers.push(fcc);
    // Prime the metro license index in the background (gently paced; only
    // uncached callsigns are fetched, so after the first pass this is a
    // no-op). Once primed, bare-frequency Close Calls identify offline.
    const primeTimer = setTimeout(() => {
      void fcc.primeDetails().then((n) => {
        if (n > 0) console.error(`[fccprox] primed ${n} license details`);
      }).catch(() => { /* next boot resumes where it left off */ });
    }, 120_000);
    primeTimer.unref?.();
  }
}
const lookup = providers.length > 0 ? composeLookups(providers) : undefined;

// Kiosk header weather (NWS). Identified with the registered UA when one is
// configured; absent display coords = no weather line, clock still shows.
const weather = config.display
  ? new NwsWeather({
      lat: config.display.weatherLat,
      lon: config.display.weatherLon,
      userAgent: config.lookup?.userAgent ?? "Kerchunk/1.0 (kiosk appliance)",
    })
  : undefined;

// Durable activity history beside the config (StateDirectory is writable).
const history = new HistoryStore({ path: join(dirname(CONFIG_PATH), "history.db") });
history.prune();
const pruneTimer = setInterval(() => history.prune(), 24 * 3600 * 1000);
pruneTimer.unref?.();

const { server } = createServer({ configStore, engine, weatherEngine, activityLog, wsHub, staticDir: STATIC_DIR, lookup, weather, history });

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => wsHub.attach(ws));

server.listen(PORT, () => {
  console.log(`kerchunk-kiosk listening on :${PORT} (engine: ${engineKind})`);
  // Boot through the SAME constructor every API path uses — a hand-built
  // payload here once omitted knownHz/lockouts/closeCall and made every
  // reboot re-discover all filed frequencies (review finding).
  if (weatherEngine && config.weatherChannel) {
    void weatherEngine.start({
      channels: [{
        ...config.weatherChannel,
        id: "wx_same", alphaTag: "NWR (SAME decode)",
        enabled: true, audible: false, background: true,
      }],
      sampleRate: config.scan.sampleRate,
      squelchLevel: config.scan.squelchLevel,
      dwellMs: config.scan.dwellMs,
      gain: config.scan.gain,
      audioSink: "none",
      closeCall: false,
      knownHz: [config.weatherChannel.freq],
    }).catch((e) => console.error("[weather-radio]", (e as Error).message));
  }
  engine.start(toScanConfig(config, "scan"))
    // Re-apply persisted volume/mute to the hardware mixer on boot, so the saved
    // setting actually takes effect instead of inheriting the OS mixer state.
    // Direct audio.js calls WITH the configured mixer card/control — the same
    // path the /api/audio endpoints use. engine.setVolume() hits amixer's
    // default card 0, which is the WRONG card whenever the HDA probe race
    // puts PCH at index 1 (volume then silently failed to persist on boot).
    .then(() => setVolume(config.audio.volume, { card: config.audio.mixerCard, control: config.audio.mixerControl }))
    .then(() => setMuted(config.audio.muted, { card: config.audio.mixerCard, control: config.audio.mixerControl }))
    .catch((err) => console.error("engine start failed:", err));
});

process.on("SIGTERM", async () => { await engine.stop(); server.close(); process.exit(0); });
process.on("SIGINT", async () => { await engine.stop(); server.close(); process.exit(0); });
