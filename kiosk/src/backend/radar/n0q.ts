// IEM's n0q national composite stores reflectivity as a palette INDEX, not a
// colour: 0 = no echo / missing, otherwise 0.5 dBZ steps from -32 dBZ.
// Verified against the PNG's own PLTE (test/radarN0q.test.ts). The glass
// fragment shader (frontend/map/glassShaders.ts) applies the same formula.
export const N0Q_NO_ECHO = 0;

export function n0qIndexToDbz(index: number): number | null {
  if (index === N0Q_NO_ECHO) return null;
  return -32 + 0.5 * index;
}
