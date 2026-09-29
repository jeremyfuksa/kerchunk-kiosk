import { describe, it, expect } from "vitest";
import { advancedHtml, bandHtml, batchSay, resetHtml, rowHtml, statusHtml } from "../src/frontend/admin-next/tune.js";
import { TUNE_FIELDS, FIELD_BY_ID } from "../src/frontend/admin-next/tuneFields.js";
import { ADVANCED_BANDS, BAND_COST, COST_LABEL } from "../src/frontend/admin/engineKnobs.js";

describe("Tune advanced bands", () => {
  for (const { band, title } of ADVANCED_BANDS) {
    it(`${band}: title, cost label and every field`, () => {
      const html = bandHtml(band, {});
      expect(html).toContain(`id="kcBand-${band}"`);
      expect(html).toContain(title);
      const cost = band === "shape" ? "Restarts scanning · Apply to confirm" : COST_LABEL[BAND_COST[band]];
      expect(html).toContain(cost);
      const ids = TUNE_FIELDS.filter((f) => f.group === band).map((f) => f.id);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        expect(html).toContain(`data-row="${id}"`);
        expect(html).toContain(`id="${id}"`);
      }
      expect(html).toContain(`data-status="${band}"`);
    });
  }

  it("shape carries the preview and an Apply bar; watchdog a restart link", () => {
    expect(bandHtml("shape", {})).toContain('id="kcPreview"');
    expect(bandHtml("shape", {})).toContain('id="kcApply-shape"');
    expect(bandHtml("watchdog", {})).toContain("data-restart");
    expect(bandHtml("loudness", {})).not.toContain("kcPreview");
  });

  it("the disclosure is closed by default and holds every band", () => {
    const html = advancedHtml({});
    expect(html).toMatch(/^<details class="kc-group kc-disclosure" id="kcAdvanced">/);
    expect(html).not.toMatch(/<details[^>]* open/);
    for (const { band } of ADVANCED_BANDS) expect(html).toContain(`kcBand-${band}`);
  });

  it("escapes operator text in values", () => {
    const html = rowHtml(FIELD_BY_ID.tAlertNtfy!, `"><img src=x>`);
    expect(html).not.toContain("<img");
  });
});

describe("Tune rows", () => {
  it("a slider's Use default sits on its label line; others in the row corner", () => {
    const sl = rowHtml(FIELD_BY_ID.kAgcTarget!, "");
    const line = sl.slice(sl.indexOf("kc-slider__line"), sl.indexOf("kc-slider__val"));
    expect(line).toContain('data-reset="kAgcTarget"');
    expect(sl).not.toContain("kc-reset--corner");
    expect(rowHtml(FIELD_BY_ID.tCloseCall!, true)).toContain("kc-reset--corner");
  });
  it("Use default names its field for assistive tech (escaped)", () => {
    const f = { ...FIELD_BY_ID.tHang!, label: `Hang <b>"x"` };
    const h = resetHtml(f, true);
    expect(h).toContain('aria-label="Use default for Hang &lt;b&gt;&quot;x&quot;"');
    expect(h).toContain(" hidden");
  });
  it("every row carries a hidden slot for a refused save", () => {
    for (const f of TUNE_FIELDS) expect(rowHtml(f, f.def)).toContain(`data-rowerr="${f.id}" hidden`);
  });
  it("the error slot has an id inputs can point aria-describedby at; a corner row's clears Use default", () => {
    expect(rowHtml(FIELD_BY_ID.tAlertCool!, "")).toContain('class="kc-rowErr kc-rowErr--corner" id="kcErr-tAlertCool"');
    expect(rowHtml(FIELD_BY_ID.kAgcTarget!, "")).toContain('class="kc-rowErr" id="kcErr-kAgcTarget"');
  });
});

describe("Tune status line", () => {
  it("is focusable by script and offers Retry beside Undo, hidden until needed", () => {
    const h = statusHtml("scanning");
    expect(h).toContain('tabindex="-1"');
    expect(h).toMatch(/data-retry="scanning" hidden>Retry<\/button><button[^>]*data-undo="scanning" hidden>/);
    expect(h).toContain('data-redo="scanning" hidden>Retry');
  });
  it("weather has no batch (no Undo) but can retry a failed save", () => {
    const h = statusHtml("weather");
    expect(h).not.toContain("data-undo");
    expect(h).not.toContain("data-retry");
    expect(h).toContain('data-redo="weather" hidden>Retry');
  });
});

describe("batchSay — one announcement per state", () => {
  it("says the countdown once, in words, with Undo", () => {
    const a = batchSay({ kind: "pending", ids: ["x"], dueAt: 1 }, 3000);
    const b = batchSay({ kind: "pending", ids: ["x", "y"], dueAt: 999_999 }, 3000);
    expect(a).toBe("Applying in 3 seconds, which restarts scanning briefly. Undo available.");
    expect(b).toBe(a); // re-arming doesn't change the sentence, so it isn't re-announced
  });
  it("covers the other states", () => {
    expect(batchSay({ kind: "saving", ids: [] })).toBe("Saving.");
    expect(batchSay({ kind: "saved" })).toBe("Saved.");
    expect(batchSay({ kind: "error", message: "bad", ids: [] })).toBe("Not saved: bad. Retry or undo available.");
    expect(batchSay({ kind: "idle" })).toBe("");
    expect(batchSay({ kind: "pending", ids: [], dueAt: 0 }, 1000)).toContain("1 second,");
  });
});
