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

  it("telemetry saves write config but skip the .bak churn", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 10 } }); // operator save -> creates .bak baseline (default)
    rmSync(path + ".bak", { force: true });                      // clear it to prove telemetry won't recreate
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 20 } }, { telemetry: true });
    expect(new ConfigStore(path).load().audio.volume).toBe(20);  // value persisted
    expect(existsSync(path + ".bak")).toBe(false);               // but no .bak churn
  });

  it("telemetry saves skip validation (already-validated in-memory config)", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    // A telemetry save does not re-parse; an operator save (default) would throw.
    expect(() => store.save({ ...cfg, audio: { ...cfg.audio, volume: 999 } }, { telemetry: true })).not.toThrow();
    expect(() => store.save({ ...cfg, audio: { ...cfg.audio, volume: 999 } })).toThrow();
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

  it("preserves a doubly-rejected file instead of clobbering it", () => {
    writeFileSync(path, '{"hand":"edited creds"}');
    writeFileSync(path + ".bak", "also garbage");
    new ConfigStore(path).load();
    // The operator's rejected file is set aside, not overwritten by defaults.
    expect(existsSync(path + ".rejected")).toBe(true);
    expect(readFileSync(path + ".rejected", "utf8")).toBe('{"hand":"edited creds"}');
    // And the main file is now valid defaults going forward.
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(defaultConfig());
  });

  it("repairs main from a good .bak so the next save can't clobber the backup", () => {
    const store = new ConfigStore(path);
    const good = store.load();
    store.save({ ...good, audio: { ...good.audio, volume: 33 } }); // main + .bak both good
    writeFileSync(path, "{ not json");                              // corrupt main only
    const reloaded = new ConfigStore(path).load();
    expect(reloaded.audio.volume).toBe(good.audio.volume);          // recovered from .bak
    // Main was rewritten from the good .bak (not left corrupt), so a later
    // operator save() copies a VALID main into .bak.
    expect(JSON.parse(readFileSync(path, "utf8")).audio.volume).toBe(good.audio.volume);
  });

  it("rejects a schema-invalid config on save", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    // @ts-expect-error deliberately invalid
    expect(() => store.save({ ...cfg, audio: { ...cfg.audio, volume: 999 } })).toThrow();
  });
});
