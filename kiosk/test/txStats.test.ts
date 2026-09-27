import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { TxStatsLog } from "../src/backend/engine/txStats.js";

function dir(): string { return mkdtempSync(join(tmpdir(), "txs-")); }
function lines(p: string): string[] {
  return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l) : [];
}

describe("TxStatsLog", () => {
  it("appends one JSON line per record, in order", async () => {
    const p = join(dir(), "txstats.jsonl");
    const log = new TxStatsLog(p);
    for (let i = 0; i < 5; i++) log.append({ i });
    await log.flush();
    expect(lines(p).map((l) => (JSON.parse(l) as { i: number }).i)).toEqual([0, 1, 2, 3, 4]);
  });

  it("rotates to .1 (single generation) past maxBytes", async () => {
    const p = join(dir(), "txstats.jsonl");
    writeFileSync(p, "x".repeat(95) + "\n");          // pre-existing file counts toward the cap
    const log = new TxStatsLog(p, { maxBytes: 100 });
    log.append({ a: 1 });                               // 96 + 8 > 100 -> rotate first
    await log.flush();
    expect(lines(`${p}.1`)).toEqual(["x".repeat(95)]);
    expect(lines(p)).toEqual(['{"a":1}']);
    for (let i = 0; i < 30; i++) log.append({ a: i });  // several more rotations
    await log.flush();
    expect(lines(`${p}.1`).length).toBeGreaterThan(0);
    expect(readFileSync(p).length).toBeLessThanOrEqual(100);
    expect(existsSync(`${p}.2`)).toBe(false);
    expect(lines(p).at(-1)).toBe('{"a":29}');
  });

  it("swallows write errors with a rate-limited log", async () => {
    const d = dir();
    const p = join(d, "is-a-dir");
    mkdirSync(p);                                       // appendFile on a directory fails
    const msgs: string[] = [];
    let t = 0;
    const log = new TxStatsLog(p, { log: (m) => msgs.push(m), now: () => t });
    log.append({ a: 1 });
    log.append({ a: 2 });
    await log.flush();
    expect(msgs).toHaveLength(1);
    t = 61_000;
    log.append({ a: 3 });
    await log.flush();
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatch(/1 more suppressed/);
  });
});
