// Test helper: parse custom properties out of a CSS file and resolve var()
// chains, plus WCAG 2.x contrast. Deliberately tiny — tokens.css is flat.
import { readFileSync } from "node:fs";

export function readProps(path: string, selector = ":root"): Record<string, string> {
  const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const start = css.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`${selector} block not found in ${path}`);
  const end = css.indexOf("}", start);
  const out: Record<string, string> = {};
  for (const m of css.slice(start, end).matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

export function resolve(props: Record<string, string>, value: string, depth = 0): string {
  if (depth > 10) return value;
  return value.replace(/var\((--[\w-]+)\)/g, (_, n: string) =>
    resolve(props, props[n] ?? `var(${n})`, depth + 1));
}

function lum(hex: string): number {
  const h = hex.replace("#", "");
  const c = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
