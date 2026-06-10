// kiosk/src/frontend/wall/wall.ts
// The Kerchunk Wall (ROADMAP Idea 3, 2nd art skin): one frequency-ordered
// column per configured channel; every key-up stacks a service-colored mark.
// Relative scale (busiest column fills the panel); a fresh hit blooms ~6s then
// settles; the busiest columns are labeled; one day = one wall, rebuilt from
// history at local midnight. Idle-suspends via lib/idleLoop. See
// docs/superpowers/specs/2026-06-09-kerchunk-wall-design.md.
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { colorFor } from "../lib/serviceColor.js";
import { startOfLocalDay } from "../lib/localDay.js";
import { createIdleLoop } from "../lib/idleLoop.js";
import { WallField } from "./wallField.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { HistoryRow } from "../../backend/history.js";
import "./wall.css";

const BREATH_MS = 6000;     // fresh-hit bloom lifetime, matches The Day's Map
const MIN_PITCH = 7;        // DEVICE-px between stacked marks (floor). Tune on the panel.
const PAD_X = 28;           // side padding (device px)
const PAD_BOTTOM = 34;      // room for the frequency axis
const PAD_TOP = 26;         // room for floating labels
const MARK_W = 6;           // mark diameter (device px)
const LABEL_COUNT = 3;      // how many busiest columns get a name

interface Col { freq: number; tag: string; color: string; }

export function renderWall(root: HTMLElement): void {
  root.innerHTML = `<canvas id="wall-canvas"></canvas>`;
  const canvas = root.querySelector<HTMLCanvasElement>("#wall-canvas")!;
  void boot(canvas);
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const cfg = await api.getConfig();
  // Columns = enabled channels, ascending by frequency. Stable layout.
  const cols: Col[] = cfg.channels
    .filter((c) => c.enabled)
    .slice()
    .sort((a, b) => a.freq - b.freq)
    .map((c) => ({ freq: c.freq, tag: c.alphaTag || `${(c.freq / 1e6).toFixed(4)}`, color: colorFor(c.freq, "active") }));
  const known = new Set(cols.map((c) => c.freq));

  const field = new WallField({ breathMs: BREATH_MS });
  let dayStart = startOfLocalDay(Date.now());

  // Seed today's wall from history (recovers it across a reload/reboot).
  try {
    const rows: HistoryRow[] = await fetch(
      `/api/history?since=${dayStart}&kind=active&limit=5000`,
    ).then((r) => (r.ok ? r.json() : []));
    for (const row of rows) {
      if (known.has(row.freq)) field.deposit({ freq: row.freq, ts: row.ts });
    }
  } catch { /* offline / no history — start empty */ }

  const ctx = canvas.getContext("2d")!;
  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function paint(): void {
    const now = Date.now();
    const today = startOfLocalDay(now);
    if (today !== dayStart) { field.clear(); dayStart = today; }

    const w = canvas.width, h = canvas.height;
    const plotH = h - PAD_TOP - PAD_BOTTOM;
    const baseY = h - PAD_BOTTOM;
    const max = field.maxCount();
    const slot = (w - PAD_X * 2) / Math.max(1, cols.length);

    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";

    // Rank for labels: indices of the LABEL_COUNT busiest columns.
    const ranked = cols
      .map((c, i) => ({ i, n: field.countFor(c.freq) }))
      .filter((x) => x.n > 0)
      .sort((a, b) => b.n - a.n)
      .slice(0, LABEL_COUNT);
    const labelled = new Set(ranked.map((x) => x.i));

    const dpr = window.devicePixelRatio || 1;
    cols.forEach((c, i) => {
      const x = PAD_X + slot * (i + 0.5);
      const n = field.countFor(c.freq);
      // Faint baseline tick — a silent channel still reads as "ready".
      paintDot(ctx, x, baseY, MARK_W * 0.5, c.color, 0.18);
      if (n === 0) return;
      // Relative scale: the busiest column fills the plot; pitch floored at
      // MIN_PITCH so marks merge into a solid glowing bar when a channel maxes.
      const colH = (n / max) * plotH;
      const pitch = Math.max(MIN_PITCH, colH / n);
      const marks = Math.min(n, Math.max(1, Math.floor(colH / pitch)));
      for (let k = 0; k < marks; k++) {
        paintDot(ctx, x, baseY - k * pitch, MARK_W * 0.5, c.color, 0.55);
      }
      const topY = baseY - (marks - 1) * pitch;
      const bloom = field.bloomFor(c.freq, now);
      if (bloom > 0) paintDot(ctx, x, topY, MARK_W * (0.6 + bloom), c.color, 0.85 * bloom);
      if (labelled.has(i)) {
        ctx.globalCompositeOperation = "source-over";
        ctx.fillStyle = "rgba(232,237,244,0.92)";
        ctx.font = `${Math.round(11 * dpr)}px system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(`${c.tag} ${n}`, x, Math.max(PAD_TOP * 0.7, topY - 8));
        ctx.globalCompositeOperation = "screen";
      }
    });

    // Faint frequency axis (guarded — an empty channel set has no endpoints).
    if (cols.length > 0) {
      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(107,115,130,0.7)";
      ctx.font = `${Math.round(9 * dpr)}px system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.fillText(`${(cols[0]!.freq / 1e6).toFixed(1)} MHz`, PAD_X, h - 12);
      ctx.textAlign = "right";
      ctx.fillText(`${(cols[cols.length - 1]!.freq / 1e6).toFixed(1)} MHz`, w - PAD_X, h - 12);
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function paintDot(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
    c.globalAlpha = alpha;
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, Math.max(1, r), 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;
  }

  const loop = createIdleLoop({ tick: () => { paint(); return !reduceMotion && field.anyBloom(Date.now()); } });
  window.addEventListener("resize", () => { resize(); if (reduceMotion) paint(); else loop.wake(); });

  function onEvent(ev: EngineEvent): void {
    if (ev.type === "active" && known.has(ev.freq)) {
      field.deposit({ freq: ev.freq, ts: ev.ts });
      if (reduceMotion) paint(); else loop.wake();
    }
  }
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new ReconnectingWs(`${proto}://${location.host}/ws`, onEvent, {});
  ws.connect();

  // Initial paint + (when not reduced-motion) kick the loop so the backfilled
  // wall shows immediately and any startup blooms animate.
  if (reduceMotion) paint(); else loop.wake();

  // Daily reset even while idle: wake once at the next local midnight so the
  // wall clears on time without a continuous poll. Re-arms each midnight.
  function scheduleMidnight(): void {
    const next = startOfLocalDay(Date.now()) + 24 * 60 * 60 * 1000;
    setTimeout(() => { if (reduceMotion) paint(); else loop.wake(); scheduleMidnight(); },
      Math.max(1000, next - Date.now()));
  }
  scheduleMidnight();
}
