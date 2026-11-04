import { describe, it, expect, afterEach, vi } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
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
const survey = (l: ReceptionLog, ts: number, hz: number, db: number, cands: Candidate[] = [], windowMs = 60_000) =>
  l.record(ts, "49m", [{ hz, db }], () => cands, windowMs);

describe("ReceptionLog carrier check", () => {
  const isNamed = (c: { steadyDb?: number }) => (c.steadyDb ?? 0) < 5;
  const record = (l: ReceptionLog, ts: number, steadyDb: number) =>
    l.record(ts, "49m", [{ hz: 5_950_000, db: 20, steadyDb }], () => [voa], 60_000, isNamed);

  it("names nothing without a carrier, whatever is scheduled", () => {
    const l = log();
    record(l, at(23), 9);
    expect(l.rows("2026-11-02")).toMatchObject([{ freqHz: 5_950_000, station: null, site: null, others: [] }]);
  });

  it("names a carrier", () => {
    const l = log();
    record(l, at(23), 1);
    expect(l.rows("2026-11-02")).toMatchObject([{ station: "VOA" }]);
  });

  it("a named station fading for a survey stays one row", () => {
    const l = log();
    record(l, at(23), 1);
    record(l, at(23, 1), 9);
    const rows = l.rows("2026-11-02");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ station: "VOA", lastTs: at(23, 1) });
  });
});

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

  it("marks the newest row for a frequency, even in the same millisecond as the last", () => {
    const l = log();
    const ts = at(22);
    l.record(ts, "49m", [{ hz: 5_950_000, db: 30 }], () => [], 60_000);
    l.record(ts, "49m", [{ hz: 5_950_000, db: 30 }], () => [{ station: "Radio X" }], 60_000);
    l.markOnSpeaker(ts, 5_950_000);
    expect(l.rows("2026-11-02").find((r) => r.station === "Radio X")?.onSpeaker).toBe(true);
  });

  it("remembers when a station last played, and hearing it on a later survey doesn't move that", () => {
    const l = log();
    l.record(at(22), "49m", [{ hz: 5_950_000, db: 30 }], () => [], 60_000);
    expect(l.rows("2026-11-02")[0]?.playedTs).toBeNull();
    l.markOnSpeaker(at(22, 1), 5_950_000);
    expect(l.rows("2026-11-02")[0]?.playedTs).toBe(at(22, 1));
    l.record(at(22, 30), "49m", [{ hz: 5_950_000, db: 30 }], () => [], 60_000);
    expect(l.rows("2026-11-02")[0]?.playedTs).toBe(at(22, 1));
    l.markOnSpeaker(at(22, 45), 5_950_000);
    expect(l.rows("2026-11-02")[0]?.playedTs).toBe(at(22, 45));
  });

  it("counts passes, not sightings", () => {
    const l = log();
    for (const m of [0, 0.1, 0.2, 0.5]) survey(l, at(22) + m * 60_000, 5_950_000, 20);
    expect(l.rows("2026-11-02")[0]?.passes).toBe(1);
    survey(l, at(22, 15), 5_950_000, 20);
    survey(l, at(22, 30), 5_950_000, 20);
    expect(l.rows("2026-11-02")[0]?.passes).toBe(3);
  });

  it("a pass is a visit to the window, however long the configured window is", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20, [], 20 * 60_000);       // a long window: the station fades and returns inside it
    survey(l, at(22, 15), 5_950_000, 20, [], 20 * 60_000);
    expect(l.rows("2026-11-02")[0]?.passes).toBe(1);
    const fast = log();
    survey(fast, at(22), 5_950_000, 20, [], 10_000);         // short windows: the next visit is only minutes off
    survey(fast, at(22, 3), 5_950_000, 20, [], 10_000);
    expect(fast.rows("2026-11-02")[0]?.passes).toBe(2);
  });

  it("the same station's small tuning difference is the same row", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22, 1), 5_952_000, 20);
    expect(l.rows("2026-11-02").map((r) => r.freqHz)).toEqual([5_950_000]);
  });

  it("the next channel, 5 kHz away, is another row, named or not", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22, 1), 5_955_000, 20);
    expect(l.rows("2026-11-02").map((r) => r.freqHz)).toEqual([5_950_000, 5_955_000]);
    const named = log();
    named.record(at(22), "49m", [{ hz: 5_950_000, db: 20 }, { hz: 5_955_000, db: 30 }], () => [voa], 60_000);
    expect(named.rows("2026-11-02").map((r) => r.peakDb)).toEqual([20, 30]);
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

  it("marks the row on the speaker, and not the channel beside it", () => {
    const l = log();
    survey(l, at(22), 5_950_000, 20);
    survey(l, at(22), 5_955_000, 20);
    l.markOnSpeaker(at(22, 1), 5_955_000);
    const rows = l.rows("2026-11-02");
    expect(rows.find((r) => r.freqHz === 5_955_000)?.onSpeaker).toBe(true);
    expect(rows.find((r) => r.freqHz === 5_950_000)?.onSpeaker).toBe(false);
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

  async function app(hfCandidates?: (hz: number, ts: number) => Candidate[]) {
    dir = mkdtempSync(join(tmpdir(), "krl-"));
    const engine = new FakeEngine();
    const receptionLog = log();
    const history = new HistoryStore({ path: ":memory:" });
    const { server } = createServer({
      configStore: new ConfigStore(join(dir, "config.json")), engine, activityLog: new ActivityLog(10),
      wsHub: new WsHub(), staticDir: dir, receptionLog, history, ...(hfCandidates ? { hfCandidates } : {}),
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

  it("a station whose schedule row appears after it took the speaker still counts as played", async () => {
    let cands: Candidate[] = [];
    const { server, engine } = await app(() => cands);
    const center = engine.tunes.at(-1)!.fixedCenterHz!;
    engine.emitCarriers(center, [{ hz: 2_350_000, db: 40 }]);
    cands = [{ station: "Radio X", lat: 45, lon: 26 } as Candidate];   // a schedule slot turns over, or the list arrives
    engine.emitCarriers(center, [{ hz: 2_350_000, db: 40 }]);
    const rows = (await request(server).get("/api/hf/log")).body.rows as Array<{ station: string | null; onSpeaker: boolean }>;
    expect(rows.find((r) => r.station === "Radio X")?.onSpeaker).toBe(true);
    await request(server).post("/api/mode").send({ mode: "scan" });
  });

  it("counts passes by the configured window, live", async () => {
    const { server, engine } = await app();
    const center = engine.tunes.at(-1)!.fixedCenterHz!;
    const passes = async () => ((await request(server).get("/api/hf/log")).body.rows as Array<{ passes: number }>)[0]?.passes;
    const start = Date.now();
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    try {
      engine.emitCarriers(center, [{ hz: 2_350_000, db: 40 }]);
      vi.setSystemTime(start + 30_000);
      engine.emitCarriers(center, [{ hz: 2_350_000, db: 40 }]);
      expect(await passes()).toBe(1);   // the default window, 60 s, covers both
      const c = (await request(server).get("/api/config")).body;
      await request(server).put("/api/config").send({ ...c, hf: { windowMs: 10_000 } });
      vi.setSystemTime(start + 60_000);
      engine.emitCarriers(engine.tunes.at(-1)!.fixedCenterHz!, [{ hz: 2_350_000, db: 40 }]);
      expect(await passes()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
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

  it("upgrades an existing log: rows that played count from when they were last heard", () => {
    const dir = mkdtempSync(join(tmpdir(), "hf-log-"));
    const path = join(dir, "reception.db");
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE reception (
      id INTEGER PRIMARY KEY, night TEXT NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
      freq_hz INTEGER NOT NULL, band TEXT NOT NULL, peak_db REAL NOT NULL, passes INTEGER NOT NULL,
      on_speaker INTEGER NOT NULL DEFAULT 0, station TEXT, country TEXT, language TEXT, site TEXT,
      lat REAL, lon REAL, power_kw REAL, distance_km REAL, others TEXT NOT NULL DEFAULT '[]');
      INSERT INTO reception (night, first_ts, last_ts, freq_hz, band, peak_db, passes, on_speaker) VALUES
        ('2026-11-02', 1, 500, 5950000, '49m', 30, 1, 1), ('2026-11-02', 1, 600, 6000000, '49m', 30, 1, 0);`);
    old.close();
    for (let i = 0; i < 2; i++) {   // a second open must not re-run it
      const l = new ReceptionLog({ path });
      const rows = l.rows("2026-11-02");
      expect(rows.map((r) => r.playedTs)).toEqual([500, null]);
      l.close();
    }
    rmSync(dir, { recursive: true });
  });
});
