import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Channel } from "./config/schema.js";

export interface SavedMode { mode: "scan" | "weather" | "cb" | "monitor" | "hf"; monitor: Channel | null }

/** The operator's chosen mode, beside the config rather than in it: the admin PUTs whole
 *  configs, so a mode in there could be overwritten with a stale copy. */
export class ModeStore {
  constructor(private readonly path: string) {}

  load(): SavedMode {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<SavedMode>;
      if (raw.mode === "scan" || raw.mode === "weather" || raw.mode === "cb" || raw.mode === "monitor" || raw.mode === "hf") {
        return { mode: raw.mode, monitor: raw.monitor ?? null };
      }
    } catch { /* absent or corrupt: scan */ }
    return { mode: "scan", monitor: null };
  }

  save(saved: SavedMode): void {
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(saved), "utf8");
    renameSync(tmp, this.path);
  }
}
