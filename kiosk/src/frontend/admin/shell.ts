// the admin chrome: wordmark, four tabs (top bar ≥900px, bottom bar below),
// health verdict, and the mini-player that follows you off the Radio tab.
import { api } from "../lib/api.js";
import { ico } from "./ui/icons.js";
import { hrefFor, parseRoute, TAB_TITLES, type Route, type Tab } from "./route.js";
import { lcdView } from "./live.js";
import type { LiveStore } from "./liveStore.js";
import type { Glance } from "./verdict.js";

export interface Shell {
  panel(tab: Tab): HTMLElement;
  route(): Route;
  onRoute(fn: (r: Route) => void): void;
  setVerdict(v: Glance, text: string): void;
  setTriageCount(n: number): void;
}

const TABS: Tab[] = ["radio", "tune", "library", "system"];

/** What the shell needs to write: the poller's exclusive lane (every
 *  every admin write goes through it) and somewhere to say a failure. Passed
 *  as callbacks so the shell imports neither the poller nor the dialogs. */
export interface ShellIo {
  run<T>(fn: () => Promise<T>): Promise<T>;
  toast(text: string): void;
}

export function mountShell(root: HTMLElement, live: LiveStore, io: ShellIo): Shell {
  const tabLink = (t: Tab): string =>
    `<a class="kc-tab" data-tab="${t}" href="${hrefFor({ tab: t })}">${ico(t)}<span>${TAB_TITLES[t]}</span>${
      t === "library" ? `<b class="kc-badge kc-triage" aria-hidden="true" hidden></b>` : ""}</a>`;
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

  // Built once: WS `signal` events update dbfs ~4×/s during a transmission,
  // and a rebuilt-every-paint mini-player dropped focus and swallowed clicks
  // that landed mid-rebuild. Only the fields that actually changed are
  // touched on each paint.
  mini.innerHTML = `<a class="kc-mini__open" href="${hrefFor({ tab: "radio" })}">
      <span class="kc-mini__name"></span><span class="kc-mini__freq" hidden></span></a>
    <button type="button" class="kc-mini__key" data-act="skip" aria-label="Skip transmission">${ico("skip")}</button>
    <button type="button" class="kc-mini__key" data-act="listen" disabled>${ico("play")}</button>`;
  mini.querySelector('[data-act="skip"]')!.addEventListener("click", () => {
    io.run(() => api.skip()).catch((e: unknown) => io.toast(e instanceof Error ? e.message : String(e)));
  });
  mini.querySelector('[data-act="listen"]')!.addEventListener("click", () => live.toggleStream());
  const miniOpen = mini.querySelector<HTMLAnchorElement>(".kc-mini__open")!;
  const miniName = mini.querySelector<HTMLElement>(".kc-mini__name")!;
  const miniFreq = mini.querySelector<HTMLElement>(".kc-mini__freq")!;
  const miniListen = mini.querySelector<HTMLButtonElement>('[data-act="listen"]')!;
  let miniPainted: { name: string; freq: string; streaming: boolean; listenEnabled: boolean } | null = null;

  function paintMini(): void {
    // Radio IS the player — no mini-player there.
    mini.hidden = current.tab === "radio";
    if (mini.hidden) return;
    const v = lcdView(live.state);
    const next = {
      name: v.name, freq: v.freq, streaming: live.streaming,
      listenEnabled: live.state.remoteListening || live.streaming,
    };
    const prev = miniPainted;
    if (prev && prev.name === next.name && prev.freq === next.freq
      && prev.streaming === next.streaming && prev.listenEnabled === next.listenEnabled) return;
    miniPainted = next;

    if (!prev || prev.name !== next.name) {
      miniName.textContent = next.name;
      miniOpen.setAttribute("aria-label", `Open radio: ${next.name}`);
    }
    if (!prev || prev.freq !== next.freq) {
      miniFreq.hidden = !next.freq;
      miniFreq.textContent = next.freq;
    }
    if (!prev || prev.listenEnabled !== next.listenEnabled) {
      miniListen.disabled = !next.listenEnabled;
    }
    if (!prev || prev.streaming !== next.streaming) {
      miniListen.setAttribute("aria-label", next.streaming ? "Stop listening" : "Listen here");
      miniListen.innerHTML = ico(next.streaming ? "stop" : "play");
    }
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
      // aria-label on a bare <b> is ignored by screen readers: the count goes
      // into the Library link's accessible name and the badge is aria-hidden.
      root.querySelectorAll<HTMLElement>(".kc-triage").forEach((b) => {
        b.hidden = n === 0; b.textContent = String(n);
      });
      root.querySelectorAll<HTMLAnchorElement>('.kc-tab[data-tab="library"]').forEach((a) => {
        if (n === 0) a.removeAttribute("aria-label");
        else a.setAttribute("aria-label", `${TAB_TITLES.library}, ${n} to review`);
      });
    },
  };
}
