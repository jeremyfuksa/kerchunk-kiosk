import { describe, it, expect } from "vitest";
import { dbText, lcd, meterLit, METER_FLOOR_DB } from "../src/frontend/faceplate/lcd.js";
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
