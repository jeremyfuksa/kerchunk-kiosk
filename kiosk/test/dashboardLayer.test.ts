// The Layer Rule for the dashboard (spec 2026-10-01): below the marker,
// dashboard.css reads layer 2 only. The storm palette is the one carve-out:
// its literals live in the .alertBar[data-kind] rules, and the card reads
// them through --alert-color / --alert-on.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const MARK = "/* ── Dashboard (layer 2) ── */";
// Strip every comment except the marker itself.
const css = readFileSync("src/frontend/dashboard/dashboard.css", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (c) => (c === MARK ? c : ""));

describe("dashboard.css Layer Rule", () => {
  it("has the layer-2 marker", () => {
    expect(css.includes(MARK)).toBe(true);
  });
  const dash = css.slice(css.indexOf(MARK) + MARK.length)
    .split("\n").filter((l) => !/\.alertBar\[data-kind=/.test(l)).join("\n");
  it("reads only --kc-* and --alert-* below the marker", () => {
    const vars = [...dash.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(20);
    expect(vars.filter((v) => !/^--(kc-|alert-)/.test(v))).toEqual([]);
  });
  it("has no literal colours below the marker (storm kinds excepted)", () => {
    expect(dash.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
  });
  it("scopes every dashboard rule to the dashboard page", () => {
    const selectors = [...dash.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter((s) => !/^(from|to|\d+%)/.test(s));
    expect(selectors.filter((s) => !s.split(",").every((p) => p.trim().startsWith('html[data-page="dashboard"]')))).toEqual([]);
  });
});

// The map joins layer 2 (spec 2026-10-01, PR 3). It renders inside the
// dashboard and on its own /map page, so its rules scope to either. The
// recorded carve-outs: --glow-color (set at runtime to a service colour),
// --flamingo (close call) and --pine (no fix) — hit-kind marks like PIN_COLORS.
import { KIOSK_FIT_PAD } from "../src/frontend/map/map.js";
const MAP_MARK = "/* ── Map (layer 2) ── */";
const mapCss = readFileSync("src/frontend/map/map.css", "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, (c) => (c === MAP_MARK ? c : ""));

describe("map.css Layer Rule", () => {
  it("has the layer-2 marker", () => {
    expect(mapCss.includes(MAP_MARK)).toBe(true);
  });
  const body = mapCss.slice(mapCss.indexOf(MAP_MARK) + MAP_MARK.length);
  it("reads only --kc-* plus the recorded carve-outs", () => {
    const vars = [...body.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]!);
    expect(vars.length).toBeGreaterThan(10);
    expect(vars.filter((v) => !/^--(kc-|glow-color$|flamingo$|pine$)/.test(v))).toEqual([]);
  });
  it("has no literal colours", () => {
    expect(body.match(/#[0-9a-f]{3,8}\b|rgba?\(/gi) ?? []).toEqual([]);
  });
  it("scopes every rule to the map or dashboard page", () => {
    const selectors = [...body.matchAll(/(^|})\s*([^{}@]+)\{/g)].map((m) => m[2]!.trim()).filter((s) => !/^(from|to|\d+%)/.test(s));
    const ok = (p: string): boolean => /^(:is\(html\[data-page="map"\], html\[data-page="dashboard"\]\)|html\[data-page="map"\])/.test(p.trim());
    expect(selectors.filter((s) => !s.split(/,(?![^(]*\))/).every(ok))).toEqual([]);
  });
  it("kiosk framing clears the clock + weather and the idle pill", () => {
    expect(KIOSK_FIT_PAD.top).toBeGreaterThanOrEqual(180);
    expect(KIOSK_FIT_PAD.bottom).toBeGreaterThanOrEqual(100);
  });
});
