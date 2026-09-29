// admin-next chrome: wordmark, four tabs (top bar ≥900px, bottom bar below),
// health verdict, and the mini-player that follows you off the Radio tab.
import { esc } from "../lib/format.js";
import { api } from "../lib/api.js";
import { ico } from "./ui/icons.js";
import { hrefFor, parseRoute, TAB_TITLES, type Route, type Tab } from "./route.js";
import { lcdView } from "./live.js";
import type { LiveStore } from "./liveStore.js";
import type { Verdict } from "./verdict.js";

export interface Shell {
  panel(tab: Tab): HTMLElement;
  route(): Route;
  onRoute(fn: (r: Route) => void): void;
  setVerdict(v: Verdict, text: string): void;
  setTriageCount(n: number): void;
}

const TABS: Tab[] = ["radio", "tune", "library", "system"];

export function mountShell(root: HTMLElement, live: LiveStore): Shell {
  const tabLink = (t: Tab): string =>
    `<a class="kc-tab" data-tab="${t}" href="${hrefFor({ tab: t })}">${ico(t)}<span>${TAB_TITLES[t]}</span>${
      t === "library" ? `<b class="kc-badge kc-triage" hidden></b>` : ""}</a>`;
  root.innerHTML = `
    <div class="kc-app">
      <button type="button" class="kc-skipLink">Skip to content</button>
      <header class="kc-top">
        <a class="kc-brand" href="${hrefFor({ tab: "radio" })}">Kerchunk</a>
        <nav class="kc-tabs kc-tabs--top" aria-label="Sections">${TABS.map(tabLink).join("")}</nav>
        <div class="kc-mini" id="kcMini" hidden></div>
        <a class="kc-verdict" id="kcVerdict" href="${hrefFor({ tab: "system" })}"><i></i><span>Checking…</span></a>
        <span class="kc-top__links">
          <a href="/" target="_blank" rel="noopener">Kiosk ${ico("external")}</a>
          <a href="/map" target="_blank" rel="noopener">Map ${ico("external")}</a>
        </span>
      </header>
      <main class="kc-main" id="kcMain" tabindex="-1">
        ${TABS.map((t) => `<section class="kc-panel" data-panel="${t}" aria-label="${TAB_TITLES[t]}" hidden></section>`).join("")}
      </main>
      <nav class="kc-tabs kc-tabs--bottom" aria-label="Sections">${TABS.map(tabLink).join("")}</nav>
    </div>`;

  const routeSubs: Array<(r: Route) => void> = [];
  const mini = root.querySelector<HTMLElement>("#kcMini")!;
  let current = parseRoute(location.hash);

  function applyRoute(): void {
    current = parseRoute(location.hash);
    document.title = `${TAB_TITLES[current.tab]} · Kerchunk`;
    root.querySelectorAll<HTMLElement>(".kc-panel").forEach((p) => { p.hidden = p.dataset.panel !== current.tab; });
    root.querySelectorAll<HTMLAnchorElement>(".kc-tab").forEach((a) => {
      if (a.dataset.tab === current.tab) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
    });
    paintMini();
    for (const fn of routeSubs) fn(current);
  }

  function paintMini(): void {
    // Radio IS the player — no mini-player there.
    mini.hidden = current.tab === "radio";
    if (mini.hidden) return;
    const v = lcdView(live.state);
    mini.innerHTML = `<a class="kc-mini__open" href="${hrefFor({ tab: "radio" })}" aria-label="Open radio">
        <span class="kc-mini__name">${esc(v.name)}</span>${v.freq ? `<span class="kc-mini__freq">${esc(v.freq)}</span>` : ""}</a>
      <button type="button" class="kc-mini__key" data-act="skip" aria-label="Skip transmission">${ico("skip")}</button>
      <button type="button" class="kc-mini__key" data-act="listen" aria-label="${live.streaming ? "Stop listening" : "Listen here"}"${
        live.state.remoteListening || live.streaming ? "" : " disabled"}>${ico(live.streaming ? "stop" : "play")}</button>`;
    mini.querySelector('[data-act="skip"]')!.addEventListener("click", () => { void api.skip(); });
    mini.querySelector('[data-act="listen"]')!.addEventListener("click", () => live.toggleStream());
  }
  live.subscribe(paintMini);

  // A fragment href would change location.hash in a hash-routed app — move
  // focus directly instead (same fix as the classic admin).
  root.querySelector<HTMLButtonElement>(".kc-skipLink")!.addEventListener("click", () =>
    root.querySelector<HTMLElement>("#kcMain")!.focus());

  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  return {
    panel: (t) => root.querySelector<HTMLElement>(`.kc-panel[data-panel="${t}"]`)!,
    route: () => current,
    onRoute: (fn) => { routeSubs.push(fn); },
    setVerdict(v, text) {
      const el = root.querySelector<HTMLElement>("#kcVerdict")!;
      el.dataset.verdict = v;
      el.querySelector("span")!.textContent = text;
    },
    setTriageCount(n) {
      root.querySelectorAll<HTMLElement>(".kc-triage").forEach((b) => {
        b.hidden = n === 0; b.textContent = String(n);
        b.setAttribute("aria-label", `${n} to review`);
      });
    },
  };
}
