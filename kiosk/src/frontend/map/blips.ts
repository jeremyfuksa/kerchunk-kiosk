// Pure blip lifecycle for the live activity map (ROADMAP Idea 2): every hit
// pulses at its transmitter site and decays away, so the map reads as
// "recent activity fading", never a pin pile-up. Pure data — the Google Maps
// rendering layer consumes alive() each animation tick.

export interface BlipInput {
  lat: number;
  lon: number;
  alphaTag: string;
  kind: "active" | "closecall";
  ts: number;
}

export interface Blip extends BlipInput {
  /** 1 at the hit, linear to 0 at lifetimeMs. */
  opacity: number;
  /** Hits at this site within the current lifetime (drives size). */
  hits: number;
}

export class BlipField {
  private blips = new Map<string, BlipInput & { hits: number }>();

  constructor(private readonly lifetimeMs: number) {}

  add(b: BlipInput): void {
    // A site key, not an event key: repeat traffic refreshes the pulse
    // (and bumps the hit count) instead of stacking markers.
    const key = `${b.lat.toFixed(5)},${b.lon.toFixed(5)}`;
    const existing = this.blips.get(key);
    this.blips.set(key, { ...b, hits: (existing?.hits ?? 0) + 1 });
  }

  /** Blips still visible at `now`, with computed opacity. Prunes expired. */
  alive(now: number): Blip[] {
    const out: Blip[] = [];
    for (const [key, b] of this.blips) {
      const age = now - b.ts;
      if (age > this.lifetimeMs) {
        this.blips.delete(key);
        continue;
      }
      out.push({ ...b, opacity: Math.max(0, 1 - age / this.lifetimeMs) });
    }
    return out;
  }
}
