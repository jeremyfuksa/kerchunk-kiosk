// What the Library's polls load, shared by its views; and the LibCtx each
// view is mounted with. Writes go through lib.run (the Poller's single-flight
// lane — this box deadlocks on concurrent requests), which then requests one
// refresh of the Library poll rather than making every poll due.
import type { Channel, Config } from "../../backend/config/schema.js";
import type { ArchiveRec, DuplicateSet } from "../lib/api.js";
import { hrefFor } from "./route.js";
import type { Ctx } from "./ctx.js";

export interface SampleMeta { bytes: number; seconds: number; ts: number }
export interface LibData { channels: Channel[]; cfg: Config; samples: Record<string, SampleMeta> }

export class LibStore {
  data: LibData | null = null;
  dups: DuplicateSet[] = [];
  recs: ArchiveRec[] = [];
  loadError: string | null = null;
  private readonly subs: Array<() => void> = [];
  subscribe(fn: () => void): void { this.subs.push(fn); }
  set(p: Partial<Pick<LibStore, "data" | "dups" | "recs" | "loadError">>): void {
    Object.assign(this, p);
    for (const fn of this.subs) fn();
  }
}

export interface LibCtx extends Ctx {
  store: LibStore;
  /** Write through the Poller lane, then refresh the Library data once. */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Ask for a refresh of one Library poll ("library" | "suggestions" | "analytics"). */
  refresh(name?: string): void;
  /** Where the Library list lives right now (for closing the detail). */
  listHref(): string;
}

export function libCtx(ctx: Ctx, store: LibStore, view: () => "channels" | "new"): LibCtx {
  const refresh = (name = "library"): void => {
    ctx.poller.request(name);
    void ctx.poller.tick(ctx.shell.route().tab);
  };
  return {
    ...ctx, store, refresh,
    run<T>(fn: () => Promise<T>): Promise<T> {
      const p = ctx.poller.run(fn);
      // Refresh after success AND failure: a refused write (409 stale revision)
      // means our copy is old.
      void p.then(() => refresh(), () => refresh());
      return p;
    },
    listHref: () => hrefFor(view() === "new" ? { tab: "library", sub: "new" } : { tab: "library" }),
  };
}
