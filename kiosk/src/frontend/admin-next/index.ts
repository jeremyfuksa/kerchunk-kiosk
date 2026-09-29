// admin-next entry: composes shell, live store, poller, dialogs and tabs.
import "./admin-next.css";
import { api } from "../lib/api.js";
import { mountShell, type Shell } from "./shell.js";
import { LiveStore } from "./liveStore.js";
import { Poller, POLL_MS } from "./poller.js";
import { mountDialogs, type Dialogs } from "./dialogs.js";
import { worseVerdict, type SystemAlert, type Verdict } from "./verdict.js";
import { renderPlaceholder } from "./placeholder.js";

export interface Ctx { shell: Shell; live: LiveStore; poller: Poller; dialogs: Dialogs }

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
      const sys = await fetch("/api/system").then((r) => r.json()) as {
        health: { verdict: Verdict; reason: string }; alerts: SystemAlert[];
      };
      const v = worseVerdict(sys.health, sys.alerts);
      shell.setVerdict(v.verdict, v.text);
    },
  });
  // WS `status` events set live.resyncPending rather than fetching directly
  // (this box deadlocks on concurrent requests) — this poll picks it up on
  // the next tick, sequenced with everything else.
  poller.add({
    name: "status", everyMs: 0,
    when: () => live.resyncPending,
    run: async () => { live.resyncPending = false; await live.syncStatus(); },
  });
  poller.add({
    name: "audio+triage", everyMs: POLL_MS.audio,
    run: async () => {
      const cfg = await api.getConfig();
      live.set({ volume: cfg.audio.volume, muted: cfg.audio.muted, remoteListening: cfg.audio.remoteListening ?? false });
      shell.setTriageCount((cfg.discoveries ?? []).length);
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
  mountRadioTab(ctx);

  live.connect();
  shell.onRoute((r) => { poller.makeDue(r.tab); void poller.tick(r.tab); });
  poller.start(() => shell.route().tab);
  void poller.tick(shell.route().tab);
}

// Replaced in Task 16 by `import { mountRadio } from "./radio.js"`.
function mountRadioTab(ctx: Ctx): void {
  ctx.shell.panel("radio").textContent = "Radio";
}
