// Per-group apply countdown for settings whose save restarts the scanner
// (spec §4.2): changes collect for TUNE_APPLY_DELAY_MS after the last one,
// then save together — one engine restart per batch, not per nudge. Undo
// cancels a pending batch. Saves never overlap.

/** How long a batch of scanner-restarting changes waits after the last edit. */
export const TUNE_APPLY_DELAY_MS = 3000;

export type BatchState =
  | { kind: "idle" }
  | { kind: "pending"; ids: string[]; dueAt: number }
  | { kind: "saving"; ids: string[] }
  | { kind: "saved" }
  | { kind: "error"; message: string; ids: string[] };

export class ApplyBatcher {
  state: BatchState = { kind: "idle" };
  private readonly ids = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> | null = null;

  constructor(
    private readonly save: (ids: string[]) => Promise<void>,
    private readonly onState: (s: BatchState) => void,
    private readonly delayMs = TUNE_APPLY_DELAY_MS,
  ) {}

  change(id: string): void {
    this.ids.add(id);
    this.clearTimer();
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
    this.set({ kind: "pending", ids: [...this.ids], dueAt: Date.now() + this.delayMs });
  }

  /** Cancel the pending batch; returns the ids so the caller can revert them. */
  undo(): string[] {
    this.clearTimer();
    const ids = [...this.ids];
    this.ids.clear();
    this.set({ kind: "idle" });
    return ids;
  }

  /** Save what's collected now (waits for an in-flight save first). */
  async flush(): Promise<void> {
    this.clearTimer();
    while (this.saving) await this.saving;
    const ids = [...this.ids];
    if (!ids.length) return;
    this.ids.clear();
    this.set({ kind: "saving", ids });
    this.saving = this.save(ids).then(
      () => { if (this.ids.size === 0) this.set({ kind: "saved" }); },
      (e: unknown) => {
        for (const id of ids) this.ids.add(id);
        this.set({ kind: "error", message: e instanceof Error ? e.message : String(e), ids });
      },
    ).finally(() => { this.saving = null; });
    await this.saving;
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null; }
  }

  private set(s: BatchState): void { this.state = s; this.onState(s); }
}
