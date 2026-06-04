import type { Config, Channel } from "../../backend/config/schema.js";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => fetch("/api/config").then(j<Config>),
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
  getStatus: () => fetch("/api/status").then(j<{ state: string; mode: "scan" | "weather" | "monitor"; monitor: Channel | null; config: Config }>),
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
  getLogs: () => fetch("/api/logs").then(j<{ freq: number; alphaTag: string; ts: number }[]>),
};
