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
    if (fromBak) {
      // Main was rejected but .bak is good. Repair main from it now, so the
      // corrupt file isn't left in place to be copied OVER the good .bak by the
      // next operator save() — which would briefly leave zero valid copies.
      this.preserveRejected(this.path);
      this.writeAtomic(fromBak);
      return fromBak;
    }
    const def = defaultConfig();
    const hadFiles = existsSync(this.path) || existsSync(this.path + ".bak");
    this.lastLoadWasReset = hadFiles;
    if (hadFiles) {
      // Both files were rejected. Set them ASIDE rather than clobbering — the
      // operator's hand-edited file (credentials, channels) may be recoverable
      // by hand, and silently overwriting it once "ate an operator's creds."
      this.preserveRejected(this.path);
      this.preserveRejected(this.path + ".bak");
    }
    this.writeAtomic(def); // persist defaults so the file exists going forward
    return def;
  }

  // Rename a rejected file to a .rejected sibling so it isn't overwritten. A
  // fixed suffix (not a timestamp) keeps exactly the last rejected copy — Date
  // is avoided so the store stays deterministic and testable.
  private preserveRejected(p: string): void {
    if (!existsSync(p)) return;
    try { renameSync(p, p + ".rejected"); } catch { /* best-effort */ }
  }

  // opts.telemetry: a high-frequency rfDb/levelTrim EMA save (~100x/hr). These
  // skip the full re-validate AND the .bak copy — the in-memory config was
  // validated at load and these paths only nudge known-numeric fields, so
  // re-parsing + duplicating a ~60KB file every few seconds is pure SSD churn
  // (~300MB/day). The .bak then stays the last OPERATOR snapshot, which is more
  // useful for recovery than the last telemetry tick. Operator PUTs (default,
  // no opts) keep the full validate + backup.
  save(cfg: Config, opts: { telemetry?: boolean } = {}): void {
    const valid = opts.telemetry ? cfg : configSchema.parse(cfg); // PUTs throw on invalid
    if (!opts.telemetry && existsSync(this.path)) copyFileSync(this.path, this.path + ".bak");
    this.writeAtomic(valid);
  }

  private tryRead(p: string): Config | null {
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      return configSchema.parse(parsed);
    } catch (err) {
      // LOUD on purpose: a rejected config file silently falling back to
      // .bak once ate an operator's hand-edited credentials. The journal
      // must say exactly what was rejected and why.
      console.error(`[config] REJECTED ${p} — falling back: ${(err as Error).message?.slice(0, 500)}`);
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
    // POSIX: the rename itself lives in the directory, and isn't durable
    // until the directory is fsynced. Without this, an unclean power loss
    // can revert to the previous config (valid, but the operator's last
    // save silently vanishes). Best-effort: not every FS accepts dir fsync.
    try {
      const dirFd = openSync(dirname(this.path), "r");
      fsyncSync(dirFd);
      closeSync(dirFd);
    } catch { /* non-fatal: durability best-effort on exotic filesystems */ }
  }
}
