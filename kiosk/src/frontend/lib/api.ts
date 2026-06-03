import type { Config, Channel } from "../../backend/config/schema.js";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => fetch("/api/config").then(j<Config>),
  getChannels: () => fetch("/api/channels").then(j<Channel[]>),
  addChannel: (c: Omit<Channel, "id">) =>
    fetch("/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(j<Channel>),
  deleteChannel: (id: string) => fetch(`/api/channels/${id}`, { method: "DELETE" }),
  setVolume: (percent: number) =>
    fetch("/api/audio/volume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent }) }),
  setMuted: (muted: boolean) =>
    fetch("/api/audio/mute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted }) }),
  getStatus: () => fetch("/api/status").then(j<{ state: string; config: Config }>),
  getLogs: () => fetch("/api/logs").then(j<{ freq: number; alphaTag: string; ts: number }[]>),
};
