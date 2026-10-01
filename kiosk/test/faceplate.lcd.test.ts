import { describe, it, expect } from "vitest";
import { dbText, lcd, meterLit, METER_FLOOR_DB, segmentsLit } from "../src/frontend/faceplate/lcd.js";
import { serviceHead } from "../src/frontend/faceplate/serviceHead.js";
import { initialLive, lcdView, reduceEvent } from "../src/frontend/admin/live.js";

const liveState = () => reduceEvent(initialLive, { type: "audible", channel: { id: "a", freq: 118_400_000, alphaTag: "A&B", mode: "am", enabled: true } as never, ts: 1 }).state;

describe("faceplate lcd (moved from the admin kit)", () => {
  it("lcd renders name, freq and state", () => {
    const h = lcd(lcdView(liveState()), { dbfs: -41 });
    expect(h).toContain('data-state="live"');
    expect(h).toContain("A&amp;B");
    expect(h).toContain("118.4000");
    expect(h).toContain("−41 dB");
  });
  it("lcd omits the MHz unit while scanning", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("MHz");
  });
  it("lcd keeps an aria-hidden dB slot while live, even before a reading", () => {
    expect(lcd(lcdView(liveState()))).toContain('<span class="kc-lcd__db" aria-hidden="true"></span>');
    expect(lcd(lcdView(initialLive))).not.toContain("kc-lcd__db");
  });
  it("lcd markup is not itself a live region (the persistent host is)", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("aria-live");
    expect(lcd(lcdView(initialLive))).not.toContain('role="status"');
  });
  it("meter floor is the knob: at the floor no bars, halfway two", () => {
    expect(meterLit(METER_FLOOR_DB)).toBe(0);
    expect(meterLit(METER_FLOOR_DB / 2)).toBe(2);
    expect(meterLit(0)).toBe(4);
  });
  it("meterLit / dbText map dBFS for in-place level updates", () => {
    expect(meterLit(null)).toBe(0);
    expect(meterLit(-60)).toBe(0);
    expect(meterLit(-30)).toBe(2);
    expect(meterLit(5)).toBe(4);
    expect(dbText(null)).toBe("");
    expect(dbText(-41.4)).toBe("−41 dB");
  });
  it("default markup is byte-identical to the admin's (radio.ts queries .kc-meter i / .kc-lcd__db)", () => {
    expect(lcd(lcdView(liveState()), { dbfs: -30 }).replace(/\s+/g, " ")).toBe(
      '<div class="kc-lcd" data-state="live"> <div class="kc-lcd__meta"><span><span class="kc-meter" aria-hidden="true"><i class="on"></i><i class="on"></i><i></i><i></i></span>Live · AM</span><span class="kc-lcd__db" aria-hidden="true">−30 dB</span></div> <div class="kc-lcd__name">A&amp;B</div> <div class="kc-lcd__freq">118.4000<small>MHz</small></div> </div>',
    );
  });
});

describe("faceplate lcd — kiosk extras", () => {
  const live = { state: "live", meta: "Live · Public safety", name: "KC Fire Dispatch", freq: "154.4300", silent: null };

  it("head renders the disc + glyph left of name and freq, aria-hidden", () => {
    const h = lcd(live, { head: serviceHead("publicsafety") });
    expect(h).toMatch(/<div class="kc-lcd__row"><svg class="kc-lcd__head" viewBox="0 0 42 42" aria-hidden="true"><circle cx="21" cy="21" r="21" fill="#E5383B"\/>/);
    expect(h).toContain('stroke="currentColor"');
    expect(h.indexOf("kc-lcd__head")).toBeLessThan(h.indexOf("kc-lcd__name"));
    expect(h).toContain('<div class="kc-lcd__text">');
  });
  it("a low-contrast head is ringed", () => {
    expect(lcd(live, { head: serviceHead("rail") })).toContain('class="kc-lcd__head kc-lcd__head--ringed"');
    expect(lcd(live, { head: serviceHead("air") })).not.toContain("kc-lcd__head--ringed");
  });
  it("segments replace the four-bar meta meter and light round(fill × count)", () => {
    const h = lcd(live, { segments: { count: 12, fill: 0.6 } });
    expect(h).not.toContain("kc-meter");
    expect(h.match(/<i class="on"><\/i>/g)?.length).toBe(7);
    expect(h.match(/<i><\/i>/g)?.length).toBe(5);
    expect(h).toContain('<div class="kc-lcd__seg" aria-hidden="true">');
  });
  it("segmentsLit clamps out-of-range and NaN fills", () => {
    expect(segmentsLit(-0.5, 12)).toBe(0);
    expect(segmentsLit(1.7, 12)).toBe(12);
    expect(segmentsLit(Number.NaN, 12)).toBe(0);
    expect(segmentsLit(0.5, 12)).toBe(6);
  });
  it("wall size adds the modifier class", () => {
    expect(lcd(live, { size: "wall" })).toContain('class="kc-lcd kc-lcd--wall"');
    expect(lcd(live, { size: "panel" })).toContain('class="kc-lcd"');
  });
  it("wall size with no head and no freq (the error state) has no empty row wrapper", () => {
    const h = lcd({ state: "error", meta: "Radio error", name: "SDR KIOSK01 not found", freq: "", silent: null }, { size: "wall" });
    expect(h).not.toContain("kc-lcd__row");
    expect(h).not.toContain("MHz");
    expect(h).toContain("SDR KIOSK01 not found");
  });
});
