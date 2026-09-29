// Guard: every `var(--name)` reference with no fallback must resolve to a
// declared custom property somewhere in src/frontend/**/*.css, or be set at
// runtime (allow-listed below with where it's set). Catches typos/rename
// drift that would otherwise silently fall back to the browser's initial
// value (usually transparent/inherit) instead of erroring.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import path from "node:path";

// Names set at runtime via el.style.setProperty("--name", …) or an inline
// style="--name:…" attribute, rather than a static CSS declaration.
const RUNTIME_SET = new Set([
  // src/frontend/map/map.ts:184 — glow.style.setProperty("--glow-color", color)
  "--glow-color",
]);

function stripCss(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

function stripTs(src: string): string {
  // Strip /* */ block comments and // line comments. Good enough for this
  // repo's TS (no // inside string literals containing var(--...) usages).
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function collectFiles(root: string, exts: string[]): string[] {
  return exts.flatMap((ext) => globSync(`${root}/**/*.${ext}`));
}

describe("CSS custom properties used without a fallback are declared", () => {
  const frontendRoot = path.resolve(__dirname, "../src/frontend");
  const cssFiles = collectFiles(frontendRoot, ["css"]);
  const tsFiles = collectFiles(frontendRoot, ["ts"]);

  const declared = new Set<string>();
  for (const f of cssFiles) {
    const css = stripCss(readFileSync(f, "utf8"));
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) declared.add(m[1]!);
  }

  const used = new Map<string, Set<string>>(); // name -> files referencing it
  for (const f of [...cssFiles, ...tsFiles]) {
    const raw = readFileSync(f, "utf8");
    const src = f.endsWith(".ts") ? stripTs(raw) : stripCss(raw);
    // var(--name) with no comma (no fallback). Negative lookahead for a
    // fallback-introducing comma before the closing paren.
    for (const m of src.matchAll(/var\((--[\w-]+)\s*\)/g)) {
      const name = m[1]!;
      if (!used.has(name)) used.set(name, new Set());
      used.get(name)!.add(path.relative(frontendRoot, f));
    }
  }

  const undeclared: string[] = [];
  for (const [name, files] of used) {
    if (declared.has(name)) continue;
    if (RUNTIME_SET.has(name)) continue;
    undeclared.push(`${name} (used in: ${[...files].join(", ")})`);
  }

  it("has no var(--name) references without a fallback that are undeclared", () => {
    expect(undeclared, `Undeclared CSS custom properties:\n${undeclared.join("\n")}`).toEqual([]);
  });

  it("sanity: found a non-trivial number of declared/used vars", () => {
    expect(declared.size).toBeGreaterThan(10);
    expect(used.size).toBeGreaterThan(10);
  });
});
