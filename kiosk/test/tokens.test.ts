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
  it("--kc-hay-ink on --kc-hay ≥ 4.5:1 (triage badge)", () => {
    expect(contrast(v("--kc-hay-ink"), v("--kc-hay"))).toBeGreaterThanOrEqual(4.5);
  });
  it("LCD text on --kc-well ≥ 4.5:1", () => {
    expect(contrast(v("--kc-glass"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(v("--kc-glass-text"), v("--kc-well"))).toBeGreaterThanOrEqual(4.5);
  });
});

describe("tokens.css layer 2 — the kiosk at room distance (spec 2026-10-01)", () => {
  const props = readProps(TOKENS);
  const v = (n: string): string => resolve(props, props[n] ?? "");
  const ramp = ["--kc-k-pill", "--kc-k-clock", "--kc-k-date", "--kc-k-glass-meta", "--kc-k-glass-name",
    "--kc-k-glass-freq", "--kc-k-head", "--kc-k-alert-title", "--kc-k-glass-error", "--kc-k-weather"];
  for (const n of ramp) it(`${n} is a rem size`, () => {
    expect(props[n], `${n} missing`).toMatch(/^\d+(\.\d+)?rem$/);
  });
  it("motion tokens are milliseconds", () => {
    for (const n of ["--kc-grow-ms", "--kc-release-ms", "--kc-sweep-ms"]) expect(props[n], n).toMatch(/^\d+ms$/);
  });
  it("the glass frequency is at least the clock's size, which outranks the pill", () => {
    const rem = (n: string): number => parseFloat(props[n] ?? "0");
    expect(rem("--kc-k-glass-freq")).toBeGreaterThanOrEqual(rem("--kc-k-clock"));
    expect(rem("--kc-k-glass-freq")).toBeGreaterThan(rem("--kc-k-glass-name"));
    expect(rem("--kc-k-clock")).toBeGreaterThan(rem("--kc-k-pill"));
  });
  it("--kc-pin-cream (head ring) ≥ 3:1 on --kc-well", () => {
    expect(contrast(v("--kc-pin-cream"), v("--kc-well"))).toBeGreaterThanOrEqual(3);
  });
  it("--kc-ink-on-light (text on Google's white info window) ≥ 4.5:1 on white", () => {
    expect(contrast(v("--kc-ink-on-light"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });
  it("the pin tokens mirror the pin SVGs", () => {
    expect(v("--kc-pin-cream").toLowerCase()).toBe("#f5ebe8");
    expect(v("--kc-pin-glyph").toLowerCase()).toBe("#ffffff");
  });
});
