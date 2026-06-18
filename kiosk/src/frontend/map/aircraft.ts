import type { AircraftTarget } from "../../backend/engine/ScannerEngine.js";

declare const google: any; // loaded dynamically with the configured Maps key

// Aircraft overlay layer (network ADS-B). Each WS "aircraft" event delivers a
// FULL snapshot; update() reconciles the marker set against it by hex — move
// the ones still present, add new ones, remove vanished ones. Markers update
// imperatively (snap), so this adds NO per-frame animation: cost is one
// reconcile per poll (~5s), independent of the blip rAF idle loop.

// Cyan so aircraft read as a distinct layer that never competes with the
// service-colored site pins or Close Call blips.
const PLANE_COLOR = "#5bd6ff";

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

export class AircraftLayer {
  private readonly markers = new Map<string, any>();
  constructor(private readonly map: any, private readonly scale: number) {}

  update(targets: AircraftTarget[]): void {
    for (const t of targets) {
      const pos = { lat: t.lat, lng: t.lon };
      let marker = this.markers.get(t.hex);
      if (!marker) {
        marker = new google.maps.Marker({
          map: this.map,
          position: pos,
          icon: this.icon(t.heading),
          label: this.label(t.callsign),
          clickable: false,
          zIndex: 2, // above site pins (zIndex 1), below info windows
        });
        this.markers.set(t.hex, marker);
      } else {
        marker.setPosition(pos);
        marker.setIcon(this.icon(t.heading));
      }
    }
    for (const hex of removedHexes(this.markers.keys(), targets)) {
      this.markers.get(hex)?.setMap(null);
      this.markers.delete(hex);
    }
  }

  // A heading-rotated plane glyph as a Google Maps Symbol. FORWARD_CLOSED_ARROW
  // points "up" (north) at rotation 0, so the track angle rotates it directly.
  private icon(heading: number | null): any {
    return {
      path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW,
      scale: 4 * this.scale,
      rotation: planeIconRotation(heading),
      fillColor: PLANE_COLOR,
      fillOpacity: 0.95,
      strokeColor: "#0a2230",
      strokeWeight: 1,
    };
  }

  private label(callsign: string): any {
    return {
      text: callsign,
      color: PLANE_COLOR,
      fontSize: `${Math.round(11 * this.scale)}px`,
      fontWeight: "600",
      className: "acLabel",
    };
  }
}
