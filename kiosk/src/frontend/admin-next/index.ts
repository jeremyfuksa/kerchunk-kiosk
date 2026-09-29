// admin-next entry: composes shell, live store, poller, dialogs and tabs.
import "./admin-next.css";
import { api } from "../lib/api.js";
import { mountShell } from "./shell.js";
import { LiveStore } from "./liveStore.js";
import { Poller, POLL_MS, POLL_TICK_MS } from "./poller.js";
import { mountDialogs } from "./dialogs.js";
import { glance, type SystemGlance } from "./verdict.js";
import { withAudio } from "./live.js";
import type { Ctx } from "./ctx.js";
import { renderPlaceholder } from "./placeholder.js";
import { mountRadio } from "./radio.js";
import { hrefFor } from "./route.js";
import { esc } from "../lib/format.js";

export function renderAdminNext(root: HTMLElement): void {
  const live = new LiveStore();
  const shell = mountShell(root, live);
  const dialogs = mountDialogs(root);
  const poller = new Poller();
  const ctx: Ctx = { shell, live, poller, dialogs };

  // Registered first: the verdict is the glance (polls run in order).
  poller.add({
    name: "verdict", everyMs: POLL_MS.verdict,
    run: async () => {
      // A failed or non-OK answer must read "unknown", never leave the last
      // "healthy" on screen.
      let sys: SystemGlance | null = null;
      try {
        const r = await fetch("/api/system");
        if (r.ok) sys = await r.json() as SystemGlance;
      } catch { /* unreachable — shown below */ }
      const v = glance(sys);
      shell.setVerdict(v.verdict, v.text);
      const strip = shell.panel("radio").querySelector<HTMLElement>("#kcHealth");
      if (strip) {
        strip.hidden = v.verdict === "healthy";
        strip.dataset.verdict = v.verdict;
        strip.innerHTML = v.verdict === "healthy" ? "" : `<span>${esc(v.text)}</span><a href="${hrefFor({ tab: "system" })}">Open System</a>`;
      }
    },
  });
  // WS `status` events (and every WS (re)open) set live.resyncPending rather
  // than fetching directly (this box deadlocks on concurrent requests) — this
  // poll picks it up on the next tick, sequenced with everything else. It also
  // runs at least every POLL_MS.status, in case a WS event was missed.
  poller.add({
    name: "status", everyMs: 0,
    when: () => live.statusDue(Date.now(), POLL_MS.status),
    run: () => live.syncStatus(),
  });
  poller.add({
    name: "audio+triage", everyMs: POLL_MS.audio,
    run: async () => {
      const cfg = await api.getConfig();
      live.set(withAudio(live.state, cfg.audio));
      // Suppressed discoveries aren't in triage (same filter as the classic
      // admin's triage list), so they don't count.
      shell.setTriageCount((cfg.discoveries ?? []).filter((d) => !d.suppressedAt).length);
    },
  });
  // Runs once at start (everyMs: Infinity never comes due again on its own);
  // a route change's makeDue may re-run it too, which is harmless.
  poller.add({
    name: "weather", everyMs: Number.POSITIVE_INFINITY,
    run: () => live.loadWeatherChannel(),
  });

  renderPlaceholder(shell.panel("tune"), "tune");
  renderPlaceholder(shell.panel("library"), "library");
  renderPlaceholder(shell.panel("system"), "system");
  mountRadio(ctx);

  live.connect();
  shell.onRoute((r) => { poller.makeDue(r.tab); void poller.tick(r.tab); });
  poller.start(() => shell.route().tab, POLL_TICK_MS);
  void poller.tick(shell.route().tab);
}
