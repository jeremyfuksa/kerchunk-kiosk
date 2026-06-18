import type { AircraftTarget, AircraftKind } from "../../backend/engine/ScannerEngine.js";

declare const google: any; // loaded dynamically with the configured Maps key

// Aircraft overlay layer (network ADS-B). Each WS "aircraft" event delivers a
// FULL snapshot; update() reconciles the marker set against it by hex — move
// the ones still present, add new ones, remove vanished ones. Markers update
// imperatively (snap), so this adds NO per-frame animation: cost is one
// reconcile per poll (~5s), independent of the blip rAF idle loop.
//
// Type reads three ways at once: SILHOUETTE (jet / prop / rotor / delta),
// SIZE (airliners largest), and COLOR. Vivid per-type palette (operator
// decision 2026-06-18) — distinct from the cream-headed site pins by form and
// motion, so a hue near a service pin still can't be mistaken for one.

const KIND_COLOR: Record<AircraftKind, string> = {
  airliner: "#5fb0e6",   // sky blue
  prop: "#a8c76f",       // sage — light GA
  helicopter: "#ffc05c", // amber — rotorcraft
  military: "#f08080",   // flamingo — high-performance
  unknown: "#7d8893",    // slate — recedes
};

// Top-view silhouettes, nose toward -Y (north) at rotation 0, centered on the
// origin so a heading rotation pivots about the aircraft's position. Drawn as
// Google Maps Symbol paths (single fill + native rotation + per-marker color).
const KIND_PATH: Record<AircraftKind, string> = {
  // swept-wing jetliner
  airliner: "M0,-11 C1.3,-11 1.9,-8.5 1.9,-5.5 L1.9,-3.2 L11,3 L11,5 L1.9,1 L1.7,7 L4.6,9.3 L4.6,10.4 L0,8.8 L-4.6,10.4 L-4.6,9.3 L-1.7,7 L-1.9,1 L-11,5 L-11,3 L-1.9,-3.2 L-1.9,-5.5 C-1.9,-8.5 -1.3,-11 0,-11 Z",
  // straight-wing light aircraft
  prop: "M0,-9 C1.1,-9 1.6,-7.2 1.6,-4.8 L1.6,-3.8 L10,-1.8 L10,0.2 L1.6,2 L1.5,6 L4.2,8 L4.2,9 L0,7.6 L-4.2,9 L-4.2,8 L-1.5,6 L-1.6,2 L-10,0.2 L-10,-1.8 L-1.6,-3.8 L-1.6,-4.8 C-1.6,-7.2 -1.1,-9 0,-9 Z",
  // rotor cross + hub + tail rotor
  helicopter: "M-11,-1.1 L11,-1.1 L11,1.1 L-11,1.1 Z M-1.1,-9 L1.1,-9 L1.1,9 L-1.1,9 Z M0,-3.6 A3.6,3.6 0 1 0 0.01,-3.6 Z M-2.6,8.4 L2.6,8.4 L2.6,9.8 L-2.6,9.8 Z",
  // sharp delta
  military: "M0,-11 L6.5,7 L1.6,4.2 L1.6,9.5 L-1.6,9.5 L-1.6,4.2 L-6.5,7 Z",
  // generic chevron — heading known, type not
  unknown: "M0,-7.5 L4.8,6 L0,3.2 L-4.8,6 Z",
};

// Base glyph scale per kind (airliners read largest); the map's own scale
// factor (1 interactive, 1.6 kiosk) multiplies on top. Sized to read across
// the room on the wall.
const KIND_BASE_SCALE: Record<AircraftKind, number> = {
  airliner: 1.0, prop: 0.82, helicopter: 0.9, military: 0.92, unknown: 0.7,
};

/** Markers whose hex is no longer in the snapshot — pure for testability. */
export function removedHexes(
  prev: Iterable<string>,
  next: ReadonlyArray<{ hex: string }>,
): string[] {
  const live = new Set(next.map((t) => t.hex));
  const gone: string[] = [];
  for (const hex of new Set(prev)) if (!live.has(hex)) gone.push(hex);
  return gone;
}

/** Degrees to rotate the glyph; 0 when heading is unknown. */
export function planeIconRotation(heading: number | null): number {
  return heading ?? 0;
}

/** Glyph scale for a kind. A2 small/regional/biz jets class as airliners but
 *  render smaller than heavies, so size still separates them at a glance. */
export function kindScale(kind: AircraftKind, category: string | null): number {
  const base = KIND_BASE_SCALE[kind] ?? 0.5;
  if (kind === "airliner" && (category ?? "").toUpperCase() === "A2") return base * 0.78;
  return base;
}

// Comet trail: how many recent positions to keep (one per poll tick ≈ 5 s, so
// ~14 ≈ the last ~70 s) and how opaque the freshest segment (at the plane) is.
const TRAIL_POINTS = 14;
const TRAIL_HEAD_OPACITY = 0.62;
// Don't let the tail fade all the way out: a slow aircraft's trail is only a
// few short segments, and a ramp straight to ~0 made it nearly invisible. The
// tail holds at this fraction of the head so even a stubby trail reads.
const TRAIL_TAIL_FLOOR = 0.35;

/** Opacity of trail segment `i` of `segCount` (0 = oldest/tail). Newest segment
 *  (nearest the plane) is brightest; the tail fades toward — but not past — the
 *  floor, so short (slow-aircraft) trails stay legible. Pure. */
export function segmentOpacity(i: number, segCount: number, headOpacity = TRAIL_HEAD_OPACITY): number {
  if (segCount <= 0) return 0;
  const ramp = TRAIL_TAIL_FLOOR + (1 - TRAIL_TAIL_FLOOR) * ((i + 1) / segCount);
  return headOpacity * ramp;
}

export class AircraftLayer {
  private readonly markers = new Map<string, any>();
  // hex -> recent positions (comet trail); hex -> its reused Polyline segments.
  private readonly history = new Map<string, any[]>();
  private readonly trailSegs = new Map<string, any[]>();
  constructor(
    private readonly map: any,
    private readonly scale: number,
    private readonly trails = false,
  ) {}

  update(targets: AircraftTarget[]): void {
    for (const t of targets) {
      const pos = { lat: t.lat, lng: t.lon };
      let marker = this.markers.get(t.hex);
      if (!marker) {
        marker = new google.maps.Marker({
          map: this.map,
          position: pos,
          icon: this.icon(t),
          label: this.label(t),
          clickable: false,
          zIndex: 2, // above site pins (zIndex 1), below info windows
        });
        this.markers.set(t.hex, marker);
      } else {
        marker.setPosition(pos);
        marker.setIcon(this.icon(t));
        marker.setLabel(this.label(t));
      }
      if (this.trails) this.updateTrail(t);
    }
    for (const hex of removedHexes(this.markers.keys(), targets)) {
      this.markers.get(hex)?.setMap(null);
      this.markers.delete(hex);
      this.clearTrail(hex);
    }
  }

  private icon(t: AircraftTarget): any {
    const color = KIND_COLOR[t.kind] ?? KIND_COLOR.unknown;
    return {
      path: KIND_PATH[t.kind] ?? KIND_PATH.unknown,
      fillColor: color,
      fillOpacity: 1,
      // Thin dark outline so a colored silhouette stays legible over the dark
      // basemap AND over the green radar wash.
      strokeColor: "#0a0e14",
      strokeOpacity: 0.85,
      strokeWeight: 1,
      rotation: planeIconRotation(t.heading),
      scale: kindScale(t.kind, t.category) * this.scale,
      anchor: new google.maps.Point(0, 0),
    };
  }

  // Callsign tinted to the type color so label and glyph read as one unit; the
  // chip plate + typography come from CSS (.acLabel — Campfire instrument
  // language: condensed, uppercase, tracked).
  private label(t: AircraftTarget): any {
    return {
      text: t.callsign,
      color: KIND_COLOR[t.kind] ?? KIND_COLOR.unknown,
      className: "acLabel",
    };
  }

  // Append the new position to the hex's trail (capped) and redraw it as
  // recency-faded segments, reusing Polyline objects to avoid per-tick churn.
  // Called only on the poll tick, so the trail snaps like the glyph — no rAF.
  private updateTrail(t: AircraftTarget): void {
    const pts = this.history.get(t.hex) ?? [];
    pts.push({ lat: t.lat, lng: t.lon });
    while (pts.length > TRAIL_POINTS) pts.shift();
    this.history.set(t.hex, pts);

    const segCount = pts.length - 1;
    let segs = this.trailSegs.get(t.hex);
    if (!segs) { segs = []; this.trailSegs.set(t.hex, segs); }
    const color = KIND_COLOR[t.kind] ?? KIND_COLOR.unknown;
    for (let i = 0; i < segCount; i++) {
      let seg = segs[i];
      if (!seg) {
        seg = new google.maps.Polyline({ map: this.map, clickable: false, zIndex: 1 });
        segs[i] = seg;
      }
      seg.setOptions({
        path: [pts[i], pts[i + 1]],
        strokeColor: color,
        strokeOpacity: segmentOpacity(i, segCount),
        strokeWeight: 3,
      });
    }
    // Trail shrank (plane reacquired with fewer points): drop extra segments.
    for (let i = segCount; i < segs.length; i++) segs[i]?.setMap(null);
    segs.length = segCount;
  }

  private clearTrail(hex: string): void {
    const segs = this.trailSegs.get(hex);
    if (segs) { for (const s of segs) s?.setMap(null); this.trailSegs.delete(hex); }
    this.history.delete(hex);
  }
}
