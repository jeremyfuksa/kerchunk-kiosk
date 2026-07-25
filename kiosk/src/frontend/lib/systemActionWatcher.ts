// Watches the backend across an action that takes it away — a backend restart,
// a reboot, a shutdown — so the admin's status line can return to normal on its
// own. The routes answer 202 *before* the process exits, so the fetch that
// triggered the action resolves normally and tells us nothing; without this the
// UI sits on "Restarting backend…" forever.

/** Where a system action has got to, as seen from the browser. */
export type SystemActionPhase =
  /** Sent; the backend is still answering as the process we asked. */
  | "pending"
  /** The backend has gone away — the action took effect. */
  | "down"
  /** A backend is answering again, and it is not the one we asked. */
  | "back"
  /** The same process kept answering: the action never took. */
  | "unchanged";

export interface SystemActionWatcherOpts {
  /**
   * Probes the backend: resolves with the answering process's `startedAt`
   * (undefined if it doesn't report one), rejects when it is unreachable.
   * The signal aborts the probe once `probeTimeoutMs` is up — pass it to
   * `fetch` so a socket to a dead host is dropped rather than left hanging.
   */
  probe: (signal: AbortSignal) => Promise<{ startedAt?: number }>;
  /** `startedAt` of the process the action was sent to, when it was known. */
  baselineStartedAt?: number;
  onPhase: (phase: SystemActionPhase) => void;
  /** Poll interval while the backend is still answering. */
  pollMs?: number;
  /** Poll interval once it has gone away — a reboot takes about a minute and a
   *  shut-down appliance may never come back, so back off rather than hammer. */
  downPollMs?: number;
  /** How long to keep waiting for the backend to go away before concluding the
   *  action never took. Only ever reached while it is still answering. */
  timeoutMs?: number;
  /** How long a single probe may take before it counts as unreachable. A
   *  rebooting host doesn't refuse connections, it swallows them — a probe can
   *  otherwise sit in SYN-retry for minutes and stall the whole loop. */
  probeTimeoutMs?: number;
}

// Tuning knobs (defaults; each is overridable per watch at the call site).
export const DEFAULT_POLL_MS = 2000;
export const DEFAULT_DOWN_POLL_MS = 5000;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 4000;

export class SystemActionWatcher {
  private readonly pollMs: number;
  private readonly downPollMs: number;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private timer?: ReturnType<typeof setTimeout>;
  private startedTs = 0;
  private sawDown = false;
  private stopped = false;

  constructor(private readonly opts: SystemActionWatcherOpts) {
    this.pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
    this.downPollMs = opts.downPollMs ?? DEFAULT_DOWN_POLL_MS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeTimeoutMs = opts.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  }

  start(): void {
    this.startedTs = Date.now();
    this.opts.onPhase("pending");
    this.schedule(this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => { void this.tick(); }, ms);
  }

  /** One probe, bounded: resolves to undefined for "unreachable or too slow". */
  private async probeOnce(): Promise<{ startedAt?: number } | undefined> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.probeTimeoutMs);
    try {
      // The race is the guarantee: aborting only helps for probes that honour
      // the signal, and the loop must tick on regardless.
      return await Promise.race([
        this.opts.probe(ctrl.signal),
        new Promise<undefined>((resolve) => {
          ctrl.signal.addEventListener("abort", () => resolve(undefined));
        }),
      ]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const answer = await this.probeOnce();
    if (this.stopped) return;

    if (!answer) {
      // Unreachable. Announce the transition once, then keep watching: a reboot
      // comes back, and a shut-down appliance comes back when someone presses
      // the power button. Deliberately no timeout in this state.
      if (!this.sawDown) { this.sawDown = true; this.opts.onPhase("down"); }
      this.schedule(this.downPollMs);
      return;
    }

    // A changed `startedAt` proves a different process is answering — the
    // reliable signal, and the only one that survives a restart that finishes
    // between two polls. It also rules out a network blip masquerading as a
    // restart: same `startedAt` means the same process we already had.
    const { baselineStartedAt } = this.opts;
    const restarted = baselineStartedAt !== undefined && answer.startedAt !== undefined
      ? answer.startedAt !== baselineStartedAt
      : this.sawDown;
    if (restarted) { this.stop(); this.opts.onPhase("back"); return; }

    // Same process, and we'd previously reported it down: that was a blip, not
    // the action landing. Take the "down" message back off the screen.
    if (this.sawDown) { this.sawDown = false; this.opts.onPhase("pending"); }

    if (Date.now() - this.startedTs >= this.timeoutMs) {
      this.stop();
      this.opts.onPhase("unchanged");
      return;
    }
    this.schedule(this.pollMs);
  }
}
