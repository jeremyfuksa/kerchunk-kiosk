// Keeps the Weather Glass radar texture in step with the backend's RadarFeed.
// poll() runs on page load, on every WS "radar" event, and on a refreshMs
// timer (the backstop for a missed event across a backend restart). It only
// downloads a frame when scanTime changes. Stale = the server says so OR the
// scan is older than staleMs locally; the layer then fades radar out.

export interface RadarMeta {
  scanTime: number; fetchedAt: number;
  bounds: { n: number; s: number; e: number; w: number };
  width: number; height: number; stale: boolean;
}
export interface RadarFrame { meta: RadarMeta; bytes: Uint8Array }

export interface RadarSyncDeps {
  fetchMeta: () => Promise<RadarMeta | null>;
  fetchFrame: () => Promise<Uint8Array | null>;
  onFrame: (f: RadarFrame) => void;
  onStale: (stale: boolean) => void;
  staleMs: number;
  now?: () => number;
}

export class RadarSync {
  private lastScan: number | null = null;
  private lastMeta: RadarMeta | null = null;
  private stale = false;
  private inFlight: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: RadarSyncDeps) {
    this.now = d.now ?? Date.now;
  }

  poll(): Promise<void> {
    this.inFlight ??= this.run().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  checkStale(): void {
    const m = this.lastMeta;
    if (!m) return;
    const stale = m.stale || this.now() - m.scanTime > this.d.staleMs;
    if (stale !== this.stale) { this.stale = stale; this.d.onStale(stale); }
  }

  private async run(): Promise<void> {
    let meta: RadarMeta | null;
    try { meta = await this.d.fetchMeta(); } catch { return; }
    if (!meta) return;
    this.lastMeta = meta;
    if (meta.scanTime !== this.lastScan) {
      let bytes: Uint8Array | null = null;
      try { bytes = await this.d.fetchFrame(); } catch { /* retry next poll */ }
      // A scan can land between the two requests; a size mismatch means the
      // frame doesn't belong to this meta, so wait for the next poll.
      if (bytes && bytes.length === meta.width * meta.height) {
        this.lastScan = meta.scanTime;
        this.d.onFrame({ meta, bytes });
      }
    }
    this.checkStale();
  }
}

export const httpRadarFetchers: Pick<RadarSyncDeps, "fetchMeta" | "fetchFrame"> = {
  fetchMeta: async () => {
    const r = await fetch("/api/radar");
    return r.ok ? (await r.json()) as RadarMeta : null;
  },
  fetchFrame: async () => {
    const r = await fetch("/api/radar/frame");
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  },
};
