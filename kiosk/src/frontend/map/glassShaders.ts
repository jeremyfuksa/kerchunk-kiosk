import { radarPaletteGlsl } from "./radarPalette.js";

// GLSL ES 3.00 for the Weather Glass layer. Two programs:
//  RADAR — georeferenced mesh; samples the real n0q grid (cubic B-spline from
//          4 bilinear taps: smooths BETWEEN measured samples, never moves or
//          invents echoes), crossfades prev→next scan in dBZ, palette by dBZ
//          from radarPalette.ts (conventional radar meaning, theme-tuned shades).
//          Index→dBZ is the n0q scale from backend/radar/n0q.ts.
//  SMOKE — half-res pass into a cached texture (glassLayer re-renders it only
//          when the puffs change): puff bodies + sparks.
//  FX    — full-viewport additive pass in drawing-buffer pixels: ambient haze,
//          afterglow smoke (puffs + sparks), live transmission fronts. Array sizes = MAX_PUFFS /
//          MAX_FRONTS in glassMath.ts.

export const RADAR_VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
uniform mat4 uMvp;
out vec2 vUv;
void main() {
  vUv = aUv;
  gl_Position = uMvp * vec4(aPos, 0.0, 1.0);
}`;

export const RADAR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform sampler2D uNext;
uniform vec2 uTexSize;
uniform float uMix;
uniform float uAlpha;
uniform float uMinDbz;
uniform float uOpacity;
out vec4 O;

float dbzAt(sampler2D t, vec2 uv) {
  return -32.0 + 0.5 * (texture(t, uv).r * 255.0);
}
// Cubic B-spline reconstruction with 4 bilinear fetches (Sigg & Hadwiger).
float bspline(sampler2D t, vec2 uv) {
  vec2 texel = uv * uTexSize - 0.5;
  vec2 i = floor(texel);
  vec2 f = texel - i;
  vec2 f2 = f * f, f3 = f2 * f;
  vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
  vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
  vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
  vec2 w3 = f3 / 6.0;
  vec2 g0 = w0 + w1, g1 = w2 + w3;
  vec2 h0 = (i - 1.0 + w1 / g0 + 0.5) / uTexSize;
  vec2 h1 = (i + 1.0 + w3 / g1 + 0.5) / uTexSize;
  return g0.y * (g0.x * dbzAt(t, vec2(h0.x, h0.y)) + g1.x * dbzAt(t, vec2(h1.x, h0.y)))
       + g1.y * (g0.x * dbzAt(t, vec2(h0.x, h1.y)) + g1.x * dbzAt(t, vec2(h1.x, h1.y)));
}
${radarPaletteGlsl()}
void main() {
  float d = mix(bspline(uPrev, vUv), bspline(uNext, vUv), uMix);
  float vis = smoothstep(uMinDbz - 2.0, uMinDbz + 3.0, d);
  if (vis <= 0.0) discard;
  vec3 c = radarColor(d);
  float a = vis * uOpacity * uAlpha * (0.55 + 0.45 * smoothstep(uMinDbz, 50.0, d));
  O = vec4(c * a, a); // premultiplied
}`;

// Integer hash on the float's exact bits: the classic fract(sin(...)) hash
// bands into diagonal hatching on the appliance's Intel GPU once inputs grow
// (seen on the wall, 2026-10-02).
const NOISE = `float h21(vec2 p) {
  uvec2 q = floatBitsToUint(p);
  uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u);
  h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
  return float(h) * (1.0 / 4294967296.0);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}`;

export const FX_VS = `#version 300 es
layout(location = 0) in vec2 aPos;   // shared by FX and SMOKE (one VAO)
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

export const FX_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform float uTime;
uniform float uHaze;
uniform vec4 uFrontA[8];   // centre px (xy), radius px, age s
uniform vec4 uFrontB[8];   // grow, bright, releasing, unused
uniform vec3 uFrontC[8];
uniform int uNFronts;
uniform sampler2D uSmoke;  // the cached smoke pass (SMOKE_FS)
uniform float uHasSmoke;
out vec4 O;

${NOISE}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 col = vec3(0.0);

  if (uHaze > 0.0) {
    vec2 p = px / uRes.y;
    float hz = fbm(p * 1.2 + vec2(uTime * 0.02, -uTime * 0.012) + fbm(p * 2.2 - uTime * 0.03));
    col += vec3(0.12, 0.32, 0.36) * pow(hz, 3.0) * uHaze;
  }

  if (uHasSmoke > 0.0) col += texture(uSmoke, px / uRes).rgb;   // one fetch per frame

  for (int i = 0; i < 8; i++) {
    if (i >= uNFronts) break;
    vec4 a = uFrontA[i];
    vec4 b = uFrontB[i];
    vec3 c = uFrontC[i];
    float R = max(a.z, 1.0);
    float d = distance(px, a.xy);
    float r = R * (0.08 + 0.92 * b.x);
    float w = max(2.0, R * 0.035);
    float live = 1.0 - b.z;
    float level = 0.35 + 0.65 * b.y;
    float rim = exp(-pow((d - r) / w, 2.0)) * mix(1.4, 0.9, b.x) * level;   // still hold (spec 2026-10-02)
    float trail = 0.0;
    for (int k = 1; k <= 2; k++) {
      float rk = r - float(k) * w * 3.5;
      trail += exp(-pow((d - rk) / w, 2.0)) * (0.25 / float(k)) * (1.0 - b.x * 0.6);
    }
    float flash = exp(-a.w * 7.0) * exp(-(d * d) / (R * R * 0.004));  // ~300 ms
    float core = exp(-(d * d) / (R * R * 0.0015)) * 0.6 * level;
    col += c * ((rim + trail + core) * live + flash);
  }

  O = vec4(col, 0.0); // additive: blendFunc(ONE, ONE)
}`;

// Smoke & sparks (spec 2026-10-02 glass smoke), rendered at half resolution
// into a texture that the FX pass samples. Opaque write (no blend), so the
// target needs no clear.
export const SMOKE_FS = `#version 300 es
precision highp float;
uniform float uScale;      // screen px per smoke-target px
uniform vec4 uPuffA[48];   // centre px (xy, drift applied), base radius px, strength
uniform vec4 uPuffB[48];   // downwind unit (xy; gl px, +y north; 0,0 = calm), along, cross
uniform vec4 uPuffC[48];   // rgb, seed
uniform int uNPuffs;
uniform float uStep;       // shared smoke tick, wrapped (STEP_WRAP): outline + spark generations
uniform float uSmokeBody;
uniform float uSparkDensity;
out vec4 O;
${NOISE}
void main() {
  vec2 px = gl_FragCoord.xy * uScale;
  vec3 col = vec3(0.0);
  // Smoke & sparks (spec 2026-10-02 glass smoke). Static between ticks: only
  // uStep and the puff uniforms change, and only on the shared smoke tick.
  vec3 acc = vec3(0.0);
  float peak = 0.0;
  for (int i = 0; i < 48; i++) {
    if (i >= uNPuffs) break;
    vec4 a = uPuffA[i];
    vec4 b = uPuffB[i];
    vec4 c = uPuffC[i];
    float R = max(a.z, 1.0);
    vec2 d = px - a.xy;
    vec2 ax = dot(b.xy, b.xy) > 0.5 ? b.xy : vec2(1.0, 0.0);
    float u = dot(d, ax) / (R * b.z);
    float v = dot(d, vec2(-ax.y, ax.x)) / (R * b.w);
    float r2 = u * u + v * v;
    if (r2 > 4.0) continue;
    float n = vnoise(d / R * 1.6 + vec2(c.w * 97.0, c.w * 41.0) + uStep * 0.15) - 0.5;   // ragged edge, shifts per tick
    float f = a.w * exp(-r2 * 2.2 * (1.0 + n * 1.4));
    f *= 0.25 + 1.1 * fbm(d / R * 2.4 + vec2(c.w * 13.0, c.w * 29.0) + uStep * 0.04);   // wisps inside the body
    acc += c.rgb * f;
    peak = max(peak, f);
  }
  float m = max(max(acc.r, acc.g), acc.b);
  if (m > 0.002) {
    vec3 hue = acc / m;                                    // keep service hues; compress brightness only
    col += hue * (1.0 - exp(-m * 0.9)) * uSmokeBody * 0.6;  // gentle curve: stacked puffs keep their wisps
    vec2 cell = floor(gl_FragCoord.xy);   // 1 px here = 2 px on screen
    float gen = floor((uStep + h21(cell) * 7.0) / 7.0);  // each grain reshuffles every 7 ticks, staggered
    float g = h21(cell + vec2(gen * 61.0, gen * 17.0));
    // Embers gather in the thick of a puff (the single strongest one here),
    // thinning fast toward its edges.
    if (g < peak * peak * peak * uSparkDensity * 0.12) col += hue * min(1.0, 0.5 + peak);
  }
  O = vec4(col, 1.0);
}`;
