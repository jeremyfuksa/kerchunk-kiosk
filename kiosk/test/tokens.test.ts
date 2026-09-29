import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { readProps, resolve, contrast } from "./cssTokens.js";

const TOKENS = "src/frontend/tokens.css";
const fixture = JSON.parse(readFileSync("test/fixtures/campfire-dark-resolved.json", "utf8")) as Record<string, string>;

describe("tokens.css layer 1 (ambient pages keep their look)", () => {
  const props = readProps(TOKENS);
  for (const [name, value] of Object.entries(fixture)) {
    it(`${name} resolves to Campfire's current value`, () => {
      expect(props[name], `${name} missing from tokens.css`).toBeDefined();
      expect(resolve(props, props[name]!).toLowerCase()).toBe(value.toLowerCase());
    });
  }
});

describe("tokens.css layer 2 (admin language) contrast", () => {
  const props = readProps(TOKENS);
  const v = (n: string): string => resolve(props, props[n] ?? "");
  const grounds = ["--kc-ground", "--kc-raised", "--kc-key"];
  const text = ["--kc-ink", "--kc-dim", "--kc-mute", "--kc-glass", "--kc-coral", "--kc-hay", "--kc-ok", "--kc-glass-text"];
  for (const t of text) for (const g of grounds) {
    it(`${t} on ${g} ≥ 4.5:1`, () => {
      expect(contrast(v(t), v(g))).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("--kc-glass-ink on --kc-glass ≥ 4.5:1", () => {
    expect(contrast(v("--kc-glass-ink"), v("--kc-glass"))).toBeGreaterThanOrEqual(4.5);
  });
  it("LCD text on --kc-well ≥ 4.5:1", () => {
    expect(contrast(v("--kc-glass"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--kc-glass-text"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
  });
});
