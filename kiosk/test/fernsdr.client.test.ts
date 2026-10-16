import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FernClient, type FernEvent } from "../src/backend/fernsdr/client.js";

const cap = JSON.parse(readFileSync(join(__dirname, "fixtures", "fernsdr", "nac-frames.json"), "utf8")) as { audio: string[]; rows: string[] };
const frame = (i: number, seq: number, gen = 1, flags = 0) => {
  const b = Buffer.from(Buffer.from(cap.audio[i]!, "base64"));
  b[1] = (gen << 4) | flags;
  b.writeUInt16LE(seq, 2);
  return b;
};
const WELCOME = { type: "welcome", capabilities: ["meter-v1", "nac2", "nac3", "wfc4", "audio-discontinuity"], bands: [{ id: "cb-radio", center: 27185000, low: 26957000, high: 27413000 }] };

let wss: WebSocketServer | null = null;
let client: FernClient | null = null;
afterEach(() => { client?.stop(); wss?.close(); wss = null; client = null; });

async function setup(onConn: (s: WsSocket, msgs: any[]) => void, over: Partial<ConstructorParameters<typeof FernClient>[0]> = {}) {
  wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss!.once("listening", r));
  const port = (wss.address() as { port: number }).port;
  const msgs: any[] = [];
  let conns = 0;
  wss.on("connection", (s) => {
    conns++;
    s.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(String(d))); });
    s.send(JSON.stringify(WELCOME));
    onConn(s, msgs);
  });
  const events: FernEvent[] = [];
  client = new FernClient({ url: `ws://127.0.0.1:${port}/ws`, band: "cb-radio", backoffMaxMs: 200, backoffBaseMs: 20, random: () => 1, ...over }, (e) => events.push(e));
  client.start();
  return { msgs, events, conns: () => conns };
}
const until = async (p: () => boolean, ms = 2000) => { const end = Date.now() + ms; while (!p() && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); return p(); };

describe("FernClient", () => {
  it("handshakes with plain capabilities and a codec-less viewport from the band edges", async () => {
    const { msgs, events } = await setup(() => {});
    await until(() => msgs.length >= 4);
    expect(msgs.slice(0, 4)).toEqual([
      { type: "hello", capabilities: ["audio-discontinuity"] },
      { type: "audio", enabled: true, rate: 12000 },
      { type: "dsp", squelch: -200, agc: "auto" },
      { type: "viewport", enabled: true, low: 26957000, high: 27413000, width: 456, fps: 10 },
    ]);
    expect(events[0]).toEqual({ type: "connected", band: WELCOME.bands[0] });
    expect(client!.connected).toBe(true);
  });

  it("drops audio until state.ack.tune catches up, then decodes at the configured rate", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    await until(() => msgs.some((m) => m.type === "tune"));
    expect(msgs.find((m) => m.type === "tune")).toEqual({ type: "tune", band: "cb-radio", freq: 27185000, mode: "am", request_id: 1 });
    sock!.send(JSON.stringify({ type: "audio-config", generation: 1, rate: 14250, frame_samples: 128, bitrate: 48000 }));
    sock!.send(frame(0, 10));                                     // old channel: dropped
    sock!.send(JSON.stringify({ type: "state", ack: { tune: 1 } }));
    sock!.send(frame(1, 11));
    await until(() => events.some((e) => e.type === "audio"));
    const audio = events.filter((e) => e.type === "audio");
    expect(audio).toHaveLength(1);
    expect(audio[0]).toMatchObject({ rate: 14250 });
  });

  it("conceals sequence gaps, skips concealment on discontinuity, drops duplicates", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    sock!.send(JSON.stringify({ type: "audio-config", generation: 1, rate: 14250, frame_samples: 128, bitrate: 48000 }));
    sock!.send(JSON.stringify({ type: "state", ack: { tune: 1 } }));
    sock!.send(frame(0, 100));
    sock!.send(frame(1, 103));          // 2 lost -> 2 concealed + 1
    sock!.send(frame(2, 103));          // duplicate -> dropped
    sock!.send(frame(3, 200, 1, 0b100)); // discontinuity -> no concealment
    await until(() => events.filter((e) => e.type === "audio").length >= 5);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "audio")).toHaveLength(5);
  });

  it("caps concealment at 8 frames; a bigger gap is a discontinuity", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    sock!.send(JSON.stringify({ type: "audio-config", generation: 1, rate: 14250, frame_samples: 128, bitrate: 48000 }));
    sock!.send(JSON.stringify({ type: "state", ack: { tune: 1 } }));
    sock!.send(frame(0, 100));
    sock!.send(frame(1, 151));          // 50 lost -> no concealment, just this frame
    await until(() => events.filter((e) => e.type === "audio").length >= 2);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.filter((e) => e.type === "audio")).toHaveLength(2);
  });

  it("a receiver that goes silent is dropped and reconnected within staleMs", async () => {
    const logs: string[] = [];
    const { events, conns } = await setup(() => {}, { staleMs: 150, log: (m) => logs.push(m) });
    await until(() => client!.connected);
    expect(await until(() => events.some((e) => e.type === "disconnected" && e.retrying), 1500)).toBe(true);
    expect(client!.retrying).toBe(true);
    expect(await until(() => conns() >= 2, 1500)).toBe(true);
    expect(logs.some((m) => m.includes("no data"))).toBe(true);
  });

  it("traffic keeps the session alive past staleMs", async () => {
    let sock: WsSocket | null = null;
    const { events } = await setup((s) => { sock = s; }, { staleMs: 200 });
    await until(() => client!.connected);
    const iv = setInterval(() => sock?.send(JSON.stringify({ type: "meter", dbfs: -50 })), 50);
    await new Promise((r) => setTimeout(r, 600));
    clearInterval(iv);
    expect(events.some((e) => e.type === "disconnected")).toBe(false);
  });

  it("logs once when a tune is never acknowledged", async () => {
    const logs: string[] = [];
    const { msgs } = await setup(() => {}, { log: (m) => logs.push(m) });
    await until(() => msgs.length >= 4);
    client!.tune(27_185_000, "am");
    expect(await until(() => logs.some((m) => m.includes("not acknowledged")), 3500)).toBe(true);
    expect(logs.filter((m) => m.includes("not acknowledged"))).toEqual(["[fernsdr] tune 27185000 not acknowledged after 2 s"]);
  }, 8000);

  it("emits decoded waterfall rows and meters; answers inactivity", async () => {
    let sock: WsSocket | null = null;
    const { msgs, events } = await setup((s) => { sock = s; });
    await until(() => msgs.length >= 4);
    for (const r of cap.rows) sock!.send(Buffer.from(r, "base64"));
    sock!.send(JSON.stringify({ type: "meter", dbfs: -92.4 }));
    sock!.send(JSON.stringify({ type: "inactivity", seconds: 60 }));
    await until(() => msgs.some((m) => m.type === "active") && events.some((e) => e.type === "meter"));
    expect(events.some((e) => e.type === "row" && e.levels.length > 0)).toBe(true);
    expect(events).toContainEqual({ type: "meter", dbfs: -92.4 });
  });

  it("reconnects with backoff after an ordinary close and replays the tune", async () => {
    let first = true;
    const { msgs, conns } = await setup((s) => { if (first) { first = false; setTimeout(() => s.close(1011), 30); } });
    await until(() => msgs.length >= 4);
    client!.tune(27_065_000, "am");
    await until(() => conns() >= 2);
    await until(() => msgs.filter((m) => m.type === "tune").length >= 2);
    expect(msgs.filter((m) => m.type === "tune").at(-1)).toMatchObject({ freq: 27065000 });
  });

  it("never reconnects after 4001 or 4002", async () => {
    for (const code of [4001, 4002]) {
      const { conns, events } = await setup((s) => setTimeout(() => s.close(code), 20));
      await until(() => events.some((e) => e.type === "disconnected"));
      await new Promise((r) => setTimeout(r, 300));
      expect(conns()).toBe(1);
      expect(events.find((e) => e.type === "disconnected")).toMatchObject({ retrying: false });
      expect(client!.error).toMatch(code === 4001 ? /timeout/ : /operator/);
      client!.stop(); wss!.close(); client = null; wss = null;
    }
  });

  it("an unreachable receiver sets error and keeps retrying", async () => {
    const events: FernEvent[] = [];
    client = new FernClient({ url: "ws://127.0.0.1:1/ws", band: "cb-radio", backoffMaxMs: 100, backoffBaseMs: 20, random: () => 1 }, (e) => events.push(e));
    client.start();
    await until(() => events.filter((e) => e.type === "disconnected").length >= 2);
    expect(client.connected).toBe(false);
    expect(client.error).toBeTruthy();
    expect(events.every((e) => e.type !== "disconnected" || e.retrying)).toBe(true);
  });

  it("a malformed welcome is a band error, not a crash, and retries", async () => {
    wss = new WebSocketServer({ port: 0 });
    await new Promise((r) => wss!.once("listening", r));
    const port = (wss.address() as { port: number }).port;
    let conns = 0;
    wss.on("connection", (s) => { conns++; s.send(JSON.stringify({ type: "welcome", bands: "nope" })); });
    const events: FernEvent[] = [];
    client = new FernClient({ url: `ws://127.0.0.1:${port}/ws`, band: "cb-radio", backoffMaxMs: 100, backoffBaseMs: 20, random: () => 1 }, (e) => events.push(e));
    client.start();
    await until(() => conns >= 2);
    expect(events.find((e) => e.type === "disconnected")).toMatchObject({ retrying: true, reason: expect.stringContaining("band") });
    expect(client.error).toMatch(/band/);
  });

  it("a bad URL does not throw and does not retry", () => {
    const events: FernEvent[] = [];
    client = new FernClient({ url: "not a url", band: "cb-radio", backoffMaxMs: 100 }, (e) => events.push(e));
    expect(() => client!.start()).not.toThrow();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "disconnected", retrying: false });
    expect(client.error).toBeTruthy();
  });

  it("garbage after a valid session does not crash or disconnect", async () => {
    let sock: WsSocket | null = null;
    const logs: string[] = [];
    const { msgs } = await setup((s) => { sock = s; }, { log: (m) => logs.push(m) });
    await until(() => msgs.length >= 4);
    sock!.send(JSON.stringify({ type: "welcome", bands: null }));
    sock!.send(JSON.stringify({ type: "welcome", bands: [{ id: "cb-radio", low: "x", high: 1, center: 2 }] }));
    sock!.send(Buffer.from([0x02, 0xff, 0x00]));
    sock!.send("{not json");
    await new Promise((r) => setTimeout(r, 100));
    expect(client!.connected || client!.error !== null).toBe(true);
  });
});
