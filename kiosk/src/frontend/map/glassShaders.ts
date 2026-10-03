import { radarPaletteGlsl } from "./radarPalette.js";

// GLSL ES 3.00 for the Weather Glass layer. Two programs:
//  RADAR — georeferenced mesh; samples the real n0q grid (cubic B-spline from
//          4 bilinear taps: smooths BETWEEN measured samples, never moves or
//          invents echoes), crossfades prev→next scan in dBZ, palette by dBZ
//          from radarPalette.ts (conventional radar meaning, theme-tuned shades).
//          Index→dBZ is the n0q scale from backend/radar/n0q.ts.
//  FX    — full-viewport additive pass in drawing-buffer pixels: ambient haze,
//          afterglows, live transmission fronts. Array sizes = MAX_GLOWS /
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

export const FX_VS = `#version 300 es
in vec2 aPos;
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
uniform vec4 uGlowA[32];   // centre px (xy), radius px, strength
uniform vec3 uGlowC[32];
uniform int uNGlows;
out vec4 O;

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), u.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) { s += a * vnoise(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
  return s;
}

void main() {
  vec2 px = gl_FragCoord.xy;
  vec3 col = vec3(0.0);

  if (uHaze > 0.0) {
    vec2 p = px / uRes.y;
    float hz = fbm(p * 1.2 + vec2(uTime * 0.02, -uTime * 0.012) + fbm(p * 2.2 - uTime * 0.03));
    col += vec3(0.12, 0.32, 0.36) * pow(hz, 3.0) * uHaze;
  }

  for (int i = 0; i < 32; i++) {
    if (i >= uNGlows) break;
    vec4 g = uGlowA[i];
    float d = distance(px, g.xy) / max(g.z, 1.0);
    col += uGlowC[i] * exp(-d * d * 2.2) * g.w * 0.35;
  }

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
