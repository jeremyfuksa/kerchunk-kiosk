// Kerchunk's own design tokens (replaced Campfire 2026-09-28): a frozen
// ambient layer for dashboard/wall/map/art and the admin's --kc-* language.
import "./tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderMap } from "./map/map.js";
import { renderWall } from "./wall/wall.js";
import { renderArt } from "./art/art.js";
import { renderAdminNext } from "./admin-next/index.js";

const root = document.getElementById("app")!;

// Web fonts, per route and off the critical path. index.html used to request
// four families on every surface: the wall and art canvases draw with
// system-ui and need none. Every surface that draws text now draws it in
// Inter — the map was the last holdout on Fira Code + Space Grotesk, which
// DESIGN.md recorded as drift rather than an exception, so it no longer pulls
// ten faces to render a legend and a row of callsign chips.
// The `media="print"` swap keeps a slow or unreachable fonts.googleapis.com
// from holding up first paint on an appliance that boots unattended.
const FONT_QUERY: Record<string, string> = {
  dashboard: "family=Inter:wght@400;500;600;700",
  map: "family=Inter:wght@400;500;600;700",
  "admin-next": "family=Schibsted+Grotesk:wght@400;500;600;700;800",
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
  ["/admin", "admin-next", renderAdminNext],
  ["/map", "map", renderMap],
  ["/wall", "wall", renderWall],
  ["/art", "art", renderArt],
];
const [, page, render] = RENDERERS.find(([prefix]) => location.pathname.startsWith(prefix))
  ?? ["", "dashboard", renderDashboard];

document.documentElement.dataset.page = page;
loadFonts(page);

render(root);
