// Weather Glass radar colours. Operator mandate (2026-10-01): shades may be
// tuned to complement the Night desk map, but the MEANING must stay the
// conventional reflectivity scale — light blue → green → yellow → orange →
// red → magenta → violet/white, at the familiar NWS breakpoints — so anyone
// who reads weather radar reads this one. test/radarPalette.test.ts pins the
// order, breakpoints and hue families. Below the first stop the shader's
// radarMinDbz cutoff decides visibility.

export interface RadarStop { name: string; dbz: number; rgb: readonly [number, number, number] }

export const RADAR_STOPS: readonly RadarStop[] = [
  { name: "blue",       dbz: 15, rgb: [0.30, 0.62, 0.92] }, // light precip
  { name: "green",      dbz: 22, rgb: [0.36, 0.80, 0.52] },
  { name: "deep-green", dbz: 32, rgb: [0.16, 0.60, 0.34] }, // moderate
  { name: "yellow",     dbz: 38, rgb: [0.98, 0.86, 0.30] },
  { name: "orange",     dbz: 45, rgb: [1.00, 0.58, 0.22] }, // heavy
  { name: "red",        dbz: 52, rgb: [0.94, 0.26, 0.30] },
  { name: "magenta",    dbz: 60, rgb: [0.86, 0.30, 0.80] }, // intense / hail
  { name: "violet",     dbz: 68, rgb: [0.74, 0.66, 1.00] }, // extreme
];

/** Half-width (dBZ) of the blend at each breakpoint: bands stay readable as
 *  bands, without hard aliased edges. */
const BLEND_DBZ = 2;

const v3 = (c: readonly [number, number, number]): string => `vec3(${c.map((x) => x.toFixed(3)).join(", ")})`;

/** GLSL `vec3 radarColor(float d)` over RADAR_STOPS. */
export function radarPaletteGlsl(): string {
  const [first, ...rest] = RADAR_STOPS;
  const lines = rest.map((s) =>
    `  c = mix(c, ${v3(s.rgb)}, smoothstep(${(s.dbz - BLEND_DBZ).toFixed(1)}, ${(s.dbz + BLEND_DBZ).toFixed(1)}, d)); // ${s.name} ${s.dbz.toFixed(1)}`);
  return [
    "vec3 radarColor(float d) {",
    `  vec3 c = ${v3(first!.rgb)}; // ${first!.name} ${first!.dbz.toFixed(1)}`,
    ...lines,
    "  return c;",
    "}",
  ].join("\n");
}
