// System › Connections (spec §6) — stub until Task 4 replaces it with the
// Maps key / Map ID and lockout rows.
import { emptyState } from "./ui/kit.js";
import type { Ctx } from "./ctx.js";

export function mountConnections(_ctx: Ctx, host: HTMLElement): void {
  host.innerHTML = emptyState("Loading connections…");
}
