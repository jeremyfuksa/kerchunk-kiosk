// The Day's Map (ROADMAP Idea 3): a calm, accumulating artistic kiosk. Today's
// history seeds the sediment; live WS hits add deposits and a soft breath. All
// marks composite with "screen" so density reads as luminance. Daily reset at
// local midnight. See docs/superpowers/specs/2026-06-09-artistic-kiosk-design.md.
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import { colorFor } from "../lib/serviceColor.js";
import { SedimentField, startOfLocalDay, type Deposit } from "./sediment.js";
import { makeProjection, type Home } from "./project.js";
import { createIdleLoop } from "../lib/idleLoop.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import type { HistoryRow } from "../../backend/history.js";
import "./art.css";

const BREATH_MS = 6000;       // live bloom lifetime
const SPAN_M = 40_000;        // metro radius mapped to the nearer canvas edge
const MAX_STRATUM_R = 90;     // DEVICE-px radius of the busiest stratum's glow (canvas is DPR-scaled; no ctx.scale). Tune on the real panel.

export function renderArt(root: HTMLElement): void {
  root.innerHTML = `<canvas id="art-canvas"></canvas>`;
  const canvas = root.querySelector<HTMLCanvasElement>("#art-canvas")!;
  void boot(canvas);
}

async function boot(canvas: HTMLCanvasElement): Promise<void> {
  const cfg = await api.getConfig();
  const home: Home = {
    lat: cfg.display?.mapLat ?? 39.0997,
    lon: cfg.display?.mapLon ?? -94.5786,
  };

  const field = new SedimentField({ breathMs: BREATH_MS });
  let dayStart = startOfLocalDay(Date.now());

  // Seed today's portrait from history (also recovers it across a reload).
  try {
    const rows: HistoryRow[] = await fetch(
      `/api/history?since=${dayStart}&kind=active&limit=5000`,
    ).then((r) => (r.ok ? r.json() : []));
    for (const row of rows) {
      if (row.lat == null || row.lon == null) continue;
      field.deposit({ lat: row.lat, lon: row.lon, color: colorFor(row.freq, "active"), ts: row.ts });
    }
  } catch { /* offline / no history store — start from an empty canvas */ }

  // Live breath: each opening with a location adds a deposit.
  const proto = location.protocol === "https:" ? "wss" : "ws";
  // Live wiring starts after the seed/config awaits — a hit or two arriving in that startup window isn't buffered; the next reload's history seed recovers it.
  const ws = new ReconnectingWs(`${proto}://${location.host}/ws`, (ev: EngineEvent) => onEvent(ev), {});
  ws.connect();

  function onEvent(ev: EngineEvent): void {
    if (ev.type === "active" && ev.channel.location?.lat != null && ev.channel.location.lon != null) {
      field.deposit({
        lat: ev.channel.location.lat,
        lon: ev.channel.location.lon,
        color: colorFor(ev.freq, "active"),
        ts: ev.ts,
      });
      loop.wake();
    }
    // closecall carries no location; the server files it as a channel whose later
    // "active" carries location — so nothing to plot here.
  }

  function resize(): void {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  }
  resize();
  // Repaint after a resize: with the idle loop, a resize while suspended would
  // otherwise leave the canvas stale at the new size until the next hit.
  window.addEventListener("resize", () => { resize(); loop.wake(); });

  const ctx = canvas.getContext("2d")!;

  function paint(): boolean {
    const now = Date.now();
    const today = startOfLocalDay(now);
    if (today !== dayStart) { field.clear(); dayStart = today; }

    const w = canvas.width, h = canvas.height;
    const project = makeProjection(home, SPAN_M, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = "screen";

    const deps = field.deposits(now);
    for (const dep of deps) {
      drawDeposit(ctx, project(dep.lat, dep.lon), dep);
    }
    ctx.globalCompositeOperation = "source-over";
    // Keep animating only while a deposit is still blooming.
    return deps.some((d) => d.breath > 0);
  }

  const loop = createIdleLoop({ tick: paint });
  // Initial paint of the seeded portrait.
  loop.wake();

  // Daily reset even while idle: wake once at the next local midnight so the
  // portrait clears on time without a continuous poll. Re-arms each midnight.
  function scheduleMidnight(): void {
    const next = startOfLocalDay(Date.now()) + 24 * 60 * 60 * 1000;
    setTimeout(() => { loop.wake(); scheduleMidnight(); }, Math.max(1000, next - Date.now()));
  }
  scheduleMidnight();

  function drawDeposit(c: CanvasRenderingContext2D, p: { x: number; y: number }, dep: Deposit): void {
    const maxHits = dep.strata[0]?.hits ?? 1;
    for (const s of dep.strata) {
      const r = MAX_STRATUM_R * (Math.log1p(s.hits) / Math.log1p(maxHits || 1));
      paintGlow(c, p.x, p.y, Math.max(8, r), s.color, 0.42);
    }
    if (dep.breath > 0) {
      const top = dep.strata[0]?.color ?? "#ffffff";
      paintGlow(c, p.x, p.y, MAX_STRATUM_R * 0.7, top, 0.5 * dep.breath);
    }
  }

  function paintGlow(c: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, alpha: number): void {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, hexA(color, alpha));
    g.addColorStop(0.5, hexA(color, alpha * 0.4));
    g.addColorStop(1, hexA(color, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, Math.PI * 2);
    c.fill();
  }

  function hexA(hex: string, a: number): string {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return `rgba(${r},${g},${b},${a})`;
  }
}
