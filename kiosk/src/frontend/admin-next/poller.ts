// The polite poller, carried over from the classic admin: this box runs near
// its thermal trip and deadlocks on concurrent requests, so polls run one at a
// time, only while the tab is visible, and only for the tab on screen.
import type { Tab } from "./route.js";

/** How often the poller wakes to see what's due (and picks up flags such as
 *  a pending status resync). */
export const POLL_TICK_MS = 1_000;

/** Tuning knobs — every admin-next poll cadence lives here. */
export const POLL_MS = {
  verdict: 30_000,    // every tab: top-bar health verdict
  status: 60_000,     // every tab: /api/status at least this often (sooner on a WS resync)
  audio: 15_000,      // every tab: volume/mute/remote-listening sync
  recent: 10_000,     // Radio: recently heard
  activity: 60_000,   // Radio: today's totals + by-hour
  insights: 60_000,   // Radio: channel activity (when expanded)
  alerts: 60_000,     // Radio: alert feed
  tune: 30_000,       // Tune: settings refresh (only untouched fields)
} as const;

export interface PollSpec {
  name: string;
  run: () => Promise<void>;
  everyMs: number;
  tabs?: Tab[];
  when?: () => boolean;
}

export class Poller {
  private readonly polls: Array<PollSpec & { lastAt: number }> = [];
  private ticking = false;
  private started = false;
  private readonly now: () => number;
  private readonly hidden: () => boolean;

  constructor(opts: { now?: () => number; hidden?: () => boolean } = {}) {
    this.now = opts.now ?? Date.now;
    this.hidden = opts.hidden ?? (() => document.hidden);
  }

  add(p: PollSpec): void { this.polls.push({ ...p, lastAt: -Infinity }); }

  /** Serialises poll passes and run() writes: nothing overlaps on the wire. */
  private lane: Promise<unknown> = Promise.resolve();

  /** Run fn exclusively — after any in-flight poll pass or earlier run(), and
   *  before the next pass. The caller gets fn's result or rejection; a
   *  rejection never blocks the lane. Used for every admin-next write.
   *
   *  Never call run() (and await it) from inside a poll's run function, or
   *  from inside another run(): the lane is waiting on that pass to finish,
   *  and the pass would wait on the lane — a deadlock. A poll that needs to
   *  write should raise a flag and let an event handler do the write. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.lane.then(() => fn());
    this.lane = result.catch(() => {});
    return result;
  }

  async tick(tab: Tab): Promise<void> {
    if (this.ticking || this.hidden()) return;
    this.ticking = true;
    const pass = this.lane.then(async () => {
      for (const p of this.polls) {
        if (this.hidden()) break;
        if (p.tabs && !p.tabs.includes(tab)) continue;
        if (p.when && !p.when()) continue;
        if (this.now() - p.lastAt < p.everyMs) continue;
        p.lastAt = this.now();
        // Sequential on purpose — see the header.
        await p.run().catch(() => {});
      }
    });
    this.lane = pass.catch(() => {});
    try { await pass; } finally { this.ticking = false; }
  }

  makeDue(tab: Tab): void {
    for (const p of this.polls) if (!p.tabs || p.tabs.includes(tab)) p.lastAt = -Infinity;
  }

  start(getTab: () => Tab, tickMs = POLL_TICK_MS): void {
    if (this.started) return;
    this.started = true;
    setInterval(() => { void this.tick(getTab()); }, tickMs);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) { this.makeDue(getTab()); void this.tick(getTab()); }
    });
  }
}
