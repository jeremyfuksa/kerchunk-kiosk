import type { Config, Channel } from "../../backend/config/schema.js";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: string };
      throw new Error(parsed.error ?? text);
    } catch (e) {
      if (e instanceof SyntaxError) throw new Error(`${res.status} ${text}`);
      throw e;
    }
  }
  return res.json() as Promise<T>;
}

// `/api/config` is the admin's most-called route — ~24 call sites, several on
// timers, and a burst of six during page init. The appliance has been observed
// to deadlock on concurrent requests (see CLAUDE.md), so callers that ask at
// the same moment share one round trip.
//
// Deliberately NOT a cache: the in-flight promise is dropped as soon as it
// settles, so a later caller always re-reads. And every caller gets its own
// clone, because most of them are read-modify-write (`cfg.banks = …` then
// `putConfig`) and sharing one object would let two edits stomp each other.
let configInFlight: Promise<Config> | null = null;

function fetchConfigShared(): Promise<Config> {
  configInFlight ??= fetch("/api/config").then(j<Config>)
    .finally(() => { configInFlight = null; });
  return configInFlight.then((cfg) => structuredClone(cfg));
}

export const api = {
  getConfig: fetchConfigShared,
  putConfig: (cfg: Config) =>
    fetch("/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(cfg) }).then(j<Config>),
  getChannels: () => fetch("/api/channels").then(j<Channel[]>),
  addChannel: (c: Omit<Channel, "id">) =>
    fetch("/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(j<Channel>),
  deleteChannel: (id: string) => fetch(`/api/channels/${id}`, { method: "DELETE" }),
  updateChannel: (id: string, patch: Partial<Omit<Channel, "id">>) =>
    fetch(`/api/channels/${id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) }).then(j<Channel>),
  setVolume: (percent: number) =>
    fetch("/api/audio/volume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent }) }),
  setMuted: (muted: boolean) =>
    fetch("/api/audio/mute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted }) }),
  getStatus: (signal?: AbortSignal) => fetch("/api/status", { signal }).then(j<{ state: string; mode: "scan" | "weather" | "monitor"; monitor: Channel | null; scanCount: number; muted?: boolean; warmed?: boolean; breakIn?: boolean; startedAt?: number }>),
  monitor: (freq: number, alphaTag?: string) =>
    fetch("/api/monitor", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ freq, alphaTag }) }).then(j<{ mode: string }>),
  monitorStop: () =>
    fetch("/api/monitor/stop", { method: "POST" }).then(j<{ mode: string }>),
  getWeatherChannel: () => fetch("/api/weather-channel").then(j<{ weatherChannel: Channel | null }>),
  setWeatherChannel: (c: Omit<Channel, "id">) =>
    fetch("/api/weather-channel", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(j<{ weatherChannel: Channel }>),
  setMode: (mode: "scan" | "weather") =>
    fetch("/api/mode", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) }).then(j<{ mode: "scan" | "weather"; state: string }>),
  skip: (holdoffSeconds?: number) =>
    fetch("/api/scan/skip", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(holdoffSeconds ? { holdoffSeconds } : {}) }),
  testAlert: (opts?: { alphaTag?: string; clear?: boolean }) =>
    fetch("/api/test/alert", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(opts ?? {}) }).then(j<{ ok: boolean }>),
  dismissAlert: (id: number) => fetch(`/api/history/alerts/${id}`, { method: "DELETE" }),
  clearAlerts: () => fetch("/api/history/alerts", { method: "DELETE" }).then(j<{ removed: number }>),
  reloadKiosk: () => fetch("/api/kiosk/reload", { method: "POST" }).then(j<{ ok: boolean }>),
  restartBackend: () => fetch("/api/backend/restart", { method: "POST" }).then(j<{ ok: boolean }>),
  powerAction: (action: "reboot" | "poweroff") =>
    fetch("/api/system/power", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action }) }).then(j<{ ok: boolean; action: string }>),
  getLogs: () => fetch("/api/logs").then(j<{ freq: number; alphaTag: string; ts: number }[]>),
};
