import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { defaultConfig } from "../src/backend/config/schema.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kcfg-"));
  path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ConfigStore", () => {
  it("writes a default config when the file is missing", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    expect(cfg).toEqual(defaultConfig());
    expect(existsSync(path)).toBe(true);
  });

  it("round-trips a saved config", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    cfg.audio.volume = 42;
    store.save(cfg);
    const reloaded = new ConfigStore(path).load();
    expect(reloaded.audio.volume).toBe(42);
  });

  it("writes a .bak before overwriting", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 10 } });
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 20 } });
    expect(existsSync(path + ".bak")).toBe(true);
    const bak = JSON.parse(readFileSync(path + ".bak", "utf8"));
    expect(bak.audio.volume).toBe(10);
  });

  it("falls back to .bak when the main file is corrupt", () => {
    const store = new ConfigStore(path);
    const good = store.load();
    store.save({ ...good, audio: { ...good.audio, volume: 33 } });
    // corrupt main, leave .bak intact (the .bak holds the prior default save)
    writeFileSync(path, "{ not json");
    const result = new ConfigStore(path).load();
    expect(result.audio.volume).toBe(good.audio.volume); // came from .bak
  });

  it("falls back to defaults when both files are corrupt", () => {
    writeFileSync(path, "garbage");
    writeFileSync(path + ".bak", "also garbage");
    const store = new ConfigStore(path);
    expect(store.load()).toEqual(defaultConfig());
    expect(store.lastLoadWasReset).toBe(true);
  });

  it("rejects a schema-invalid config on save", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    // @ts-expect-error deliberately invalid
    expect(() => store.save({ ...cfg, audio: { ...cfg.audio, volume: 999 } })).toThrow();
  });
});
