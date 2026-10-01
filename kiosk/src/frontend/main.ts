// Kerchunk's own design tokens (replaced Campfire 2026-09-28): a frozen
// ambient layer for dashboard/wall/map/art and the admin's --kc-* language.
import "./tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderMap } from "./map/map.js";
import { renderWall } from "./wall/wall.js";
import { renderArt } from "./art/art.js";
import { renderAdmin } from "./admin/index.js";

const root = document.getElementById("app")!;

// Web fonts, per route and off the critical path. index.html used to request
// four families on every surface: the wall and art canvases draw with
// system-ui and need none. The admin, the kiosk dashboard and the map (spec
// 2026-10-01) draw in Schibsted Grotesk.
// The `media="print"` swap keeps a slow or unreachable fonts.googleapis.com
// from holding up first paint on an appliance that boots unattended.
const FONT_QUERY: Record<string, string> = {
  dashboard: "family=Schibsted+Grotesk:wght@400;500;600;700;800",
  map: "family=Schibsted+Grotesk:wght@400;500;600;700;800",
  admin: "family=Schibsted+Grotesk:wght@400;500;600;700;800",
};

function loadFonts(page: string): void {
  const query = FONT_QUERY[page];
  if (!query) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?${query}&display=swap`;
  link.media = "print";
  link.addEventListener("load", () => { link.media = "all"; }, { once: true });
  document.head.appendChild(link);
}
// All pages' CSS is injected globally (every render module is imported above),
// so full-screen-only rules must be scoped. Mark the active route on <html> and
// let each page's CSS opt in via html[data-page="…"]. Without this, the wall/art
// `overflow: hidden` body lock leaks onto the scrollable admin page.
const RENDERERS: Array<[string, string, (root: HTMLElement) => void]> = [
  ["/admin", "admin", renderAdmin],
  ["/map", "map", renderMap],
  ["/wall", "wall", renderWall],
  ["/art", "art", renderArt],
];
const [, page, render] = RENDERERS.find(([prefix]) => location.pathname.startsWith(prefix))
  ?? ["", "dashboard", renderDashboard];

document.documentElement.dataset.page = page;
loadFonts(page);

// Wall watchdog heartbeat (src/backend/wallWatchdog.ts). Sent from inside a
// rAF so a beat proves the page is painting, not just that a timer fired; the
// backend restarts kerchunk-display when the local wall's beats stop. Keep it
// well under config.wallWatchdog.staleMs (60 s). Not from the admin: it isn't
// a wall surface and shouldn't vouch for one.
const HEARTBEAT_MS = 15_000;
if (page !== "admin") {
  const beat = () => requestAnimationFrame(() => {
    fetch("/api/kiosk/heartbeat", { method: "POST" }).catch(() => { /* backend down: nothing to tell */ });
  });
  beat();
  setInterval(beat, HEARTBEAT_MS);
}

render(root);
