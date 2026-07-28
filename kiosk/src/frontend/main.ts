// Campfire design tokens (the operator's own design system) — tokens only;
// the React component layer is not used (this app is framework-free).
import "@jeremyfuksa/campfire/tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";
import { renderMap } from "./map/map.js";
import { renderWall } from "./wall/wall.js";
import { renderArt } from "./art/art.js";

const root = document.getElementById("app")!;

// Web fonts, per route and off the critical path. index.html used to request
// four families on every surface: the wall and art canvases draw with
// system-ui and need none, admin and dashboard override every font token to
// Inter, and only the map uses the Campfire faces — so most pages downloaded
// ten faces they never drew. Hanken Grotesk turned out to be used nowhere.
// The `media="print"` swap keeps a slow or unreachable fonts.googleapis.com
// from holding up first paint on an appliance that boots unattended.
const FONT_QUERY: Record<string, string> = {
  admin: "family=Inter:wght@400;500;600;700",
  dashboard: "family=Inter:wght@400;500;600;700",
  map: "family=Fira+Code:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700",
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
const [, page, render] =
  RENDERERS.find(([prefix]) => location.pathname.startsWith(prefix))
  ?? ["", "dashboard", renderDashboard] as const;

document.documentElement.dataset.page = page;
loadFonts(page);
render(root);
