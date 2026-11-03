// GLM lightning shapes (spec 2026-10-13 glass lightning). No imports: the
// frontend type-imports this file, directly and via ScannerEngine's event union.

/** One GLM flash inside the crop box. */
export interface Flash {
  /** Epoch ms of the flash's first optical event. */
  t: number;
  lat: number;
  lon: number;
  /** Total optical energy, femtojoules. */
  energyFj: number;
  /** Footprint, km². */
  areaKm2: number;
}

/** Inclusive lat/lon box (degrees). */
export interface Box { n: number; s: number; e: number; w: number }
