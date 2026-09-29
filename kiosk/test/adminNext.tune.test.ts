import { describe, it, expect } from "vitest";
import { advancedHtml, bandHtml, rowHtml } from "../src/frontend/admin-next/tune.js";
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
