import { describe, it, expect } from "vitest";
import { dbText, key, lcd, group, meterLit, METER_FLOOR_DB, slider, switchRow, segmented, chip, field } from "../src/frontend/admin-next/ui/kit.js";
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
});

describe("slider / switchRow", () => {
  it("slider pairs a range and a typed-entry box with named ends", () => {
    const h = slider({ id: "kAgcTarget", label: "Target <loud>", hint: "Where it lands", min: -40, max: -3, step: 1, value: -18, unit: "dBFS", ends: ["Quieter", "Louder"] });
    expect(h).toContain('id="kAgcTarget" type="range" min="-40" max="-3" step="1" value="-18"');
    expect(h).toContain('id="kAgcTarget-num" type="number"');
    expect(h).toContain('<label for="kAgcTarget">Target &lt;loud&gt;</label>');
    expect(h).toContain(">Quieter<");
    expect(h).toContain(">Louder<");
    expect(h).not.toContain(" disabled");
  });
  it("slider and switchRow honour disabled", () => {
    expect(slider({ id: "a", label: "A", min: 0, max: 1, step: 1, value: 0, unit: "", ends: ["x", "y"], disabled: true })).toContain(" disabled");
    const s = switchRow({ id: "kcRemote", label: "Remote listening", hint: "Stream it", checked: true, disabled: true });
    expect(s).toContain('<input id="kcRemote" type="checkbox" role="switch" checked disabled');
    expect(s).toContain('class="kc-switchRow"');
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

describe("segmented", () => {
  it("renders links with the current one marked and counts", () => {
    const html = segmented({
      label: "Library view", current: "new",
      items: [
        { id: "channels", label: "Channels", href: "#/library", count: 102 },
        { id: "new", label: "New", href: "#/library/new", count: 3, attention: true },
      ],
    });
    expect(html).toContain('aria-label="Library view"');
    expect(html).toMatch(/href="#\/library\/new"[^>]*aria-current="page"/);
    expect(html).not.toMatch(/href="#\/library"[^>]*aria-current/);
    expect(html).toContain('<b class="kc-seg__count">102</b>');
    expect(html).toContain('<b class="kc-seg__count kc-badge">3</b>');
  });
});

describe("chip", () => {
  it("is a pressed-state button that escapes its label", () => {
    const html = chip({ id: "bank:a", label: "<Air>", count: 15, pressed: true });
    expect(html).toContain('data-chip="bank:a"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("&lt;Air&gt;");
    expect(html).toContain("<b>15</b>");
  });
});

describe("field", () => {
  it("labels the control and carries a hidden error slot", () => {
    const html = field({ id: "kcX", label: "Name", control: '<input id="kcX">', hint: "Shown on the wall" });
    expect(html).toContain('<label for="kcX">Name</label>');
    expect(html).toContain('id="kcX-err"');
    expect(html).toContain("hidden");
  });
});
