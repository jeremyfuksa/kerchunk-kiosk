// Pure blip lifecycle for the live activity map (ROADMAP Idea 2): every hit
// pulses at its transmitter site and decays away, so the map reads as
// "recent activity fading", never a pin pile-up. Pure data — the Google Maps
// rendering layer consumes alive() each animation tick.

export interface BlipInput {
  lat: number;
  lon: number;
  alphaTag: string;
  kind: "active" | "closecall" | "nofix";
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

// The unknown-origin ring: activity we cannot locate (GMRS simplex, mobiles,
// unidentified Close Calls) gets a DETERMINISTIC spot on a dashed ring around
// the QTH — same frequency, same spot, every time — pseudo-spatial identity
// without claiming real geography. Golden-angle hashing spreads adjacent
// channels (25 kHz neighbors) far apart around the circle.
export function ringPoint(
  home: { lat: number; lng: number },
  radiusM: number,
  freqHz: number,
): { lat: number; lng: number } {
  const angle = ((freqHz / 12_500) * 137.508) % 360;
  const rad = (angle * Math.PI) / 180;
  const dLat = (radiusM * Math.cos(rad)) / 111_320;
  const dLng = (radiusM * Math.sin(rad)) / (111_320 * Math.cos((home.lat * Math.PI) / 180));
  return { lat: home.lat + dLat, lng: home.lng + dLng };
}
