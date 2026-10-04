// OKLCH / OKLab <-> sRGB (Björn Ottosson's matrices). The palette's one colour
// space: family bases, per-site variation and the CVD/containment tests.
export interface Lch { L: number; C: number; h: number }

function oklchToLinear({ L, C, h }: Lch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
}

/** OKLCH -> lower-case sRGB hex, pulling chroma in (0.005 steps) until the
 *  colour fits the gamut — hue and lightness are kept, never clipped apart. */
export function oklchHex(c: Lch): string {
  let C = c.C;
  let rgb = oklchToLinear({ ...c, C });
  while (C > 0 && rgb.some((v) => v < 0 || v > 1)) { C -= 0.005; rgb = oklchToLinear({ ...c, C }); }
  const enc = (v: number): number => {
    const x = Math.min(1, Math.max(0, v));
    return Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  };
  return "#" + rgb.map((v) => enc(v).toString(16).padStart(2, "0")).join("");
}

/** "#rrggbb" -> linear-light RGB 0..1. */
export function linearRgb(hex: string): [number, number, number] {
  const ch = (i: number): number => {
    const x = parseInt(hex.slice(i, i + 2), 16) / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return [ch(1), ch(3), ch(5)];
}

export function linearToOklab([r, g, b]: [number, number, number]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  ];
}

export function hexToOklab(hex: string): [number, number, number] {
  return linearToOklab(linearRgb(hex));
}
