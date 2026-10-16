// CB wall (spec 2026-10-14 "the dial"): CbState → what the stage shows, and
// the stage's markup. Pure: dashboard.ts rebuilds the DOM only when `key`
// changes and patches the meter + dB in place during a transmission.
import { CB_ALL, CB_CORE, CB_FREQ_HZ, cbLabel, cbNumberForFreq } from "../../backend/config/cb.js";
import { fmtFreq, esc } from "../lib/format.js";
import { dbText, segmentsLit } from "../faceplate/lcd.js";
import { friendlyError, meterFill, METER_SEGMENTS } from "./cornerView.js";
import { dialX, tickStep, type CbState, type FadeStep } from "./cbDial.js";

/** display.cb defaults (schema.ts) — test/cbView.test.ts pins them equal. */
export const CB_VIEW_DEFAULTS = { fadeStepsMin: [2, 10, 20, 30], stepTickMs: 60_000, logRows: 5 };

export interface CbViewInput {
  cb: CbState;
  now: number;
  /** The dashboard's nowPlaying frequency (the audible channel), if any. */
  liveFreq: number | null;
  error: string | null;
  /** FernSDR receiver session down (status.cb.error); engine errors win. */
  offline?: string | null;
  /** The live channel's mode ("am" | "lsb"); AM when absent. */
  liveMode?: string | null;
  muted: boolean;
  /** Channel numbers the scanner is listening to (config.cb.channels). */
  monitored: readonly number[];
  names: Readonly<Record<string, string>>;
  fadeStepsMin: readonly number[];
  logRows: number;
  fmtTime?: (ts: number) => string;
}
export interface CbReadout {
  state: "live" | "idle" | "never" | "error";
  meta: string;
  /** Right-hand meta: "Last heard 5:39 PM", "Muted", or "" (live shows dB). */
  metaRight: string;
  num: string;
  name: string;
  freq: string;
}
export interface CbTick { n: number; x: number; core: boolean; monitored: boolean; step: FadeStep; label: boolean }
export interface CbLogRow { label: string; when: string; live: boolean }
export interface CbView { key: string; readout: CbReadout; ticks: CbTick[]; needleX: number | null; log: CbLogRow[] }

const clock = (ts: number): string => new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** "0:41", "2:05". */
export function fmtDur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const freqOf = (n: number): number => CB_FREQ_HZ[n] ?? 0;

export function cbView(i: CbViewInput): CbView {
  const t = i.fmtTime ?? clock;
  const core = CB_CORE as readonly number[];
  const name = (n: number): string => i.names[String(n)] ?? "";
  const liveN = i.liveFreq === null ? null : cbNumberForFreq(i.liveFreq);
  const listening = `CB only · Listening on ${i.monitored.length} channels`;
  const last = i.cb.log[0];

  let readout: CbReadout;
  if (i.error) {
    readout = { state: "error", meta: "Radio error", metaRight: "", num: "", name: friendlyError(i.error), freq: "" };
  } else if (i.offline) {
    readout = { state: "error", meta: "Receiver offline", metaRight: "", num: "", name: "Retrying the CB receiver", freq: "" };
  } else if (liveN !== null) {
    readout = { state: "live", meta: `CB · ${(i.liveMode ?? "am").toUpperCase()} · Live`, metaRight: i.muted ? "Muted" : "", num: String(liveN), name: name(liveN), freq: fmtFreq(freqOf(liveN)) };
  } else if (last) {
    readout = { state: "idle", meta: listening, metaRight: `Last heard ${t(i.cb.lastHeard[last.n] ?? last.ts)}`, num: String(last.n), name: name(last.n), freq: fmtFreq(freqOf(last.n)) };
  } else {
    readout = { state: "never", meta: listening, metaRight: "", num: "", name: "", freq: "" };
  }

  const ticks: CbTick[] = CB_ALL.map((n) => {
    const step: FadeStep = liveN === n ? 4 : tickStep(i.cb.lastHeard[n], i.now, i.fadeStepsMin);
    const isCore = core.includes(n);
    return { n, x: dialX(freqOf(n)), core: isCore, monitored: i.monitored.includes(n), step, label: isCore || n === 1 || n % 5 === 0 || step >= 3 };
  });

  const openKeys = new Set(Object.values(i.cb.open).map((o) => `${o.n}:${o.ts}`));
  const log: CbLogRow[] = i.cb.log.slice(0, i.logRows).map((r) => {
    const live = openKeys.has(`${r.n}:${r.ts}`);
    const when = live ? "now" : r.durationMs === null ? t(r.ts) : `${t(r.ts)} · ${fmtDur(r.durationMs)}`;
    return { label: cbLabel(r.n, i.names), when, live };
  });

  const needleX = liveN === null ? null : dialX(freqOf(liveN));
  const key = JSON.stringify([readout, ticks.map((k) => `${k.n}.${k.step}.${+k.monitored}.${+k.label}`), needleX, log]);
  return { key, readout, ticks, needleX, log };
}

const pct = (x: number): string => `${(x * 100).toFixed(2)}%`;

export function cbHtml(v: CbView, signalDb: number | null): string {
  const r = v.readout;
  const lit = r.state === "live" ? segmentsLit(meterFill(signalDb), METER_SEGMENTS) : 0;
  const seg = Array.from({ length: METER_SEGMENTS }, (_, k) => `<i${k < lit ? ' class="on"' : ""}></i>`).join("");
  const right = r.state === "live" && !r.metaRight
    ? `<span class="kc-cb__db">${esc(dbText(signalDb))}</span>`
    : `<span>${esc(r.metaRight)}</span>`;
  const readout = `<div class="kc-cb__readout" data-state="${r.state}">`
    + `<div class="kc-cb__meta"><span>${esc(r.meta)}</span>${right}</div>`
    + (r.num ? `<div class="kc-cb__num">${esc(r.num)}</div>` : "")
    + `<div class="kc-cb__sub"><b>${esc(r.name)}</b><span>${r.freq ? `${esc(r.freq)} MHz` : ""}</span></div>`
    + `<div class="kc-cb__seg" aria-hidden="true">${seg}</div></div>`;
  const ticks = v.ticks.map((k) =>
    `<i class="kc-cb__tick${k.core ? " is-core" : ""}${k.monitored ? "" : " is-off"}" data-step="${k.step}" style="left:${pct(k.x)}"></i>`
    + (k.label ? `<b class="kc-cb__lab${k.core ? " is-core" : ""}${k.step >= 3 ? " is-hot" : ""}" style="left:${pct(k.x)}">${k.n}</b>` : ""),
  ).join("");
  const needle = v.needleX === null ? "" : `<i class="kc-cb__needle" style="left:${pct(v.needleX)}"></i>`;
  const rows = v.log.map((l) => `<div class="kc-cb__row${l.live ? " is-live" : ""}"><span>${esc(l.label)}</span><i>${esc(l.when)}</i></div>`).join("");
  return `<div class="kc-cb__tag">CB mode</div>${readout}`
    + `<section class="kc-cb__log"><h2>Heard on CB</h2>${rows}</section>`
    + `<div class="kc-cb__dial" aria-hidden="true"><div class="kc-cb__scale">${ticks}${needle}</div></div>`;
}
