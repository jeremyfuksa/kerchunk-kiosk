import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import type { Response as SuperAgentResponse } from "superagent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { RadarScan, RadarSource } from "../src/backend/radar/RadarFeed.js";
import type { EngineEvent } from "../src/backend/engine/ScannerEngine.js";

function binaryParser(res: SuperAgentResponse, cb: (err: Error | null, body: Buffer) => void): void {
  res.setEncoding("binary");
  let data = "";
  res.on("data", (c: string) => { data += c; });
  res.on("end", () => cb(null, Buffer.from(data, "binary")));
}
// superagent normally inflates gzip before the parser; tolerate either.
const maybeGunzip = (b: Buffer): Buffer => (b[0] === 0x1f && b[1] === 0x8b ? gunzipSync(b) : b);

class FakeRadar implements RadarSource {
  scan: RadarScan | null = null;
  stale = false;
  started = false;
  private cb: ((s: RadarScan) => void) | null = null;
  latest() { return this.scan; }
  isStale() { return this.stale; }
  onScan(cb: (s: RadarScan) => void) { this.cb = cb; }
  start() { this.started = true; }
  stop() {}
  fire(s: RadarScan) { this.scan = s; this.cb?.(s); }
}
const scanOf = (scanTime: number): RadarScan => {
  const bytes = new Uint8Array([0, 104, 120, 255, 64, 1]);
  return { scanTime, fetchedAt: scanTime + 5, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 3, height: 2, bytes, gz: gzipSync(bytes) };
};

let dir: string;
function makeApp(radar?: RadarSource) {
  dir = mkdtempSync(join(tmpdir(), "kradar-"));
  const wsHub = new WsHub();
  const sent: EngineEvent[] = [];
  const realBroadcast = wsHub.broadcast.bind(wsHub);
  wsHub.broadcast = (e: EngineEvent) => { sent.push(e); realBroadcast(e); };
  const { server } = createServer({
    configStore: new ConfigStore(join(dir, "config.json")), engine: new FakeEngine(),
    activityLog: new ActivityLog(100), wsHub, staticDir: dir, ...(radar ? { radar } : {}),
  });
  return { server, sent };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("radar routes", () => {
  it("404 when radar is disabled (no source)", async () => {
    const { server } = makeApp();
    expect((await request(server).get("/api/radar")).status).toBe(404);
    expect((await request(server).get("/api/radar/frame")).status).toBe(404);
  });

  it("503 before the first scan", async () => {
    const { server } = makeApp(new FakeRadar());
    expect((await request(server).get("/api/radar")).status).toBe(503);
    expect((await request(server).get("/api/radar/frame")).status).toBe(503);
  });

  it("meta reports the scan and the stale flag", async () => {
    const radar = new FakeRadar();
    radar.scan = scanOf(1_790_000_000_000);
    radar.stale = true;
    const { server } = makeApp(radar);
    const res = await request(server).get("/api/radar");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scanTime: 1_790_000_000_000, fetchedAt: 1_790_000_000_005, bounds: { n: 40, s: 39, e: -94, w: -95 }, width: 3, height: 2, stale: true });
  });

  it("frame serves the gzip'd bytes with an ETag, 304 on match", async () => {
    const radar = new FakeRadar();
    radar.scan = scanOf(1_790_000_000_000);
    const { server } = makeApp(radar);
    const res = await request(server).get("/api/radar/frame").buffer(true).parse(binaryParser);
    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    expect(res.headers["content-type"]).toBe("application/octet-stream");
    expect(res.headers.etag).toBe('"1790000000000"');
    expect(maybeGunzip(res.body as Buffer).equals(Buffer.from([0, 104, 120, 255, 64, 1]))).toBe(true);
    const again = await request(server).get("/api/radar/frame").set("If-None-Match", '"1790000000000"');
    expect(again.status).toBe(304);
  });

  it("starts the feed and broadcasts a radar event per new scan", async () => {
    const radar = new FakeRadar();
    const { sent } = makeApp(radar);
    expect(radar.started).toBe(true);
    radar.fire(scanOf(42));
    expect(sent.filter((e) => e.type === "radar")).toEqual([expect.objectContaining({ type: "radar", scanTime: 42 })]);
  });
});
