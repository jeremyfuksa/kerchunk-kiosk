// Recorded Close Call samples: at most one plays at a time (two discoveries
// talking over each other is the confusion this exists to remove). State is
// keyed by discovery id, not by button, so a card rebuilt by a poll mid-clip
// repaints itself from playingId instead of cutting the clip off.

/** A frequency's clip is overwritten in place by its next hit, so the URL is
 *  cache-busted by the clip's timestamp. */
export const sampleUrl = (id: string, ts: number): string =>
  `/api/discoveries/${encodeURIComponent(id)}/sample.wav?t=${ts}`;

export class SamplePlayer {
  private cur: { id: string; audio: HTMLAudioElement } | null = null;
  private readonly subs: Array<() => void> = [];
  constructor(private readonly makeAudio: (url: string) => HTMLAudioElement = (u) => new Audio(u)) {}

  get playingId(): string | null { return this.cur?.id ?? null; }
  /** Notified on start, stop and every `timeupdate` (~4 Hz) — subscribers
   *  must patch in place, never rebuild. */
  subscribe(fn: () => void): void { this.subs.push(fn); }
  private notify(): void { for (const fn of this.subs) fn(); }

  stop(): void {
    if (!this.cur) return;
    const { audio } = this.cur;
    this.cur = null;
    audio.pause();
    // Release the source so the element stops buffering the clip.
    audio.removeAttribute("src");
    audio.load();
    this.notify();
  }

  /** Start id's clip, or stop it if it is the one playing. */
  toggle(id: string, ts: number): void {
    const wasThis = this.cur?.id === id;
    this.stop();
    if (wasThis) return;
    const audio = this.makeAudio(sampleUrl(id, ts));
    const end = (): void => { if (this.cur?.audio === audio) this.stop(); };
    audio.addEventListener("ended", end);
    audio.addEventListener("error", end);
    audio.addEventListener("timeupdate", () => { if (this.cur?.audio === audio) this.notify(); });
    this.cur = { id, audio };
    this.notify();
    void audio.play().catch(end);
  }

  /** Seconds left of the playing clip, or null. */
  remaining(full: number): number | null {
    return this.cur ? Math.max(0, full - this.cur.audio.currentTime) : null;
  }
}
