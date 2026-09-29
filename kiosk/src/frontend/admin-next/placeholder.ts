// Interim panels for tabs not rebuilt yet (PRs 3–5 replace these). Each links
// to the working classic-admin page for the same job.
import type { Tab } from "./route.js";

const CLASSIC: Record<Exclude<Tab, "radio">, { href: string; what: string }> = {
  tune: { href: "/admin#/scan", what: "Settings" },
  library: { href: "/admin#/channels", what: "Channels and Triage" },
  system: { href: "/admin#/system", what: "System" },
};

export function renderPlaceholder(el: HTMLElement, tab: Exclude<Tab, "radio">): void {
  const c = CLASSIC[tab];
  el.innerHTML = `<div class="kc-placeholder">
    <p>This tab is being rebuilt. ${c.what} still works in the classic admin.</p>
    <a class="kc-key kc-key--primary" href="${c.href}">Open classic ${c.what}</a>
  </div>`;
}
