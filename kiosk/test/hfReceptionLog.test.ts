import { describe, it, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { nightOf, ReceptionLog, type Candidate } from "../src/backend/hf/receptionLog.js";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import { HistoryStore } from "../src/backend/history.js";

const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m).getTime();
const voa: Candidate = { station: "VOA", country: "USA", language: "E", site: "Greenville", lat: 35.6, lon: -77.2, powerKw: 250, distanceKm: 1700 };
const bbc: Candidate = { station: "BBC", country: "G", language: "E", site: "Woofferton", lat: 52.3, lon: -2.7, powerKw: 300, distanceKm: 6600 };
const log = () => new ReceptionLog({ path: ":memory:" });
const survey = (l: ReceptionLog, ts: number, hz: number, db: number, cands: Candidate[] = []) =>
  l.record(ts, "49m", [{ hz, db }], () => cands);

describe("nightOf", () => {
  it("runs noon to noon, so one night keeps one date", () => {
    expect(nightOf(at(23))).toBe("2026-11-02");
    expect(nightOf(new Date(2026, 10, 3, 3).getTime())).toBe("2026-11-02");
    expect(nightOf(at(11, 59))).toBe("2026-11-01");
    expect(nightOf(at(12))).toBe("2026-11-02");
  });
});

describe("ReceptionLog", () => {
  it("keeps one row per station per night, with peak, first and last heard", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22, 1), 5_950_000, 35);
    survey(l, at(22, 2), 5_950_000, 25);
    const rows = l.rows("2026-11-02");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ freqHz: 5_950_000, band: "49m", peakDb: 35, firstTs: at(22), lastTs: at(22, 2), station: null });
  });

  it("counts passes, not sightings", () => {
    const l = log();
    for (const m of [0, 0.1, 0.2, 0.5]) survey(l, at(22) + m * 60_000, 5_950_000, 20);
    expect(l.rows("2026-11-02")[0]?.passes).toBe(1);
    survey(l, at(22, 15), 5_950_000, 20);
    survey(l, at(22, 30), 5_950_000, 20);
    expect(l.rows("2026-11-02")[0]?.passes).toBe(3);
  });

  it("a carrier within tolerance is the same row", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22, 1), 5_955_000, 20);
    survey(l, at(22, 2), 5_965_000, 20);
    expect(l.rows("2026-11-02").map((r) => r.freqHz).sort()).toEqual([5_950_000, 5_965_000]);
  });

  it("a new night is a new row", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, new Date(2026, 10, 3, 22).getTime(), 5_950_000, 20);
    expect(l.rows("2026-11-02")).toHaveLength(1);
    expect(l.rows("2026-11-03")).toHaveLength(1);
    expect(l.nights()).toEqual([{ night: "2026-11-03", count: 1 }, { night: "2026-11-02", count: 1 }]);
  });

  it("stores the top schedule candidate and the others; a new top candidate starts a new row", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20, [voa, bbc]);
    survey(l, at(22, 1), 5_950_000, 22, [voa]);
    survey(l, at(23), 5_950_000, 30, [bbc]);
    const rows = l.rows("2026-11-02");
    expect(rows).toHaveLength(2);
    const v = rows.find((r) => r.station === "VOA")!;
    expect(v).toMatchObject({ country: "USA", language: "E", site: "Greenville", lat: 35.6, lon: -77.2, powerKw: 250, distanceKm: 1700 });
    expect(v.others).toEqual(["BBC"]);
    expect(rows.find((r) => r.station === "BBC")?.peakDb).toBe(30);
  });

  it("an identified row and an unidentified one on a frequency stay separate", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(23), 5_950_000, 20, [voa]);
    expect(l.rows("2026-11-02")).toHaveLength(2);
  });

  it("marks the row on the speaker, including an existing one a raster step away", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22), 6_000_000, 20);
    l.markOnSpeaker(at(22, 1), 5_955_000);
    const rows = l.rows("2026-11-02");
    expect(rows.find((r) => r.freqHz === 5_950_000)?.onSpeaker).toBe(true);
    expect(rows.find((r) => r.freqHz === 6_000_000)?.onSpeaker).toBe(false);
  });

  it("marks nothing if the station has no row yet", () => {
    const l = log();
    expect(() => l.markOnSpeaker(at(22), 5_950_000)).not.toThrow();
    expect(l.rows("2026-11-02")).toEqual([]);
  });

  it("survives a reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "krl-"));
    const path = join(dir, "reception.db");
    const a = new ReceptionLog({ path });
    survey(a, at(22), 5_950_000, 20, [voa]);
    a.close();
    expect(new ReceptionLog({ path }).rows("2026-11-02")[0]?.station).toBe("VOA");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("HF mode logging", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function app() {
    dir = mkdtempSync(join(tmpdir(), "krl-"));
    const engine = new FakeEngine();
    const receptionLog = log();
    const history = new HistoryStore({ path: ":memory:" });
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir, receptionLog, history,
    });
    const c = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...c, spyserver: { host: "airspy.local" } });
    await request(server).post("/api/channels").send({ freq: 145_130_000, alphaTag: "S", mode: "nfm", enabled: true });
    await request(server).post("/api/scan/start");
    await request(server).post("/api/mode").send({ mode: "hf" });
    return { server, engine, receptionLog, history };
  }

  it("logs every in-band carrier, marks the one that plays, and serves it over the API", async () => {
    const { server, engine } = await app();
    const center = engine.tunes.at(-1)!.fixedCenterHz!;
    engine.emitCarriers(center, [{ hz: 2_350_000, db: 40 }, { hz: 2_400_000, db: 12 }, { hz: 2_130_000, db: 50 }]);
    const res = await request(server).get("/api/hf/log");
    expect(res.status).toBe(200);
    expect(res.body.nights).toHaveLength(1);
    expect(res.body.rows.map((r: { freqHz: number }) => r.freqHz).sort()).toEqual([2_350_000, 2_400_000]);
    expect(res.body.rows.find((r: { freqHz: number }) => r.freqHz === 2_350_000).onSpeaker).toBe(true);
    expect(res.body.rows.find((r: { freqHz: number }) => r.freqHz === 2_400_000).onSpeaker).toBe(false);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("the CB stop writes no shortwave records", async () => {
    const { server, engine } = await app();
    const body = (await request(server).get("/api/config")).body;
    await request(server).put("/api/config").send({ ...body, hf: { bands: [{ name: "49m", loHz: 5_900_000, hiHz: 6_200_000 }] } });
    await request(server).post("/api/mode").send({ mode: "scan" });
    await request(server).post("/api/mode").send({ mode: "hf" });
    await request(server).post("/api/scan/skip");
    expect(engine.tunes.at(-1)!.fixedCenterHz).toBe(27_195_000);
    engine.emitCarriers(27_195_000, [{ hz: 27_185_000, db: 40 }]);
    expect((await request(server).get("/api/hf/log")).body.rows).toEqual([]);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("rejects a malformed night", async () => {
    const { server } = await app();
    expect((await request(server).get("/api/hf/log?night=x")).status).toBe(400);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("history.prune() can't touch the log, which lives in its own database", async () => {
    const { engine, receptionLog, history } = await app();
    engine.emitCarriers(engine.tunes.at(-1)!.fixedCenterHz!, [{ hz: 2_350_000, db: 40 }]);
    history.prune();
    expect(receptionLog.nights()).toHaveLength(1);
  });
});
