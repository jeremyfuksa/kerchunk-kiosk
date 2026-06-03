import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configSchema, defaultConfig, type Config } from "./schema.js";

export class ConfigStore {
  lastLoadWasReset = false;

  constructor(private readonly path: string) {}

  load(): Config {
    this.lastLoadWasReset = false;
    const fromMain = this.tryRead(this.path);
    if (fromMain) return fromMain;
    const fromBak = this.tryRead(this.path + ".bak");
    if (fromBak) return fromBak;
    const def = defaultConfig();
    this.lastLoadWasReset = existsSync(this.path) || existsSync(this.path + ".bak");
    this.writeAtomic(def); // persist defaults so the file exists going forward
    return def;
  }

  save(cfg: Config): void {
    const valid = configSchema.parse(cfg); // throws on invalid
    if (existsSync(this.path)) copyFileSync(this.path, this.path + ".bak");
    this.writeAtomic(valid);
  }

  private tryRead(p: string): Config | null {
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      return configSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  private writeAtomic(cfg: Config): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const json = JSON.stringify(cfg, null, 2);
    writeFileSync(tmp, json, "utf8");
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }
}
