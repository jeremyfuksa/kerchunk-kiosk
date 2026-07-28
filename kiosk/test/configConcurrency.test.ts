import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

// PUT /api/config replaces the document wholesale, and the server writes it
// from a dozen other paths (a discovery arriving, the lookup chain filling in
// a location, an RF estimate landing). A client that GET → edit → PUT could
// therefore erase anything written in between, with nothing to show for it.
// These cover the optimistic-concurrency guard that stops that.

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "kcfg-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const { server } = createServer({
    configStore,
    engine: new FakeEngine(),
    activityLog: new ActivityLog(100),
    wsHub: new WsHub(),
    staticDir: dir,
  });
  return { server, configStore };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("config optimistic concurrency", () => {
  it("GET /api/config carries an ETag", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.headers.etag).toMatch(/^W\/"cfg-\d+"$/);
  });

  it("accepts a PUT carrying the current revision", async () => {
    const { server } = makeApp();
    const read = await request(server).get("/api/config");
    const res = await request(server)
      .put("/api/config")
      .set("If-Match", read.headers.etag!)
      .send(read.body);
    expect(res.status).toBe(200);
  });

  it("rejects a PUT built from a stale read instead of applying it", async () => {
    const { server } = makeApp();
    // Client A reads.
    const readA = await request(server).get("/api/config");
    const stale = readA.headers.etag!;

    // Something else writes in the meantime — here, another client's save.
    const readB = await request(server).get("/api/config");
    await request(server)
      .put("/api/config")
      .set("If-Match", readB.headers.etag!)
      .send({ ...readB.body, channels: [...readB.body.channels, {
        id: "ch_meanwhile", freq: 146_520_000, alphaTag: "Arrived meanwhile", mode: "nfm", enabled: true,
      }] });

    // Client A now PUTs its stale copy, which does not contain that channel.
    const res = await request(server)
      .put("/api/config")
      .set("If-Match", stale)
      .send(readA.body);

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/changed on the appliance/i);

    // The crucial part: the meanwhile-write survived.
    const after = await request(server).get("/api/config");
    expect(after.body.channels.some((c: { id: string }) => c.id === "ch_meanwhile")).toBe(true);
  });

  it("advances the revision on every write, so a reused ETag goes stale", async () => {
    const { server } = makeApp();
    const first = await request(server).get("/api/config");
    const etag1 = first.headers.etag!;

    await request(server).put("/api/config").set("If-Match", etag1).send(first.body);

    const second = await request(server).get("/api/config");
    expect(second.headers.etag).not.toBe(etag1);

    // Replaying the old revision is refused.
    const replay = await request(server)
      .put("/api/config").set("If-Match", etag1).send(first.body);
    expect(replay.status).toBe(409);
  });

  it("still accepts a PUT with no If-Match, so older clients keep working", async () => {
    const { server } = makeApp();
    const read = await request(server).get("/api/config");
    const res = await request(server).put("/api/config").send(read.body);
    expect(res.status).toBe(200);
  });

  it("a rejected write leaves the stored config untouched", async () => {
    const { server } = makeApp();
    const read = await request(server).get("/api/config");
    await request(server).put("/api/config").set("If-Match", read.headers.etag!).send(read.body);

    const before = (await request(server).get("/api/config")).body;
    const res = await request(server)
      .put("/api/config")
      .set("If-Match", read.headers.etag!)   // now stale
      .send({ ...read.body, channels: [] }); // would have wiped every channel

    expect(res.status).toBe(409);
    const after = (await request(server).get("/api/config")).body;
    expect(after.channels).toEqual(before.channels);
  });
});
