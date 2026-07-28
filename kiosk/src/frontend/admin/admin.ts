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
import icoWrench from "lucide-static/icons/wrench.svg?raw";
import icoPlay from "lucide-static/icons/play.svg?raw";
import icoStop from "lucide-static/icons/square.svg?raw";
import icoEllipsis from "lucide-static/icons/ellipsis.svg?raw";
import icoChevronRight from "lucide-static/icons/chevron-right.svg?raw";
import icoExternal from "lucide-static/icons/arrow-up-right.svg?raw";
import type { Bank } from "../../backend/config/schema.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { SystemActionWatcher } from "../lib/systemActionWatcher.js";
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

/** Config shape the lockout pair mutates — the slice both need, so these stay
 *  callable from tests without standing up a whole config fixture. */
type LockoutCfg = {
  channels: Channel[];
  discoveries?: Array<{ freq: number }>;
  scan: { lockoutHz?: number[] };
};

/** Lock out a frequency: ARCHIVE its channel (enabled:false), drop any pending
 *  discovery, and add it to the Close Call suppression list.
 *
 *  Archiving, not deleting: schema.ts already defines enabled:false as
 *  "identity/location remain, but the channel stops consuming scanner
 *  capacity" — exactly what a lockout wants. Deleting threw away the alphaTag,
 *  location, rfDb and learned levelTrimDb the lookup chain paid API calls to
 *  build, and left `unlockFreq` with nothing to restore. */
export function lockoutFreqIn<T extends LockoutCfg>(cfg: T, freq: number): T {
  return {
    ...cfg,
    channels: cfg.channels.map((c) => (c.freq === freq ? { ...c, enabled: false } : c)),
    discoveries: (cfg.discoveries ?? []).filter((d) => d.freq !== freq),
    scan: { ...cfg.scan, lockoutHz: [...new Set([...(cfg.scan.lockoutHz ?? []), freq])] },
  };
}

/** The true inverse: clear the suppression AND un-archive the channel lockout
 *  archived. Clearing suppression alone left the operator with an unlocked
 *  frequency that still never scanned, and no hint why. */
export function unlockFreqIn<T extends LockoutCfg>(cfg: T, freq: number): T {
  return {
    ...cfg,
    channels: cfg.channels.map((c) => (c.freq === freq ? { ...c, enabled: true } : c)),
    scan: { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== freq) },
  };
}



// Icons come from Lucide (lucide-static raw SVGs, stroke = currentColor, so
// the consequence color-coding on button classes carries straight through).
// Every glyph in this app comes from here — there is deliberately no second
// vocabulary. Typed characters standing in for icons (▶ ⏹ ⋯ › ↗) used to sit
// beside these: they carry no stroke weight, ignore currentColor sizing, and
// resolve to whatever the fallback font happens to have — ▶/⏹ can even land in
// emoji presentation and drag the button's line box with them.
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
  play: icoPlay,
  stop: icoStop,
  more: icoEllipsis,
  chevron: icoChevronRight,
  external: icoExternal,
};

function iconBtn(cls: string, icon: string, label: string, attrs = ""): string {
  return `<button class="${cls} iconBtn" title="${label}" aria-label="${label}"${attrs ? " " + attrs : ""}>${ICONS[icon]}</button>`;
}

/** An icon that rides *inside* a label rather than replacing it. Sized in `em`
 *  by `.btnIco`, so it tracks whatever type step its label uses. `where` sets
 *  which side gets the gap — "solo" is an icon that IS the whole label, and
 *  still needs an accessible name on the element wrapping it. */
function btnIco(icon: string, where: "lead" | "trail" | "solo" = "lead"): string {
  const mod = where === "solo" ? "" : ` btnIco--${where}`;
  return ICONS[icon]!.replace("<svg", `<svg class="btnIco${mod}" aria-hidden="true" focusable="false"`);
}

export function renderAdmin(root: HTMLElement): void {
  root.innerHTML = `
    <main class="admin">
      <button type="button" class="skipLink">Skip to content</button>
      <header class="adminHead">
        <a class="brand" href="#/" aria-label="Kerchunk admin overview">KERCHUNK <span class="brandSub">admin</span></a>
        <div class="headActions">
          <a href="/" target="_blank" title="Open the kiosk display">Kiosk${btnIco("external", "trail")}</a>
          <a href="/map" target="_blank" title="Open the live activity map">Map${btnIco("external", "trail")}</a>
        </div>
      </header>
      <div class="workspace">
      <nav class="adminNav" id="adminNav" aria-label="Admin sections">
        <a href="#/" data-route="home"><span class="navIco" data-ico="home"></span><span class="navCopy"><b>Overview</b><small>Live status and activity</small></span></a>
        <a href="#/triage" data-route="triage"><span class="navIco" data-ico="triage"></span><span class="navCopy"><b>Triage</b><small>Review new discoveries</small></span><span id="navDcCount" class="navBadge"></span></a>
        <a href="#/channels" data-route="channels"><span class="navIco" data-ico="channels"></span><span class="navCopy"><b>Channels</b><small>Organize what you scan</small></span></a>
        <a href="#/scan" data-route="scan"><span class="navIco" data-ico="scan"></span><span class="navCopy"><b>Settings</b><small>Scanning, alerts, weather</small></span></a>
        <a href="#/system" data-route="system"><span class="navIco" data-ico="system"></span><span class="navCopy"><b>System</b><small>Appliance health and controls</small></span></a>
      </nav>
      <div class="pages" id="adminPages" tabindex="-1">
      <div id="healthBanner" class="healthBanner healthClear" data-page="home" role="status" aria-live="polite"></div>
      <div class="pageIntro" data-page="home">
        <div><h1>Radio status</h1></div>
      </div>
      <section class="nowCard hero" data-page="home">
        <h2>Now playing <span id="npSilent" class="silentChip" hidden></span></h2>
        <div class="npWhat"><span id="npName" class="npName">scanning…</span> <span id="npFreq" class="npFreq"></span></div>
        <div class="npControls">
          <div class="controlGroup audioControls">
            <button id="streamBtn" class="primary" disabled title="Enable remote listening to stream the feed">${btnIco("play")}Listen here</button>
            <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
            <label class="checkLabel"><input id="mute" type="checkbox" /> Mute</label>
            <label class="checkLabel"><input id="remoteListen" type="checkbox" /> Remote listening</label>
          </div>
          <div class="controlGroup transmissionControls">
            <button id="resumeBtn" class="resume" style="display:none">${btnIco("stop")}Resume scan</button>
            <button id="weatherBtn" class="weatherAction">Listen to weather</button>
            <button id="skipBtn" title="Force-close the current transmission">Skip transmission</button>
            <button id="tlockBtn" title="Suppress this channel for 30 minutes (clears on restart)" disabled>Pause 30 min</button>
            <button id="lockBtn" class="danger" title="Remove this channel and never Close-Call its frequency again" disabled>Lock out channel</button>
          </div>
        </div>
      </section>
      <section class="alertFeed" data-page="home">
        <h2>Alerts <span class="hint">last 25</span></h2>
        <ul id="alertRows" class="alertList"></ul>
        <div class="alertFeedFoot"><button id="clearAlerts" class="alertClearAll" type="button" hidden>Clear all</button></div>
      </section>
      <section class="discoveries" data-page="triage">
        <div class="pageIntro sectionIntro">
          <div><h1>Review discoveries <span class="count" id="dcCount"></span></h1><p>Close Call found these frequencies. Listen, then add useful signals or dismiss the rest.</p></div>
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
          <div><h1>Channel library <span class="count" id="chCount"></span></h1></div>
          <button id="addBtn" class="primary">${btnIco("add")}Add channel</button>
        </div>
        <div class="chFilterBar">
          <label class="chFilter">
            <span class="visuallyHidden">Filter channels</span>
            <input id="chFilter" type="search" placeholder="Filter by name, frequency or tag…  (press /)" autocomplete="off" />
          </label>
          <span id="chFilterCount" class="hint"></span>
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
        <div id="dupPanel" class="dupPanel" hidden></div>
        <div class="tableWrap">
          <table class="chTable">
            <thead><tr>
              <th>Freq (MHz)</th><th>Name</th><th class="chAudible">Audible</th>
            </tr></thead>
            <tbody id="chRows"></tbody>
          </table>
        </div>
        <span id="chErr" class="err"></span>
        <div id="archiveRecommendations" class="archiveRecommendations"></div>
      </section>
      <div class="statRow" data-page="home" id="statRow"></div>
      <section class="insights" data-page="home">
        <h2>Insights <span class="hint" id="inPeriodHint"></span></h2>
        <div class="inToolbar">
          <button class="inPeriod" data-h="24">24 h</button>
          <button class="inPeriod" data-h="168">7 d</button>
          <button class="inPeriod" data-h="720">30 d</button>
        </div>
        <div id="inBody" class="inBody"></div>
      </section>
      <div class="pageIntro" data-page="scan">
        <div><h1>Scanner settings</h1><p>Each card saves on its own.</p></div>
      </div>
      <div class="settingsCards" data-page="scan">
      <details class="settingsCard tuning" open>
        <summary><h2>Scanning</h2><span class="cardHint">Dwell, squelch, and discovery</span></summary>
        <div class="cardBody">
        <div class="settingGroups">
          <label><span>Group dwell <small>Time spent on each frequency group</small></span><span class="inputUnit"><input id="tGroupDwell" type="number" min="500" step="100" placeholder="3000" /><b>ms</b></span></label>
          <label><span>Hang time <small>Wait after a transmission ends</small></span><span class="inputUnit"><input id="tHang" type="number" min="100" step="100" placeholder="2000" /><b>ms</b></span></label>
          <label><span>Squelch open <small>Signal level above the noise floor</small></span><span class="inputUnit"><input id="tOpenDb" type="number" min="1" step="0.5" placeholder="9" /><b>dB</b></span></label>
          <label><span>Quieting threshold <small>Absolute noise threshold</small></span><span class="inputUnit"><input id="tQuietDb" type="number" max="-1" step="0.5" placeholder="-86" /><b>dB</b></span></label>
          <label class="switchRow"><span>Close Call <small>Find strong nearby signals outside your channel list</small></span><input id="tCloseCall" type="checkbox" /></label>
          <label><span>Close Call threshold <small>Higher values reduce false discoveries</small></span><span class="inputUnit"><input id="tCloseCallDb" type="number" min="5" step="1" placeholder="15" /><b>dB</b></span></label>
          <label><span>Sweep ranges <small>Comma-separated MHz ranges; empty disables sweeping</small></span><input id="tSweep" type="text" placeholder="450-470, 150-162" title="Band-sweep: one empty-window stop per rotation hunts for activity inside these ranges" /></label>
        </div>
        <div class="formActions"><button id="tSave" class="primary">Save scanning</button><span id="tErr" class="err"></span></div>
        </div>
      </details>
      <details class="settingsCard alertsCard">
        <summary><h2>Alerts</h2><span class="cardHint">Cooldowns, notifications, SAME scope</span></summary>
        <div class="cardBody">
        <div class="settingGroups">
          <label><span>Alert cooldown <small>Minimum time before repeating an alert</small></span><span class="inputUnit"><input id="tAlertCool" type="number" min="1" step="1" placeholder="15" /><b>min</b></span></label>
          <label><span>Alert hold <small>How long an alert remains visible</small></span><span class="inputUnit"><input id="tAlertHold" type="number" min="5" step="5" placeholder="30" /><b>sec</b></span></label>
          <label><span>Push notification URL <small>Optional ntfy topic URL</small></span><input id="tAlertNtfy" type="text" placeholder="https://ntfy.sh/your-topic" /></label>
          <label><span>SAME county codes <small>Comma-separated FIPS codes; empty allows all</small></span><input id="tSameFips" type="text" placeholder="029047, 029095" title="County FIPS codes for SAME/EAS scoping — 5-digit SSCCC or 6-digit PSSCCC" /></label>
          <label class="switchRow"><span>Show SAME tests <small>Include weekly and monthly test banners</small></span><input id="tSameTests" type="checkbox" /></label>
        </div>
        <div class="formActions"><button id="alSave" class="primary">Save alerts</button><span id="alErr" class="err"></span></div>
        </div>
      </details>
      <details class="settingsCard weather">
        <summary><h2>Weather channel</h2><span class="cardHint">NOAA channel for weather-only mode</span></summary>
        <div class="cardBody">
        <div class="settingGroups">
          <label><span>Channel <small>Local NOAA transmitter</small></span><select id="wxFreq">${NOAA_CHANNELS.map((c) => `<option value="${c.mhz}">${c.label} — ${c.mhz} MHz</option>`).join("")}</select></label>
          <label><span>Name</span><input id="wxTag" type="text" placeholder="NOAA WX" /></label>
          <label><span>Mode</span><select id="wxMode"><option value="nfm">NFM</option><option value="fm">FM</option><option value="am">AM</option></select></label>
        </div>
        <div class="formActions"><button id="wxSave" class="primary">Save weather channel</button><span id="wxErr" class="err"></span></div>
        </div>
      </details>
      <details class="settingsCard integrations">
        <summary><h2>Integrations</h2><span class="cardHint">Google Maps for the activity map</span></summary>
        <div class="cardBody">
        <div class="settingGroups">
          <label><span>Google Maps key</span><input id="tMapsKey" type="text" placeholder="AIza…" /></label>
          <label><span>Google Maps Map ID</span><input id="tMapsMapId" type="text" placeholder="Optional vector map ID" /></label>
        </div>
        <div class="formActions"><button id="igSave" class="primary">Save integrations</button><span id="igErr" class="err"></span></div>
        </div>
      </details>
      </div>
      <div class="pageIntro" data-page="system">
        <div><h1>Appliance</h1></div>
      </div>
      <section class="sysHealth" data-page="system">
        <h2>System health</h2>
        <div id="sysBody"></div>
      </section>
      <section class="systemCard" data-page="system">
        <h2>Kiosk &amp; radio actions</h2>
        <div class="actionGroup">
          <h3 class="actionGroupLabel">Kiosk screen</h3>
          <div class="systemActions">
            <button id="kioskReload" title="Refresh the display page and reload its map and frontend assets">Refresh kiosk screen</button>
            <button id="testAlert" title="Show a sample weather-alert banner on the kiosk (for design + verifying alerts work)">Test weather alert</button>
            <button id="testAlertClear" title="Clear the test weather-alert banner from the kiosk">Clear alert</button>
            <span id="kioskActionStatus" class="hint" role="status"></span>
          </div>
        </div>
        <div class="actionGroup power">
          <h3 class="actionGroupLabel">Power</h3>
          <p class="hint actionGroupNote">These take the radio off air.</p>
          <div class="systemActions">
            <button id="backendRestart" class="danger" title="Restart the radio backend and scanner helpers">Restart radio backend</button>
            <button id="systemReboot" class="danger" title="Reboot the whole appliance">Reboot appliance</button>
            <button id="systemShutdown" class="danger" title="Power the appliance off — it stays off until someone presses its power button">Shut down appliance</button>
          </div>
          <span id="systemActionStatus" class="hint" role="status"></span>
        </div>
      </section>
      <section class="lockouts" data-page="system">
        <h2>Close Call lockouts</h2>
        <details class="lockoutsBox">
          <summary>Locked-out frequencies <span id="loCount" class="count"></span></summary>
          <div id="loList" class="loChips"></div>
        </details>
      </section>
      </div>
      </div>
    <div id="toastHost" class="toastHost" role="status" aria-live="polite"></div>
    <div id="drawerScrim" class="drawerScrim"></div>
    <aside id="chDrawer" class="drawer" role="dialog" aria-modal="true" aria-label="Channel details" aria-hidden="true" inert></aside>
    <dialog id="confirmDialog" class="confirmDialog" aria-labelledby="confirmTitle" aria-describedby="confirmMessage">
      <form method="dialog">
        <h2 id="confirmTitle"></h2>
        <p id="confirmMessage"></p>
        <div class="confirmActions">
          <button value="cancel">Cancel</button>
          <button id="confirmAction" value="confirm">Confirm</button>
        </div>
      </form>
    </dialog>
    </main>`;

  // ── Acknowledgement layer ───────────────────────────────────────────────
  // Destructive actions used to mutate, re-render, and say nothing. "Did that
  // work, and can I take it back?" had no answer anywhere in the app — and
  // lockout describes itself as permanent-until-unlocked, with the unlock list
  // on a different page inside a collapsed disclosure.
  // A fragment href would set location.hash, and this app is hash-routed —
  // the first control a keyboard user reaches would have navigated them to
  // Overview. Move focus directly instead.
  const skipLink = root.querySelector<HTMLButtonElement>(".skipLink")!;
  const adminPages = root.querySelector<HTMLElement>("#adminPages")!;
  skipLink.addEventListener("click", () => adminPages.focus());

  const toastHost = root.querySelector<HTMLElement>("#toastHost")!;
  /** How long an undo stays offered. */
  const TOAST_MS = 8000;
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function showToast(text: string, opts: { undo?: () => Promise<void>; ms?: number } = {}): void {
    if (toastTimer !== undefined) clearTimeout(toastTimer);
    toastHost.innerHTML = `<div class="toast"><span class="toastText">${esc(text)}</span>${
      opts.undo ? `<button type="button" class="toastUndo">Undo</button>` : ""
    }<button type="button" class="toastClose iconBtn" aria-label="Dismiss">${ICONS.dismiss}</button></div>`;
    toastHost.classList.add("on");
    const close = (): void => {
      toastHost.classList.remove("on");
      toastHost.innerHTML = "";
      if (toastTimer !== undefined) { clearTimeout(toastTimer); toastTimer = undefined; }
    };
    toastHost.querySelector<HTMLButtonElement>(".toastClose")!.addEventListener("click", close);
    const undo = opts.undo;
    if (undo) {
      const undoBtn = toastHost.querySelector<HTMLButtonElement>(".toastUndo")!;
      undoBtn.addEventListener("click", async () => {
        // Keep the toast mounted until the write settles. Tearing it down
        // first meant a rejected undo (the 409 guard makes that reachable)
        // destroyed the only affordance for retrying it.
        if (toastTimer !== undefined) { clearTimeout(toastTimer); toastTimer = undefined; }
        undoBtn.disabled = true;
        undoBtn.textContent = "Undoing…";
        try {
          await undo();
          close();
          showToast("Undone.");
        } catch (e) {
          undoBtn.disabled = false;
          undoBtn.textContent = "Undo";
          const line = toastHost.querySelector<HTMLElement>(".toastText");
          if (line) line.textContent = (e as Error).message;
          toastTimer = setTimeout(close, opts.ms ?? TOAST_MS);
        }
      });
    }
    toastTimer = setTimeout(close, opts.ms ?? TOAST_MS);
  }

  /** Read-modify-write against the live config, surfacing a rejected write
   *  (409 from the optimistic-concurrency guard) instead of failing silently. */
  async function editConfig(mutate: (cfg: Config) => void): Promise<void> {
    try {
      const cfg = await api.getConfig();
      mutate(cfg);
      await api.putConfig(cfg);
    } catch (e) {
      showToast((e as Error).message);
      throw e;
    }
  }

  /** Field-level status line. Success used to be written as the literal string
   *  "saved" into the same `.err` span styled `color: var(--red)` — so every
   *  successful save flashed the failure colour and then stayed on screen,
   *  making the NEXT save unverifiable. Mirrors setSystemActionStatus below. */
  const fieldStatusTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
  function setFieldStatus(el: HTMLElement, text: string, kind: "ok" | "err", clearAfterMs?: number): void {
    const pending = fieldStatusTimers.get(el);
    if (pending !== undefined) { clearTimeout(pending); fieldStatusTimers.delete(el); }
    el.textContent = text;
    el.classList.toggle("ok", kind === "ok");
    el.classList.toggle("err", kind === "err");
    if (clearAfterMs !== undefined && text !== "") {
      fieldStatusTimers.set(el, setTimeout(() => {
        el.textContent = "";
        fieldStatusTimers.delete(el);
      }, clearAfterMs));
    }
  }
  /** How long a green "Saved" lingers before clearing itself. */
  const SAVED_MESSAGE_MS = 4000;

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

  // ── Admin IA (ROADMAP Idea 15): config is a destination, monitoring is
  // the landing. Pure re-layout — all sections stay wired as before; the
  // route only decides which data-page group is visible. Unknown = home.
  const ROUTES = new Set(["home", "triage", "channels", "scan", "system"]);
  const NAV_ICONS: Record<string, string> = {
    home: icoGauge, triage: icoInbox, channels: icoList, scan: icoSliders, system: icoWrench,
  };
  root.querySelectorAll<HTMLElement>(".navIco").forEach((el) => {
    el.innerHTML = NAV_ICONS[el.dataset.ico!] ?? "";
  });
  function currentRoute(): string {
    let r = location.hash.replace(/^#\/?/, "") || "home";
    if (r === "banks") r = "channels";   // pre-unification bookmarks survive
    return ROUTES.has(r) ? r : "home";
  }

  // ── Polling budget ──────────────────────────────────────────────────────
  // This box runs ~1 °C under its thermal trip and deadlocks on concurrent
  // requests, so the admin polls politely: one request group in flight at a
  // time, nothing while the tab is hidden, and nothing for a page the operator
  // isn't looking at. Before this, /api/system alone rebuilt six sparklines
  // every 3 s on all five routes — 1200 requests an hour, ~95% of them
  // repainting `display:none`.
  //
  // These are the tuning knobs; each poll declares which routes it feeds.
  const POLL_MS = {
    systemGauges: 3_000,   // System page: live CPU/temp gauges
    systemBanner: 30_000,  // Overview: just the health banner, no gauges
    discoveries: 15_000,   // triage table + audio-control sync
    analytics: 5_000,      // only while an analytics drawer is open
    insights: 60_000,
    statTiles: 60_000,
    alertFeed: 60_000,
  };
  const POLL_TICK_MS = 1_000;

  type Poll = {
    run: () => Promise<void>;
    everyMs: number;
    pages?: string[];
    when?: () => boolean;
    lastAt: number;
  };
  const polls: Poll[] = [];
  function poll(p: Omit<Poll, "lastAt">): void { polls.push({ ...p, lastAt: 0 }); }

  let ticking = false;
  async function tick(): Promise<void> {
    if (ticking || document.hidden) return;
    ticking = true;
    try {
      const route = currentRoute();
      for (const p of polls) {
        if (document.hidden) break;
        if (p.pages && !p.pages.includes(route)) continue;
        if (p.when && !p.when()) continue;
        if (Date.now() - p.lastAt < p.everyMs) continue;
        p.lastAt = Date.now();
        // Sequential on purpose — see the deadlock note above.
        await p.run().catch(() => {});
      }
    } finally { ticking = false; }
  }
  /** Make every poll feeding `route` due now, so a page is never stale on
   *  arrival just because its cadence is 60 s. */
  function refreshPollsFor(route: string): void {
    for (const p of polls) if (!p.pages || p.pages.includes(route)) p.lastAt = 0;
    void tick();
  }
  function applyRoute(): void {
    const route = currentRoute();
    const titles: Record<string, string> = { home: "Overview", triage: "Triage", channels: "Channels", scan: "Settings", system: "System" };
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
    refreshPollsFor(route);
  }
  window.addEventListener("hashchange", applyRoute);
  applyRoute();
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) refreshPollsFor(currentRoute());
  });

  // Any click/tap outside an open bank menu closes it.
  document.addEventListener("click", (ev) => {
    root.querySelectorAll<HTMLDetailsElement>(".bankMenu[open]").forEach((menu) => {
      if (menu.contains(ev.target as Node)) return;
      // Read BEFORE closing: collapsing a <details> makes its contents
      // non-rendered and drops focus to <body>, so testing afterwards is
      // always false.
      const hadFocus = menu.contains(document.activeElement);
      menu.open = false;
      if (hadFocus) menu.querySelector<HTMLElement>("summary")?.focus();
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
      message: "This stops the frequency being scanned or Close-Called. "
        + "The channel is archived, not deleted — unlock restores it.",
      confirmLabel: "Lock out",
      danger: true,
    });
    if (!confirmed) return;
    // `unlockFreqIn` is the operator-facing "unlock", not the inverse of this
    // action: lockoutFreqIn also DROPS every pending discovery at the
    // frequency (with its hit count and any location the lookup chain paid
    // for), and unlock force-enables channels that may have been archived
    // beforehand. Snapshot both so Undo restores what was actually there.
    let droppedDiscoveries: Discovery[] = [];
    const priorEnabled = new Map<string, boolean>();
    await editConfig((cfg) => {
      droppedDiscoveries = (cfg.discoveries ?? []).filter((d) => d.freq === freq);
      for (const c of cfg.channels) if (c.freq === freq) priorEnabled.set(c.id, c.enabled);
      Object.assign(cfg, lockoutFreqIn(cfg, freq));
    });
    await refresh();
    void renderDiscoveries();
    void renderLockouts();
    showToast(`Locked out ${label}.`, {
      undo: async () => {
        await editConfig((cfg) => {
          cfg.scan = { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== freq) };
          cfg.channels = cfg.channels.map((c) =>
            priorEnabled.has(c.id) ? { ...c, enabled: priorEnabled.get(c.id)! } : c);
          if (droppedDiscoveries.length) {
            cfg.discoveries = [...(cfg.discoveries ?? []), ...droppedDiscoveries];
          }
        });
        await refresh();
        void renderDiscoveries();
        void renderLockouts();
      },
    });
  }

  // ── Banks: toggleable predicates over band/tags (ROADMAP Idea 1) ──
  const bkErr = root.querySelector<HTMLElement>("#bkErr")!;

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
  // Persisted: this used to be a plain local, so a 7d/30d selection silently
  // reverted to 24h on the next route change.
  const IN_HOURS_KEY = "kerchunk.admin.insightHours";
  let inHours = Number(localStorage.getItem(IN_HOURS_KEY)) || 24;

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

    // Glance first (spec 2026-07-16 polish): a headline and the hour clock
    // are the take-away; the full table lives behind one disclosure.
    const busiest = st.topChannels[0];
    const wasOpen = inBody.querySelector<HTMLDetailsElement>(".inBreakdown")?.open ?? false;
    inBody.innerHTML = `
      <div class="inTotals">
        <span><b>${st.totalHits}</b> hits</span>
        <span><b>${fmtAir(st.totalAirtimeMs)}</b> airtime</span>
        <span><b>${st.discoveries}</b> close calls</span>
        <span class="inBusiest">${busiest ? `busiest <b>${esc(busiest.alphaTag) || fmtFreq(busiest.freq)}</b>` : "quiet band"}</span>
      </div>
      <div class="inClock" title="activity by hour of day">
        ${st.byHour.map((n, h) => `<div class="inHr${h === nowHour ? " now" : ""}" style="height:${Math.max(4, (n / maxHour) * 100).toFixed(0)}%" title="${String(h).padStart(2, "0")}:00 — ${n}"></div>`).join("")}
      </div>
      <details class="inBreakdown"${wasOpen ? " open" : ""}>
        <summary>Show breakdown</summary>
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
        </div>
      </details>`;
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
    b.addEventListener("click", () => {
      inHours = Number(b.dataset.h);
      localStorage.setItem(IN_HOURS_KEY, String(inHours));
      void renderInsights();
    }));
  poll({ run: renderInsights, everyMs: POLL_MS.insights, pages: ["home"] });

  // ── Home stat tiles (Idea 15): the glance numbers. One /api/stats(24h)
  // + config fetch feeds all four tiles and the hour clock.
  const statRow = root.querySelector<HTMLElement>("#statRow")!;
  function fmtAirShort(ms: number): string {
    const m = Math.round(ms / 60000);
    return m >= 60 ? `${(m / 60).toFixed(1)}h` : `${m}m`;
  }
  async function renderStatTiles(): Promise<void> {
    const since = Date.now() - 24 * 3600 * 1000;
    // Sequential, not Promise.all: three at once is exactly the concurrency
    // the appliance has been observed to deadlock on.
    const stats = await fetch(`/api/stats?since=${since}`).then((r) => r.json());
    const cfg = await api.getConfig();
    const alerts = await fetch(`/api/history?kind=alert&since=${since}&limit=200`)
      .then((r) => (r.ok ? r.json() : []));
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
    // `attention` is the only tile colouring its number, and only when there is
    // something to do. Everything else here is a 24-hour count — history, not
    // live state — so it stays in ink and lets size carry the hierarchy.
    const tile = (label: string, value: string, sub: string, href?: string, attention = false) =>
      `<${href ? `a href="${href}"` : "div"} class="statTile${attention ? " needsAttention" : ""}">
        <div class="stLabel">${label}</div>
        <div class="stValue">${value}</div>
        <div class="stSub">${sub}</div>
      </${href ? "a" : "div"}>`;
    statRow.innerHTML =
      tile("Hits · 24h", String(stats.totalHits), `${stats.topChannels[0] ? esc(stats.topChannels[0].alphaTag) + " leads" : "quiet band"}`)
      + tile("Airtime", fmtAirShort(stats.totalAirtimeMs), `${stats.discoveries} close call${stats.discoveries === 1 ? "" : "s"} heard`)
      + tile("Triage queue", String(pending), pending > 0 ? `${pending} to review` : "nothing pending", "#/triage", pending > 0)
      + tile("Alerts · 24h", String((alerts as unknown[]).length), "bell and SAME")
      + `<div class="statTile clockTile">
          <div class="stLabel">Activity by hour</div>
          <div class="hourClock" role="img" aria-label="${total === 0 ? "No traffic yet today" : `${total} hits today, busiest around ${String(peak).padStart(2, "0")}:00`}">${clock}</div>
        </div>`;
  }
  poll({ run: renderStatTiles, everyMs: POLL_MS.statTiles, pages: ["home"] });

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
  poll({ run: renderAlertFeed, everyMs: POLL_MS.alertFeed, pages: ["home"] });

  // ── System health (Idea 16): gauges + sparklines off /api/system.
  const sysBody = root.querySelector<HTMLElement>("#sysBody")!;
  const healthBanner = root.querySelector<HTMLElement>("#healthBanner")!;
  let lastHealthSig = "";
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
    // Only rewrite when the alert set actually changed: this is a polite live
    // region, so an unconditional innerHTML write re-announced the same text
    // every poll for as long as the condition persisted.
    // Guard only the BANNER write — the gauges below must keep updating every
    // poll, so this must not short-circuit the rest of the function.
    const healthSig = `${safetyMode}|${alerts.map((a) => `${a.id}:${a.severity}`).join(",")}`;
    if (healthSig !== lastHealthSig) {
      lastHealthSig = healthSig;
      healthBanner.innerHTML = alerts.length ? `${safetyMode ? `<div class="safetyMode"><strong>Protection active:</strong> Close Call and sweep ranges are paused until temperature recovers.</div>` : ""}${alerts.map((a) => `<div class="healthAlert">
        <div><strong>${esc(a.title)}</strong><span>${esc(a.message)}</span><small>${esc(a.help)}</small></div>
        ${a.id.startsWith("cpu-") || a.id.startsWith("memory-") ? `<a href="#/scan">Reduce processing load</a>` : ""}
      </div>`).join("")}` : "";
    }
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
    // Always open: health has its own page now — no disclosure to manage.
    sysBody.innerHTML =
      `<div class="healthVerdict ${health.verdict}">
         <span class="verdictDot"></span>
         <span class="verdictLabel">${health.verdict.toUpperCase()}</span>
         <span class="verdictReason">${esc(health.reason)}</span>
       </div>
       <div class="sysGrid">${cells}</div>`;
  }
  // renderSystem writes two things: the gauges on the System page and the
  // health banner on Overview. The gauges want live cadence; the banner does
  // not — so the same function runs at two rates depending on where you are.
  poll({ run: renderSystem, everyMs: POLL_MS.systemGauges, pages: ["system"] });
  poll({ run: renderSystem, everyMs: POLL_MS.systemBanner, pages: ["home"] });
  poll({
    run: () => renderAnalyticsDrawer(analyticsFreq!),
    everyMs: POLL_MS.analytics,
    when: () => drawerKind === "analytics" && analyticsFreq !== null,
  });

  // Channel table: read-only rows (freq · name · audible toggle); all other
  // edits happen in the drawer, the single editor (spec 2026-07-16 admin IA).
  let channels: Channel[] = [];
  let banksCache: Bank[] = [];
  // Collapsed bank groups (persisted like the collapsible modules).
  const GROUPS_KEY = "kerchunk.admin.banksCollapsed";
  const collapsedBanks = readStoredStringSet(localStorage.getItem(GROUPS_KEY), []);

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

  // The caret is a real button (it was a click-wired <span>, so collapsing a
  // bank was mouse-only) and reports its state to assistive tech.
  function caret(key: string, label: string): string {
    const open = !collapsedBanks.has(key);
    // The drawn `.chev` rotates off aria-expanded, so state lives in one place
    // instead of in a pair of swapped characters.
    return `<button type="button" class="bkCaret" aria-expanded="${open}" aria-label="${open ? "Collapse" : "Expand"} ${label}"><span class="chev"></span></button>`;
  }

  function bankHeaderRow(g: BankGroup): string {
    if (!g.bank) {
      return `<tr class="bankRow" data-bank="unbanked">
        <td colspan="3"><div class="bkRowInner">${caret("unbanked", "unbanked channels")}
        <span class="bkName">UNBANKED</span> <span class="bankCount">${g.channels.length}</span>
        <span class="hint">matches no bank — tag these or add a bank that covers them</span></div></td>
      </tr>`;
    }
    const b = g.bank;
    const audibleCount = g.channels.filter((c) => c.enabled && c.audible !== false).length;
    const archivedCount = g.channels.filter((c) => !c.enabled).length;
    const summary = profileSummary(b);
    return `<tr class="bankRow" data-bank="${esc(b.id)}">
      <td colspan="3"><div class="bkRowInner">
        ${caret(b.id, esc(b.name))}
        <span class="bkName">${esc(b.name)}</span>
        <span class="bankCount">${g.channels.length}</span>
        <span class="bkSummary">${audibleCount} audible · ${archivedCount} archived${summary ? ` · ${summary}` : ""}</span>
        <details class="bankMenu">
          <summary aria-label="Actions for ${esc(b.name)}" title="Bank actions">${btnIco("more", "solo")}</summary>
          <div class="bankMenuList">
            <button class="bkBulkAudible" title="Make every channel in this collection audible">Make audible</button>
            <button class="bkBulkSilent" title="Keep tracking every channel but silence them">Make silent</button>
            <button class="bkBulkArchive" title="Stop tracking every channel in this collection">Archive all</button>
            <button class="bkAddCh" title="Add a channel into ${esc(b.name)}">Add channel here</button>
            <button class="bkGear" title="Squelch/dwell overrides for this bank">Scan profile</button>
            <button class="bkDel danger" title="Delete bank — its channels keep scanning">Delete bank</button>
          </div>
        </details>
      </div></td>
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
    // The chevron is the row's keyboard handle, not decoration: the drawer is
    // the only channel editor, so a mouse-only `td` click left it unreachable.
    // A real button gives one tab stop per row and its click bubbles to the
    // same `td.rowOpen` handler — no second code path to keep in sync.
    const name = esc(c.alphaTag) || fmtFreq(c.freq);
    return `<tr data-id="${esc(c.id)}">
      <td class="rowOpen">${fmtFreq(c.freq)}</td>
      <td class="rowOpen">${esc(c.alphaTag)}${c.alert ? `<span class="bellChip" title="Alerts on a hit">${ICONS.bell}</span>` : ""}${membershipChips(c)}${locChip(c.location)}<button type="button" class="rowChev" aria-label="Open ${name} details">${btnIco("chevron", "solo")}</button></td>
      <td class="chAudible"><input type="checkbox" class="audible" ${c.audible !== false ? "checked" : ""} aria-label="Audible — play ${name} through the speaker" title="Audible — play this channel through the speaker" /></td>
    </tr>`;
  }

  /** Free-text filter over the library. Matches name, frequency (as typed —
   *  "146.52" and "146520000" both work) and tags, so finding one channel in
   *  ninety-seven stops being a scroll. */
  function matchesFilter(c: Channel): boolean {
    const q = chFilterQuery.trim().toLowerCase();
    if (!q) return true;
    return c.alphaTag.toLowerCase().includes(q)
      || fmtFreq(c.freq).includes(q)
      || String(c.freq).includes(q)
      || (c.tags ?? []).some((t) => t.toLowerCase().includes(q));
  }

  function renderRows(): void {
    const visible = channels.filter(matchesFilter);
    const filtering = chFilterQuery.trim() !== "";
    chFilterCount.textContent = filtering
      ? `${visible.length} of ${channels.length}`
      : "";
    if (filtering && visible.length === 0) {
      chRows.innerHTML = `<tr><td colspan="3" class="empty">No channel matches “${esc(chFilterQuery)}”.</td></tr>`;
      return;
    }
    const groups = groupChannelsByBank(visible, banksCache);
    chRows.innerHTML =
      groups.map((g) => {
        const key = g.bank?.id ?? "unbanked";
        // While filtering, collapsed banks open themselves — a hidden match is
        // indistinguishable from no match.
        const body = collapsedBanks.has(key) && !filtering
          ? ""
          : g.channels.map(displayRow).join("");
        return bankHeaderRow(g) + body;
      }).join("") +
      (channels.length === 0
        ? `<tr><td colspan="3" class="empty">No channels yet — use Add channel above.</td></tr>` : "");
    wireRows();
    wireBankRows();
  }

  function wireRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr").forEach((tr) => {
      const id = tr.dataset.id;
      if (!id) return;
      tr.querySelectorAll<HTMLElement>(".rowOpen").forEach((cell) =>
        cell.addEventListener("click", () => openDrawer("channel", id)));
      tr.querySelector<HTMLInputElement>(".audible")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { audible: (ev.target as HTMLInputElement).checked });
        await refresh();
      });
    });
  }

  function wireBankRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr.bankRow").forEach((tr) => {
      const id = tr.dataset.bank!;
      const menu = tr.querySelector<HTMLDetailsElement>(".bankMenu");
      // One menu open at a time across the table.
      menu?.addEventListener("toggle", () => {
        if (!menu.open) return;
        chRows.querySelectorAll<HTMLDetailsElement>(".bankMenu[open]").forEach((o) => {
          if (o !== menu) o.open = false;
        });
      });
      const closeMenu = () => { if (menu) menu.open = false; };
      tr.querySelector<HTMLElement>(".bkCaret")?.addEventListener("click", () => {
        if (collapsedBanks.has(id)) collapsedBanks.delete(id);
        else collapsedBanks.add(id);
        localStorage.setItem(GROUPS_KEY, JSON.stringify([...collapsedBanks]));
        renderRows();
      });
      if (id === "unbanked") return;
      const bulk = async (patch: Partial<Pick<Channel, "enabled" | "audible">>, label: string) => {
        // Snapshot the exact prior state of every channel this touches, so the
        // undo restores what was there rather than guessing a default.
        const before = new Map<string, Pick<Channel, "enabled" | "audible">>();
        let touched = 0;
        await editConfig((cfg) => {
          const bank = (cfg.banks ?? []).find((x) => x.id === id);
          if (!bank) return;
          cfg.channels = cfg.channels.map((c) => {
            if (!matchesBank(c, bank)) return c;
            before.set(c.id, { enabled: c.enabled, audible: c.audible });
            touched++;
            return { ...c, ...patch };
          });
        });
        await refresh();
        if (touched === 0) return;
        showToast(`${label} — ${touched} channel${touched === 1 ? "" : "s"}.`, {
          undo: async () => {
            await editConfig((cfg) => {
              cfg.channels = cfg.channels.map((c) => {
                const prev = before.get(c.id);
                return prev ? { ...c, ...prev } : c;
              });
            });
            await refresh();
          },
        });
      };
      tr.querySelector<HTMLButtonElement>(".bkBulkAudible")?.addEventListener("click", () => { closeMenu(); void bulk({ enabled: true, audible: true }, "Made audible"); });
      tr.querySelector<HTMLButtonElement>(".bkBulkSilent")?.addEventListener("click", () => { closeMenu(); void bulk({ enabled: true, audible: false }, "Silenced"); });
      tr.querySelector<HTMLButtonElement>(".bkBulkArchive")?.addEventListener("click", async () => {
        closeMenu();
        const b = banksCache.find((x) => x.id === id);
        if (!b || !await confirmAdminAction({
          title: `Archive every channel in ${b.name}?`,
          message: "Archived channels stop consuming scanner capacity but keep their identity and location.",
          confirmLabel: "Archive channels",
        })) return;
        await bulk({ enabled: false }, "Archived");
      });
      tr.querySelector<HTMLButtonElement>(".bkGear")?.addEventListener("click", () => {
        closeMenu();
        const b = banksCache.find((x) => x.id === id);
        if (b) openBankProfile(b);
      });
      tr.querySelector<HTMLButtonElement>(".bkAddCh")?.addEventListener("click", () => {
        closeMenu();
        const b = banksCache.find((x) => x.id === id);
        openChannelEditor(undefined, b?.tags?.length ? [b.tags[0]!] : []);
      });
      tr.querySelector<HTMLButtonElement>(".bkDel")?.addEventListener("click", async () => {
        closeMenu();
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

  const chCount = root.querySelector<HTMLElement>("#chCount")!;
  const chFilterEl = root.querySelector<HTMLInputElement>("#chFilter")!;
  const chFilterCount = root.querySelector<HTMLElement>("#chFilterCount")!;
  let chFilterQuery = "";
  chFilterEl.addEventListener("input", () => { chFilterQuery = chFilterEl.value; renderRows(); });
  // "/" focuses the filter from anywhere on the Channels page, the way every
  // list-heavy tool the operator already uses behaves.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "/" || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (currentRoute() !== "channels") return;
    ev.preventDefault();
    chFilterEl.focus();
    chFilterEl.select();
  });
  // ── Channel drawer: full dossier + the editor (edit left the table rows).
  const drawer = root.querySelector<HTMLElement>("#chDrawer")!;
  const scrim = root.querySelector<HTMLElement>("#drawerScrim")!;
  let drawerId: string | null = null;
  let drawerKind: "channel" | "discovery" | "analytics" | "bank" = "channel";
  let analyticsFreq: number | null = null;
  // New-channel mode: tags preset by the bank whose menu opened the editor.
  let drawerPresetTags: string[] = [];

  // The drawer is visually modal (a scrim covers the page), so it has to be
  // modal to the keyboard too. Off-screen `transform` alone left every drawer
  // control in the tab order after a close — focus landed on invisible Save /
  // Lock out buttons. `inert` on the drawer when shut, and on the page behind
  // it when open, keeps the tab ring where the eye is.
  // aria-modal="true" tells assistive tech to ignore everything outside the
  // drawer, so everything outside it must actually be inert — including the
  // toast and skip link this pass added.
  const inertWhileOpen = [
    root.querySelector<HTMLElement>(".skipLink")!,
    root.querySelector<HTMLElement>(".adminHead")!,
    root.querySelector<HTMLElement>(".workspace")!,
    root.querySelector<HTMLElement>("#toastHost")!,
  ];
  let drawerReturnFocus: HTMLElement | null = null;

  function closeDrawer(): void {
    drawerId = null;
    // Clear the analytics-poll state too: the 5 s interval keys off
    // drawerKind/analyticsFreq, so leaving them set kept fetching history and
    // rewriting the hidden drawer every 5 s forever after the drawer closed.
    drawerKind = "channel";
    analyticsFreq = null;
    drawer.classList.remove("open");
    scrim.classList.remove("open");
    drawer.inert = true;
    drawer.setAttribute("aria-hidden", "true");
    for (const el of inertWhileOpen) el.inert = false;
    drawer.innerHTML = "";
    drawerReturnFocus?.focus();
    drawerReturnFocus = null;
  }

  /** Reveal the drawer after its content is rendered: un-inert it, put the
   *  page behind it out of reach, and move focus to the close button so the
   *  panel is usable without a mouse. */
  function showDrawer(): void {
    drawerReturnFocus = document.activeElement as HTMLElement | null;
    drawer.inert = false;
    drawer.removeAttribute("aria-hidden");
    drawer.classList.add("open");
    scrim.classList.add("open");
    for (const el of inertWhileOpen) el.inert = true;
    drawer.querySelector<HTMLButtonElement>(".dwClose")?.focus();
  }

  function openDrawer(kind: "channel" | "discovery", id: string): void {
    drawerKind = kind;
    drawerId = id;
    renderDrawer();
    showDrawer();
  }

  // The drawer is the ONLY channel editor (spec 2026-07-16 admin IA).
  // No argument = new channel; presetTags seed the Tags field so a channel
  // added from a bank's menu actually matches that bank.
  function openChannelEditor(c?: Channel, presetTags: string[] = []): void {
    drawerPresetTags = presetTags;
    drawerKind = "channel";
    drawerId = c?.id ?? "new";
    renderDrawer();
    showDrawer();
  }

  function openBankProfile(b: Bank): void {
    drawerKind = "bank";
    drawerId = b.id;
    renderDrawer();
    showDrawer();
  }

  function openAnalytics(freq: number): void {
    drawerKind = "analytics";
    analyticsFreq = freq;
    drawerId = `analytics_${freq}`;
    // Analytics renders async — reveal first so the panel doesn't pop in, then
    // move focus once the close button actually exists.
    showDrawer();
    void renderAnalyticsDrawer(freq).then(() =>
      drawer.querySelector<HTMLButtonElement>(".dwClose")?.focus());
  }

  function renderDrawer(): void {
    if (drawerKind === "discovery") { renderDiscoveryDrawer(); return; }
    if (drawerKind === "analytics") { if (analyticsFreq) void renderAnalyticsDrawer(analyticsFreq); return; }
    if (drawerKind === "bank") { renderBankProfileDrawer(); return; }
    const c = drawerId === "new" ? undefined : channels.find((x) => x.id === drawerId);
    if (drawerId !== "new" && !c) { closeDrawer(); return; }
    renderChannelDrawer(c);
  }

  // One form for edit and create: `c` undefined = new channel. The dossier
  // (freq hero, info list, Listen/Lock out) only renders for existing rows.
  function renderChannelDrawer(c?: Channel): void {
    const loc = c?.location;
    drawer.innerHTML = `
      <header class="dwHead">
        <h3>${c ? esc(c.alphaTag) || fmtFreq(c.freq) : "New channel"}</h3>
        ${iconBtn("dwClose", "dismiss", "Close")}
      </header>
      ${c ? `<div class="dwFreq">${fmtFreq(c.freq)}<span class="dwUnit">MHz</span></div>` : ""}
      <div class="dwForm">
        <div class="dwSection">Identity</div>
        <label class="dwRow"><span>Freq <small>MHz</small></span><input id="dwMhz" value="${c ? fmtFreq(c.freq) : ""}" placeholder="145.130" /></label>
        <label class="dwRow"><span>Name</span><input id="dwTag" value="${c ? esc(c.alphaTag) : ""}" placeholder="KC0KW — Gibbs Rd" /></label>
        <label class="dwRow"><span>Mode</span><select id="dwMode">${modeOptions(c?.mode ?? "nfm")}</select></label>
        <label class="dwRow"><span>Tags <small>Comma-separated — banks match on these</small></span><input id="dwTags" value="${esc((c ? c.tags ?? [] : drawerPresetTags).join(", "))}" placeholder="air, rail, ham" /></label>
        <label class="dwRow"><span>Site <small>Transmitter lat, lon — drives the map blip</small></span><input id="dwLoc" value="${c?.location?.lat != null ? `${c.location.lat}, ${c.location.lon}` : ""}" placeholder="39.1755, -94.4861" /></label>
        <div class="dwSection">Behavior</div>
        <label class="dwRow switchRow"><span>Audible <small>Play through the speaker</small></span><input id="dwAudible" type="checkbox" ${!c || c.audible !== false ? "checked" : ""} /></label>
        <label class="dwRow switchRow"><span>Priority <small>Preempts other channels in its group</small></span><input id="dwPrio" type="checkbox" ${c?.priority ? "checked" : ""} /></label>
        <label class="dwRow switchRow"><span>Alert on hit <small>Flashes the kiosk and lands in the alert feed</small></span><input id="dwAlert" type="checkbox" ${c?.alert ? "checked" : ""} /></label>
        <label class="dwRow switchRow"><span>Archived <small>Keep identity and location, stop scanning</small></span><input id="dwArchived" type="checkbox" ${c && !c.enabled ? "checked" : ""} /></label>
        <div class="dwFooter">
          <button id="dwSave" class="primary">${c ? "Save" : "Add channel"}</button>
          ${c ? `<button id="dwListen" class="listen">Listen</button>
          <button id="dwLock" class="lock">Lock out</button>` : ""}
        </div>
        <span id="dwErr" class="err"></span>
      </div>
      ${c ? `<dl class="dwInfo">
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
      </dl>` : ""}`;
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
        let location = c?.location;
        if (locRaw === "") {
          location = undefined;
        } else {
          const m = locRaw.split(",").map((x) => Number(x.trim()));
          if (m.length === 2 && m.every(Number.isFinite)) {
            location = { ...(c?.location ?? {}), lat: m[0]!, lon: m[1]!, source: "operator" };
          } else {
            throw new Error("site must be 'lat, lon'");
          }
        }
        const patch = {
          location,
          ...base,
          tags: drawer.querySelector<HTMLInputElement>("#dwTags")!.value
            .split(",").map((t) => t.trim()).filter(Boolean),
          priority: drawer.querySelector<HTMLInputElement>("#dwPrio")!.checked,
          alert: drawer.querySelector<HTMLInputElement>("#dwAlert")!.checked,
          enabled: !drawer.querySelector<HTMLInputElement>("#dwArchived")!.checked,
          audible: drawer.querySelector<HTMLInputElement>("#dwAudible")!.checked,
        };
        if (c) {
          await api.updateChannel(c.id, patch);
          await refresh();
          setFieldStatus(err, "Saved", "ok", SAVED_MESSAGE_MS);
        } else {
          await api.addChannel(patch);
          closeDrawer();
          await refresh();
        }
      } catch (e) { err.textContent = (e as Error).message; }
    });
    if (c) {
      drawer.querySelector<HTMLButtonElement>("#dwListen")!.addEventListener("click", () =>
        api.monitor(c.freq, c.alphaTag || fmtFreq(c.freq)));
      drawer.querySelector<HTMLButtonElement>("#dwLock")!.addEventListener("click", async () => {
        await lockoutFreq(c.freq, c.alphaTag || fmtFreq(c.freq));
        closeDrawer();
      });
    }
  }

  // Bank scan profile in the drawer — the same side-panel pattern channels
  // use, replacing the box that used to inject at the top of the page.
  function renderBankProfileDrawer(): void {
    const b = banksCache.find((x) => x.id === drawerId);
    if (!b) { closeDrawer(); return; }
    const num = (v: number | undefined) => (v !== undefined ? String(v) : "");
    drawer.innerHTML = `
      <header class="dwHead">
        <h3>${esc(b.name)} — scan profile</h3>
        ${iconBtn("dwClose", "dismiss", "Close")}
      </header>
      <div class="dwForm">
        <div class="dwSection">Scan profile</div>
        <p class="dwHelp">Overrides for this bank's channels. Empty fields inherit the global scanning settings.</p>
        <label class="dwRow"><span>Squelch open <small>dB over the noise floor</small></span><input id="bpOpen" type="number" min="1" step="0.5" value="${num(b.openAboveFloorDb)}" placeholder="global" /></label>
        <label class="dwRow"><span>Quieting threshold <small>dB</small></span><input id="bpQuiet" type="number" max="-1" step="0.5" value="${num(b.noiseQuietDb)}" placeholder="global" /></label>
        <label class="dwRow"><span>Hang time <small>ms after a transmission ends</small></span><input id="bpHang" type="number" min="100" step="100" value="${num(b.hangMs)}" placeholder="global" /></label>
        <label class="dwRow"><span>Dwell weight <small>2 = twice the park time, 0.5 = half</small></span><input id="bpDwell" type="number" min="0.1" step="0.1" value="${num(b.dwellWeight)}" placeholder="1" /></label>
        <div class="dwFooter"><button id="bpSave" class="primary">Save profile</button></div>
        <span id="bpErr" class="err"></span>
      </div>`;
    drawer.querySelector<HTMLButtonElement>(".dwClose")!.addEventListener("click", closeDrawer);
    const val = (sel: string): number | undefined => {
      const raw = drawer.querySelector<HTMLInputElement>(sel)!.value.trim();
      return raw === "" ? undefined : Number(raw);
    };
    drawer.querySelector<HTMLButtonElement>("#bpSave")!.addEventListener("click", async () => {
      const err = drawer.querySelector<HTMLElement>("#bpErr")!;
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
        closeDrawer();
        await refresh();
      } catch (e) { err.textContent = (e as Error).message; }
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
      await mutateDiscovery(d.id, () => {}, { text: (x) => `Dismissed ${x.alphaTag}.` });
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
    // Sequential: see the concurrency note on the polling budget.
    const chs = await api.getChannels();
    const cfg = await api.getConfig();
    channels = chs;
    banksCache = cfg.banks ?? [];
    chCount.textContent = String(channels.length);
    renderRows();
    await renderArchiveRecommendations().catch(() => {});
    await renderDuplicates().catch(() => {});
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
      if (!await confirmAdminAction({
        title: `Delete ${total} duplicate row${total === 1 ? "" : "s"}?`,
        message: "The most complete row for each frequency is kept. GMRS frequencies are never affected. This cannot be undone.",
        confirmLabel: `Delete ${total === 1 ? "row" : "rows"}`,
        danger: true,
      })) return;
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
      const id = b.dataset.id!;
      const name = recs.find((c) => c.id === id)?.alphaTag ?? "channel";
      await api.updateChannel(id, { enabled: false });
      await refresh();
      showToast(`Archived ${name}.`, {
        undo: async () => { await api.updateChannel(id, { enabled: true }); await refresh(); },
      });
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

  async function mutateDiscovery(
    id: string,
    fn: (cfg2: Awaited<ReturnType<typeof api.getConfig>>, d: Discovery) => void,
    toast?: { text: (d: Discovery) => string; undoable?: boolean },
  ): Promise<void> {
    let removed: Discovery | undefined;
    // `fn` may ALSO add a channel (promoteDiscovery does). An undo that only
    // put the discovery back left the promoted channel in place — and because
    // promoteDiscovery derives a deterministic id from the discovery id, a
    // second Add then wrote two channels sharing one id. Snapshot the channel
    // ids that existed before `fn` ran so the undo can reverse both halves.
    let idsBefore: Set<string> | undefined;
    await editConfig((cfg2) => {
      const d = (cfg2.discoveries ?? []).find((x) => x.id === id);
      if (!d) return;
      removed = d;
      idsBefore = new Set(cfg2.channels.map((c) => c.id));
      cfg2.discoveries = (cfg2.discoveries ?? []).filter((x) => x.id !== id);
      fn(cfg2, d);
    });
    if (!removed) return;
    await refresh();
    void renderDiscoveries();
    void renderLockouts();
    if (toast) {
      const gone = removed;
      const priorIds = idsBefore;
      showToast(toast.text(gone), toast.undoable === false ? {} : {
        undo: async () => {
          await editConfig((cfg2) => {
            cfg2.discoveries = [...(cfg2.discoveries ?? []), gone];
            // Drop anything `fn` added, so promote's undo is a real inverse.
            if (priorIds) cfg2.channels = cfg2.channels.filter((c) => priorIds.has(c.id));
          });
          await refresh();
          void renderDiscoveries();
        },
      });
    }
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
    // The empty state has to know WHY it is empty. It used to promise "Close
    // Call is hunting" even when config.scan.closeCall was false — the queue
    // was structurally incapable of filling and the page said otherwise.
    // (undefined means the engine default, which is ON.)
    const hunting = cfg.scan.closeCall !== false;
    const emptyCopy = hunting
      ? "Nothing pending — Close Call is hunting. New discoveries land here."
      : `Close Call is off, so no new discoveries will arrive. <a href="#/scan">Turn it on in Settings</a>`;
    dcRows.innerHTML = ds.length === 0
      ? `<tr><td colspan="5" class="empty">${emptyCopy}</td></tr>`
      : ds.map((d) => `<tr data-id="${esc(d.id)}" class="dcRow">
          <td><input type="checkbox" class="dSel" ${dcSelected.has(d.id) ? "checked" : ""} aria-label="Select ${fmtFreq(d.freq)} ${esc(d.alphaTag)}" /></td>
          <td class="rowOpen">${fmtFreq(d.freq)}<span class="dcSvc${serviceFor(d.freq) ? "" : " outband"}">${esc(serviceFor(d.freq) ?? "OUTBAND")}</span></td>
          <td class="rowOpen">${esc(d.alphaTag)}${d.audible === false ? '<span class="dcSee" title="Identified as data/paging — filed seen-not-heard; promotes as SEE">SEE</span>' : d.audible === true ? '<span class="dcHear" title="Identified as analog voice — hearable">HEAR</span>' : ""}${locChip(d.location)}<button type="button" class="rowChev" aria-label="Open ${esc(d.alphaTag)} details">${btnIco("chevron", "solo")}</button></td>
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
        mutateDiscovery(id, promoteDiscovery, { text: (d) => `Added ${d.alphaTag} to channels (silent).` }));
      if (b.classList.contains("dLock")) b.addEventListener("click", () =>
        mutateDiscovery(id, (cfg2, d) => {
          cfg2.scan.lockoutHz = [...new Set([...(cfg2.scan.lockoutHz ?? []), d.freq])];
        }));
      if (b.classList.contains("dDismiss")) b.addEventListener("click", () => mutateDiscovery(id, () => {},
        { text: (d) => `Dismissed ${d.alphaTag}.` }));
    });
  }
  // Select-all means the rows on screen. Reading the raw config here also
  // swept up SUPPRESSED discoveries, which are deliberately not rendered — so
  // "Lock out selected" could permanently kill frequencies never seen.
  dcAll.addEventListener("change", () => {
    dcSelected.clear();
    if (dcAll.checked) for (const d of discoveries) dcSelected.add(d.id);
    void renderDiscoveries();
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
    let doomed: Discovery[] = [];
    await editConfig((cfg) => {
      doomed = (cfg.discoveries ?? []).filter((d) => dcSelected.has(d.id));
      cfg.discoveries = (cfg.discoveries ?? []).filter((d) => !dcSelected.has(d.id));
      if (lockout) {
        cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), ...doomed.map((d) => d.freq)])];
      }
    });
    dcSelected.clear();
    void renderDiscoveries();
    void renderLockouts();
    const gone = doomed;
    showToast(`${lockout ? "Locked out" : "Dismissed"} ${gone.length} ${gone.length === 1 ? "discovery" : "discoveries"}.`, {
      undo: async () => {
        await editConfig((cfg) => {
          cfg.discoveries = [...(cfg.discoveries ?? []), ...gone];
          if (lockout) {
            const freqs = new Set(gone.map((d) => d.freq));
            cfg.scan.lockoutHz = (cfg.scan.lockoutHz ?? []).filter((f) => !freqs.has(f));
          }
        });
        void renderDiscoveries();
        void renderLockouts();
      },
    });
  }
  dcDismissSel.addEventListener("click", () => bulkDiscoveries(false));
  dcLockSel.addEventListener("click", () => bulkDiscoveries(true));

  // Feeds Triage's table and Overview's audio controls (one config read does
  // both), so it runs on those two routes only.
  poll({
    run: () => renderDiscoveries({ refreshDrawer: false }),
    everyMs: POLL_MS.discoveries,
    pages: ["home", "triage"],
  });

  const loList = root.querySelector<HTMLElement>("#loList")!;
  async function renderLockouts(): Promise<void> {
    const cfg = await api.getConfig();
    const lo = cfg.scan.lockoutHz ?? [];
    const loCount = root.querySelector<HTMLElement>("#loCount");
    if (loCount) loCount.textContent = String(lo.length);
    loList.innerHTML = lo.length === 0
      ? `<span class="empty">No locked-out frequencies.</span>`
      : lo.map((f) => `<span class="loChip">${fmtFreq(f)}${iconBtn("unlock", "unlock", `Unlock ${fmtFreq(f)} — scan it again`, `data-hz="${f}"`)}</span>`).join("");
    loList.querySelectorAll<HTMLButtonElement>(".unlock").forEach((b) =>
      b.addEventListener("click", async () => {
        const hz = Number(b.dataset.hz);
        const cfg2 = await api.getConfig();
        await api.putConfig(unlockFreqIn(cfg2, hz));
        await refresh();
        renderLockouts();
      }));
  }
  renderLockouts();

  addBtn.addEventListener("click", () => {
    chErr.textContent = "";
    openChannelEditor();
  });

  // ---- Now Playing card ----
  // Live speaker ownership over the same WS feed the dashboard uses (the hub
  // replays the current audible channel on connect). Lockout buttons act on
  // whatever is playing right now.
  const npName = root.querySelector<HTMLElement>("#npName")!;
  const npSilent = root.querySelector<HTMLElement>("#npSilent")!;
  const nowCard = root.querySelector<HTMLElement>(".nowCard")!;
  const npFreq = root.querySelector<HTMLElement>("#npFreq")!;
  const tlockBtn = root.querySelector<HTMLButtonElement>("#tlockBtn")!;
  const lockBtn = root.querySelector<HTMLButtonElement>("#lockBtn")!;
  let nowPlaying: { freq: number; alphaTag: string } | null = null;
  // Speaker reality, not just engine reality. The hero used to render the
  // tuned channel identically whether the sink was live, muted or at zero —
  // so an operator standing next to a silent radio read "Now playing" in lit
  // amber. Audibility is now part of what the card reports.
  let audioMuted = false;
  let audioVolume = 100;
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
    // Nothing reaches the speaker when muted or at zero — say so, and stop
    // the channel name claiming to be live.
    const silent = audioMuted || audioVolume === 0;
    npSilent.hidden = !silent;
    npSilent.textContent = audioMuted ? "MUTED" : "VOLUME 0";
    nowCard.classList.toggle("isSilent", silent);
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
    // innerHTML, not textContent: the label carries an inline Lucide glyph and
    // assigning text would strip it, leaving this one button bare.
    if (streamEl) {
      streamEl.pause(); streamEl.src = ""; streamEl = null;
      streamBtn.innerHTML = `${btnIco("play")}Listen here`;
      return;
    }
    streamEl = new Audio(`/api/stream.wav?t=${Date.now()}`);
    void streamEl.play().catch(() => { streamEl = null; });
    streamBtn.innerHTML = `${btnIco("stop")}Stop listening`;
  });
  const systemActionStatus = root.querySelector<HTMLElement>("#systemActionStatus")!;
  const kioskActionStatus = root.querySelector<HTMLElement>("#kioskActionStatus")!;
  root.querySelector<HTMLButtonElement>("#kioskReload")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    kioskActionStatus.textContent = "Refreshing kiosk screen…";
    try {
      await api.reloadKiosk();
      kioskActionStatus.textContent = "Refresh sent";
    } catch (e) {
      kioskActionStatus.textContent = (e as Error).message;
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
    kioskActionStatus.textContent = `Showing “${alphaTag}”…`;
    try {
      await api.testAlert({ alphaTag });
      kioskActionStatus.textContent = `Showing “${alphaTag}” on kiosk — click again for the next type`;
    } catch (e) {
      kioskActionStatus.textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  root.querySelector<HTMLButtonElement>("#testAlertClear")!.addEventListener("click", async (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    kioskActionStatus.textContent = "Clearing test alert…";
    try {
      await api.testAlert({ clear: true });
      kioskActionStatus.textContent = "Test alert cleared";
    } catch (e) {
      kioskActionStatus.textContent = (e as Error).message;
    } finally {
      button.disabled = false;
    }
  });
  // ── Actions that take the backend away: restart, reboot, shut down.
  //
  // All three routes answer 202 and *then* exit, so the fetch resolving proves
  // nothing about the outcome. Without a watcher the status line sat on
  // "Restarting backend…" for the life of the page and the power buttons never
  // came back. `SystemActionWatcher` polls /api/status until a *different*
  // backend process answers (or until it's clear nothing happened) and puts the
  // card back to normal. The break-in warning is advice, not a block — the
  // operator keeps final say.
  const restartBtn = root.querySelector<HTMLButtonElement>("#backendRestart")!;
  const rebootBtn = root.querySelector<HTMLButtonElement>("#systemReboot")!;
  const shutdownBtn = root.querySelector<HTMLButtonElement>("#systemShutdown")!;
  const SYSTEM_ACTION_BUTTONS = [restartBtn, rebootBtn, shutdownBtn];

  // Knobs for how patiently the admin waits out a system action.
  const WATCH_POLL_MS = 2000;        // while the backend is still answering
  const WATCH_DOWN_POLL_MS = 5000;   // once it has gone away (reboot ≈ a minute)
  const WATCH_TIMEOUT_MS = 20_000;   // same process still up ⇒ the action never took
  const WATCH_PROBE_TIMEOUT_MS = 4000; // a rebooting host swallows connections
  const BACK_MESSAGE_MS = 8000;      // how long "…is back" lingers before clearing

  type SystemAction = "restart" | "reboot" | "poweroff";
  const SYSTEM_ACTION_COPY: Record<SystemAction, {
    title: string; message: string; confirmLabel: string;
    pending: string; down: string; back: string; unchanged: string;
  }> = {
    restart: {
      title: "Restart radio backend?",
      message: "Audio and scanning will stop briefly while the backend and radio helpers restart.",
      confirmLabel: "Restart backend",
      pending: "Restarting backend…",
      down: "Backend is down — waiting for it to come back…",
      back: "Backend is back",
      unchanged: "Backend did not restart — try again.",
    },
    reboot: {
      title: "Reboot appliance?",
      message: "The whole machine restarts. Radio, audio and the kiosk screen go down for about a minute.",
      confirmLabel: "Reboot",
      pending: "Rebooting appliance…",
      down: "Appliance is rebooting — waiting for it to come back…",
      back: "Appliance is back online",
      unchanged: "Reboot did not start — try again.",
    },
    poweroff: {
      title: "Shut down appliance?",
      message: "The machine powers off. It will not come back on until someone presses the power button on the laptop.",
      confirmLabel: "Shut down",
      pending: "Shutting down…",
      down: "Appliance is off — press its power button to start it again.",
      back: "Appliance is back online",
      unchanged: "Shut down did not start — try again.",
    },
  };

  let statusClearTimer: ReturnType<typeof setTimeout> | undefined;
  function setSystemActionStatus(text: string, clearAfterMs?: number): void {
    if (statusClearTimer !== undefined) clearTimeout(statusClearTimer);
    statusClearTimer = undefined;
    systemActionStatus.textContent = text;
    if (clearAfterMs !== undefined) {
      statusClearTimer = setTimeout(() => { systemActionStatus.textContent = ""; }, clearAfterMs);
    }
  }

  let systemActionWatcher: SystemActionWatcher | undefined;
  function watchSystemAction(action: SystemAction, baselineStartedAt: number | undefined): void {
    const copy = SYSTEM_ACTION_COPY[action];
    systemActionWatcher?.stop();
    systemActionWatcher = new SystemActionWatcher({
      probe: (signal) => api.getStatus(signal),
      baselineStartedAt,
      pollMs: WATCH_POLL_MS,
      downPollMs: WATCH_DOWN_POLL_MS,
      timeoutMs: WATCH_TIMEOUT_MS,
      probeTimeoutMs: WATCH_PROBE_TIMEOUT_MS,
      onPhase: (phase) => {
        switch (phase) {
          case "pending": setSystemActionStatus(copy.pending); break;
          case "down": setSystemActionStatus(copy.down); break;
          case "back":
            setSystemActionStatus(copy.back, BACK_MESSAGE_MS);
            for (const b of SYSTEM_ACTION_BUTTONS) b.disabled = false;
            break;
          case "unchanged":
            setSystemActionStatus(copy.unchanged);
            for (const b of SYSTEM_ACTION_BUTTONS) b.disabled = false;
            break;
        }
      },
    });
    systemActionWatcher.start();
  }

  async function runSystemAction(action: SystemAction): Promise<void> {
    const copy = SYSTEM_ACTION_COPY[action];
    // One status read does double duty: the break-in warning for the confirm
    // dialog, and the identity of the process we're about to take down.
    const before = await api.getStatus().catch(() => null);
    const confirmed = await confirmAdminAction({
      title: copy.title,
      message: before?.breakIn ? `A weather alert is on air right now. ${copy.message}` : copy.message,
      confirmLabel: copy.confirmLabel,
      danger: true,
    });
    if (!confirmed) return;
    for (const b of SYSTEM_ACTION_BUTTONS) b.disabled = true;
    setSystemActionStatus(copy.pending);
    try {
      if (action === "restart") await api.restartBackend();
      else await api.powerAction(action);
    } catch (e) {
      // The request itself failed, so nothing is going down — recover now
      // rather than wait out a watch that would only ever say "unchanged".
      setSystemActionStatus((e as Error).message);
      for (const b of SYSTEM_ACTION_BUTTONS) b.disabled = false;
      return;
    }
    watchSystemAction(action, before?.startedAt);
  }
  restartBtn.addEventListener("click", () => { void runSystemAction("restart"); });
  rebootBtn.addEventListener("click", () => { void runSystemAction("reboot"); });
  shutdownBtn.addEventListener("click", () => { void runSystemAction("poweroff"); });

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
    audioMuted = cfg.audio.muted;
    audioVolume = cfg.audio.volume;
    syncRemoteListening(cfg.audio.remoteListening ?? false);
    paintNow();
  }
  api.getConfig().then(syncAudioControls);
  vol.addEventListener("change", () => {
    audioVolume = Number(vol.value);
    api.setVolume(audioVolume);
    paintNow();
  });
  mute.addEventListener("change", () => {
    audioMuted = mute.checked;
    api.setMuted(audioMuted);
    paintNow();
  });
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
    syncCloseCallDependents();
    tCloseCallDb.value = cfg.scan.closeCallDb != null ? String(cfg.scan.closeCallDb) : "";
    tSweep.value = (cfg.scan.sweepRanges ?? [])
      .map((r) => `${r.loHz / 1e6}-${r.hiHz / 1e6}`).join(", ");
  });

  // Per-card saves (spec 2026-07-16 admin IA): each card patches only its
  // slice of config. Field semantics unchanged: empty = default/clear.
  const numOrU = (el: HTMLInputElement): number | undefined =>
    el.value.trim() === "" ? undefined : Number(el.value);

  // A dependent field that stays live under an off parent implies a setting
  // that does something. Close Call's threshold only means anything when Close
  // Call is on.
  function syncCloseCallDependents(): void {
    tCloseCallDb.disabled = !tCloseCall.checked;
  }
  tCloseCall.addEventListener("change", syncCloseCallDependents);

  root.querySelector<HTMLButtonElement>("#tSave")!.addEventListener("click", async () => {
    tErr.textContent = "";
    try {
      const cfg = await api.getConfig();
      cfg.scan.groupDwellMs = numOrU(tGroupDwell);
      cfg.scan.openAboveFloorDb = numOrU(tOpenDb);
      cfg.scan.noiseQuietDb = numOrU(tQuietDb);
      cfg.scan.closeCall = tCloseCall.checked;
      cfg.scan.closeCallDb = numOrU(tCloseCallDb);
      const sweeps = tSweep.value.split(",").map((x) => x.trim()).filter(Boolean)
        .map((x) => {
          const m = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(x);
          if (!m) throw new Error(`sweep range "${x}" must be lo-hi in MHz`);
          return { loHz: Math.round(Number(m[1]) * 1e6), hiHz: Math.round(Number(m[2]) * 1e6) };
        });
      if (sweeps.length) cfg.scan.sweepRanges = sweeps;
      else delete cfg.scan.sweepRanges;
      const hang = numOrU(tHang);
      if (hang !== undefined) cfg.scan.dwellMs = hang;
      await api.putConfig(cfg);
      setFieldStatus(tErr, "Saved", "ok", SAVED_MESSAGE_MS);
    } catch (e) { setFieldStatus(tErr, (e as Error).message, "err"); }
  });

  const alErr = root.querySelector<HTMLElement>("#alErr")!;
  root.querySelector<HTMLButtonElement>("#alSave")!.addEventListener("click", async () => {
    alErr.textContent = "";
    try {
      const cfg = await api.getConfig();
      // Alert knobs: empty fields fall back to defaults (15 min / 30 s).
      const ntfy = tAlertNtfy.value.trim();
      const fips = tSameFips.value.split(",").map((x) => x.trim()).filter(Boolean);
      const alerts = {
        ...(numOrU(tAlertCool) !== undefined ? { cooldownMinutes: numOrU(tAlertCool) } : {}),
        ...(numOrU(tAlertHold) !== undefined ? { holdSeconds: numOrU(tAlertHold) } : {}),
        ...(ntfy ? { ntfyUrl: ntfy } : {}),
        ...(fips.length ? { sameFips: fips } : {}),
        ...(tSameTests.checked ? { sameTests: true } : {}),
      };
      if (Object.keys(alerts).length) cfg.alerts = alerts;
      else delete cfg.alerts;
      await api.putConfig(cfg);
      setFieldStatus(alErr, "Saved", "ok", SAVED_MESSAGE_MS);
    } catch (e) { setFieldStatus(alErr, (e as Error).message, "err"); }
  });

  const igErr = root.querySelector<HTMLElement>("#igErr")!;
  root.querySelector<HTMLButtonElement>("#igSave")!.addEventListener("click", async () => {
    igErr.textContent = "";
    try {
      const cfg = await api.getConfig();
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
        setFieldStatus(igErr, "Set a weather location first — the map needs coordinates.", "err");
        return;
      }
      await api.putConfig(cfg);
      setFieldStatus(igErr, "Saved", "ok", SAVED_MESSAGE_MS);
    } catch (e) { setFieldStatus(igErr, (e as Error).message, "err"); }
  });

  // Settings cards: desktop shows all four open; phones get an accordion
  // (one open at a time). Re-applied on every breakpoint crossing — read once
  // at load, a rotate or window resize left the page in the other mode's
  // state, with the accordion handler either missing or stuck on a card CSS
  // had made un-tappable.
  const settingsCards = [...root.querySelectorAll<HTMLDetailsElement>(".settingsCard")];
  const wide = window.matchMedia("(min-width: 700px)");
  let accordionWired = false;
  function applySettingsLayout(): void {
    if (wide.matches) {
      settingsCards.forEach((d) => { d.open = true; });
      return;
    }
    if (!accordionWired) {
      accordionWired = true;
      settingsCards.forEach((d) => d.addEventListener("toggle", () => {
        if (d.open && !wide.matches) settingsCards.forEach((o) => { if (o !== d) o.open = false; });
      }));
    }
    // Collapse to a single open card so the phone doesn't inherit four.
    settingsCards.forEach((d, i) => { d.open = i === 0; });
  }
  wide.addEventListener("change", applySettingsLayout);
  applySettingsLayout();

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
    setFieldStatus(wxErr, "", "err");
    try {
      const saved = await api.setWeatherChannel(weatherFormToChannel({ mhz: wxFreq.value, alphaTag: wxTag.value, mode: wxMode.value }));
      weatherChannel = saved.weatherChannel;
      paintNow();
      setFieldStatus(wxErr, "Saved", "ok", SAVED_MESSAGE_MS);
    } catch (e) {
      setFieldStatus(wxErr, (e as Error).message, "err");
    }
  });

  // Everything above only *registers* polls; this starts the single ticker
  // that drives them. One timer, one request group at a time.
  setInterval(() => { void tick(); }, POLL_TICK_MS);
  void tick();
}
