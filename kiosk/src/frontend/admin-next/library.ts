// Library — channels and new discoveries (spec §5). Composes the list, the
// detail sheet/pane (route-driven: #/library/ch/<id> …), the Manage banks
// and Suggestions sheets, and the New (triage) cards.
//
// Every fetch rides the sequential Poller: the "library" poll loads channels,
// then config, then (when recording) the sample index, one after another;
// "suggestions" loads duplicates and archive ideas less often; writes go
// through lib.run (test/adminNext.lane.test.ts enforces it).
import "./library.css";
import { api } from "../lib/api.js";
import { esc } from "../lib/format.js";
import { hrefFor, type Route } from "./route.js";
import { segmented } from "./ui/kit.js";
import { ico } from "./ui/icons.js";
import { POLL_MS } from "./poller.js";
import { pendingDiscoveries } from "./libraryModel.js";
import { LibStore, libCtx, type LibCtx } from "./libraryStore.js";
import { mountChannels } from "./libraryChannels.js";
import { mountDetail } from "./channelDetail.js";
import { mountSheets } from "./librarySheets.js";
import { mountNew } from "./libraryNew.js";
import type { Ctx } from "./ctx.js";

export function mountLibrary(ctx: Ctx): void {
  const el = ctx.shell.panel("library");
  const store = new LibStore();
  let view: "channels" | "new" = "channels";
  const lib: LibCtx = libCtx(ctx, store, () => view);

  el.innerHTML = `<div class="kc-lib">
    <header class="kc-lib__head">
      <h1>Library</h1>
      <a class="kc-key kc-key--primary" id="kcLibAdd" href="${hrefFor({ tab: "library", detail: { kind: "add" } })}">${ico("plus")}<span>Add channel</span></a>
    </header>
    <div id="kcLibSeg"></div>
    <p class="kc-empty" id="kcLibLoading">${esc("Loading the library…")}</p>
    <div id="kcLibChannels"></div>
    <div id="kcLibNew" hidden></div>
  </div>`;
  const $ = <T extends HTMLElement>(s: string): T => el.querySelector<T>(s)!;
  const seg = $("#kcLibSeg");
  const chHost = $("#kcLibChannels");
  const newHost = $("#kcLibNew");

  const sheets = mountSheets(lib, el);
  const channels = mountChannels(lib, chHost, sheets);
  const triage = mountNew(lib, newHost);
  const detail = mountDetail(lib, el);

  let segShown = "";
  function paintSeg(): void {
    const d = store.data;
    const nCh = d ? d.channels.filter((c) => c.enabled).length : undefined;
    const nNew = d ? pendingDiscoveries(d.cfg).length : undefined;
    const html = segmented({
      label: "Library view", current: view,
      items: [
        { id: "channels", label: "Channels", href: hrefFor({ tab: "library" }), count: nCh },
        { id: "new", label: "New", href: hrefFor({ tab: "library", sub: "new" }), count: nNew, attention: (nNew ?? 0) > 0 },
      ],
    });
    if (html !== segShown) { segShown = html; seg.innerHTML = html; }
  }

  store.subscribe(() => {
    paintSeg();
    if (view === "channels") channels.paint(); else triage.paint();
    detail.paint();
    const d = store.data;
    if (d) ctx.shell.setTriageCount(pendingDiscoveries(d.cfg).length);
  });

  // ── Polls (sequential; see header)
  ctx.poller.add({
    name: "library", everyMs: POLL_MS.library, tabs: ["library"],
    run: async () => {
      try {
        const chs = await api.getChannels();
        const cfg = await api.getConfig();
        const samples = cfg.scan.recordCloseCalls === true
          ? await api.getDiscoverySamples().catch(() => ({}))
          : {};
        store.set({ data: { channels: chs, cfg, samples }, loadError: null });
      } catch (e) {
        store.set({ loadError: e instanceof Error ? e.message : String(e) });
      }
    },
  });
  ctx.poller.add({
    name: "suggestions", everyMs: POLL_MS.suggestions, tabs: ["library"],
    run: async () => {
      // Each is best-effort: no history store → no archive ideas, not an error.
      const dups = await api.getDuplicates().catch(() => []);
      const recs = await api.getArchiveRecommendations().catch(() => []);
      store.set({ dups, recs });
    },
  });

  // ── Routing: the tab's view follows #/library vs #/library/new; a detail
  // route keeps whichever view was showing and opens the sheet over it.
  let prev: Route | null = null;
  function onRoute(r: Route): void {
    if (r.tab !== "library") { detail.hide(); prev = r; return; }
    if (!r.detail) view = r.sub === "new" ? "new" : "channels";
    chHost.hidden = view !== "channels";
    newHost.hidden = view !== "new";
    paintSeg();
    if (view === "channels") channels.paint(); else triage.paint();
    if (r.detail) detail.show(r.detail, { fromList: prev?.tab === "library" && !prev.detail });
    else detail.hide();
    channels.setSelected(r.detail?.kind === "ch" ? r.detail.id : null);
    prev = r;
  }
  ctx.shell.onRoute(onRoute);
  onRoute(ctx.shell.route());

  // "/" focuses search on the Channels view (not while typing anywhere).
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (ctx.shell.route().tab !== "library" || view !== "channels") return;
    const s = chHost.querySelector<HTMLInputElement>("#kcLibSearch");
    if (!s) return;
    ev.preventDefault(); s.focus(); s.select();
  });

  // "Loading the library…" (above both views, so it shows whichever is first)
  // goes on the first poll result, data or error.
  store.subscribe(() => { el.querySelector("#kcLibLoading")?.remove(); });
}
