// Campfire design tokens (the operator's own design system) — tokens only;
// the React component layer is not used (this app is framework-free).
import "@jeremyfuksa/campfire/tokens.css";
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";

const root = document.getElementById("app")!;
if (location.pathname.startsWith("/admin")) {
  renderAdmin(root);
} else {
  renderDashboard(root);
}
