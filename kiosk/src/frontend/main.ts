// Campfire design tokens (the operator's own design system) — tokens only;
// the React component layer is not used (this app is framework-free).
import "@jeremyfuksa/campfire/tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";
import { renderMap } from "./map/map.js";
import { renderWall } from "./wall/wall.js";
import { renderArt } from "./art/art.js";

const root = document.getElementById("app")!;
if (location.pathname.startsWith("/admin")) {
  renderAdmin(root);
} else if (location.pathname.startsWith("/map")) {
  renderMap(root);
} else if (location.pathname.startsWith("/wall")) {
  renderWall(root);
} else if (location.pathname.startsWith("/art")) {
  renderArt(root);
} else {
  renderDashboard(root);
}
