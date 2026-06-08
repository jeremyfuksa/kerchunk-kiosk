import { describe, it, expect } from "vitest";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";
import { WidebandEngine } from "../src/backend/engine/WidebandEngine.js";
import { toScanConfig } from "../src/backend/server.js";

describe("scan.detectVia", () => {
  it("defaults to absent (lane behavior) and accepts 'lane' | 'fft'", () => {
    const base = { sampleRate: 2_400_000, squelchLevel: 1800, gain: "auto" as const, dwellMs: 2000 };
    expect(configSchema.shape.scan.parse({ ...base }).detectVia).toBeUndefined();
    expect(configSchema.shape.scan.parse({ ...base, detectVia: "fft" }).detectVia).toBe("fft");
    expect(configSchema.shape.scan.parse({ ...base, detectVia: "lane" }).detectVia).toBe("lane");
    expect(() => configSchema.shape.scan.parse({ ...base, detectVia: "nope" })).toThrow();
  });
});

describe("WidebandEngine --detect-via", () => {
  const base = {
    channels: [], sampleRate: 2_400_000, squelchLevel: 1800, dwellMs: 2000,
    gain: "auto" as const, audioSink: "default",
  };
  function argsFor(cfg: object): string[] {
    const e = new WidebandEngine({});
    (e as unknown as { config: unknown }).config = cfg;
    return (e as unknown as { helperArgs(): string[] }).helperArgs();
  }
  it("omits --detect-via by default and includes it when set", () => {
    expect(argsFor(base)).not.toContain("--detect-via");
    const a = argsFor({ ...base, detectVia: "fft" });
    expect(a).toContain("--detect-via");
    expect(a[a.indexOf("--detect-via") + 1]).toBe("fft");
  });
  it("passes --close-call unless closeCall is explicitly false", () => {
    // Mirrors the per-tune `closeCall ?? true`: the FFT is built on by default
    // (absent or true) and skipped only when the operator turns Close Call off.
    expect(argsFor(base)).toContain("--close-call");                       // absent -> on
    expect(argsFor({ ...base, closeCall: true })).toContain("--close-call");
    expect(argsFor({ ...base, closeCall: false })).not.toContain("--close-call");
  });
});

describe("toScanConfig detectVia passthrough", () => {
  it("passes detectVia: 'fft' through to ScanConfig", () => {
    const cfg = defaultConfig();
    cfg.scan.detectVia = "fft";
    expect(toScanConfig(cfg, "scan").detectVia).toBe("fft");
  });
  it("leaves detectVia undefined when absent from config", () => {
    const cfg = defaultConfig();
    expect(toScanConfig(cfg, "scan").detectVia).toBeUndefined();
  });
});
