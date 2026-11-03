// The Log tab: what HF mode heard, night by night.
import { api } from "../lib/api.js";
import type { Ctx } from "./ctx.js";
import { esc } from "../lib/format.js";
import { emptyState } from "./ui/kit.js";
import { logRows, sortRows, type HfLogRow, type HfLogSort } from "./hfLogModel.js";
import "./hfLog.css";

const REFRESH_MS = 60_000;
const COLUMNS: Array<{ label: string; sort?: HfLogSort; num?: boolean }> = [
  { label: "kHz", sort: "freqHz", num: true }, { label: "Band" }, { label: "Likely station", sort: "station" }, { label: "Language" },
  { label: "Transmitter" }, { label: "Power", num: true }, { label: "Distance", num: true }, { label: "Peak dB", sort: "peakDb", num: true },
  { label: "Passes", sort: "passes", num: true }, { label: "First" }, { label: "Last", sort: "lastTs" }, { label: "Speaker" },
];

const clock = (ts: number): string => new Date(ts).toISOString().slice(11, 16);

export function mountHfLog(ctx: Ctx): void {
  const el = ctx.shell.panel("log");
  el.innerHTML = `<div class="kc-log">
    <header class="kc-log__head"><h1>Log</h1>
      <label class="kc-log__night">Night <select id="kcLogNight"></select></label>
    </header>
    <p class="kc-log__note" id="kcLogNote"></p>
    <div class="kc-log__scroll" id="kcLogBody">${emptyState("Loading the log…")}</div>
  </div>`;
  const select = el.querySelector<HTMLSelectElement>("#kcLogNight")!;
  const note = el.querySelector<HTMLElement>("#kcLogNote")!;
  const body = el.querySelector<HTMLElement>("#kcLogBody")!;
  let rows: HfLogRow[] = [];
  let sort: HfLogSort = "lastTs";
  let night: string | null = null;

  function paint(): void {
    if (rows.length === 0) { body.innerHTML = emptyState("Nothing logged yet. HF mode logs every station it hears."); note.textContent = ""; return; }
    const heard = rows.filter((r) => r.onSpeaker).length;
    note.textContent = `${rows.length} station${rows.length === 1 ? "" : "s"}, ${heard} on the speaker. Names are likely, from schedules. Times are UTC.`;
    body.innerHTML = `<table class="kc-log__table"><thead><tr>${COLUMNS.map((c) =>
      `<th class="${c.num ? "is-num" : ""}">${c.sort ? `<button type="button" data-sort="${c.sort}" aria-pressed="${sort === c.sort}">${c.label}</button>` : c.label}</th>`).join("")}</tr></thead>
      <tbody>${logRows(sortRows(rows, sort)).map((r) => `<tr>
        <td class="is-num">${esc(r.freq)}</td><td>${esc(r.band)}</td>
        <td class="kc-log__wrap ${r.likely ? "" : "is-dim"}">${esc(r.station)}${r.others ? `<small>or ${esc(r.others)}</small>` : ""}</td>
        <td>${esc(r.language)}</td><td class="kc-log__wrap">${esc(r.where)}</td><td class="is-num">${esc(r.power)}</td><td class="is-num">${esc(r.distance)}</td>
        <td class="is-num">${esc(r.peak)}</td><td class="is-num">${r.passes}</td><td>${clock(r.first)}</td><td>${clock(r.last)}</td><td>${r.onSpeaker ? "Yes" : ""}</td>
      </tr>`).join("")}</tbody></table>`;
  }

  async function load(): Promise<void> {
    const log = await api.getHfLog(night);
    night = log.night;
    rows = log.rows as HfLogRow[];
    select.innerHTML = log.nights.map((n) => `<option value="${esc(n.night)}"${n.night === night ? " selected" : ""}>${esc(n.night)} (${n.count})</option>`).join("");
    select.disabled = log.nights.length === 0;
    paint();
  }

  ctx.poller.add({ name: "hfLog", everyMs: REFRESH_MS, tabs: ["log"], run: load });
  select.addEventListener("change", () => { night = select.value; void ctx.poller.run(load); });
  body.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-sort]");
    if (b) { sort = b.dataset.sort as HfLogSort; paint(); }
  });
}
