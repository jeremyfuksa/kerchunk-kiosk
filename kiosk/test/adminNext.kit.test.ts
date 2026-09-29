import { describe, it, expect } from "vitest";
import { dbText, key, lcd, group, meterLit } from "../src/frontend/admin-next/ui/kit.js";
import { initialLive, lcdKey, lcdView, reduceEvent } from "../src/frontend/admin-next/live.js";

describe("ui kit", () => {
  it("key escapes its label and carries variant + disabled", () => {
    const h = key({ id: "k", label: "<b>Lock</b>", variant: "danger", disabled: true });
    expect(h).toContain("&lt;b&gt;Lock&lt;/b&gt;");
    expect(h).toContain('class="kc-key kc-key--danger"');
    expect(h).toContain(" disabled");
    expect(h).toContain('id="k"');
  });
  it("lcd renders name, freq and state", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: { id: "a", freq: 118_400_000, alphaTag: "A&B", mode: "am", enabled: true } as never, ts: 1 }).state;
    const h = lcd(lcdView(s), { dbfs: -41 });
    expect(h).toContain('data-state="live"');
    expect(h).toContain("A&amp;B");
    expect(h).toContain("118.4000");
    expect(h).toContain("−41 dB");
  });
  it("lcd omits the MHz unit while scanning", () => {
    expect(lcd(lcdView(initialLive))).not.toContain("MHz");
  });
  it("group wraps a titled section", () => {
    expect(group("Alerts", "<p>x</p>", { id: "g" })).toMatch(/<section class="kc-group" id="g"[^>]*>\s*<h2 class="kc-group__title">Alerts<\/h2>/);
  });
  it("lcd keeps an aria-hidden dB slot while live, even before a reading", () => {
    const s = reduceEvent(initialLive, { type: "audible", channel: { id: "a", freq: 118_400_000, alphaTag: "A", mode: "am", enabled: true } as never, ts: 1 }).state;
    expect(lcd(lcdView(s))).toContain('<span class="kc-lcd__db" aria-hidden="true"></span>');
    expect(lcd(lcdView(initialLive))).not.toContain("kc-lcd__db");
  });
  it("meterLit / dbText map dBFS for in-place level updates", () => {
    expect(meterLit(null)).toBe(0);
    expect(meterLit(-60)).toBe(0);
    expect(meterLit(-30)).toBe(2);
    expect(meterLit(5)).toBe(4);
    expect(dbText(null)).toBe("");
    expect(dbText(-41.4)).toBe("−41 dB");
  });
});

describe("lcdKey", () => {
  const ch = { id: "a", freq: 462_562_500, alphaTag: "Ch 1", mode: "fm", enabled: true } as never;
  const live = reduceEvent(initialLive, { type: "audible", channel: ch, ts: 1 }).state;
  it("ignores dbfs-only changes (no LCD rebuild at signal rate)", () => {
    const a = reduceEvent(live, { type: "signal", dbfs: -40, ts: 2 } as never).state;
    const b = reduceEvent(a, { type: "signal", dbfs: -12, ts: 3 } as never).state;
    expect(lcdKey(lcdView(a))).toBe(lcdKey(lcdView(b)));
  });
  it("changes when the channel, state or silent flag changes", () => {
    const k = lcdKey(lcdView(live));
    expect(lcdKey(lcdView(initialLive))).not.toBe(k);
    expect(lcdKey(lcdView({ ...live, muted: true }))).not.toBe(k);
    const other = reduceEvent(live, { type: "audible", channel: { ...(ch as object), freq: 462_587_500, alphaTag: "Ch 2" } as never, ts: 4 }).state;
    expect(lcdKey(lcdView(other))).not.toBe(k);
  });
});
