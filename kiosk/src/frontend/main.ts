// Campfire design tokens (the operator's own design system) — tokens only;
// the React component layer is not used (this app is framework-free).
import "@jeremyfuksa/campfire/tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";
import { renderMap } from "./map/map.js";
import { renderWall } from "./wall/wall.js";
import { renderArt } from "./art/art.js";

const root = document.getElementById("app")!;
// All pages' CSS is injected globally (every render module is imported above),
// so full-screen-only rules must be scoped. Mark the active route on <html> and
// let each page's CSS opt in via html[data-page="…"]. Without this, the wall/art
// `overflow: hidden` body lock leaks onto the scrollable admin page.
if (location.pathname.startsWith("/admin")) {
  document.documentElement.dataset.page = "admin";
  renderAdmin(root);
} else if (location.pathname.startsWith("/map")) {
  document.documentElement.dataset.page = "map";
  renderMap(root);
} else if (location.pathname.startsWith("/wall")) {
  document.documentElement.dataset.page = "wall";
  renderWall(root);
} else if (location.pathname.startsWith("/art")) {
  document.documentElement.dataset.page = "art";
  renderArt(root);
} else {
  document.documentElement.dataset.page = "dashboard";
  renderDashboard(root);
}
