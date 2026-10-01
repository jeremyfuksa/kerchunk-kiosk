import { describe, it, expect } from "vitest";
import { pillHtml, glassHtml, cornerPaint } from "../src/frontend/dashboard/corner.js";
import { cornerView, type CornerInput } from "../src/frontend/dashboard/cornerView.js";

const base: CornerInput = {
  warmed: true, warmupPhase: null, warmupStep: 0, warmupOf: 4, error: null, engineState: "running",
  nowPlaying: null, tunedHz: 160_900_000, scanCount: 41, muted: false, mode: "scan", breakIn: false,
};
const scanning = cornerView(base);
const live = cornerView({ ...base, nowPlaying: { freq: 154_430_000, alphaTag: "KC Fire Dispatch", tags: ["public-safety"] } });
const live2 = cornerView({ ...base, nowPlaying: { freq: 155_010_000, alphaTag: "KC Police", tags: ["public-safety"] } });

describe("pillHtml", () => {
  it("word, detail and the sweep tick", () => {
    const h = pillHtml(scanning as never);
    expect(h).toContain('class="kc-pill" data-sweep="on"');
    expect(h).toContain('<span class="kc-pill__word">Scanning</span>');
    expect(h).toContain('<span class="kc-pill__detail"> · VHF high 160.9</span>');
    expect(h).toContain('<span class="kc-pill__tick" aria-hidden="true"></span>');
  });
  it("hay tone, muted, and no sweep", () => {
    const h = pillHtml(cornerView({ ...base, scanCount: 0, muted: true }) as never);
    expect(h).toContain('class="kc-pill kc-pill--hay" data-sweep="off"');
    expect(h).toContain("kc-pill__muted");
    expect(h).toContain("Muted");
  });
  it("warm-up pill carries the 12-segment row", () => {
    const h = pillHtml(cornerView({ ...base, warmed: false, warmupPhase: "tuned", warmupStep: 3, warmupOf: 4 }) as never);
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(9);
  });
  it("escapes the detail", () => {
    const v = { ...(scanning as object), detail: "<b>" } as never;
    expect(pillHtml(v)).toContain("&lt;b&gt;");
  });
});

describe("glassHtml", () => {
  it("is a wall-size LCD with the head and a 12-segment meter filled from dB", () => {
    const h = glassHtml(live as never, -15);
    expect(h).toContain('class="kc-lcd kc-lcd--wall" data-state="live"');
    expect(h).toContain("kc-lcd__head");
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(6);
    expect(h).not.toContain("kc-meter");
  });
  it("the error glass has its hint and no meter", () => {
    const h = glassHtml(cornerView({ ...base, error: "boom" }) as never, null);
    expect(h).toContain("kc-lcd__hint");
    expect(h).not.toContain("kc-lcd__seg");
  });
});

describe("cornerPaint", () => {
  it("first paint builds what it shows", () => {
    expect(cornerPaint(null, scanning)).toMatchObject({ show: "pill", rebuildPill: true, rebuildGlass: false });
  });
  it("a hit grows the glass and leaves the pill's content alone", () => {
    const p0 = cornerPaint(null, scanning);
    const p1 = cornerPaint(p0.memo, live);
    expect(p1).toMatchObject({ show: "glass", rebuildGlass: true, rebuildPill: false });
  });
  it("a release keeps the glass content while it shrinks (no rebuild of the glass)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    const p2 = cornerPaint(p1.memo, scanning);
    expect(p2).toMatchObject({ show: "pill", rebuildGlass: false, rebuildPill: false });
  });
  it("a different channel while live swaps the glass in place", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    expect(cornerPaint(p1.memo, live2)).toMatchObject({ show: "glass", rebuildGlass: true });
  });
  it("same view → nothing rebuilt (signal ticks update in place)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    expect(cornerPaint(p1.memo, live)).toMatchObject({ rebuildGlass: false, rebuildPill: false });
  });
  it("a re-hit on the same channel during a release reuses the glass (reverses, no rebuild)", () => {
    const p1 = cornerPaint(cornerPaint(null, scanning).memo, live);
    const p2 = cornerPaint(p1.memo, scanning);
    expect(cornerPaint(p2.memo, live)).toMatchObject({ show: "glass", rebuildGlass: false });
  });
});

import { pillDetailText, alertFlip } from "../src/frontend/dashboard/corner.js";

describe("corner — review fixes", () => {
  it("the pill always carries a detail span, so a window hop patches text in place", () => {
    const h = pillHtml(cornerView({ ...base, tunedHz: null }) as never);
    expect(h).toContain('<span class="kc-pill__detail"></span>');
    expect(pillDetailText("UHF-T 462.8")).toBe(" · UHF-T 462.8");
    expect(pillDetailText("")).toBe("");
  });
  it("alertFlip: on a grow the card starts where it was (below) and slides up with the glass", () => {
    expect(alertFlip(70, 300, "glass")).toEqual({ offsetPx: 230, durationVar: "--kc-grow-ms" });
  });
  it("alertFlip: on a release the card starts above and slides down with the shrinking glass", () => {
    expect(alertFlip(300, 70, "pill")).toEqual({ offsetPx: -230, durationVar: "--kc-release-ms" });
  });
  it("alertFlip: no height change → no slide", () => {
    expect(alertFlip(120, 120, "glass")).toBeNull();
  });
});
