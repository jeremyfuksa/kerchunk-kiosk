import { z } from "zod";

// Wall watchdog. The ambient pages (dashboard/map/wall/art) POST
// /api/kiosk/heartbeat every 15 s from inside a requestAnimationFrame, so a
// beat proves the renderer is alive AND painting. When the wall's beats stop
// — a renderer crash leaves chromium on "Aw, Snap!" forever (2026-09-29: a
// V8 OOM after ~4 h) — the backend restarts kerchunk-display. Only loopback
// beats count: a remote viewer's dashboard must not vouch for the wall.
export const wallWatchdogSchema = z.object({
  enabled: z.boolean().default(true),
  // No beat for this long = the wall is dead. The page beats every 15 s
  // (HEARTBEAT_MS in src/frontend/main.ts); keep this a few beats wider.
  staleMs: z.number().int().min(30_000).default(60_000),
  // Time a fresh page gets to send its first beat — after backend start and
  // after each restart (the display takes ~15 s to come up).
  graceMs: z.number().int().min(30_000).default(120_000),
  // Restarts that don't bring the page back double the wait, up to this cap,
  // so a display that can't recover isn't bounced every two minutes forever.
  maxBackoffMs: z.number().int().min(60_000).default(30 * 60_000),
});
export type WallWatchdogSettings = z.infer<typeof wallWatchdogSchema>;

export function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export interface WallWatchdogOpts {
  getSettings: () => WallWatchdogSettings;
  /** False when the operator stopped the display on purpose — never start it. */
  isDisplayActive: () => Promise<boolean>;
  restartDisplay: () => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

export class WallWatchdog {
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private lastBeatAt: number | undefined;
  /** No restart before this: the grace after start or after a restart. */
  private holdUntil: number;
  /** Hold applied after the next restart; doubles while restarts fail. */
  private backoffMs: number | undefined;
  private busy = false;
  private skippedInactive = false;

  constructor(private readonly opts: WallWatchdogOpts) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.error(m));
    this.holdUntil = this.now() + opts.getSettings().graceMs;
  }

  beat(): void {
    // The page is back: whatever grace it was being given is moot, and the
    // next failure starts the backoff over.
    this.lastBeatAt = this.now();
    this.holdUntil = 0;
    this.backoffMs = undefined;
  }

  async check(): Promise<void> {
    const s = this.opts.getSettings();
    if (!s.enabled || this.busy) return;
    const now = this.now();
    if (now < this.holdUntil) return;
    if (this.lastBeatAt !== undefined && now - this.lastBeatAt <= s.staleMs) return;
    this.busy = true;
    try {
      if (!(await this.opts.isDisplayActive())) {
        if (!this.skippedInactive) this.log("[kiosk] wall heartbeat stale, but kerchunk-display is stopped — leaving it");
        this.skippedInactive = true;
        return;
      }
      this.skippedInactive = false;
      const hold = Math.min(this.backoffMs ?? s.graceMs, s.maxBackoffMs);
      const age = this.lastBeatAt === undefined ? "never beat" : `stale ${Math.round((now - this.lastBeatAt) / 1000)} s`;
      this.log(`[kiosk] wall heartbeat ${age} — restarting kerchunk-display (next check in ${Math.round(hold / 1000)} s)`);
      this.holdUntil = now + hold;
      this.backoffMs = Math.min(hold * 2, s.maxBackoffMs);
      await this.opts.restartDisplay();
    } catch (e) {
      this.log(`[kiosk] wall watchdog restart failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }
}
