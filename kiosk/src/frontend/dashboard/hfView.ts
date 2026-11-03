// The Atlas's text: the station panel and the reception band (spec 2026-11-03-hf-atlas). Pure, like
// cbView. The key holds everything drawn, so the text redraws only when something changes.
import { esc, hfLanguage } from "../lib/format.js";
import { segmentsLit } from "../faceplate/lcd.js";
import type { HfStatus } from "../lib/api.js";
import { bandColor, legend, type AtlasRow, type HitKey, type LegendEntry } from "./atlas.js";
import { friendlyError, METER_SEGMENTS } from "./cornerView.js";
import { ituToIso2 } from "./ituCountry.js";

// The HF+ measured about -59 to -9 dBFS on stations, night of 2026-11-03; the shared meter scale starts at -35.
const HF_METER_DB = { floor: -60, ceil: -10 } as const;
const HEARD_ROWS = 3;

/** 0 dB is the helper's placeholder when a lane is opened by hand, not a level. */
function hfMeterFill(db: number | null): number {
  return db === null || db >= 0 ? 0 : (db - HF_METER_DB.floor) / (HF_METER_DB.ceil - HF_METER_DB.floor);
}

export interface HfHeard extends AtlasRow { station: string | null; lastTs: number }

export interface HfViewInput {
  hf: HfStatus | null;
  carriers: ReadonlyArray<{ hz: number; db: number }>;
  error: string | null;
  muted: boolean;
  signalDb: number | null;
  /** Everything in tonight's log. */
  log: readonly HfHeard[];
}

export interface HfReadout {
  state: "live" | "hunting" | "error";
  meta: string; metaRight: string; headline: string; name: string; likely: string; details: string[];
}

/** A stage covers the map, so it must not draw underneath. */
export function mapShouldRun(cbOn: boolean, hfOn: boolean): boolean {
  return !cbOn && !hfOn;
}

export interface HfView {
  key: string;
  tag: string;
  readout: HfReadout;
  heardTitle: string;
  rows: string[];
  legend: LegendEntry[];
  ticks: Array<{ x: number; strong: boolean }>;
  needle: number | null;
  liveColor: string;
  /** The station to draw a ring and line for. Null without a place to draw them. */
  liveStation: HitKey | null;
  /** ISO code of the country to tint, which a station can have without coordinates. */
  tint: string | null;
  lit: number;
}

const kHz = (hz: number): string => String(hz / 1000);

export function hfView(i: HfViewInput): HfView {
  const hf = i.hf;
  const cand = hf?.candidate ?? null;
  const listen = hf?.listenHz ?? null;
  const where = hf?.band ?? "";
  let readout: HfReadout;
  if (i.error) {
    readout = { state: "error", meta: "Receiver offline", metaRight: "", headline: "", name: friendlyError(i.error), likely: "", details: [] };
  } else if (listen !== null) {
    readout = {
      state: "live", meta: `${where} · AM · Live`, metaRight: i.muted ? "Muted" : "", headline: kHz(listen),
      name: cand?.station ?? "Unidentified station", likely: cand ? "Likely" : "",
      details: cand ? [
        hfLanguage(cand.language), [cand.site, cand.country].filter(Boolean).join(", "),
        cand.powerKw !== undefined ? `${cand.powerKw} kW` : "",
        cand.distanceKm !== undefined ? `${cand.distanceKm.toLocaleString("en-US")} km` : "",
      ].filter((d): d is string => !!d) : [],
    };
  } else {
    readout = {
      state: "hunting", meta: `${where} · Hunting`,
      metaRight: i.muted ? "Muted" : "", headline: "", name: "Listening for a station", likely: "", details: [],
    };
  }

  const lo = hf?.loHz ?? null;
  const hi = hf?.hiHz ?? null;
  const pct = (hz: number): number | null => (lo === null || hi === null || hz < lo || hz > hi ? null : ((hz - lo) / (hi - lo)) * 100);
  const ticks = i.carriers.flatMap((c) => {
    const x = pct(c.hz);
    return x === null ? [] : [{ x, strong: c.db >= 30 }];
  });
  const live = readout.state === "live";
  const place = live && listen !== null && hf && cand?.lat !== undefined && cand.lon !== undefined
    ? { hz: listen, lat: cand.lat, lon: cand.lon, band: hf.band }
    : null;

  const view: Omit<HfView, "key"> = {
    tag: hf ? `HF · ${hf.band}` : "HF",
    readout,
    heardTitle: `Heard tonight ${i.log.length}`,
    rows: [...i.log].sort((a, b) => b.lastTs - a.lastTs).slice(0, HEARD_ROWS).map((h) => `${kHz(h.freqHz)} ${h.station ?? "Unidentified"}`),
    legend: legend(i.log, live ? hf?.band ?? null : null),
    ticks,
    needle: !i.error && listen !== null ? pct(listen) : null,
    liveColor: live ? bandColor(hf?.band ?? null) : bandColor(null),
    liveStation: place,
    tint: live ? ituToIso2(cand?.itu) : null,
    lit: live ? segmentsLit(hfMeterFill(i.signalDb), METER_SEGMENTS) : 0,
  };
  // The meter moves by itself: it's outside the key, so signal ticks don't rebuild the text.
  const { lit: _lit, liveStation: _s, tint: _t, ...keyed } = view;
  return { ...view, key: JSON.stringify(keyed) };
}

export function hfHtml(v: HfView): string {
  const r = v.readout;
  const seg = Array.from({ length: METER_SEGMENTS }, (_, k) => `<i${k < v.lit ? ' class="on"' : ""}></i>`).join("");
  const line = [r.likely, ...r.details].filter((d) => d !== "");
  const readout = `<div class="kc-hf__readout" data-state="${r.state}">`
    + `<div class="kc-hf__meta"><span>${esc(r.meta)}</span><span class="kc-hf__db">${esc(r.metaRight)}</span></div>`
    + (r.headline ? `<div class="kc-hf__freq">${esc(r.headline)}<small>kHz</small></div>` : "")
    + `<div class="kc-hf__name">${esc(r.name)}</div>`
    + (line.length ? `<div class="kc-hf__details">${line.map((d) => esc(d)).join(" · ")}</div>` : "")
    + `<div class="kc-hf__seg" aria-hidden="true">${seg}</div></div>`;
  const key = v.legend.map((l) => `<i class="${l.lit ? "is-lit" : ""}${l.live ? " is-live" : ""}" style="color:${l.color}">${esc(l.label)}</i>`).join("");
  const ticks = v.ticks.map((t) => `<i class="kc-hf__tick${t.strong ? " is-strong" : ""}" style="left:${t.x.toFixed(2)}%"></i>`).join("");
  const needle = v.needle === null ? "" : `<i class="kc-hf__needle" style="left:${v.needle.toFixed(2)}%"></i>`;
  return `<div class="kc-hf__tag">${esc(v.tag)}</div>${readout}<div class="kc-hf__band">`
    + `<div class="kc-hf__bandRow"><div class="kc-hf__legend" aria-hidden="true">${key}</div>`
    + `<section class="kc-hf__log"><h2>${esc(v.heardTitle)}</h2><span>${v.rows.map((l) => esc(l)).join(" · ")}</span></section></div>`
    + `<div class="kc-hf__scale" aria-hidden="true">${ticks}${needle}</div></div>`;
}
