import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SMOKE_FS } from "../src/frontend/map/glassShaders.js";

describe("smoke hue dominance (spec 2026-10-04 §4)", () => {
  it("declares uHueDominance and weights hue by f^k, brightness by f", () => {
    expect(SMOKE_FS).toContain("uniform float uHueDominance;");
    expect(SMOKE_FS).toMatch(/accP \+= c\.rgb \* pow\(f, uHueDominance\);/);
    expect(SMOKE_FS).toMatch(/acc \+= c\.rgb \* f;/);
  });
  it("k = 1 path is the plain average (accP == acc, so hue = acc / m)", () => {
    // With k = 1, pow(f, 1) = f: accP accumulates exactly what acc does.
    expect(SMOKE_FS).toMatch(/vec3 hue = mp > 1e-9 \? accP \/ mp : acc \/ m;/);
  });
  it("the layer links and sets the uniform from the knob", () => {
    const src = readFileSync(join(__dirname, "..", "src", "frontend", "map", "glassLayer.ts"), "utf8");
    expect(src).toContain('"uHueDominance"');
    expect(src).toMatch(/gl\.uniform1f\(u\.uHueDominance!, k\.hueDominance\)/);
  });
});
