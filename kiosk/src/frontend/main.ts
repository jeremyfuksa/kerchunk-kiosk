import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";

const root = document.getElementById("app")!;
if (location.pathname.startsWith("/admin")) {
  renderAdmin(root);
} else {
  renderDashboard(root);
}
