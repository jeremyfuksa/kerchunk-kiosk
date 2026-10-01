// The dashboard's single poll lane. The appliance has been observed to
// deadlock on 2+ concurrent requests (CLAUDE.md), so every periodic fetch runs
// here strictly one at a time, and an "update now" goes through request() —
// it runs on the next tick, in the queue, never out of band.
export interface Poller {
  poll(name: string, run: () => Promise<void>, everyMs: number): void;
  /** Make `name` due now; the next tick runs it in order. */
  request(name: string): void;
  tick(): Promise<void>;
}

export function createPoller(now: () => number = Date.now): Poller {
  const polls: Array<{ name: string; run: () => Promise<void>; everyMs: number; lastAt: number }> = [];
  let ticking = false;
  return {
    poll(name, run, everyMs) { polls.push({ name, run, everyMs, lastAt: -Infinity }); },
    request(name) { for (const p of polls) if (p.name === name) p.lastAt = -Infinity; },
    async tick() {
      if (ticking) return;
      ticking = true;
      try {
        for (const p of polls) {
          if (now() - p.lastAt < p.everyMs) continue;
          p.lastAt = now();
          await p.run().catch(() => {});
        }
      } finally { ticking = false; }
    },
  };
}
