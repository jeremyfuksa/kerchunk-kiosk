import type { Channel, Config } from "../../backend/config/schema.js";
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

declare const google: any;
let mapsReady: Promise<boolean> | null = null;
async function loadAdminMaps(): Promise<boolean> {
  if (typeof google !== "undefined" && google.maps) return true;
  if (mapsReady) return mapsReady;
  mapsReady = api.getConfig().then((cfg) => new Promise<boolean>((resolve) => {
    const key = cfg.display?.googleMapsApiKey;
    if (!key) { resolve(false); return; }
    const s = document.createElement("script");
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&v=weekly`;
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.head.appendChild(s);
  }));
  return mapsReady;
}

/** Parse a persisted JSON string-set (collapse state) defensively. localStorage
 *  outlives app versions and can hold junk — and this runs during renderAdmin's
 *  synchronous init with no catch above it, where a throw bricks the whole
 *  admin page. Anything but a string array falls back to the default. */
export function readStoredStringSet(raw: string | null, fallback: string[]): Set<string> {
  if (raw !== null) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        return new Set(parsed as string[]);
      }
    } catch { /* corrupt: fall through to the default */ }
  }
  return new Set(fallback);
}

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

type DiscoveryRow = NonNullable<Config["discoveries"]>[number];

/** Bring a suppressed discovery back to triage. Clears ALL suppression
 *  bookkeeping (schema.ts: "Restoring clears these fields") — leaving a stale
 *  hitCount would let the server re-suppress it on the very next hit. */
export function restoreDiscovery<T extends Partial<DiscoveryRow>>(d: T): T {
  return { ...d, hitCount: undefined, lastSeenAt: undefined, suppressedAt: undefined, suppressionReason: undefined };
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
      <div id="healthBanner" class="healthBanner healthClear" data-page="home" role="alert"></div>
      <div class="pageIntro" data-page="home">
        <div><span class="eyebrow">Overview</span><h1>Radio status</h1><p>Monitor what is playing, check system health, and review recent activity.</p></div>
      </div>
      <section class="nowCard hero" data-page="home">
        <h2>Now playing</h2>
        <div class="npWhat"><span id="npName" class="npName">scanning…</span> <span id="npFreq" class="npFreq"></span></div>
        <div class="npControls">
          <div class="controlGroup audioControls">
            <button id="streamBtn" class="primary" disabled title="Enable remote listening to stream the feed">▶ Listen here</button>
            <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
            <label class="checkLabel"><input id="mute" type="checkbox" /> Mute</label>
            <label class="checkLabel"><input id="remoteListen" type="checkbox" /> Remote listening</label>
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
            <button id="testAlert" title="Show a sample weather-alert banner on the kiosk (for design + verifying alerts work)">Test weather alert</button>
            <button id="testAlertClear" title="Clear the test weather-alert banner from the kiosk">Clear alert</button>
            <button id="backendRestart" class="danger" title="Restart the radio backend and scanner helpers">Restart radio backend</button>
            <span id="systemActionStatus" class="hint" role="status"></span>
          </div>
        </div>
      </section>
      <section class="sysHealth collapsible" data-key="system" data-page="home">
        <h2>System health <span class="hint">the machine under the radio — helper CPU is the usual suspect</span></h2>
        <div id="sysBody"></div>
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
        <details id="suppressedPanel" class="suppressedPanel">
          <summary>Suppressed likely noise <span id="suppressedCount"></span></summary>
          <div id="suppressedRows"></div>
        </details>
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
        <div id="dupPanel" class="dupPanel" hidden></div>
        <div class="tableWrap">
          <table class="chTable">
            <thead><tr>
              <th>Freq (MHz)</th><th>Name</th><th>Mode</th><th>Priority</th><th>Audible</th><th>Archived</th><th></th>
            </tr></thead>
            <tbody id="chRows"></tbody>
          </table>
        </div>
        <span id="chErr" class="err"></span>
        <div id="archiveRecommendations" class="archiveRecommendations"></div>
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
        <div class="alertFeedFoot"><button id="clearAlerts" class="alertClearAll" type="button" hidden>Clear all</button></div>
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
            <legend>Alerts</legend>
            <label><span>Alert cooldown <small>Minimum time before repeating an alert</small></span><span class="inputUnit"><input id="tAlertCool" type="number" min="1" step="1" placeholder="15" /><b>min</b></span></label>
            <label><span>Alert hold <small>How long an alert remains visible</small></span><span class="inputUnit"><input id="tAlertHold" type="number" min="5" step="5" placeholder="30" /><b>sec</b></span></label>
            <label><span>Push notification URL <small>Optional ntfy topic URL</small></span><input id="tAlertNtfy" type="text" placeholder="https://ntfy.sh/your-topic" /></label>
            <label><span>SAME county codes <small>Comma-separated FIPS codes; empty allows all</small></span><input id="tSameFips" type="text" placeholder="029047, 029095" title="County FIPS codes for SAME/EAS scoping — 5-digit SSCCC or 6-digit PSSCCC" /></label>
            <label class="switchRow"><span>Show SAME tests <small>Include weekly and monthly test banners</small></span><input id="tSameTests" type="checkbox" /></label>
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
  const collapsed = readStoredStringSet(
    localStorage.getItem(COLLAPSE_KEY), ["tuning", "lockouts", "weather", "insights"]);
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
    if (!name) { bkErr.textContent = "Enter a bank name"; return; }
    const band = root.querySelector<HTMLSelectElement>("#bkBand")!.value;
    const tags = root.querySelector<HTMLInputElement>("#bkTags")!.value
      .split(",").map((t) => t.trim()).filter(Boolean);
    const lo = root.querySelector<HTMLInputElement>("#bkLo")!.value.trim();
    const hi = root.querySelector<HTMLInputElement>("#bkHi")!.value.trim();
    try {
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
    } catch (e) {
      // Without this, a rejected save was an unhandled rejection and the button
      // looked dead — the operator's bank definition lost with no message.
      bkErr.textContent = (e as Error).message || "could not save bank";
    }
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
    if (!r.ok) { inBody.innerHTML = `<div class="empty">History store unavailable — restart the radio backend if this persists.</div>`; return; }
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
        ${st.topChannels.slice(0, 8).map((c) => `<tr class="inChannel" data-freq="${c.freq}" tabindex="0" title="Open channel analytics">
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
    inBody.querySelectorAll<HTMLElement>(".inChannel").forEach((row) => {
      const open = () => openAnalytics(Number(row.dataset.freq));
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") open(); });
    });
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
  const clearAlertsBtn = root.querySelector<HTMLButtonElement>("#clearAlerts")!;
  async function renderAlertFeed(): Promise<void> {
    const rows = await fetch("/api/history?kind=alert&limit=25")
      .then((r) => (r.ok ? r.json() : [])) as
      Array<{ id: number; ts: number; freq: number; alphaTag: string }>;
    clearAlertsBtn.hidden = rows.length === 0;
    alertRows.innerHTML = rows.length
      ? rows.map((r) => `<li><span class="alertWhen">${new Date(r.ts).toLocaleString()}</span>
          <span class="alertWhat">${fmtFreq(r.freq)} ${esc(r.alphaTag)}</span>${iconBtn("alertDismiss", "del", "Dismiss this alert", `data-id="${r.id}"`)}</li>`).join("")
      : `<li class="hint">no alerts yet — flag a channel with “Alert on hit” in its drawer</li>`;
    alertRows.querySelectorAll<HTMLButtonElement>(".alertDismiss").forEach((b) =>
      b.addEventListener("click", async () => {
        await api.dismissAlert(Number(b.dataset.id));
        renderAlertFeed().catch(() => {});
      }));
  }
  clearAlertsBtn.addEventListener("click", async () => {
    if (!await confirmAdminAction({
      title: "Clear all alerts",
      message: "Remove every alert from the feed? The underlying activity history is kept.",
      confirmLabel: "Clear all",
      danger: true,
    })) return;
    await api.clearAlerts();
    renderAlertFeed().catch(() => {});
  });
  void renderAlertFeed().catch(() => {});
  setInterval(() => { renderAlertFeed().catch(() => {}); }, 60_000);

  // ── System health (Idea 16): gauges + sparklines off /api/system.
  const sysBody = root.querySelector<HTMLElement>("#sysBody")!;
  const healthBanner = root.querySelector<HTMLElement>("#healthBanner")!;
  let lastVerdict: string | null = null;
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
    const { now, ring, alerts, safetyMode, health, coreCount } = await fetch("/api/system").then((r) => r.json()) as {
      now: Record<string, number | boolean | null> | null;
      ring: Array<Record<string, number | boolean | null>>;
      alerts: Array<{ id: string; severity: "attention" | "severe"; title: string; message: string; help: string }>;
      safetyMode: boolean;
      health: { verdict: "healthy" | "stressed" | "trouble"; reason: string };
      coreCount: number;
    };
    if (!now) { sysBody.textContent = "No readings yet — data appears within a minute."; return; }
    healthBanner.classList.toggle("healthClear", alerts.length === 0);
    healthBanner.classList.toggle("severe", alerts.some((a) => a.severity === "severe"));
    healthBanner.innerHTML = alerts.length ? `${safetyMode ? `<div class="safetyMode"><strong>Protection active:</strong> Close Call and sweep ranges are paused until temperature recovers.</div>` : ""}${alerts.map((a) => `<div class="healthAlert">
      <div><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span><small>${esc(a.help)}</small></div>
      ${a.id.startsWith("cpu-") || a.id.startsWith("memory-") ? `<a href="#/scan">Reduce processing load</a>` : ""}
    </div>`).join("")}` : "";
    const num = (k: string) => ring.map((r) => (typeof r[k] === "number" ? r[k] as number : null));
    const cell = (label: string, value: string, sparkHtml: string, hot = false) =>
      `<div class="sysCell${hot ? " hot" : ""}"><div class="sysLabel">${label}</div>
        <div class="sysValue">${value}</div>${sparkHtml}</div>`;
    const t = now.tempC as number | null;
    const helperCores = now.helperCpuPct === null
      ? "—"
      : `${((now.helperCpuPct as number) / 100).toFixed(1)} / ${coreCount} cores${now.helperRssMb === null ? "" : ` · ${now.helperRssMb} MB`}`;
    const cells =
      cell("CPU", `${now.cpuPct}%`, spark(num("cpuPct"), 100, 85), (now.cpuPct as number) >= 85)
      + cell("DSP helper", helperCores,
          spark(num("helperCpuPct"), 100 * coreCount, 80 * coreCount), (now.helperCpuPct as number | null ?? 0) >= 80 * coreCount)
      + cell("Temp", t === null ? "n/a" : `${t}°C${now.throttled ? " · THROTTLED" : ""}`,
          // 87°C matches the backend "running hot" line; this box idles ~82-83°C.
          // Throttling annotates the value but no longer reddens the cell on its own.
          spark(num("tempC"), 100, 87), (t ?? 0) >= 87)
      + cell("RAM", `${now.memUsedPct}% · node ${now.backendRssMb} MB`, spark(num("memUsedPct"), 100, 90), (now.memUsedPct as number) >= 90)
      + cell("Open channels", String(now.openCount), spark(num("openCount"), 12, 11))
      + cell("Disk free", now.diskFreeMb === null ? "n/a" : `${((now.diskFreeMb as number) / 1024).toFixed(1)} GB`,
          "", (now.diskFreeMb as number | null ?? 1e9) < 2048);
    const verdictClass = health.verdict;
    const verdictLabel = health.verdict.toUpperCase();
    // Preserve the user's manual open/collapse across the 3s polls. The verdict-
    // derived default (open unless healthy) is only re-asserted on first render
    // or when the verdict actually changes.
    const prevDetails = sysBody.querySelector<HTMLDetailsElement>(".sysDetails");
    const userOpen = prevDetails ? prevDetails.open : null; // null = no panel yet
    const verdictDefaultOpen = health.verdict !== "healthy";
    const shouldOpen = health.verdict !== lastVerdict
      ? verdictDefaultOpen
      : (userOpen ?? verdictDefaultOpen);
    lastVerdict = health.verdict;
    sysBody.innerHTML =
      `<div class="healthVerdict ${verdictClass}">
         <span class="verdictDot"></span>
         <span class="verdictLabel">${verdictLabel}</span>
         <span class="verdictReason">${esc(health.reason)}</span>
       </div>
       <details class="sysDetails"${shouldOpen ? " open" : ""}>
         <summary>Details</summary>
         <div class="sysGrid">${cells}</div>
       </details>`;
  }
  void renderSystem().catch(() => {});
  setInterval(() => { renderSystem().catch(() => {}); }, 3000);
  setInterval(() => {
    if (drawerKind === "analytics" && analyticsFreq !== null) void renderAnalyticsDrawer(analyticsFreq);
  }, 5000);

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
  const collapsedBanks = readStoredStringSet(localStorage.getItem(GROUPS_KEY), []);
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
      <td class="rowOpen">${esc(c.alphaTag)}${c.alert ? `<span class="bellChip" title="Alerts on a hit">${ICONS.bell}</span>` : ""}${membershipChips(c)}${locChip(c.location)}<span class="rowChev" aria-hidden="true">›</span></td>
      <td class="rowOpen">${esc(c.mode.toUpperCase())}</td>
      <td><input type="checkbox" class="prio" ${c.priority ? "checked" : ""} /></td>
      <td><input type="checkbox" class="audible" ${c.audible !== false ? "checked" : ""} /></td>
      <td><input type="checkbox" class="archived" ${!c.enabled ? "checked" : ""} /></td>
      <td class="actions">${iconBtn("listen", "listen", "Listen — park the radio on this channel (unsquelched)")}${iconBtn("lock", "lockout", "Lock out — remove and never Close-Call this frequency again")}</td>
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
        ? `<tr><td colspan="7" class="empty">No channels yet — use Add channel above.</td></tr>` : "");
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
  let drawerKind: "channel" | "discovery" | "analytics" = "channel";
  let analyticsFreq: number | null = null;

  function closeDrawer(): void {
    drawerId = null;
    // Clear the analytics-poll state too: the 5 s interval keys off
    // drawerKind/analyticsFreq, so leaving them set kept fetching history and
    // rewriting the hidden drawer every 5 s forever after the drawer closed.
    drawerKind = "channel";
    analyticsFreq = null;
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

  function openAnalytics(freq: number): void {
    drawerKind = "analytics";
    analyticsFreq = freq;
    drawerId = `analytics_${freq}`;
    drawer.classList.add("open");
    scrim.classList.add("open");
    void renderAnalyticsDrawer(freq);
  }

  function renderDrawer(): void {
    if (drawerKind === "discovery") { renderDiscoveryDrawer(); return; }
    if (drawerKind === "analytics") { if (analyticsFreq) void renderAnalyticsDrawer(analyticsFreq); return; }
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
        <button id="dwLock" class="lock">Lock out</button>
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

  async function renderAnalyticsDrawer(freq: number): Promise<void> {
    const since = Date.now() - 24 * 3_600_000;
    const rows = await fetch(`/api/history?freq=${freq}&since=${since}&limit=1000`)
      .then((r) => r.ok ? r.json() : []) as Array<{ ts: number; durationMs: number | null; rfDb: number | null; alphaTag: string }>;
    const active = rows.filter((r) => r.durationMs !== null || r.rfDb !== null);
    const name = active[0]?.alphaTag || channels.find((c) => c.freq === freq)?.alphaTag || fmtFreq(freq);
    const signals = [...active].filter((r) => r.rfDb !== null).reverse();
    const W = 420; const H = 150;
    const min = signals.length ? Math.min(...signals.map((r) => r.rfDb!)) - 2 : -40;
    const max = signals.length ? Math.max(...signals.map((r) => r.rfDb!)) + 2 : 0;
    const points = signals.map((r, i) => {
      const x = signals.length === 1 ? W / 2 : i * W / (signals.length - 1);
      const y = H - ((r.rfDb! - min) / Math.max(1, max - min)) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    const airtime = active.reduce((n, r) => n + (r.durationMs ?? 0), 0);
    drawer.innerHTML = `
      <header class="dwHead"><div><span class="drawerEyebrow">Channel analytics · live 24h</span><h3>${esc(name)}</h3></div>${iconBtn("dwClose", "dismiss", "Close")}</header>
      <div class="dwFreq">${fmtFreq(freq)}<span class="dwUnit">MHz</span></div>
      <div class="analyticsSummary"><span><b>${active.length}</b> transmissions</span><span><b>${fmtAir(airtime)}</b> airtime</span><span><b>${signals.length}</b> strength samples</span></div>
      <div class="signalChart">
        <div class="chartLabel">Signal strength per transmission</div>
        ${signals.length ? `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${points}" fill="none" /></svg>
          <div class="chartRange"><span>${max.toFixed(1)} dB</span><span>${min.toFixed(1)} dB</span></div>` : `<div class="empty">Signal strength will appear after new transmissions close.</div>`}
      </div>
      <ol class="transmissionList">${active.slice(0, 30).map((r) => `<li><time>${new Date(r.ts).toLocaleTimeString()}</time><span>${r.durationMs === null ? "open" : `${(r.durationMs / 1000).toFixed(1)}s`}</span><b>${r.rfDb === null ? "—" : `${r.rfDb.toFixed(1)} dB`}</b></li>`).join("")}</ol>`;
    drawer.querySelector<HTMLButtonElement>(".dwClose")!.addEventListener("click", closeDrawer);
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
      <section class="locationEditor">
        <h4>Identify and locate</h4>
        <label>Display name <input id="dcLocateName" value="${esc(d.alphaTag.startsWith("Close Call ") ? "" : d.alphaTag)}" placeholder="Business or site name" /></label>
        <div class="locationSearch"><input id="dcLocateSearch" placeholder="Search business or address" /><button id="dcLocateFind">Search nearby</button></div>
        <div id="dcLocateSuggestions" class="locationSuggestions"></div>
        <div id="dcLocateMap" class="locationMap"><span>Loading map…</span></div>
        <label>Pin location <input id="dcLocateCoords" value="${loc?.lat != null ? `${loc.lat}, ${loc.lon}` : ""}" placeholder="Drag/drop pin or enter lat, lon" /></label>
        <button id="dcLocateSave" class="save">Save located channel</button>
        <span id="dcLocateErr" class="err"></span>
      </section>
      <div class="dwActions">
        <button id="dwListen" class="listen">Listen</button>
        <button id="dwAdd" class="dAdd">Add channel</button>
        <button id="dwSuppress">Suppress likely noise</button>
        <button id="dwLock" class="lock">Lock out</button>
        <button id="dwDismiss" class="dDismiss">Dismiss</button>
      </div>`;
    drawer.querySelector<HTMLButtonElement>(".dwClose")!.addEventListener("click", closeDrawer);
    drawer.querySelector<HTMLButtonElement>("#dwListen")!.addEventListener("click", () =>
      api.monitor(d.freq, d.alphaTag));
    drawer.querySelector<HTMLButtonElement>("#dwAdd")!.addEventListener("click", async () => {
      await mutateDiscovery(d.id, promoteDiscovery);
      closeDrawer();
    });
    drawer.querySelector<HTMLButtonElement>("#dwSuppress")!.addEventListener("click", async () => {
      const cfg = await api.getConfig();
      cfg.discoveries = (cfg.discoveries ?? []).map((x) => x.id === d.id
        ? { ...x, suppressedAt: Date.now(), suppressionReason: "Suppressed by operator" } : x);
      await api.putConfig(cfg);
      closeDrawer();
      await renderDiscoveries();
    });
    drawer.querySelector<HTMLButtonElement>("#dwLock")!.addEventListener("click", async () => {
      await lockoutFreq(d.freq, d.alphaTag);
      closeDrawer();
    });
    drawer.querySelector<HTMLButtonElement>("#dwDismiss")!.addEventListener("click", async () => {
      await mutateDiscovery(d.id, () => {});
      closeDrawer();
    });
    void mountDiscoveryLocationEditor(d);
  }

  async function mountDiscoveryLocationEditor(d: Discovery): Promise<void> {
    const mapEl = drawer.querySelector<HTMLElement>("#dcLocateMap");
    const coords = drawer.querySelector<HTMLInputElement>("#dcLocateCoords");
    const search = drawer.querySelector<HTMLInputElement>("#dcLocateSearch");
    const suggestions = drawer.querySelector<HTMLElement>("#dcLocateSuggestions");
    if (!mapEl || !coords || !search || !suggestions) return;
    const cfg = await api.getConfig();
    const home = { lat: cfg.display?.weatherLat ?? 39.1, lng: cfg.display?.weatherLon ?? -94.58 };
    if (!await loadAdminMaps() || !drawer.contains(mapEl)) {
      mapEl.innerHTML = `<span>Google Maps key unavailable. Enter coordinates manually.</span>`;
    } else {
      const initial = d.location?.lat != null ? { lat: d.location.lat, lng: d.location.lon! } : home;
      const map = new google.maps.Map(mapEl, { center: initial, zoom: d.location?.lat != null ? 14 : 10, mapTypeControl: false });
      const marker = new google.maps.Marker({ map, position: initial, draggable: true });
      const set = (p: { lat: number; lng: number }) => {
        marker.setPosition(p); map.panTo(p); coords.value = `${p.lat.toFixed(6)}, ${p.lng.toFixed(6)}`;
      };
      marker.addListener("dragend", () => set(marker.getPosition().toJSON()));
      map.addListener("click", (ev: any) => set(ev.latLng.toJSON()));
      const geocoder = new google.maps.Geocoder();
      drawer.querySelector<HTMLButtonElement>("#dcLocateFind")?.addEventListener("click", () => {
        if (!search.value.trim()) return;
        geocoder.geocode({ address: search.value, bounds: map.getBounds() }, (results: any[], status: string) => {
          if (status !== "OK" || !results?.length) { suggestions.textContent = "No nearby matches found"; return; }
          suggestions.innerHTML = results.slice(0, 5).map((r, i) => `<button data-i="${i}">${esc(r.formatted_address)}</button>`).join("");
          suggestions.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.addEventListener("click", () => {
            const r = results[Number(b.dataset.i)];
            set(r.geometry.location.toJSON());
            if (!drawer.querySelector<HTMLInputElement>("#dcLocateName")!.value) {
              drawer.querySelector<HTMLInputElement>("#dcLocateName")!.value = r.formatted_address.split(",")[0];
            }
          }));
        });
      });
    }
    drawer.querySelector<HTMLButtonElement>("#dcLocateSave")?.addEventListener("click", async () => {
      const err = drawer.querySelector<HTMLElement>("#dcLocateErr")!;
      try {
        const name = drawer.querySelector<HTMLInputElement>("#dcLocateName")!.value.trim();
        if (!name) throw new Error("Enter a display name");
        const pair = coords.value.split(",").map((v) => Number(v.trim()));
        if (pair.length !== 2 || !pair.every(Number.isFinite)) throw new Error("Drop a pin or enter lat, lon");
        await mutateDiscovery(d.id, (cfg2, current) => {
          promoteDiscovery(cfg2, {
            ...current, alphaTag: name,
            location: { ...(current.location ?? {}), lat: pair[0]!, lon: pair[1]!, source: "operator" },
          });
        });
        closeDrawer();
      } catch (e) { err.textContent = (e as Error).message; }
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
    void renderArchiveRecommendations();
    void renderDuplicates();
    if (drawerId) renderDrawer(); // keep an open dossier fresh after saves
  }

  // Duplicates audit (spec 2026-06-09): shown only when non-GMRS dupes exist.
  async function renderDuplicates(): Promise<void> {
    const panel = root.querySelector<HTMLElement>("#dupPanel");
    if (!panel) return;
    const sets = await fetch("/api/channels/duplicates").then((r) => (r.ok ? r.json() : [])) as Array<{
      freq: number; channels: Array<{ channel: { id: string; alphaTag: string }; completeness: number }>;
    }>;
    if (sets.length === 0) { panel.hidden = true; panel.innerHTML = ""; return; }
    const total = sets.reduce((n, s) => n + s.channels.length - 1, 0);
    panel.hidden = false;
    panel.innerHTML =
      `<h3>${sets.length} frequenc${sets.length === 1 ? "y has" : "ies have"} duplicate rows</h3>` +
      sets.map((s) => `<div class="dupSet"><strong>${fmtFreq(s.freq)}</strong><ul>` +
        s.channels.map((c, i) =>
          `<li>${esc(c.channel.alphaTag || "(unnamed)")}${i === 0 ? ' <span class="dupKeep">keeps</span>' : ' <span class="dupDrop">removed</span>'}</li>`,
        ).join("") + `</ul></div>`).join("") +
      `<button id="dupResolve" class="danger">Delete ${total} duplicate row${total === 1 ? "" : "s"}</button>`;
    panel.querySelector<HTMLButtonElement>("#dupResolve")?.addEventListener("click", async () => {
      if (!confirm(`Delete ${total} duplicate row${total === 1 ? "" : "s"}? GMRS frequencies are never affected. This cannot be undone.`)) return;
      await fetch("/api/channels/duplicates/resolve", { method: "POST" });
      await refresh();
    });
  }

  async function renderArchiveRecommendations(): Promise<void> {
    const host = root.querySelector<HTMLElement>("#archiveRecommendations")!;
    const recs = await fetch("/api/recommendations/archive").then((r) => r.ok ? r.json() : []) as
      Array<{ id: string; freq: number; alphaTag: string; audible: boolean }>;
    if (!recs.length) { host.innerHTML = ""; return; }
    host.innerHTML = `<h3>Archive suggestions</h3><p>Not heard in 30 days. Priority and manually located channels are excluded.</p>
      ${recs.slice(0, 12).map((c) => `<div class="archiveRec"><span><b>${esc(c.alphaTag)}</b> ${fmtFreq(c.freq)}${c.audible ? " · audible" : ""}</span><button data-id="${esc(c.id)}">Archive</button></div>`).join("")}`;
    host.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.addEventListener("click", async () => {
      await api.updateChannel(b.dataset.id!, { enabled: false });
      await refresh();
    }));
  }

  const dcRows = root.querySelector<HTMLElement>("#dcRows")!;
  const dcAll = root.querySelector<HTMLInputElement>("#dcAll")!;
  const dcDismissSel = root.querySelector<HTMLButtonElement>("#dcDismissSel")!;
  const dcLockSel = root.querySelector<HTMLButtonElement>("#dcLockSel")!;
  const dcSelCount = root.querySelector<HTMLElement>("#dcSelCount")!;
  const suppressedRows = root.querySelector<HTMLElement>("#suppressedRows")!;
  const suppressedCount = root.querySelector<HTMLElement>("#suppressedCount")!;
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

  async function renderDiscoveries(opts: { refreshDrawer?: boolean } = {}): Promise<void> {
    const cfg = await api.getConfig();
    syncAudioControls(cfg); // one poll feeds both (was a separate 5s loop)
    const all = [...(cfg.discoveries ?? [])].sort((a, b) => b.ts - a.ts);
    const ds = all.filter((d) => !d.suppressedAt);
    const suppressed = all.filter((d) => d.suppressedAt);
    discoveries = ds;
    root.querySelector<HTMLElement>("#dcCount")!.textContent = String(ds.length);
    suppressedCount.textContent = suppressed.length ? `(${suppressed.length})` : "";
    suppressedRows.innerHTML = suppressed.length
      ? suppressed.map((d) => `<div class="suppressedRow" data-id="${esc(d.id)}"><span><b>${fmtFreq(d.freq)}</b> ${esc(d.alphaTag)}</span><small>${esc(d.suppressionReason ?? "Likely repeated noise")} · ${d.hitCount ?? "several"} hits</small><button>Restore to triage</button></div>`).join("")
      : `<div class="empty">No suppressed frequencies</div>`;
    suppressedRows.querySelectorAll<HTMLButtonElement>("button").forEach((button) => button.addEventListener("click", async () => {
      const id = (button.closest(".suppressedRow") as HTMLElement).dataset.id;
      const cfg2 = await api.getConfig();
      cfg2.discoveries = (cfg2.discoveries ?? []).map((d) => d.id === id ? restoreDiscovery(d) : d);
      await api.putConfig(cfg2);
      await renderDiscoveries();
    }));
    const present = new Set(ds.map((d) => d.id));
    for (const id of dcSelected) if (!present.has(id)) dcSelected.delete(id);
    dcRows.innerHTML = ds.length === 0
      ? `<tr><td colspan="5" class="empty">Nothing pending — Close Call is hunting. New discoveries land here.</td></tr>`
      : ds.map((d) => `<tr data-id="${esc(d.id)}" class="dcRow">
          <td><input type="checkbox" class="dSel" ${dcSelected.has(d.id) ? "checked" : ""} /></td>
          <td class="rowOpen">${fmtFreq(d.freq)}<span class="dcSvc${serviceFor(d.freq) ? "" : " outband"}">${esc(serviceFor(d.freq) ?? "OUTBAND")}</span></td>
          <td class="rowOpen">${esc(d.alphaTag)}${d.audible === false ? '<span class="dcSee" title="Identified as data/paging — filed seen-not-heard; promotes as SEE">SEE</span>' : d.audible === true ? '<span class="dcHear" title="Identified as analog voice — hearable">HEAR</span>' : ""}${locChip(d.location)}<span class="rowChev" aria-hidden="true">›</span></td>
          <td class="rowOpen dMode${d.mode && DIGITAL.some((x) => d.mode!.toUpperCase().includes(x)) ? " digital" : ""}">${d.mode ? esc(d.mode.toUpperCase()) : "—"}</td>
          <td class="actions">${iconBtn("dListen", "listen", "Listen — audition this discovery")}${iconBtn("dAdd", "add", "Add as an enabled channel")}${iconBtn("dLock", "lockout", "Lock out — never Close-Call this frequency again")}${iconBtn("dDismiss", "dismiss", "Dismiss (may be rediscovered later)")}</td>
        </tr>`).join("");
    dcAll.checked = ds.length > 0 && dcSelected.size === ds.length;
    paintDcToolbar();
    dcRows.querySelectorAll<HTMLElement>(".rowOpen").forEach((cell) => {
      const id = (cell.closest("tr") as HTMLElement).dataset.id!;
      cell.addEventListener("click", () => openDrawer("discovery", id));
    });
    // Re-render the open discovery drawer only for action-driven refreshes, not
    // the passive 15 s poll: rebuilding it wipes in-progress operator input
    // (display name, search, dragged pin) and leaks a new Google Map instance
    // each time. The poll passes refreshDrawer:false.
    if (opts.refreshDrawer !== false && drawerId && drawerKind === "discovery") renderDrawer();
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
  setInterval(() => { renderDiscoveries({ refreshDrawer: false }).catch(() => {}); }, 15000);

  const loList = root.querySelector<HTMLElement>("#loList")!;
  async function renderLockouts(): Promise<void> {
    const cfg = await api.getConfig();
    const lo = cfg.scan.lockoutHz ?? [];
    loList.innerHTML = lo.length === 0
      ? `<li class="empty">No locked-out frequencies.</li>`
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
  // Cycle representative storm types so each themed banner can be designed/
  // verified from one button: warning tiers (loud) → a watch → a winter warning.
  const TEST_ALERTS = [
    "TORNADO WARNING",
    "SEVERE THUNDERSTORM WARNING",
    "FLASH FLOOD WARNING",
    "TORNADO WATCH",
    "WINTER STORM WARNING",
  ];
  let testAlertIdx = 0;
  root.querySelector<HTMLButtonElement>("#testAlert")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const alphaTag = TEST_ALERTS[testAlertIdx % TEST_ALERTS.length]!;
    testAlertIdx += 1;
    button.disabled = true;
    systemActionStatus.textContent = `Showing “${alphaTag}”…`;
    try {
      await api.testAlert({ alphaTag });
      systemActionStatus.textContent = `Showing “${alphaTag}” on kiosk — click again for the next type`;
    } catch (e) {
      systemActionStatus.textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector<HTMLButtonElement>("#testAlertClear")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    systemActionStatus.textContent = "Clearing test alert…";
    try {
      await api.testAlert({ clear: true });
      systemActionStatus.textContent = "Test alert cleared";
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
  const remoteListen = root.querySelector<HTMLInputElement>("#remoteListen")!;

  function syncRemoteListening(on: boolean): void {
    if (document.activeElement !== remoteListen) remoteListen.checked = on;
    // The in-browser "Listen here" button streams /api/stream.wav, which 404s
    // when remote listening is off — disable it so it never silently fails.
    streamBtn.disabled = !on;
    streamBtn.title = on
      ? "Listen to the live speaker feed in this browser"
      : "Enable remote listening to stream the feed";
  }

  remoteListen.addEventListener("change", async () => {
    const cfg = await api.getConfig();
    await api.putConfig({ ...cfg, audio: { ...cfg.audio, remoteListening: remoteListen.checked } });
    syncRemoteListening(remoteListen.checked);
  });

  function syncAudioControls(cfg: { audio: { volume: number; muted: boolean; remoteListening?: boolean } }): void {
    if (document.activeElement !== vol) vol.value = String(cfg.audio.volume);
    if (document.activeElement !== mute) mute.checked = cfg.audio.muted;
    syncRemoteListening(cfg.audio.remoteListening ?? false);
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
      const mapsKey = tMapsKey.value.trim();
      const mapId = tMapsMapId.value.trim();
      if (cfg.display) {
        // Both fields are prefilled from config, so an emptied field means
        // "clear it" — drop back to the raster map (matches the Map ID).
        if (mapsKey) cfg.display.googleMapsApiKey = mapsKey;
        else delete cfg.display.googleMapsApiKey;
        if (mapId) cfg.display.googleMapsMapId = mapId;
        else delete cfg.display.googleMapsMapId;
      } else if (mapsKey || mapId) {
        // No display block (no weather location yet) means no place to store
        // these AND no map without coordinates — say so instead of a silent
        // "saved" that drops the key.
        tErr.textContent = "set a weather location first — the map needs coordinates";
        return;
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
