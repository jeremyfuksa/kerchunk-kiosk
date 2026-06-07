import { describe, it, expect } from "vitest";
import { SystemStats, procStatTicks } from "../src/backend/systemStats.js";

const STAT = "1234 (python3 (gr)) S 1 1 1 0 -1 4194304 0 0 0 0 5000 2500 0 0 20 0 12 0 100 0 0 18446744073709551615";

describe("SystemStats", () => {
  it("parses helper ticks past a comm field containing spaces and parens", () => {
    expect(procStatTicks(STAT)).toBe(7500);
  });
  it("samples a ring with helper cpu derived from tick deltas", async () => {
    let ticks = 5000;
    const files: Record<string, () => string> = {
      "/proc/77/stat": () => `77 (x) S 1 1 1 0 -1 0 0 0 0 0 ${ticks} 0 0 0 20 0 12 0 100 0 0 1`,
      "/proc/77/status": () => "VmRSS:\t  204800 kB",
    };
    const s = new SystemStats({
      helperPid: () => 77,
      openCount: () => 3,
      dataDir: "/tmp",
      intervalMs: 999999,
      readFile: (p) => {
        const f = files[p];
        if (!f) throw new Error("nope");
        return f();
      },
    });
    s.start();                       // first sample: no delta yet
    ticks += 250;                    // 2.5 s of CPU across a fake gap
    await new Promise((r) => setTimeout(r, 30));
    (s as unknown as { sample(): void }).sample();
    const { now, ring } = s.snapshot();
    s.stop();
    expect(ring.length).toBe(2);
    expect(now!.helperRssMb).toBe(200);
    expect(now!.openCount).toBe(3);
    expect(now!.helperCpuPct).toBeGreaterThan(100); // 2.5 s of ticks in ~30 ms
    expect(now!.tempC === null || typeof now!.tempC === "number").toBe(true);
  });
});
