import { describe, it, expect } from "vitest";
import { key, lcd, group } from "../src/frontend/admin-next/ui/kit.js";
import { initialLive, lcdView, reduceEvent } from "../src/frontend/admin-next/live.js";

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
});
