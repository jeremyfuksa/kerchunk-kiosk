import type { Channel } from "../../backend/config/schema.js";
import { NOAA_CHANNELS } from "../../backend/config/noaa.js";
import { api } from "../lib/api.js";
import { fmtFreq, esc } from "../lib/format.js";
import { bandFor, matchesBank, serviceFor, groupChannelsByBank } from "../../backend/config/banks.js";
import type { BankGroup } from "../../backend/config/banks.js";
import icoHeadphones from "lucide-static/icons/headphones.svg?raw";
import icoPencil from "lucide-static/icons/pencil.svg?raw";
import icoBan from "lucide-static/icons/ban.svg?raw";
import icoTrash from "lucide-static/icons/trash-2.svg?raw";
import icoPlus from "lucide-static/icons/circle-plus.svg?raw";
import icoX from "lucide-static/icons/x.svg?raw";
import icoCheck from "lucide-static/icons/check.svg?raw";
import icoUnlock from "lucide-static/icons/lock-open.svg?raw";
import icoBell from "lucide-static/icons/bell-ring.svg?raw";
import icoGauge from "lucide-static/icons/gauge.svg?raw";
import icoInbox from "lucide-static/icons/inbox.svg?raw";
import icoList from "lucide-static/icons/list.svg?raw";
import icoSliders from "lucide-static/icons/sliders-horizontal.svg?raw";
import icoGear from "lucide-static/icons/settings-2.svg?raw";
import type { Bank } from "../../backend/config/schema.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import "./admin.css";

export function mhzToHz(mhz: string): number {
  const n = Number(mhz);
  if (!Number.isFinite(n)) throw new Error(`invalid frequency: ${mhz}`);
  return Math.round(n * 1e6);
}

export function formToChannel(form: { mhz: string; alphaTag: string; mode: string; priority?: boolean }): Omit<Channel, "id"> {
  const mode = form.mode as Channel["mode"];
  // priority is only included when set, so non-priority channels stay free of
  // the key in saved config (and existing toEqual-style consumers are stable).
  return { freq: mhzToHz(form.mhz), alphaTag: form.alphaTag, mode, enabled: true, ...(form.priority ? { priority: true } : {}) };
}

export function weatherFormToChannel(form: { mhz: string; alphaTag: string; mode: string }): Omit<Channel, "id"> {
  return formToChannel(form);
}



// Icons come from Lucide (lucide-static raw SVGs, stroke = currentColor, so
// the consequence color-coding on button classes carries straight through).
const ICONS: Record<string, string> = {
  listen: icoHeadphones,
  edit: icoPencil,
  lockout: icoBan,
  del: icoTrash,
  add: icoPlus,
  dismiss: icoX,
  save: icoCheck,
  cancel: icoX,
  unlock: icoUnlock,
  bell: icoBell,
  gear: icoGear,
};

function iconBtn(cls: string, icon: string, label: string, attrs = ""): string {
  return `<button class="${cls} iconBtn" title="${label}" aria-label="${label}"${attrs ? " " + attrs : ""}>${ICONS[icon]}</button>`;
}

export function renderAdmin(root: HTMLElement): void {
  root.innerHTML = `
    <main class="admin">
      <header class="adminHead">
        <a class="brand" href="#/" aria-label="Kerchunk admin overview">KERCHUNK <span class="brandSub">admin</span></a>
        <div class="headActions">
          <a href="/" target="_blank" title="Open the kiosk display">Kiosk ↗</a>
          <a href="/map" target="_blank" title="Open the live activity map">Map ↗</a>
        </div>
      </header>
      <div class="workspace">
      <nav class="adminNav" id="adminNav" aria-label="Admin sections">
        <a href="#/" data-route="home"><span class="navIco" data-ico="home"></span><span class="navCopy"><b>Overview</b><small>Live status and activity</small></span></a>
        <a href="#/triage" data-route="triage"><span class="navIco" data-ico="triage"></span><span class="navCopy"><b>Triage</b><small>Review new discoveries</small></span><span id="navDcCount" class="navBadge"></span></a>
        <a href="#/channels" data-route="channels"><span class="navIco" data-ico="channels"></span><span class="navCopy"><b>Channels</b><small>Organize what you scan</small></span></a>
        <a href="#/scan" data-route="scan"><span class="navIco" data-ico="scan"></span><span class="navCopy"><b>Settings</b><small>Scanning and integrations</small></span></a>
      </nav>
      <div class="pages">
      <div class="pageIntro" data-page="home">
        <div><span class="eyebrow">Overview</span><h1>Radio status</h1><p>Monitor what is playing, check system health, and review recent activity.</p></div>
      </div>
      <section class="nowCard hero" data-page="home">
        <h2>Now playing</h2>
        <div class="npWhat"><span id="npName" class="npName">scanning…</span> <span id="npFreq" class="npFreq"></span></div>
        <div class="npControls">
          <div class="controlGroup audioControls">
            <button id="streamBtn" class="primary" title="Listen to the live speaker feed in this browser">▶ Listen here</button>
            <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
            <label class="checkLabel"><input id="mute" type="checkbox" /> Mute</label>
          </div>
          <div class="controlGroup transmissionControls">
            <button id="resumeBtn" class="resume" style="display:none">⏹ Resume scan</button>
            <button id="weatherBtn" class="weatherAction">Listen to weather</button>
            <button id="skipBtn" title="Force-close the current transmission">Skip transmission</button>
            <button id="tlockBtn" title="Suppress this channel for 30 minutes (clears on restart)" disabled>Pause 30 min</button>
            <button id="lockBtn" class="danger" title="Remove this channel and never Close-Call its frequency again" disabled>Lock out channel</button>
          </div>
          <div class="systemActions">
            <span class="systemActionsLabel">System controls</span>
            <button id="kioskReload" title="Refresh the display page and reload its map and frontend assets">Refresh kiosk screen</button>
            <button id="backendRestart" class="danger" title="Restart the radio backend and scanner helpers">Restart radio backend</button>
            <span id="systemActionStatus" class="hint" role="status"></span>
          </div>
        </div>
      </section>
      <section class="sysHealth collapsible" data-key="system" data-page="home">
        <h2>System health <span class="hint">the machine under the radio — helper CPU is the usual suspect</span></h2>
        <div id="sysBody" class="sysBody"></div>
      </section>
      <section class="discoveries" data-page="triage">
        <div class="pageIntro sectionIntro">
          <div><span class="eyebrow">Triage</span><h1>Review discoveries <span class="count" id="dcCount"></span></h1><p>Close Call found these frequencies. Listen, then add useful signals or dismiss the rest.</p></div>
        </div>
        <div class="dcToolbar">
          <button id="dcDismissSel" disabled>Dismiss selected</button>
          <button id="dcLockSel" class="danger" disabled>Lock out selected</button>
          <span id="dcSelCount" class="hint"></span>
        </div>
        <div class="tableWrap">
          <table class="chTable">
            <thead><tr><th><input id="dcAll" type="checkbox" title="Select all" /></th><th>Freq (MHz)</th><th>Name</th><th>Mode</th><th></th></tr></thead>
            <tbody id="dcRows"></tbody>
          </table>
        </div>
      </section>
      <section class="channels" data-page="channels">
        <div class="pageIntro sectionIntro">
          <div><span class="eyebrow">Channels</span><h1>Channel library <span class="count" id="chCount"></span></h1><p>Add frequencies, choose what is audible, and organize related channels into banks.</p></div>
          <button id="addBtn" class="primary">+ Add channel</button>
        </div>
        <details class="bankBuilder">
          <summary>Create a channel bank <span>Group channels by band, frequency range, or tag</span></summary>
          <div class="bankAdd">
            <label>Bank name <input id="bkName" placeholder="Air, Rail, Local…" /></label>
            <label>Band <select id="bkBand"><option value="">Any band</option><option value="hf">HF</option><option value="vhf">VHF</option><option value="uhf">UHF</option><option value="shf">SHF</option></select></label>
            <label>From MHz <input id="bkLo" type="number" step="0.001" placeholder="Optional" title="Frequency range predicate — e.g. 144 for 2m" /></label>
            <label>To MHz <input id="bkHi" type="number" step="0.001" placeholder="Optional" /></label>
            <label>Tags <input id="bkTags" placeholder="Comma-separated, optional" /></label>
            <button id="bkAdd" class="primary">Create bank</button>
            <span id="bkErr" class="err"></span>
          </div>
        </details>
        <div id="bankProfile" class="bankProfile"></div>
        <div class="tableWrap">
          <table class="chTable">
            <thead><tr>
              <th>Freq (MHz)</th><th>Name</th><th>Mode</th><th>Priority</th><th>Audible</th><th>Archived</th><th></th>
            </tr></thead>
            <tbody id="chRows"></tbody>
          </table>
        </div>
        <span id="chErr" class="err"></span>
      </section>
      <div class="statRow" data-page="home" id="statRow"></div>
      <section class="insights collapsible" data-key="insights" data-page="home">
        <h2>Insights <span class="hint" id="inPeriodHint"></span></h2>
        <div class="inToolbar">
          <button class="inPeriod" data-h="24">24 h</button>
          <button class="inPeriod" data-h="168">7 d</button>
          <button class="inPeriod" data-h="720">30 d</button>
        </div>
        <div id="inBody" class="inBody"></div>
      </section>
      <div class="feedsRow" data-page="home">
      <section class="alertFeed collapsible" data-key="alerts" data-page="home">
        <h2>Alerts <span class="hint">what fired while you were away — flag channels with the bell</span></h2>
        <ul id="alertRows" class="alertList"></ul>
      </section>
      <section class="transcripts collapsible" data-key="transcripts" data-page="home">
        <h2>Transcripts <span class="hint">what was said — whisper-tiny gist, not gospel</span></h2>
        <ul id="trRows" class="alertList"></ul>
      </section>
      </div>
      <div class="pageIntro" data-page="scan">
        <div><span class="eyebrow">Settings</span><h1>Scanner settings</h1><p>Adjust scan behavior and optional services. Changes apply when you save each section.</p></div>
      </div>
      <div class="moduleRow" data-page="scan">
      <section class="tuning settingsPanel">
        <h2>Scan behavior</h2>
        <p class="sectionHelp">These defaults control how quickly the scanner moves and when a signal opens.</p>
        <div class="settingGroups">
          <fieldset>
            <legend>Timing and squelch</legend>
            <label><span>Group dwell <small>Time spent on each frequency group</small></span><span class="inputUnit"><input id="tGroupDwell" type="number" min="500" step="100" placeholder="3000" /><b>ms</b></span></label>
            <label><span>Hang time <small>Wait after a transmission ends</small></span><span class="inputUnit"><input id="tHang" type="number" min="100" step="100" placeholder="2000" /><b>ms</b></span></label>
            <label><span>Squelch open <small>Signal level above the noise floor</small></span><span class="inputUnit"><input id="tOpenDb" type="number" min="1" step="0.5" placeholder="9" /><b>dB</b></span></label>
            <label><span>Quieting threshold <small>Absolute noise threshold</small></span><span class="inputUnit"><input id="tQuietDb" type="number" max="-1" step="0.5" placeholder="-86" /><b>dB</b></span></label>
          </fieldset>
          <fieldset>
            <legend>Discovery</legend>
            <label class="switchRow"><span>Close Call <small>Find strong nearby signals outside your channel list</small></span><input id="tCloseCall" type="checkbox" /></label>
            <label><span>Close Call threshold <small>Higher values reduce false discoveries</small></span><span class="inputUnit"><input id="tCloseCallDb" type="number" min="5" step="1" placeholder="15" /><b>dB</b></span></label>
            <label><span>Sweep ranges <small>Comma-separated MHz ranges; empty disables sweeping</small></span><input id="tSweep" type="text" placeholder="450-470, 150-162" title="Band-sweep: one empty-window stop per rotation hunts for activity inside these ranges" /></label>
          </fieldset>
          <fieldset>
            <legend>Alerts and transcripts</legend>
            <label><span>Alert cooldown <small>Minimum time before repeating an alert</small></span><span class="inputUnit"><input id="tAlertCool" type="number" min="1" step="1" placeholder="15" /><b>min</b></span></label>
            <label><span>Alert hold <small>How long an alert remains visible</small></span><span class="inputUnit"><input id="tAlertHold" type="number" min="5" step="5" placeholder="30" /><b>sec</b></span></label>
            <label><span>Push notification URL <small>Optional ntfy topic URL</small></span><input id="tAlertNtfy" type="text" placeholder="https://ntfy.sh/your-topic" /></label>
            <label><span>SAME county codes <small>Comma-separated FIPS codes; empty allows all</small></span><input id="tSameFips" type="text" placeholder="029047, 029095" title="County FIPS codes for SAME/EAS scoping — 5-digit SSCCC or 6-digit PSSCCC" /></label>
            <label class="switchRow"><span>Show SAME tests <small>Include weekly and monthly test banners</small></span><input id="tSameTests" type="checkbox" /></label>
            <label class="switchRow" title="Speech-to-text on every transmission the speaker plays. Costs CPU and takes effect at service restart."><span>Transcribe audio <small>Uses additional CPU; takes effect after restart</small></span><input id="tTranscribe" type="checkbox" /></label>
          </fieldset>
          <fieldset>
            <legend>Map integration</legend>
            <label><span>Google Maps key</span><input id="tMapsKey" type="text" placeholder="AIza…" /></label>
            <label><span>Google Maps Map ID</span><input id="tMapsMapId" type="text" placeholder="Optional vector map ID" /></label>
          </fieldset>
        </div>
        <div class="formActions"><button id="tSave" class="primary">Save scanner settings</button><span id="tErr" class="err"></span></div>
      </section>
      <section class="lockouts collapsible" data-key="lockouts">
        <h2>Close Call lockouts</h2>
        <ul id="loList"></ul>
      </section>
      <section class="weather collapsible" data-key="weather" data-page="scan">
        <h2>Weather</h2>
        <p class="sectionHelp">Choose the local NOAA channel used by weather-only mode.</p>
        <label>Channel <select id="wxFreq">${NOAA_CHANNELS.map((c) => `<option value="${c.mhz}">${c.label} — ${c.mhz} MHz</option>`).join("")}</select></label>
        <label>Name <input id="wxTag" type="text" placeholder="NOAA WX" /></label>
        <label>Mode <select id="wxMode"><option value="nfm">NFM</option><option value="fm">FM</option><option value="am">AM</option></select></label>
        <button id="wxSave" class="primary">Save weather channel</button>
        <span id="wxErr" class="err"></span>
      </section>
      </div>
    </main>
      </div>
      </div>
    <div id="drawerScrim" class="drawerScrim"></div>
    <aside id="chDrawer" class="drawer" aria-label="Channel details"></aside>
    <dialog id="confirmDialog" class="confirmDialog" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
      <form method="dialog">
        <span class="confirmEyebrow">Confirm action</span>
        <h2 id="confirmTitle"></h2>
        <p id="confirmMessage"></p>
        <div class="confirmActions">
          <button value="cancel">Cancel</button>
          <button id="confirmAction" value="confirm">Confirm</button>
        </div>
      </form>
    </dialog>`;

  const confirmDialog = root.querySelector<HTMLDialogElement>("#confirmDialog")!;
  const confirmTitle = root.querySelector<HTMLElement>("#confirmTitle")!;
  const confirmMessage = root.querySelector<HTMLElement>("#confirmMessage")!;
  const confirmAction = root.querySelector<HTMLButtonElement>("#confirmAction")!;

  function confirmAdminAction(opts: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean> {
    confirmTitle.textContent = opts.title;
    confirmMessage.textContent = opts.message;
    confirmAction.textContent = opts.confirmLabel;
    confirmAction.classList.toggle("danger", opts.danger ?? false);
    confirmAction.classList.toggle("primary", !(opts.danger ?? false));
    confirmDialog.returnValue = "cancel";
    confirmDialog.showModal();
    return new Promise((resolve) => {
      confirmDialog.addEventListener("close", () => resolve(confirmDialog.returnValue === "confirm"), { once: true });
    });
  }

  // Progressive disclosure: minor modules collapse behind their legends.
  // State persists per device (an operator who tunes often keeps it open).
  const COLLAPSE_KEY = "kerchunk.admin.collapsed";
  const collapsed = new Set<string>(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '["tuning","lockouts","weather","insights","transcripts"]'));
  // ── Admin IA (ROADMAP Idea 15): config is a destination, monitoring is
  // the landing. Pure re-layout — all sections stay wired as before; the
  // route only decides which data-page group is visible. Unknown = home.
  const ROUTES = new Set(["home", "triage", "channels", "scan"]);
  const NAV_ICONS: Record<string, string> = {
    home: icoGauge, triage: icoInbox, channels: icoList, scan: icoSliders,
  };
  root.querySelectorAll<HTMLElement>(".navIco").forEach((el) => {
    el.innerHTML = NAV_ICONS[el.dataset.ico!] ?? "";
  });
  function currentRoute(): string {
    let r = location.hash.replace(/^#\/?/, "") || "home";
    if (r === "banks") r = "channels";   // pre-unification bookmarks survive
    return ROUTES.has(r) ? r : "home";
  }
  function applyRoute(): void {
    const route = currentRoute();
    const titles: Record<string, string> = { home: "Overview", triage: "Triage", channels: "Channels", scan: "Settings" };
    document.title = `${titles[route]} · Kerchunk Admin`;
    root.querySelectorAll<HTMLElement>("[data-page]").forEach((el) => {
      el.classList.toggle("pageHidden", el.dataset.page !== route);
    });
    root.querySelectorAll<HTMLAnchorElement>("#adminNav a").forEach((a) => {
      const active = a.dataset.route === route;
      a.classList.toggle("active", active);
      if (active) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
  }
  window.addEventListener("hashchange", applyRoute);
  applyRoute();

  root.querySelectorAll<HTMLElement>("section.collapsible").forEach((sec) => {
    const key = sec.dataset.key!;
    if (collapsed.has(key)) sec.classList.add("collapsed");
    const heading = sec.querySelector<HTMLElement>("h2")!;
    heading.tabIndex = 0;
    heading.setAttribute("role", "button");
    heading.setAttribute("aria-expanded", String(!sec.classList.contains("collapsed")));
    const toggle = () => {
      sec.classList.toggle("collapsed");
      heading.setAttribute("aria-expanded", String(!sec.classList.contains("collapsed")));
      if (sec.classList.contains("collapsed")) collapsed.add(key); else collapsed.delete(key);
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed]));
    };
    heading.addEventListener("click", toggle);
    heading.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); }
    });
  });

  const vol = root.querySelector<HTMLInputElement>("#vol")!;
  const mute = root.querySelector<HTMLInputElement>("#mute")!;
  const chRows = root.querySelector<HTMLElement>("#chRows")!;
  const chErr = root.querySelector<HTMLElement>("#chErr")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#addBtn")!;

  // Identified-modulation chip; digital modes get the warning treatment —
  // this radio demodulates analog FM only, so a DMR/P25 discovery explains
  // itself ("that's why it sounds like a wood chipper").
  const DIGITAL = ["DMR", "P25", "NXDN", "D-STAR", "YSF", "TETRA"];

  // "Olathe, KS" chip for anything an identification source located.
  function locChip(loc?: { city?: string; state?: string }): string {
    if (!loc || (!loc.city && !loc.state)) return "";
    const txt = [loc.city, loc.state].filter(Boolean).join(", ");
    return ` <span class="loc">${esc(txt)}</span>`;
  }

  // Single lockout path for all three entry points (channel row, discovery
  // row, now-playing card) — they drifted when each had its own copy.
  async function lockoutFreq(freq: number, label: string): Promise<void> {
    const confirmed = await confirmAdminAction({
      title: `Lock out ${label}?`,
      message: "This removes the channel and permanently prevents this frequency from triggering Close Call.",
      confirmLabel: "Lock out permanently",
      danger: true,
    });
    if (!confirmed) return;
    const cfg = await api.getConfig();
    // Locking out a frequency removes it EVERYWHERE: channel(s), pending
    // discoveries, and into the suppression list.
    cfg.channels = cfg.channels.filter((c) => c.freq !== freq);
    cfg.discoveries = (cfg.discoveries ?? []).filter((d) => d.freq !== freq);
    cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), freq])];
    await api.putConfig(cfg);
    await refresh();
    renderDiscoveries();
    renderLockouts();
  }

  // ── Banks: toggleable predicates over band/tags (ROADMAP Idea 1) ──
  const bkErr = root.querySelector<HTMLElement>("#bkErr")!;

  // ── Per-bank scan profile editor (ROADMAP Idea 7): squelch trio applies
  // to the bank's channels; dwell weight scales its windows' park time.
  // Empty field = inherit the global Scan tuning value.
  const bankProfBox = root.querySelector<HTMLElement>("#bankProfile")!;
  function openProfileEditor(b: Bank | undefined): void {
    if (!b) return;
    const num = (v: number | undefined) => (v !== undefined ? String(v) : "");
    bankProfBox.innerHTML = `
      <h3>${esc(b.name)} — scan profile <span class="hint">empty = global default</span></h3>
      <label>Squelch open (dB over floor) <input id="bpOpen" type="number" min="1" step="0.5" value="${num(b.openAboveFloorDb)}" placeholder="global" /></label>
      <label>Quieting threshold (dB) <input id="bpQuiet" type="number" max="-1" step="0.5" value="${num(b.noiseQuietDb)}" placeholder="global" /></label>
      <label>Hang time (ms) <input id="bpHang" type="number" min="100" step="100" value="${num(b.hangMs)}" placeholder="global" /></label>
      <label>Dwell weight <input id="bpDwell" type="number" min="0.1" step="0.1" value="${num(b.dwellWeight)}" placeholder="1" title="2 = this bank's windows get twice the park time; 0.5 = half" /></label>
      <button id="bpSave">Save profile</button>
      <button id="bpCancel">Cancel</button>
      <span id="bpErr" class="err"></span>`;
    bankProfBox.classList.add("open");
    const val = (sel: string): number | undefined => {
      const raw = bankProfBox.querySelector<HTMLInputElement>(sel)!.value.trim();
      return raw === "" ? undefined : Number(raw);
    };
    bankProfBox.querySelector<HTMLButtonElement>("#bpCancel")!
      .addEventListener("click", () => { bankProfBox.classList.remove("open"); bankProfBox.innerHTML = ""; });
    bankProfBox.querySelector<HTMLButtonElement>("#bpSave")!.addEventListener("click", async () => {
      const err = bankProfBox.querySelector<HTMLElement>("#bpErr")!;
      err.textContent = "";
      try {
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).map((x) => {
          if (x.id !== b.id) return x;
          const { openAboveFloorDb: _o, noiseQuietDb: _q, hangMs: _h, dwellWeight: _d, ...rest } = x;
          return {
            ...rest,
            ...(val("#bpOpen") !== undefined ? { openAboveFloorDb: val("#bpOpen") } : {}),
            ...(val("#bpQuiet") !== undefined ? { noiseQuietDb: val("#bpQuiet") } : {}),
            ...(val("#bpHang") !== undefined ? { hangMs: val("#bpHang") } : {}),
            ...(val("#bpDwell") !== undefined ? { dwellWeight: val("#bpDwell") } : {}),
          };
        });
        await api.putConfig(cfg);
        bankProfBox.classList.remove("open");
        bankProfBox.innerHTML = "";
        await refresh();
      } catch (e) { err.textContent = (e as Error).message; }
    });
  }

  root.querySelector<HTMLButtonElement>("#bkAdd")!.addEventListener("click", async () => {
    bkErr.textContent = "";
    const name = root.querySelector<HTMLInputElement>("#bkName")!.value.trim();
    if (!name) { bkErr.textContent = "name required"; return; }
    const band = root.querySelector<HTMLSelectElement>("#bkBand")!.value;
    const tags = root.querySelector<HTMLInputElement>("#bkTags")!.value
      .split(",").map((t) => t.trim()).filter(Boolean);
    const lo = root.querySelector<HTMLInputElement>("#bkLo")!.value.trim();
    const hi = root.querySelector<HTMLInputElement>("#bkHi")!.value.trim();
    const cfg = await api.getConfig();
    cfg.banks = [...(cfg.banks ?? []), {
      id: `bk_${Math.random().toString(36).slice(2, 10)}`,
      name, enabled: true,
      ...(band ? { band: band as Bank["band"] } : {}),
      ...(lo ? { loHz: Math.round(Number(lo) * 1e6) } : {}),
      ...(hi ? { hiHz: Math.round(Number(hi) * 1e6) } : {}),
      ...(tags.length ? { tags } : {}),
    }];
    await api.putConfig(cfg);
    root.querySelector<HTMLInputElement>("#bkName")!.value = "";
    root.querySelector<HTMLInputElement>("#bkTags")!.value = "";
    await refresh();
  });

  // ── Insights (ROADMAP Idea 9): aggregates over the history store ──
  const inBody = root.querySelector<HTMLElement>("#inBody")!;
  let inHours = 24;

  function fmtAir(ms: number): string {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m >= 1 ? `${m}m` : `${Math.round(ms / 1000)}s`;
  }

  async function renderInsights(): Promise<void> {
    const since = Date.now() - inHours * 3_600_000;
    const r = await fetch(`/api/stats?since=${since}`);
    if (!r.ok) { inBody.innerHTML = `<div class="empty">history store unavailable</div>`; return; }
    const st: {
      totalHits: number; totalAirtimeMs: number; discoveries: number;
      topChannels: Array<{ alphaTag: string; freq: number; hits: number; airtimeMs: number }>;
      byTag: Array<{ tag: string; hits: number }>;
      byBand: Array<{ band: string; hits: number }>;
      byHour: number[];
    } = await r.json();

    const maxHits = Math.max(1, ...st.topChannels.map((c) => c.hits));
    const maxHour = Math.max(1, ...st.byHour);
    const nowHour = new Date().getHours();

    inBody.innerHTML = `
      <div class="inTotals">
        <span><b>${st.totalHits}</b> hits</span>
        <span><b>${fmtAir(st.totalAirtimeMs)}</b> airtime</span>
        <span><b>${st.discoveries}</b> close calls</span>
      </div>
      <div class="inClock" title="activity by hour of day">
        ${st.byHour.map((n, h) => `<div class="inHr${h === nowHour ? " now" : ""}" style="height:${(4 + 26 * n / maxHour).toFixed(0)}px" title="${String(h).padStart(2, "0")}:00 — ${n}"></div>`).join("")}
      </div>
      <table class="inTop">
        ${st.topChannels.slice(0, 8).map((c) => `<tr>
          <td class="inName">${esc(c.alphaTag) || fmtFreq(c.freq)}</td>
          <td class="inBar"><div style="width:${(100 * c.hits / maxHits).toFixed(0)}%"></div></td>
          <td class="inN">${c.hits}</td>
          <td class="inAir">${fmtAir(c.airtimeMs)}</td>
        </tr>`).join("")}
      </table>
      <div class="inSplit">
        ${st.byBand.map((b) => `<span class="inChip">${esc(b.band.toUpperCase())} ${b.hits}</span>`).join("")}
        ${st.byTag.map((t) => `<span class="inChip tag">${esc(t.tag)} ${t.hits}</span>`).join("")}
      </div>`;
    root.querySelector<HTMLElement>("#inPeriodHint")!.textContent =
      inHours === 24 ? "last 24 hours" : inHours === 168 ? "last 7 days" : "last 30 days";
    root.querySelectorAll<HTMLButtonElement>(".inPeriod").forEach((b) =>
      b.classList.toggle("active", Number(b.dataset.h) === inHours));
  }
  root.querySelectorAll<HTMLButtonElement>(".inPeriod").forEach((b) =>
    b.addEventListener("click", () => { inHours = Number(b.dataset.h); void renderInsights(); }));
  void renderInsights();
  setInterval(() => { renderInsights().catch(() => {}); }, 60_000);

  // ── Home stat tiles (Idea 15): the glance numbers. One /api/stats(24h)
  // + config fetch feeds all four tiles and the hour clock.
  const statRow = root.querySelector<HTMLElement>("#statRow")!;
  function fmtAirShort(ms: number): string {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
  }
  async function renderStatTiles(): Promise<void> {
    const since = Date.now() - 24 * 3600 * 1000;
    const [stats, cfg, alerts] = await Promise.all([
      fetch(`/api/stats?since=${since}`).then((r) => r.json()),
      api.getConfig(),
      fetch(`/api/history?kind=alert&since=${since}&limit=200`).then((r) => (r.ok ? r.json() : [])),
    ]);
    const pending = (cfg.discoveries ?? []).length;
    const navBadge = root.querySelector<HTMLElement>("#navDcCount");
    if (navBadge) navBadge.textContent = pending > 0 ? String(pending) : "";
    const byHour = stats.byHour as number[];
    const max = Math.max(1, ...byHour);
    const nowHour = new Date().getHours();
    const total = byHour.reduce((a, b) => a + b, 0);
    const peak = byHour.indexOf(Math.max(...byHour));
    const clock = total === 0
      ? `<div class="clkEmpty">no traffic yet today</div>`
      : byHour.map((n, h) =>
        `<div class="clkBar${h === nowHour ? " now" : ""}" style="height:${Math.max(4, (n / max) * 100)}%" title="${String(h).padStart(2, "0")}:00 — ${n} hits"></div>`).join("");
    const tile = (label: string, value: string, sub: string, href?: string) =>
      `<${href ? `a href="${href}"` : "div"} class="statTile">
        <div class="stLabel">${label}</div>
        <div class="stValue">${value}</div>
        <div class="stSub">${sub}</div>
      </${href ? "a" : "div"}>`;
    statRow.innerHTML =
      tile("Hits · 24h", String(stats.totalHits), `${stats.topChannels[0] ? esc(stats.topChannels[0].alphaTag) + " leads" : "quiet band"}`)
      + tile("Airtime", fmtAirShort(stats.totalAirtimeMs), `${stats.discoveries} close call${stats.discoveries === 1 ? "" : "s"} heard`)
      + tile("Triage queue", String(pending), pending > 0 ? "discoveries await review" : "inbox zero", "#/triage")
      + tile("Alerts · 24h", String((alerts as unknown[]).length), "bell + SAME, feed below")
      + `<div class="statTile clockTile">
          <div class="stLabel">Activity by hour</div>
          <div class="hourClock" role="img" aria-label="${total === 0 ? "No traffic yet today" : `${total} hits today, busiest around ${String(peak).padStart(2, "0")}:00`}">${clock}</div>
        </div>`;
  }
  void renderStatTiles().catch(() => {});
  setInterval(() => { renderStatTiles().catch(() => {}); }, 60_000);

  // ── Alert feed (ROADMAP Idea 6): the durable "what fired while I was
  // away" review, straight off history rows with kind=alert.
  const alertRows = root.querySelector<HTMLElement>("#alertRows")!;
  async function renderAlertFeed(): Promise<void> {
    const rows = await fetch("/api/history?kind=alert&limit=25")
      .then((r) => (r.ok ? r.json() : [])) as
      Array<{ ts: number; freq: number; alphaTag: string }>;
    alertRows.innerHTML = rows.length
      ? rows.map((r) => `<li><span class="alertWhen">${new Date(r.ts).toLocaleString()}</span>
          <span class="alertWhat">${fmtFreq(r.freq)} ${esc(r.alphaTag)}</span></li>`).join("")
      : `<li class="hint">no alerts yet — flag a channel with “Alert on hit” in its drawer</li>`;
  }
  void renderAlertFeed().catch(() => {});
  setInterval(() => { renderAlertFeed().catch(() => {}); }, 60_000);

  // ── System health (Idea 16): gauges + sparklines off /api/system.
  const sysBody = root.querySelector<HTMLElement>("#sysBody")!;
  function spark(values: Array<number | null>, max: number, warn: number): string {
    const W = 120; const H = 28;
    const pts = values.map((v, i) => {
      const x = (i / Math.max(1, values.length - 1)) * W;
      const y = H - Math.min(1, Math.max(0, (v ?? 0) / max)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const last = values[values.length - 1];
    const hot = last !== null && last !== undefined && last >= warn;
    return `<svg class="spark${hot ? " hot" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" /></svg>`;
  }
  async function renderSystem(): Promise<void> {
    const { now, ring } = await fetch("/api/system").then((r) => r.json()) as {
      now: Record<string, number | boolean | null> | null;
      ring: Array<Record<string, number | boolean | null>>;
    };
    if (!now) { sysBody.textContent = "no samples yet"; return; }
    const num = (k: string) => ring.map((r) => (typeof r[k] === "number" ? r[k] as number : null));
    const cell = (label: string, value: string, sparkHtml: string, hot = false) =>
      `<div class="sysCell${hot ? " hot" : ""}"><div class="sysLabel">${label}</div>
        <div class="sysValue">${value}</div>${sparkHtml}</div>`;
    const t = now.tempC as number | null;
    sysBody.innerHTML =
      cell("CPU", `${now.cpuPct}%`, spark(num("cpuPct"), 100, 85), (now.cpuPct as number) >= 85)
      + cell("DSP helper", now.helperCpuPct === null ? "—" : `${now.helperCpuPct}% · ${now.helperRssMb} MB`,
          spark(num("helperCpuPct"), 400, 320), (now.helperCpuPct as number | null ?? 0) >= 320)
      + cell("Temp", t === null ? "n/a" : `${t}°C${now.throttled ? " · THROTTLED" : ""}`,
          spark(num("tempC"), 100, 85), (t ?? 0) >= 85 || now.throttled === true)
      + cell("RAM", `${now.memUsedPct}% · node ${now.backendRssMb} MB`, spark(num("memUsedPct"), 100, 90), (now.memUsedPct as number) >= 90)
      + cell("Open channels", String(now.openCount), spark(num("openCount"), 12, 11))
      + cell("Disk free", now.diskFreeMb === null ? "n/a" : `${((now.diskFreeMb as number) / 1024).toFixed(1)} GB`,
          "", (now.diskFreeMb as number | null ?? 1e9) < 2048)
      + `<div class="sysCell"><div class="sysLabel">Load</div><div class="sysValue">${(now.load1 as number).toFixed(1)}</div>
         <div class="hint" style="font-size:0.7rem">GR threads inflate this — trust temp</div></div>`;
  }
  void renderSystem().catch(() => {});
  setInterval(() => { renderSystem().catch(() => {}); }, 3000);

  // ── Transcripts (stretch, opt-in): the searchable voice log.
  const trRows = root.querySelector<HTMLElement>("#trRows")!;
  async function renderTranscripts(): Promise<void> {
    const rows = await fetch("/api/history?transcribed=1&limit=20")
      .then((r) => (r.ok ? r.json() : [])) as
      Array<{ ts: number; freq: number; alphaTag: string; transcript: string | null }>;
    trRows.innerHTML = rows.length
      ? rows.map((r) => `<li><span class="alertWhen">${new Date(r.ts).toLocaleTimeString()}</span>
          <span class="alertWhat"><b>${esc(r.alphaTag)}</b> ${esc(r.transcript ?? "")}</span></li>`).join("")
      : `<li class="hint">nothing transcribed yet — enable “Transcribe audio” in Scan tuning (takes effect at restart)</li>`;
  }
  void renderTranscripts().catch(() => {});
  setInterval(() => { renderTranscripts().catch(() => {}); }, 60_000);

  // Inline-editable CRUD table. One row at a time is editable: editingId is a
  // channel id, "new" (blank row pending creation), or null. Checkboxes on
  // display rows act immediately (PUT patch); text/mode edits go through
  // edit -> save / cancel, with Enter/Escape shortcuts.
  let channels: Channel[] = [];
  let banksCache: Bank[] = [];
  // Per-group add: the new-channel row renders inside this bank's section
  // and the saved channel carries the bank's first tag, so a channel added
  // "into Rail" actually matches Rail.
  let pendingTags: string[] = [];
  let pendingGroup: string | null = null;
  // Collapsed bank groups (persisted like the collapsible modules).
  const GROUPS_KEY = "kerchunk.admin.banksCollapsed";
  const collapsedBanks = new Set<string>(JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]"));
  let editingId: string | null = null;

  const MODES: Channel["mode"][] = ["nfm", "fm", "am"];

  function modeOptions(selected: string): string {
    return MODES.map((m) =>
      `<option value="${m}" ${m === selected ? "selected" : ""}>${m.toUpperCase()}</option>`).join("");
  }

  function profileSummary(b: Bank): string {
    const bits: string[] = [];
    if (b.dwellWeight !== undefined) bits.push(`dwell ×${b.dwellWeight}`);
    if (b.hangMs !== undefined) bits.push(`hang ${b.hangMs / 1000} s`);
    if (b.openAboveFloorDb !== undefined) bits.push(`open ${b.openAboveFloorDb} dB`);
    if (b.noiseQuietDb !== undefined) bits.push(`quiet ${b.noiseQuietDb} dB`);
    return bits.join(" · ");
  }

  function bankHeaderRow(g: BankGroup): string {
    if (!g.bank) {
      return `<tr class="bankRow" data-bank="unbanked">
        <td colspan="7"><span class="bkCaret">${collapsedBanks.has("unbanked") ? "▸" : "▾"}</span>
        <span class="bkName">UNBANKED</span> <span class="bankCount">${g.channels.length}</span>
        <span class="hint">matches no bank — tag these or add a bank that covers them</span></td>
      </tr>`;
    }
    const b = g.bank;
    const audibleCount = g.channels.filter((c) => c.enabled && c.audible !== false).length;
    const archivedCount = g.channels.filter((c) => !c.enabled).length;
    const summary = profileSummary(b);
    return `<tr class="bankRow" data-bank="${esc(b.id)}">
      <td colspan="7">
        <span class="bkCaret">${collapsedBanks.has(b.id) ? "▸" : "▾"}</span>
        <span class="bkName">${esc(b.name)}</span>
        <span class="bankCount">${g.channels.length}</span>
        <button class="bkBulkAudible" title="Make every channel in this collection audible">Make audible</button>
        <button class="bkBulkSilent" title="Keep tracking every channel but silence them">Make silent</button>
        <button class="bkBulkArchive" title="Stop tracking every channel in this collection">Archive</button>
        <span class="bkSummary">${audibleCount} audible · ${archivedCount} archived${summary ? ` · ${summary}` : ""}</span>
        ${iconBtn("bkGear", "gear", "Scan profile (squelch/dwell overrides)")}
        ${iconBtn("bkAddCh", "add", `Add a channel into ${esc(b.name)}`)}
        ${iconBtn("bkDel", "del", "Delete bank — its channels keep scanning")}
      </td>
    </tr>`;
  }

  // A channel can match several banks (they're predicates); its row lives
  // under the FIRST match, and these dim chips name the others.
  function membershipChips(c: Channel): string {
    const others = banksCache.filter((b) => matchesBank(c, b));
    if (others.length <= 1) return "";
    const home = others[0]!;
    return others.slice(1).map((b) =>
      `<span class="memChip" title="Also matches ${esc(b.name)} (home: ${esc(home.name)})">${esc(b.name)}</span>`).join("");
  }

  function displayRow(c: Channel): string {
    return `<tr data-id="${esc(c.id)}">
      <td class="rowOpen">${fmtFreq(c.freq)}</td>
      <td class="rowOpen">${esc(c.alphaTag)}${c.alert ? `<span class="bellChip" title="Alerts on a hit">${ICONS.bell}</span>` : ""}${membershipChips(c)}${locChip(c.location)}</td>
      <td class="rowOpen">${esc(c.mode.toUpperCase())}</td>
      <td><input type="checkbox" class="prio" ${c.priority ? "checked" : ""} /></td>
      <td><input type="checkbox" class="audible" ${c.audible !== false ? "checked" : ""} /></td>
      <td><input type="checkbox" class="archived" ${!c.enabled ? "checked" : ""} /></td>
      <td class="actions">${iconBtn("listen", "listen", "Listen — park the radio on this channel (unsquelched)")}${iconBtn("lock", "lockout", "Lockout — remove and never Close-Call this frequency again")}</td>
    </tr>`;
  }

  function editRow(c?: Channel): string {
    return `<tr data-id="${c ? esc(c.id) : "new"}" class="editing">
      <td><input class="fMhz" value="${c ? fmtFreq(c.freq) : ""}" placeholder="145.130" /></td>
      <td><input class="fTag" value="${c ? esc(c.alphaTag) : ""}" placeholder="KC0KW — Gibbs Rd" /></td>
      <td><select class="fMode">${modeOptions(c?.mode ?? "nfm")}</select></td>
      <td><input type="checkbox" class="fPrio" ${c?.priority ? "checked" : ""} /></td>
      <td><input type="checkbox" class="fAudible" ${c ? (c.audible !== false ? "checked" : "") : ""} /></td>
      <td><input type="checkbox" class="fArchived" ${c && !c.enabled ? "checked" : ""} /></td>
      <td class="actions">${iconBtn("save", "save", "Save")}${iconBtn("cancel", "cancel", "Cancel")}</td>
    </tr>`;
  }

  function renderRows(): void {
    const groups = groupChannelsByBank(channels, banksCache);
    // Where does the new-channel editor render? A per-group add (pendingGroup
    // set) renders inside ITS bank's group; the global + Add renders at the
    // very top (index 0). Either way the saved channel re-homes by its own
    // predicate match on the post-save refresh.
    const editorGroup = pendingGroup === null
      ? 0
      : Math.max(0, groups.findIndex((g) => (g.bank?.id ?? "unbanked") === pendingGroup));
    chRows.innerHTML =
      groups.map((g, i) => {
        const key = g.bank?.id ?? "unbanked";
        const body = collapsedBanks.has(key)
          ? ""
          : (editingId === "new" && i === editorGroup ? editRow() : "")
            + g.channels.map((c) => (editingId === c.id ? editRow(c) : displayRow(c))).join("");
        return bankHeaderRow(g) + body;
      }).join("") +
      (channels.length === 0 && editingId !== "new"
        ? `<tr><td colspan="7" class="empty">no channels — hit + Add</td></tr>` : "");
    addBtn.disabled = editingId !== null;
    wireRows();
    wireBankRows();
  }

  function rowPatch(tr: HTMLElement): Omit<Channel, "id"> {
    // formToChannel throws on a bad frequency — surfaced in chErr by saveRow.
    // priority/enabled are set explicitly: a PUT patch needs `priority: false`
    // (not an absent key) to UNSET the flag on an existing channel.
    const base = formToChannel({
      mhz: tr.querySelector<HTMLInputElement>(".fMhz")!.value,
      alphaTag: tr.querySelector<HTMLInputElement>(".fTag")!.value,
      mode: tr.querySelector<HTMLSelectElement>(".fMode")!.value,
    });
    return {
      ...base,
      priority: tr.querySelector<HTMLInputElement>(".fPrio")!.checked,
      audible: tr.querySelector<HTMLInputElement>(".fAudible")!.checked,
      enabled: !tr.querySelector<HTMLInputElement>(".fArchived")!.checked,
      ...(tr.dataset.id === "new" && pendingTags.length ? { tags: pendingTags } : {}),
    };
  }

  async function saveRow(tr: HTMLElement): Promise<void> {
    chErr.textContent = "";
    try {
      const payload = rowPatch(tr);
      if (tr.dataset.id === "new") await api.addChannel(payload);
      else await api.updateChannel(tr.dataset.id!, payload);
      editingId = null;
      pendingTags = [];
      pendingGroup = null;
      await refresh();
    } catch (e) { chErr.textContent = (e as Error).message; }
  }

  function wireRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr").forEach((tr) => {
      const id = tr.dataset.id;
      if (!id) return;
      tr.querySelectorAll<HTMLElement>(".rowOpen").forEach((cell) =>
        cell.addEventListener("click", () => openDrawer("channel", id)));
      tr.querySelector<HTMLButtonElement>(".listen")?.addEventListener("click", () => {
        const c = channels.find((x) => x.id === id);
        if (c) api.monitor(c.freq, c.alphaTag || fmtFreq(c.freq));
      });
      tr.querySelector<HTMLButtonElement>(".lock")?.addEventListener("click", () => {
        const c = channels.find((x) => x.id === id);
        if (c) void lockoutFreq(c.freq, c.alphaTag || fmtFreq(c.freq));
      });
      tr.querySelector<HTMLInputElement>(".prio")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { priority: (ev.target as HTMLInputElement).checked });
        await refresh();
      });
      tr.querySelector<HTMLInputElement>(".audible")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { audible: (ev.target as HTMLInputElement).checked });
        await refresh();
      });
      tr.querySelector<HTMLInputElement>(".archived")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { enabled: !(ev.target as HTMLInputElement).checked });
        await refresh();
      });
      tr.querySelector<HTMLButtonElement>(".save")?.addEventListener("click", () => saveRow(tr));
      tr.querySelector<HTMLButtonElement>(".cancel")?.addEventListener("click", () => {
        editingId = null; pendingTags = []; pendingGroup = null; chErr.textContent = ""; renderRows();
      });
      if (tr.classList.contains("editing")) {
        tr.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); saveRow(tr); }
          if (ev.key === "Escape") { editingId = null; pendingTags = []; pendingGroup = null; chErr.textContent = ""; renderRows(); }
        });
      }
    });
  }

  function wireBankRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr.bankRow").forEach((tr) => {
      const id = tr.dataset.bank!;
      tr.querySelector<HTMLElement>(".bkCaret")?.addEventListener("click", () => {
        if (collapsedBanks.has(id)) collapsedBanks.delete(id);
        else collapsedBanks.add(id);
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...collapsedBanks]));
        renderRows();
      });
      if (id === "unbanked") return;
      const bulk = async (patch: Partial<Pick<Channel, "enabled" | "audible">>) => {
        const cfg = await api.getConfig();
        const bank = (cfg.banks ?? []).find((x) => x.id === id);
        if (!bank) return;
        cfg.channels = cfg.channels.map((c) => matchesBank(c, bank) ? { ...c, ...patch } : c);
        await api.putConfig(cfg);
        await refresh();
      };
      tr.querySelector<HTMLButtonElement>(".bkBulkAudible")?.addEventListener("click", () => bulk({ enabled: true, audible: true }));
      tr.querySelector<HTMLButtonElement>(".bkBulkSilent")?.addEventListener("click", () => bulk({ enabled: true, audible: false }));
      tr.querySelector<HTMLButtonElement>(".bkBulkArchive")?.addEventListener("click", async () => {
        const b = banksCache.find((x) => x.id === id);
        if (!b || !await confirmAdminAction({
          title: `Archive every channel in ${b.name}?`,
          message: "Archived channels stop consuming scanner capacity but keep their identity and location.",
          confirmLabel: "Archive channels",
        })) return;
        await bulk({ enabled: false });
      });
      tr.querySelector<HTMLButtonElement>(".bkGear")?.addEventListener("click", () =>
        openProfileEditor(banksCache.find((x) => x.id === id)));
      tr.querySelector<HTMLButtonElement>(".bkAddCh")?.addEventListener("click", () => {
        const b = banksCache.find((x) => x.id === id);
        pendingTags = b?.tags?.length ? [b.tags[0]!] : [];
        pendingGroup = id;
        editingId = "new";
        collapsedBanks.delete(id);
        renderRows();
      });
      tr.querySelector<HTMLButtonElement>(".bkDel")?.addEventListener("click", async () => {
        const b = banksCache.find((x) => x.id === id);
        if (!b || !await confirmAdminAction({
          title: `Delete bank ${b.name}?`,
          message: "Its channels will remain in the library and keep scanning.",
          confirmLabel: "Delete bank",
          danger: true,
        })) return;
        const cfg = await api.getConfig();
        cfg.banks = (cfg.banks ?? []).filter((x) => x.id !== id);
        await api.putConfig(cfg);
        await refresh();
      });
    });
  }

  function tr0Focus(): void {
    chRows.querySelector<HTMLInputElement>("tr.editing .fMhz")?.focus();
  }

  const chCount = root.querySelector<HTMLElement>("#chCount")!;
  // ── Channel drawer: full dossier + the editor (edit left the table rows).
  const drawer = root.querySelector<HTMLElement>("#chDrawer")!;
  const scrim = root.querySelector<HTMLElement>("#drawerScrim")!;
  let drawerId: string | null = null;
  let drawerKind: "channel" | "discovery" = "channel";

  function closeDrawer(): void {
    drawerId = null;
    drawer.classList.remove("open");
    scrim.classList.remove("open");
  }

  function openDrawer(kind: "channel" | "discovery", id: string): void {
    drawerKind = kind;
    drawerId = id;
    renderDrawer();
    drawer.classList.add("open");
    scrim.classList.add("open");
  }

  function renderDrawer(): void {
    if (drawerKind === "discovery") { renderDiscoveryDrawer(); return; }
    const c = channels.find((x) => x.id === drawerId);
    if (!c) { closeDrawer(); return; }
    const loc = c.location;
    drawer.innerHTML = `
      <header class="dwHead">
        <h3>${esc(c.alphaTag) || fmtFreq(c.freq)}</h3>
        ${iconBtn("dwClose", "dismiss", "Close")}
      </header>
      <div class="dwFreq">${fmtFreq(c.freq)}<span class="dwUnit">MHz</span></div>
      <div class="dwForm">
        <label>Freq (MHz) <input id="dwMhz" value="${fmtFreq(c.freq)}" /></label>
        <label>Name <input id="dwTag" value="${esc(c.alphaTag)}" /></label>
        <label>Mode <select id="dwMode">${modeOptions(c.mode)}</select></label>
        <label>Tags <input id="dwTags" value="${esc((c.tags ?? []).join(", "))}" placeholder="air, rail, ham" /></label>
        <label>Site lat, lon <input id="dwLoc" value="${c.location?.lat != null ? `${c.location.lat}, ${c.location.lon}` : ""}" placeholder="39.1755, -94.4861" title="Transmitter site — drives the map blip" /></label>
        <label><input id="dwPrio" type="checkbox" ${c.priority ? "checked" : ""} /> Priority</label>
        <label title="A hit flashes the kiosk, lands in the alert feed, and temporarily plays a silent tracked channel through the speaker. The channel must not be archived."><input id="dwAlert" type="checkbox" ${c.alert ? "checked" : ""} /> Alert on hit</label>
        <label><input id="dwAudible" type="checkbox" ${c.audible !== false ? "checked" : ""} /> Audible</label>
        <label title="Archived channels keep their identity and location but stop consuming scanner capacity."><input id="dwArchived" type="checkbox" ${!c.enabled ? "checked" : ""} /> Archived</label>
        <div><button id="dwSave" class="save">Save</button> <span id="dwErr" class="err"></span></div>
      </div>
      <dl class="dwInfo">
        <dt>band</dt><dd>${bandFor(c.freq).toUpperCase()}</dd>
        <dt>exact</dt><dd>${c.freq.toLocaleString()} Hz</dd>
        <dt>location</dt><dd>${loc
          ? `${esc([loc.city, loc.state].filter(Boolean).join(", ") || "—")}${loc.lat != null ? ` · ${loc.lat}, ${loc.lon}` : ""} <span class="dwVia">via ${esc(loc.source)}</span>`
          : "not identified"}</dd>
        <dt>power</dt><dd>${c.location?.powerWatts
          ? `${c.location.powerWatts} W${c.location.antennaHaatM ? ` @ ${c.location.antennaHaatM} m` : ""} <span class="dwVia">${c.location.powerEstimated ? "RF estimate" : "FCC license"}</span>`
          : c.rfDb != null ? `<span class="dwVia">measured ${c.rfDb} dB — awaiting estimate</span>` : "—"}</dd>
        <dt>level trim</dt><dd>${c.levelTrimDb != null ? `${c.levelTrimDb > 0 ? "+" : ""}${c.levelTrimDb} dB` : "learning"}</dd>
        <dt>looked up</dt><dd>${c.lookedUpAt ? new Date(c.lookedUpAt).toLocaleString() : "never"}</dd>
        <dt>id</dt><dd>${esc(c.id)}</dd>
      </dl>
      <div class="dwActions">
        <button id="dwListen" class="listen">Listen</button>
        <button id="dwLock" class="lock">Lockout</button>
      </div>`;
    drawer.querySelector<HTMLButtonElement>(".dwClose")!.addEventListener("click", closeDrawer);
    drawer.querySelector<HTMLButtonElement>("#dwSave")!.addEventListener("click", async () => {
      const err = drawer.querySelector<HTMLElement>("#dwErr")!;
      err.textContent = "";
      try {
        const base = formToChannel({
          mhz: drawer.querySelector<HTMLInputElement>("#dwMhz")!.value,
          alphaTag: drawer.querySelector<HTMLInputElement>("#dwTag")!.value,
          mode: drawer.querySelector<HTMLSelectElement>("#dwMode")!.value,
        });
        const locRaw = drawer.querySelector<HTMLInputElement>("#dwLoc")!.value.trim();
        let location = c.location;
        if (locRaw === "") {
          location = undefined;
        } else {
          const m = locRaw.split(",").map((x) => Number(x.trim()));
          if (m.length === 2 && m.every(Number.isFinite)) {
            location = { ...(c.location ?? {}), lat: m[0]!, lon: m[1]!, source: "operator" };
          } else {
            throw new Error("site must be 'lat, lon'");
          }
        }
        await api.updateChannel(c.id, {
          location,
          ...base,
          tags: drawer.querySelector<HTMLInputElement>("#dwTags")!.value
            .split(",").map((t) => t.trim()).filter(Boolean),
          priority: drawer.querySelector<HTMLInputElement>("#dwPrio")!.checked,
          alert: drawer.querySelector<HTMLInputElement>("#dwAlert")!.checked,
          enabled: !drawer.querySelector<HTMLInputElement>("#dwArchived")!.checked,
          audible: drawer.querySelector<HTMLInputElement>("#dwAudible")!.checked,
        });
        await refresh();
        err.textContent = "saved";
      } catch (e) { err.textContent = (e as Error).message; }
    });
    drawer.querySelector<HTMLButtonElement>("#dwListen")!.addEventListener("click", () =>
      api.monitor(c.freq, c.alphaTag || fmtFreq(c.freq)));
    drawer.querySelector<HTMLButtonElement>("#dwLock")!.addEventListener("click", async () => {
      await lockoutFreq(c.freq, c.alphaTag || fmtFreq(c.freq));
      closeDrawer();
    });
  }

  function renderDiscoveryDrawer(): void {
    const d = discoveries.find((x) => x.id === drawerId);
    if (!d) { closeDrawer(); return; }
    const loc = d.location;
    const digital = d.mode && DIGITAL.some((x) => d.mode!.toUpperCase().includes(x));
    drawer.innerHTML = `
      <header class="dwHead">
        <h3>${esc(d.alphaTag)}</h3>
        ${iconBtn("dwClose", "dismiss", "Close")}
      </header>
      <div class="dwFreq">${fmtFreq(d.freq)}<span class="dwUnit">MHz</span></div>
      <dl class="dwInfo">
        <dt>mode</dt><dd${digital ? ' class="dwDigital"' : ""}>${d.mode ? esc(d.mode.toUpperCase()) : "not identified"}${digital ? " · digital — not decodable here" : ""}</dd>
        <dt>exact</dt><dd>${d.freq.toLocaleString()} Hz</dd>
        <dt>found</dt><dd>${new Date(d.ts).toLocaleString()}</dd>
        <dt>location</dt><dd>${loc
          ? `${esc([loc.city, loc.state].filter(Boolean).join(", ") || "—")}${loc.lat != null ? ` · ${loc.lat}, ${loc.lon}` : ""} <span class="dwVia">via ${esc(loc.source)}</span>`
          : "not identified"}</dd>
        <dt>looked up</dt><dd>${d.lookedUpAt ? new Date(d.lookedUpAt).toLocaleString() : "pending"}</dd>
        <dt>id</dt><dd>${esc(d.id)}</dd>
      </dl>
      <div class="dwActions">
        <button id="dwListen" class="listen">Listen</button>
        <button id="dwAdd" class="dAdd">Add</button>
        <button id="dwLock" class="lock">Lockout</button>
        <button id="dwDismiss" class="dDismiss">Dismiss</button>
      </div>`;
    drawer.querySelector<HTMLButtonElement>(".dwClose")!.addEventListener("click", closeDrawer);
    drawer.querySelector<HTMLButtonElement>("#dwListen")!.addEventListener("click", () =>
      api.monitor(d.freq, d.alphaTag));
    drawer.querySelector<HTMLButtonElement>("#dwAdd")!.addEventListener("click", async () => {
      await mutateDiscovery(d.id, promoteDiscovery);
      closeDrawer();
    });
    drawer.querySelector<HTMLButtonElement>("#dwLock")!.addEventListener("click", async () => {
      await lockoutFreq(d.freq, d.alphaTag);
      closeDrawer();
    });
    drawer.querySelector<HTMLButtonElement>("#dwDismiss")!.addEventListener("click", async () => {
      await mutateDiscovery(d.id, () => {});
      closeDrawer();
    });
  }

  scrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && drawerId) closeDrawer();
  });

  async function refresh(): Promise<void> {
    const [chs, cfg] = await Promise.all([api.getChannels(), api.getConfig()]);
    channels = chs;
    banksCache = cfg.banks ?? [];
    chCount.textContent = String(channels.length);
    renderRows();
    if (drawerId) renderDrawer(); // keep an open dossier fresh after saves
  }

  const dcRows = root.querySelector<HTMLElement>("#dcRows")!;
  const dcAll = root.querySelector<HTMLInputElement>("#dcAll")!;
  const dcDismissSel = root.querySelector<HTMLButtonElement>("#dcDismissSel")!;
  const dcLockSel = root.querySelector<HTMLButtonElement>("#dcLockSel")!;
  const dcSelCount = root.querySelector<HTMLElement>("#dcSelCount")!;
  // Selection survives the 15 s auto-refresh (a triage session shouldn't
  // lose its checkmarks because a new discovery arrived).
  const dcSelected = new Set<string>();
  type Discovery = NonNullable<Awaited<ReturnType<typeof api.getConfig>>["discoveries"]>[number];
  let discoveries: Discovery[] = [];

  async function mutateDiscovery(id: string, fn: (cfg2: Awaited<ReturnType<typeof api.getConfig>>, d: Discovery) => void): Promise<void> {
    const cfg2 = await api.getConfig();
    const d = (cfg2.discoveries ?? []).find((x) => x.id === id);
    if (!d) return;
    cfg2.discoveries = (cfg2.discoveries ?? []).filter((x) => x.id !== id);
    fn(cfg2, d);
    await api.putConfig(cfg2);
    await refresh();
    renderDiscoveries();
    renderLockouts();
  }

  function promoteDiscovery(cfg2: Awaited<ReturnType<typeof api.getConfig>>, d: Discovery): void {
    // Map the identified modulation onto our demod modes; digital and
    // unknown fall back to nfm (all we can demodulate).
    const m = (d.mode ?? "").toUpperCase();
    const mode = m === "FM" ? "fm" as const : m === "AM" ? "am" as const : "nfm" as const;
    cfg2.channels.push({
      id: `ch_${d.id.replace(/^cc_/, "")}`, freq: d.freq, alphaTag: d.alphaTag,
      mode, enabled: true, audible: false,
      // A promoted discovery is tracked and mapped, but audibility is always
      // an explicit operator choice.
      ...(d.location ? { location: d.location, lookedUpAt: Date.now() } : {}),
    });
  }

  function paintDcToolbar(): void {
    dcDismissSel.disabled = dcSelected.size === 0;
    dcLockSel.disabled = dcSelected.size === 0;
    dcSelCount.textContent = dcSelected.size > 0 ? `${dcSelected.size} selected` : "";
  }

  async function renderDiscoveries(): Promise<void> {
    const cfg = await api.getConfig();
    syncAudioControls(cfg); // one poll feeds both (was a separate 5s loop)
    const ds = [...(cfg.discoveries ?? [])].sort((a, b) => b.ts - a.ts);
    discoveries = ds;
    root.querySelector<HTMLElement>("#dcCount")!.textContent = String(ds.length);
    const present = new Set(ds.map((d) => d.id));
    for (const id of dcSelected) if (!present.has(id)) dcSelected.delete(id);
    dcRows.innerHTML = ds.length === 0
      ? `<tr><td colspan="5" class="empty">nothing pending — Close Call is hunting</td></tr>`
      : ds.map((d) => `<tr data-id="${esc(d.id)}" class="dcRow">
          <td><input type="checkbox" class="dSel" ${dcSelected.has(d.id) ? "checked" : ""} /></td>
          <td class="rowOpen">${fmtFreq(d.freq)}<span class="dcSvc${serviceFor(d.freq) ? "" : " outband"}">${esc(serviceFor(d.freq) ?? "OUTBAND")}</span></td>
          <td class="rowOpen">${esc(d.alphaTag)}${d.audible === false ? '<span class="dcSee" title="Identified as data/paging — filed seen-not-heard; promotes as SEE">SEE</span>' : d.audible === true ? '<span class="dcHear" title="Identified as analog voice — hearable">HEAR</span>' : ""}${locChip(d.location)}</td>
          <td class="rowOpen dMode${d.mode && DIGITAL.some((x) => d.mode!.toUpperCase().includes(x)) ? " digital" : ""}">${d.mode ? esc(d.mode.toUpperCase()) : "—"}</td>
          <td class="actions">${iconBtn("dListen", "listen", "Listen — audition this discovery")}${iconBtn("dAdd", "add", "Add as an enabled channel")}${iconBtn("dLock", "lockout", "Lockout — never Close-Call this frequency again")}${iconBtn("dDismiss", "dismiss", "Dismiss (may be rediscovered later)")}</td>
        </tr>`).join("");
    dcAll.checked = ds.length > 0 && dcSelected.size === ds.length;
    paintDcToolbar();
    dcRows.querySelectorAll<HTMLElement>(".rowOpen").forEach((cell) => {
      const id = (cell.closest("tr") as HTMLElement).dataset.id!;
      cell.addEventListener("click", () => openDrawer("discovery", id));
    });
    if (drawerId && drawerKind === "discovery") renderDrawer();
    dcRows.querySelectorAll<HTMLInputElement>(".dSel").forEach((cb) => {
      const id = (cb.closest("tr") as HTMLElement).dataset.id!;
      cb.addEventListener("change", () => {
        if (cb.checked) dcSelected.add(id); else dcSelected.delete(id);
        dcAll.checked = dcSelected.size === present.size && present.size > 0;
        paintDcToolbar();
      });
    });

    dcRows.querySelectorAll<HTMLButtonElement>("tr [class^=d]").forEach((b) => {
      const id = (b.closest("tr") as HTMLElement).dataset.id!;
      if (b.classList.contains("dListen")) b.addEventListener("click", async () => {
        const cfg2 = await api.getConfig();
        const d = (cfg2.discoveries ?? []).find((x) => x.id === id);
        if (d) api.monitor(d.freq, d.alphaTag);
      });
      if (b.classList.contains("dAdd")) b.addEventListener("click", () =>
        mutateDiscovery(id, promoteDiscovery));
      if (b.classList.contains("dLock")) b.addEventListener("click", () =>
        mutateDiscovery(id, (cfg2, d) => {
          cfg2.scan.lockoutHz = [...new Set([...(cfg2.scan.lockoutHz ?? []), d.freq])];
        }));
      if (b.classList.contains("dDismiss")) b.addEventListener("click", () => mutateDiscovery(id, () => {}));
    });
  }
  dcAll.addEventListener("change", async () => {
    const cfg = await api.getConfig();
    dcSelected.clear();
    if (dcAll.checked) for (const d of cfg.discoveries ?? []) dcSelected.add(d.id);
    renderDiscoveries();
  });

  async function bulkDiscoveries(lockout: boolean): Promise<void> {
    const n = dcSelected.size;
    if (n === 0) return;
    const verb = lockout ? "Lock out" : "Dismiss";
    if (!await confirmAdminAction({
      title: `${verb} ${n} ${n === 1 ? "discovery" : "discoveries"}?`,
      message: lockout
        ? "These frequencies will be permanently prevented from triggering Close Call."
        : "Dismissed frequencies may be discovered again later.",
      confirmLabel: lockout ? "Lock out permanently" : "Dismiss",
      danger: lockout,
    })) return;
    const cfg = await api.getConfig();
    const doomed = (cfg.discoveries ?? []).filter((d) => dcSelected.has(d.id));
    cfg.discoveries = (cfg.discoveries ?? []).filter((d) => !dcSelected.has(d.id));
    if (lockout) {
      cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), ...doomed.map((d) => d.freq)])];
    }
    dcSelected.clear();
    await api.putConfig(cfg);
    renderDiscoveries();
    renderLockouts();
  }
  dcDismissSel.addEventListener("click", () => bulkDiscoveries(false));
  dcLockSel.addEventListener("click", () => bulkDiscoveries(true));

  renderDiscoveries();
  setInterval(() => { renderDiscoveries().catch(() => {}); }, 15000);

  const loList = root.querySelector<HTMLElement>("#loList")!;
  async function renderLockouts(): Promise<void> {
    const cfg = await api.getConfig();
    const lo = cfg.scan.lockoutHz ?? [];
    loList.innerHTML = lo.length === 0
      ? `<li class="empty">none</li>`
      : lo.map((f) => `<li>${fmtFreq(f)} ${iconBtn("unlock", "unlock", "Remove lockout", `data-hz="${f}"`)}</li>`).join("");
    loList.querySelectorAll<HTMLButtonElement>(".unlock").forEach((b) =>
      b.addEventListener("click", async () => {
        const cfg2 = await api.getConfig();
        cfg2.scan.lockoutHz = (cfg2.scan.lockoutHz ?? []).filter((f) => f !== Number(b.dataset.hz));
        await api.putConfig(cfg2);
        renderLockouts();
      }));
  }
  renderLockouts();

  addBtn.addEventListener("click", () => {
    pendingTags = []; pendingGroup = null; editingId = "new"; chErr.textContent = ""; renderRows(); tr0Focus();
  });

  // ---- Now Playing card ----
  // Live speaker ownership over the same WS feed the dashboard uses (the hub
  // replays the current audible channel on connect). Lockout buttons act on
  // whatever is playing right now.
  const npName = root.querySelector<HTMLElement>("#npName")!;
  const npFreq = root.querySelector<HTMLElement>("#npFreq")!;
  const tlockBtn = root.querySelector<HTMLButtonElement>("#tlockBtn")!;
  const lockBtn = root.querySelector<HTMLButtonElement>("#lockBtn")!;
  let nowPlaying: { freq: number; alphaTag: string } | null = null;
  let npAudibleDriven = false;
  let currentMode: "scan" | "weather" | "monitor" = "scan";
  let weatherChannel: Channel | null = null;

  const resumeBtn = root.querySelector<HTMLButtonElement>("#resumeBtn")!;
  const weatherBtn = root.querySelector<HTMLButtonElement>("#weatherBtn")!;
  let monitoring: { freq: number; alphaTag: string } | null = null;

  function paintNow(): void {
    if (monitoring) {
      npName.textContent = `MONITORING ${monitoring.alphaTag || fmtFreq(monitoring.freq)}`;
      npFreq.textContent = fmtFreq(monitoring.freq);
    } else if (currentMode === "weather") {
      npName.textContent = `WEATHER ONLY · ${weatherChannel?.alphaTag || "NOAA weather"}`;
      npFreq.textContent = weatherChannel ? fmtFreq(weatherChannel.freq) : "";
    } else {
      npName.textContent = nowPlaying ? (nowPlaying.alphaTag || fmtFreq(nowPlaying.freq)) : "scanning…";
      npFreq.textContent = nowPlaying ? fmtFreq(nowPlaying.freq) : "";
    }
    resumeBtn.style.display = monitoring ? "" : "none";
    weatherBtn.textContent = currentMode === "weather" ? "Resume scanning" : "Listen to weather";
    weatherBtn.disabled = currentMode !== "weather" && weatherChannel === null;
    // Both act on the live audible channel: no target (or monitoring,
    // where lockout-of-what-you-chose makes no sense) disables both.
    tlockBtn.disabled = monitoring !== null || nowPlaying === null;
    lockBtn.disabled = monitoring !== null || nowPlaying === null;
  }

  async function syncMode(): Promise<void> {
    try {
      const st = await api.getStatus();
      currentMode = st.mode;
      monitoring = st.mode === "monitor" && st.monitor
        ? { freq: st.monitor.freq, alphaTag: st.monitor.alphaTag } : null;
      paintNow();
    } catch { /* transient */ }
  }
  resumeBtn.addEventListener("click", async () => { await api.monitorStop(); syncMode(); });
  weatherBtn.addEventListener("click", async () => {
    await api.setMode(currentMode === "weather" ? "scan" : "weather");
    await syncMode();
  });

  function onEngineEvent(ev: EngineEvent): void {
    if (ev.type === "alert") {
      void renderAlertFeed().catch(() => {});
      return;
    }
    if (ev.type === "audible") {
      npAudibleDriven = true;
      nowPlaying = ev.channel ? { freq: ev.channel.freq, alphaTag: ev.channel.alphaTag } : null;
    } else if (ev.type === "active" && !npAudibleDriven) {
      nowPlaying = { freq: ev.freq, alphaTag: ev.channel.alphaTag };
    } else if (ev.type === "idle" && !npAudibleDriven) {
      nowPlaying = null;
    } else if (ev.type === "status") {
      nowPlaying = null;
      npAudibleDriven = false;
      // Mode may have flipped (Listen / Resume / weather): re-sync the card.
      void syncMode();
    } else {
      return;
    }
    paintNow();
  }
  const wsProto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${wsProto}://${location.host}/ws`, onEngineEvent).connect();
  api.getWeatherChannel().then((r) => { weatherChannel = r.weatherChannel; paintNow(); }).catch(() => {});
  syncMode();
  paintNow();

  // Remote listening: an <audio> on the endless-WAV stream. Recreated per
  // press — reusing a stalled stream element resumes seconds in the past.
  let streamEl: HTMLAudioElement | null = null;
  const streamBtn = root.querySelector<HTMLButtonElement>("#streamBtn")!;
  streamBtn.addEventListener("click", () => {
    if (streamEl) {
      streamEl.pause(); streamEl.src = ""; streamEl = null;
      streamBtn.textContent = "▶ Listen here";
      return;
    }
    streamEl = new Audio(`/api/stream.wav?t=${Date.now()}`);
    void streamEl.play().catch(() => { streamEl = null; });
    streamBtn.textContent = "⏹ Stop listening";
  });
  const systemActionStatus = root.querySelector<HTMLElement>("#systemActionStatus")!;
  root.querySelector<HTMLButtonElement>("#kioskReload")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    systemActionStatus.textContent = "Refreshing kiosk screen…";
    try {
      await api.reloadKiosk();
      systemActionStatus.textContent = "Refresh sent";
    } catch (e) {
      systemActionStatus.textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector<HTMLButtonElement>("#backendRestart")!.addEventListener("click", async () => {
    const confirmed = await confirmAdminAction({
      title: "Restart radio backend?",
      message: "Audio and scanning will stop briefly while the backend and radio helpers restart.",
      confirmLabel: "Restart backend",
      danger: true,
    });
    if (!confirmed) return;
    systemActionStatus.textContent = "Restarting backend…";
    try {
      await api.restartBackend();
    } catch (e) {
      systemActionStatus.textContent = (e as Error).message;
    }
  });
  tlockBtn.addEventListener("click", () => api.skip(1800));
  lockBtn.addEventListener("click", () => {
    if (!nowPlaying) return;
    void lockoutFreq(nowPlaying.freq, nowPlaying.alphaTag || fmtFreq(nowPlaying.freq));
  });

  // Volume/mute stay in sync with the server (another admin tab, a stale
  // page across service restarts): poll lightly and update the controls —
  // but never while the operator is actively holding the slider.
  function syncAudioControls(cfg: { audio: { volume: number; muted: boolean } }): void {
    if (document.activeElement !== vol) vol.value = String(cfg.audio.volume);
    if (document.activeElement !== mute) mute.checked = cfg.audio.muted;
  }
  api.getConfig().then(syncAudioControls);
  vol.addEventListener("change", () => { api.setVolume(Number(vol.value)); vol.blur(); });
  mute.addEventListener("change", () => api.setMuted(mute.checked));
  root.querySelector<HTMLButtonElement>("#skipBtn")!.addEventListener("click", () => api.skip());

  // Scan tuning knobs — optional config fields; empty input = engine default
  // (shown as the placeholder). Saved via whole-config PUT, which restarts
  // the engine so changes take effect immediately.
  const tGroupDwell = root.querySelector<HTMLInputElement>("#tGroupDwell")!;
  const tHang = root.querySelector<HTMLInputElement>("#tHang")!;
  const tOpenDb = root.querySelector<HTMLInputElement>("#tOpenDb")!;
  const tQuietDb = root.querySelector<HTMLInputElement>("#tQuietDb")!;
  const tMapsKey = root.querySelector<HTMLInputElement>("#tMapsKey")!;
  const tMapsMapId = root.querySelector<HTMLInputElement>("#tMapsMapId")!;
  const tAlertCool = root.querySelector<HTMLInputElement>("#tAlertCool")!;
  const tAlertHold = root.querySelector<HTMLInputElement>("#tAlertHold")!;
  const tAlertNtfy = root.querySelector<HTMLInputElement>("#tAlertNtfy")!;
  const tSameFips = root.querySelector<HTMLInputElement>("#tSameFips")!;
  const tSameTests = root.querySelector<HTMLInputElement>("#tSameTests")!;
  const tTranscribe = root.querySelector<HTMLInputElement>("#tTranscribe")!;
  const tCloseCall = root.querySelector<HTMLInputElement>("#tCloseCall")!;
  const tCloseCallDb = root.querySelector<HTMLInputElement>("#tCloseCallDb")!;
  const tSweep = root.querySelector<HTMLInputElement>("#tSweep")!;
  const tErr = root.querySelector<HTMLElement>("#tErr")!;

  api.getConfig().then((cfg) => {
    tGroupDwell.value = cfg.scan.groupDwellMs != null ? String(cfg.scan.groupDwellMs) : "";
    tHang.value = String(cfg.scan.dwellMs);
    tOpenDb.value = cfg.scan.openAboveFloorDb != null ? String(cfg.scan.openAboveFloorDb) : "";
    tQuietDb.value = cfg.scan.noiseQuietDb != null ? String(cfg.scan.noiseQuietDb) : "";
    tMapsKey.value = cfg.display?.googleMapsApiKey ?? "";
    tMapsMapId.value = cfg.display?.googleMapsMapId ?? "";
    tAlertCool.value = cfg.alerts?.cooldownMinutes != null ? String(cfg.alerts.cooldownMinutes) : "";
    tAlertHold.value = cfg.alerts?.holdSeconds != null ? String(cfg.alerts.holdSeconds) : "";
    tAlertNtfy.value = cfg.alerts?.ntfyUrl ?? "";
    tSameFips.value = (cfg.alerts?.sameFips ?? []).join(", ");
    tSameTests.checked = cfg.alerts?.sameTests ?? false;
    tTranscribe.checked = cfg.transcribe ?? false;
    tCloseCall.checked = cfg.scan.closeCall ?? true;   // engine default: ON
    tCloseCallDb.value = cfg.scan.closeCallDb != null ? String(cfg.scan.closeCallDb) : "";
    tSweep.value = (cfg.scan.sweepRanges ?? [])
      .map((r) => `${r.loHz / 1e6}-${r.hiHz / 1e6}`).join(", ");
  });

  root.querySelector<HTMLButtonElement>("#tSave")!.addEventListener("click", async () => {
    tErr.textContent = "";
    try {
      const cfg = await api.getConfig();
      const num = (el: HTMLInputElement): number | undefined =>
        el.value.trim() === "" ? undefined : Number(el.value);
      cfg.scan.groupDwellMs = num(tGroupDwell);
      cfg.scan.openAboveFloorDb = num(tOpenDb);
      cfg.scan.noiseQuietDb = num(tQuietDb);
      cfg.scan.closeCall = tCloseCall.checked;
      cfg.scan.closeCallDb = num(tCloseCallDb);
      const sweeps = tSweep.value.split(",").map((x) => x.trim()).filter(Boolean)
        .map((x) => {
          const m = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(x);
          if (!m) throw new Error(`sweep range "${x}" must be lo-hi in MHz`);
          return { loHz: Math.round(Number(m[1]) * 1e6), hiHz: Math.round(Number(m[2]) * 1e6) };
        });
      if (sweeps.length) cfg.scan.sweepRanges = sweeps;
      else delete cfg.scan.sweepRanges;
      if (tMapsKey.value.trim() && cfg.display) cfg.display.googleMapsApiKey = tMapsKey.value.trim();
      if (cfg.display) {
        // Clearable: an emptied field drops back to the raster map.
        const mapId = tMapsMapId.value.trim();
        if (mapId) cfg.display.googleMapsMapId = mapId;
        else delete cfg.display.googleMapsMapId;
      }
      // Alert knobs: empty fields fall back to defaults (15 min / 30 s).
      const ntfy = tAlertNtfy.value.trim();
      const fips = tSameFips.value.split(",").map((x) => x.trim()).filter(Boolean);
      const alerts = {
        ...(num(tAlertCool) !== undefined ? { cooldownMinutes: num(tAlertCool) } : {}),
        ...(num(tAlertHold) !== undefined ? { holdSeconds: num(tAlertHold) } : {}),
        ...(ntfy ? { ntfyUrl: ntfy } : {}),
        ...(fips.length ? { sameFips: fips } : {}),
        ...(tSameTests.checked ? { sameTests: true } : {}),
      };
      if (Object.keys(alerts).length) cfg.alerts = alerts;
      else delete cfg.alerts;
      if (tTranscribe.checked) cfg.transcribe = true;
      else delete cfg.transcribe;
      const hang = num(tHang);
      if (hang !== undefined) cfg.scan.dwellMs = hang;
      await api.putConfig(cfg);
      tErr.textContent = "saved";
    } catch (e) { tErr.textContent = (e as Error).message; }
  });

  refresh().catch((e) => { chErr.textContent = (e as Error).message; });

  const wxFreq = root.querySelector<HTMLSelectElement>("#wxFreq")!;
  const wxTag = root.querySelector<HTMLInputElement>("#wxTag")!;
  const wxMode = root.querySelector<HTMLSelectElement>("#wxMode")!;
  const wxSave = root.querySelector<HTMLButtonElement>("#wxSave")!;
  const wxErr = root.querySelector<HTMLElement>("#wxErr")!;
  api.getWeatherChannel().then(({ weatherChannel }) => {
    if (weatherChannel) {
      wxFreq.value = (weatherChannel.freq / 1e6).toFixed(3);
      wxTag.value = weatherChannel.alphaTag;
      wxMode.value = weatherChannel.mode;
    }
  }).catch(() => {});

  wxSave.addEventListener("click", async () => {
    wxErr.textContent = "";
    try {
      const saved = await api.setWeatherChannel(weatherFormToChannel({ mhz: wxFreq.value, alphaTag: wxTag.value, mode: wxMode.value }));
      weatherChannel = saved.weatherChannel;
      paintNow();
    } catch (e) {
      wxErr.textContent = (e as Error).message;
    }
  });
}
