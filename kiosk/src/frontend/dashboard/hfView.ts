// The wall's "Station first" stage for HF mode (spec 2026-11-02-hf-mode). Pure, like cbView. The key
// holds everything drawn, so the stage redraws only when something changes: no standing animation.
import { esc, hfLanguage } from "../lib/format.js";
import { segmentsLit } from "../faceplate/lcd.js";
import type { HfStatus } from "../lib/api.js";
import { friendlyError, METER_SEGMENTS } from "./cornerView.js";
import { ituToIso2 } from "./ituCountry.js";
import { greatCircle, robinson, type LatLon } from "./robinson.js";

const PATH_SEGMENTS = 48;
// The HF+ measured about -59 to -9 dBFS on stations, night of 2026-11-03; the shared meter scale starts at -35.
const HF_METER_DB = { floor: -60, ceil: -10 } as const;

/** 0 dB is the helper's placeholder when a lane is opened by hand, not a level. */
function hfMeterFill(db: number | null): number {
  return db === null || db >= 0 ? 0 : (db - HF_METER_DB.floor) / (HF_METER_DB.ceil - HF_METER_DB.floor);
}

export interface HfHeard { freqHz: number; station: string | null; lastTs: number; onSpeaker: boolean }

export interface HfViewInput {
  hf: HfStatus | null;
  carriers: ReadonlyArray<{ hz: number; db: number }>;
  error: string | null;
  muted: boolean;
  signalDb: number | null;
  heardCount: number;
  heard: readonly HfHeard[];
  home: LatLon;
  fmtTime: (ts: number) => string;
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
  mapKey: string;
  readout: HfReadout;
  heardTitle: string;
  rows: Array<{ label: string; when: string }>;
  ticks: Array<{ x: number; strong: boolean }>;
  needle: number | null;
  scale: { lo: string; hi: string };
  map: { tint: string | null; dot: { x: number; y: number } | null; home: { x: number; y: number }; path: string };
  lit: number;
}

const kHz = (hz: number): string => String(hz / 1000);

export function hfView(i: HfViewInput): HfView {
  const hf = i.hf;
  const cand = hf?.candidate ?? null;
  const listen = hf?.listenHz ?? null;
  const where = hf?.stage === "sweep" ? hf.band : "CB";
  let readout: HfReadout;
  if (i.error) {
    readout = { state: "error", meta: "Receiver offline", metaRight: "", headline: "", name: friendlyError(i.error), likely: "", details: [] };
  } else if (listen !== null) {
    readout = {
      state: "live", meta: `${where} · AM · Live`, metaRight: i.muted ? "Muted" : "", headline: kHz(listen),
      name: cand?.station ?? "Unidentified station", likely: cand ? "Likely · from schedule" : "",
      details: cand ? [
        hfLanguage(cand.language), [cand.site, cand.country].filter(Boolean).join(", "),
        cand.powerKw !== undefined ? `${cand.powerKw} kW` : "",
        cand.distanceKm !== undefined ? `${cand.distanceKm.toLocaleString("en-US")} km` : "",
      ].filter((d): d is string => !!d) : [],
    };
  } else {
    readout = {
      state: "hunting", meta: hf?.stage === "cbStop" ? "CB · Checking the band" : `${where} · Hunting`,
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
  const place = !i.error && listen !== null && cand?.lat !== undefined && cand.lon !== undefined ? { lat: cand.lat, lon: cand.lon } : null;
  const homeXy = robinson(i.home.lat, i.home.lon);
  const dot = place ? robinson(place.lat, place.lon) : null;
  const path = place
    ? polyline(greatCircle(i.home, place, PATH_SEGMENTS))
    : "";

  const view: Omit<HfView, "key" | "mapKey"> = {
    readout,
    heardTitle: `Heard tonight · ${i.heardCount}`,
    rows: i.heard.map((h) => ({ label: `${kHz(h.freqHz)} ${h.station ?? "Unidentified"}`, when: i.fmtTime(h.lastTs) })),
    ticks,
    needle: !i.error && listen !== null ? pct(listen) : null,
    scale: { lo: lo === null ? "" : kHz(lo), hi: hi === null ? "" : kHz(hi) },
    map: { tint: !i.error && listen !== null ? ituToIso2(cand?.itu) : null, dot, home: homeXy, path },
    lit: readout.state === "live" ? segmentsLit(hfMeterFill(i.signalDb), METER_SEGMENTS) : 0,
  };
  // The meter moves by itself: it's outside the key, so signal ticks don't rebuild the stage.
  const { lit: _lit, ...keyed } = view;
  return {
    ...view,
    key: JSON.stringify([keyed.readout, keyed.rows.map((r) => r.label), keyed.heardTitle, keyed.ticks, keyed.needle]),
    mapKey: JSON.stringify([keyed.map.tint, keyed.map.path, keyed.map.dot]),
  };
}

/** A long path can cross the map's edge at the antimeridian: break the line there, don't streak across. */
function polyline(points: readonly LatLon[]): string {
  let d = "";
  let prev: LatLon | null = null;
  for (const p of points) {
    const { x, y } = robinson(p.lat, p.lon);
    const jump = prev !== null && Math.abs(p.lon - prev.lon) > 180;
    d += `${prev === null || jump ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    prev = p;
  }
  return d;
}

export function hfHtml(v: HfView): string {
  const r = v.readout;
  const seg = Array.from({ length: METER_SEGMENTS }, (_, k) => `<i${k < v.lit ? ' class="on"' : ""}></i>`).join("");
  const readout = `<div class="kc-hf__readout" data-state="${r.state}">`
    + `<div class="kc-hf__meta"><span>${esc(r.meta)}</span><span class="kc-hf__db">${esc(r.metaRight)}</span></div>`
    + (r.headline ? `<div class="kc-hf__freq">${esc(r.headline)}<small>kHz</small></div>` : "")
    + `<div class="kc-hf__name">${esc(r.name)}</div>`
    + (r.likely ? `<div class="kc-hf__likely">${esc(r.likely)}</div>` : "")
    + (r.details.length ? `<div class="kc-hf__details">${r.details.map((d) => `<span>${esc(d)}</span>`).join("")}</div>` : "")
    + `<div class="kc-hf__seg" aria-hidden="true">${seg}</div></div>`;
  const rows = v.rows.map((l) => `<div class="kc-hf__row"><span>${esc(l.label)}</span><i>${esc(l.when)}</i></div>`).join("");
  const ticks = v.ticks.map((t) => `<i class="kc-hf__tick${t.strong ? " is-strong" : ""}" style="left:${t.x.toFixed(2)}%"></i>`).join("");
  const needle = v.needle === null ? "" : `<i class="kc-hf__needle" style="left:${v.needle.toFixed(2)}%"></i>`;
  return `<div class="kc-hf__tag">HF mode · Shortwave</div>${readout}`
    + `<section class="kc-hf__log"><h2>${esc(v.heardTitle)}</h2>${rows}</section>`
    + `<div class="kc-hf__dial" aria-hidden="true"><div class="kc-hf__scale">${ticks}${needle}</div>`
    + `<div class="kc-hf__ends"><span>${esc(v.scale.lo)}</span><span>${esc(v.scale.hi)}</span></div></div>`;
}
