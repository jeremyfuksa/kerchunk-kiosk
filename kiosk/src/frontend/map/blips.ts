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
  /** Frequency, when known — drives service coloring (pin palette). */
  freq?: number;
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

export interface GeoPoint { lat: number; lng: number; }

function metersBetween(a: GeoPoint, b: GeoPoint): number {
  const midLat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lng - b.lng) * 111_320 * Math.cos(midLat);
  return Math.hypot(dx, dy);
}

function offsetPoint(home: GeoPoint, radiusM: number, angle: number): GeoPoint {
  return {
    lat: home.lat + (radiusM * Math.cos(angle)) / 111_320,
    lng: home.lng + (radiusM * Math.sin(angle)) / (111_320 * Math.cos(home.lat * Math.PI / 180)),
  };
}

// Stable synthetic placement for credible activity whose transmitter cannot be
// located. A frequency gets a deterministic set of candidate points, then takes
// the candidate farthest from known sites and the home antenna. Unknown traffic
// therefore fills visual gaps instead of piling onto a ring, while the position
// remains explicitly symbolic rather than pretending to be measured geography.
export function syntheticPoint(
  home: { lat: number; lng: number },
  radiusM: number,
  freqHz: number,
  occupied: GeoPoint[] = [],
): GeoPoint {
  const channel = Math.round(freqHz / 12_500);
  const golden = 137.508 * Math.PI / 180;
  const references = [home, ...occupied];
  let best = home;
  let bestScore = -1;

  for (let i = 0; i < 48; i++) {
    // sqrt distributes candidates by area, not by radius, while leaving a
    // quiet center around the real home marker.
    const unit = (((channel * 2654435761) + i * 2246822519) >>> 0) / 0xffffffff;
    const radius = radiusM * (0.24 + 0.76 * Math.sqrt(unit));
    const angle = ((channel % 360) * Math.PI / 180) + i * golden;
    const candidate = offsetPoint(home, radius, angle);
    const nearest = Math.min(...references.map((p) => metersBetween(candidate, p)));
    // Slight center preference avoids placing every unknown at the outer edge
    // when the known-site field is sparse.
    const score = nearest - radius * 0.12;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

// ── Coverage-radius estimate (operator idea): when a channel's FCC license
// reports transmitter power (and antenna height), the blip's radius IS the
// estimated coverage area — physically meaningful circles instead of an
// arbitrary size ramp. Model: radio-horizon from antenna height, scaled by
// ERP relative to a 50 W reference. An ESTIMATE, deliberately conservative;
// constants are the tuning knobs.
const COV_DEFAULT_HAAT_M = 15;   // typical business-band mast when FCC omits it
const COV_HORIZON_K = 4.12;      // km per sqrt(meter) — standard radio horizon
const COV_RX_HEIGHT_M = 1.5;     // a handheld on the street
const COV_SCALE = 0.6;           // real coverage runs well inside the horizon
const COV_MIN_KM = 2;
const COV_MAX_KM = 30;

export function coverageRadiusM(powerWatts: number, antennaHaatM?: number): number {
  const h = antennaHaatM ?? COV_DEFAULT_HAAT_M;
  const horizonKm = COV_HORIZON_K * (Math.sqrt(h) + Math.sqrt(COV_RX_HEIGHT_M));
  const powerFactor = Math.min(1.6, Math.max(0.4, Math.sqrt(powerWatts / 50)));
  const km = Math.min(COV_MAX_KM, Math.max(COV_MIN_KM, horizonKm * powerFactor * COV_SCALE));
  return Math.round(km * 1000);
}
