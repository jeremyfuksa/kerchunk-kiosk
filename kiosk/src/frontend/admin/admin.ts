import type { Channel } from "../../backend/config/schema.js";
import { NOAA_CHANNELS } from "../../backend/config/noaa.js";
import { api } from "../lib/api.js";
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

function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(3); }

// Channel fields (alphaTag especially) are operator-typed and rendered via
// innerHTML, so escape them to prevent stored XSS.
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function renderAdmin(root: HTMLElement): void {
  root.innerHTML = `
    <main class="admin">
      <h1>Kerchunk Kiosk — Admin</h1>
      <section class="nowCard">
        <h2>Now playing</h2>
        <div class="npWhat"><span id="npName" class="npName">scanning…</span> <span id="npFreq" class="npFreq"></span></div>
        <div class="npControls">
          <button id="resumeBtn" class="resume" style="display:none">⏹ Resume scan</button>
          <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
          <label><input id="mute" type="checkbox" /> Mute</label>
          <button id="skipBtn" title="Force-close the current transmission">Skip ▶</button>
          <button id="tlockBtn" title="Suppress this channel for 30 minutes (clears on restart)" disabled>Temp lockout 30m</button>
          <button id="lockBtn" title="Remove this channel and never Close-Call its frequency again" disabled>Lockout</button>
        </div>
      </section>
      <section class="discoveries">
        <h2>Discoveries <span class="hint">found by Close Call — listen, then decide</span></h2>
        <div class="dcToolbar">
          <button id="dcDismissSel" disabled>Dismiss selected</button>
          <button id="dcLockSel" disabled>Lockout selected</button>
          <span id="dcSelCount" class="hint"></span>
        </div>
        <table class="chTable">
          <thead><tr><th><input id="dcAll" type="checkbox" title="Select all" /></th><th>Freq (MHz)</th><th>Name</th><th>Found</th><th></th></tr></thead>
          <tbody id="dcRows"></tbody>
        </table>
      </section>
      <section class="channels">
        <h2>Channels <button id="addBtn">+ Add</button></h2>
        <table class="chTable">
          <thead><tr>
            <th>Freq (MHz)</th><th>Name</th><th>Mode</th><th>Priority</th><th>Enabled</th><th></th>
          </tr></thead>
          <tbody id="chRows"></tbody>
        </table>
        <span id="chErr" class="err"></span>
      </section>
      <section class="tuning">
        <h2>Scan tuning</h2>
        <label>Group dwell (ms) <input id="tGroupDwell" type="number" min="500" step="100" placeholder="3000" /></label>
        <label>Hang time (ms) <input id="tHang" type="number" min="100" step="100" placeholder="2000" /></label>
        <label>Squelch open (dB over floor) <input id="tOpenDb" type="number" min="1" step="0.5" placeholder="9" /></label>
        <label>Quieting threshold (dB) <input id="tQuietDb" type="number" max="-1" step="0.5" placeholder="-86" /></label>
        <label><input id="tCloseCall" type="checkbox" /> Close Call</label>
        <label>Close Call threshold (dB over floor) <input id="tCloseCallDb" type="number" min="5" step="1" placeholder="15" /></label>
        <button id="tSave">Save tuning</button>
        <span id="tErr" class="err"></span>
      </section>
      <section class="lockouts">
        <h2>Close Call lockouts</h2>
        <ul id="loList"></ul>
      </section>
      <section class="weather">
        <h2>Weather</h2>
        <label>Channel <select id="wxFreq">${NOAA_CHANNELS.map((c) => `<option value="${c.mhz}">${c.label} — ${c.mhz} MHz</option>`).join("")}</select></label>
        <label>Tag <input id="wxTag" type="text" placeholder="NOAA WX" /></label>
        <select id="wxMode"><option value="nfm">nfm</option><option value="fm">fm</option><option value="am">am</option></select>
        <button id="wxSave">Save weather channel</button>
        <span id="wxErr" class="err"></span>
        <label class="modeToggle"><input id="wxToggle" type="checkbox" /> Weather-only mode</label>
        <span id="modeLabel"></span>
      </section>
    </main>`;

  const vol = root.querySelector<HTMLInputElement>("#vol")!;
  const mute = root.querySelector<HTMLInputElement>("#mute")!;
  const chRows = root.querySelector<HTMLElement>("#chRows")!;
  const chErr = root.querySelector<HTMLElement>("#chErr")!;
  const addBtn = root.querySelector<HTMLButtonElement>("#addBtn")!;

  // Inline-editable CRUD table. One row at a time is editable: editingId is a
  // channel id, "new" (blank row pending creation), or null. Checkboxes on
  // display rows act immediately (PUT patch); text/mode edits go through
  // edit -> save / cancel, with Enter/Escape shortcuts.
  let channels: Channel[] = [];
  let editingId: string | null = null;

  const MODES: Channel["mode"][] = ["nfm", "fm", "am"];

  function modeOptions(selected: string): string {
    return MODES.map((m) =>
      `<option value="${m}" ${m === selected ? "selected" : ""}>${m.toUpperCase()}</option>`).join("");
  }

  function displayRow(c: Channel): string {
    return `<tr data-id="${esc(c.id)}">
      <td>${fmtFreq(c.freq)}</td>
      <td>${esc(c.alphaTag)}</td>
      <td>${esc(c.mode.toUpperCase())}</td>
      <td><input type="checkbox" class="prio" ${c.priority ? "checked" : ""} /></td>
      <td><input type="checkbox" class="en" ${c.enabled ? "checked" : ""} /></td>
      <td><button class="listen" title="Park the radio on this channel (unsquelched)">listen</button> <button class="edit">edit</button> <button class="lock" title="Remove and never Close-Call this frequency again">lockout</button> <button class="del">delete</button></td>
    </tr>`;
  }

  function editRow(c?: Channel): string {
    return `<tr data-id="${c ? esc(c.id) : "new"}" class="editing">
      <td><input class="fMhz" value="${c ? fmtFreq(c.freq) : ""}" placeholder="145.130" /></td>
      <td><input class="fTag" value="${c ? esc(c.alphaTag) : ""}" placeholder="KC0KW — Gibbs Rd" /></td>
      <td><select class="fMode">${modeOptions(c?.mode ?? "nfm")}</select></td>
      <td><input type="checkbox" class="fPrio" ${c?.priority ? "checked" : ""} /></td>
      <td><input type="checkbox" class="fEn" ${c ? (c.enabled ? "checked" : "") : "checked"} /></td>
      <td><button class="save">save</button> <button class="cancel">cancel</button></td>
    </tr>`;
  }

  function renderRows(): void {
    const sorted = [...channels].sort((a, b) => a.freq - b.freq);
    chRows.innerHTML =
      (editingId === "new" ? editRow() : "") +
      sorted.map((c) => (editingId === c.id ? editRow(c) : displayRow(c))).join("") +
      (channels.length === 0 && editingId !== "new"
        ? `<tr><td colspan="6" class="empty">no channels — hit + Add</td></tr>` : "");
    addBtn.disabled = editingId !== null;
    wireRows();
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
      enabled: tr.querySelector<HTMLInputElement>(".fEn")!.checked,
    };
  }

  async function saveRow(tr: HTMLElement): Promise<void> {
    chErr.textContent = "";
    try {
      const payload = rowPatch(tr);
      if (tr.dataset.id === "new") await api.addChannel(payload);
      else await api.updateChannel(tr.dataset.id!, payload);
      editingId = null;
      await refresh();
    } catch (e) { chErr.textContent = (e as Error).message; }
  }

  function wireRows(): void {
    chRows.querySelectorAll<HTMLElement>("tr").forEach((tr) => {
      const id = tr.dataset.id;
      if (!id) return;
      tr.querySelector<HTMLButtonElement>(".edit")?.addEventListener("click", () => {
        editingId = id; chErr.textContent = ""; renderRows();
        tr0Focus();
      });
      tr.querySelector<HTMLButtonElement>(".listen")?.addEventListener("click", () => {
        const c = channels.find((x) => x.id === id);
        if (c) api.monitor(c.freq, c.alphaTag || fmtFreq(c.freq));
      });
      tr.querySelector<HTMLButtonElement>(".lock")?.addEventListener("click", async () => {
        const c = channels.find((x) => x.id === id);
        if (!c) return;
        if (!confirm(`Lock out ${c.alphaTag || fmtFreq(c.freq)}? It will be removed and never trigger Close Call again.`)) return;
        const cfg = await api.getConfig();
        cfg.channels = cfg.channels.filter((x) => x.id !== id);
        cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), c.freq])];
        await api.putConfig(cfg);
        await refresh();
        renderLockouts();
      });
      tr.querySelector<HTMLButtonElement>(".del")?.addEventListener("click", async () => {
        const c = channels.find((x) => x.id === id);
        if (!confirm(`Delete ${c ? c.alphaTag || fmtFreq(c.freq) : "channel"}?`)) return;
        await api.deleteChannel(id);
        await refresh();
      });
      tr.querySelector<HTMLInputElement>(".prio")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { priority: (ev.target as HTMLInputElement).checked });
        await refresh();
      });
      tr.querySelector<HTMLInputElement>(".en")?.addEventListener("change", async (ev) => {
        await api.updateChannel(id, { enabled: (ev.target as HTMLInputElement).checked });
        await refresh();
      });
      tr.querySelector<HTMLButtonElement>(".save")?.addEventListener("click", () => saveRow(tr));
      tr.querySelector<HTMLButtonElement>(".cancel")?.addEventListener("click", () => {
        editingId = null; chErr.textContent = ""; renderRows();
      });
      if (tr.classList.contains("editing")) {
        tr.addEventListener("keydown", (ev) => {
          if (ev.key === "Enter") { ev.preventDefault(); saveRow(tr); }
          if (ev.key === "Escape") { editingId = null; chErr.textContent = ""; renderRows(); }
        });
      }
    });
  }

  function tr0Focus(): void {
    chRows.querySelector<HTMLInputElement>("tr.editing .fMhz")?.focus();
  }

  async function refresh(): Promise<void> {
    channels = await api.getChannels();
    renderRows();
  }

  const dcRows = root.querySelector<HTMLElement>("#dcRows")!;
  const dcAll = root.querySelector<HTMLInputElement>("#dcAll")!;
  const dcDismissSel = root.querySelector<HTMLButtonElement>("#dcDismissSel")!;
  const dcLockSel = root.querySelector<HTMLButtonElement>("#dcLockSel")!;
  const dcSelCount = root.querySelector<HTMLElement>("#dcSelCount")!;
  // Selection survives the 15 s auto-refresh (a triage session shouldn't
  // lose its checkmarks because a new discovery arrived).
  const dcSelected = new Set<string>();

  function paintDcToolbar(): void {
    dcDismissSel.disabled = dcSelected.size === 0;
    dcLockSel.disabled = dcSelected.size === 0;
    dcSelCount.textContent = dcSelected.size > 0 ? `${dcSelected.size} selected` : "";
  }

  async function renderDiscoveries(): Promise<void> {
    const cfg = await api.getConfig();
    const ds = [...(cfg.discoveries ?? [])].sort((a, b) => b.ts - a.ts);
    const present = new Set(ds.map((d) => d.id));
    for (const id of dcSelected) if (!present.has(id)) dcSelected.delete(id);
    dcRows.innerHTML = ds.length === 0
      ? `<tr><td colspan="5" class="empty">nothing pending — Close Call is hunting</td></tr>`
      : ds.map((d) => `<tr data-id="${esc(d.id)}">
          <td><input type="checkbox" class="dSel" ${dcSelected.has(d.id) ? "checked" : ""} /></td>
          <td>${fmtFreq(d.freq)}</td>
          <td>${esc(d.alphaTag)}</td>
          <td>${new Date(d.ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</td>
          <td>
            <button class="dListen">listen</button>
            <button class="dAdd" title="Promote to an enabled channel">add</button>
            <button class="dLock" title="Never Close-Call this frequency again">lockout</button>
            <button class="dDismiss" title="Remove (may be rediscovered later)">dismiss</button>
          </td>
        </tr>`).join("");
    dcAll.checked = ds.length > 0 && dcSelected.size === ds.length;
    paintDcToolbar();
    dcRows.querySelectorAll<HTMLInputElement>(".dSel").forEach((cb) => {
      const id = (cb.closest("tr") as HTMLElement).dataset.id!;
      cb.addEventListener("change", () => {
        if (cb.checked) dcSelected.add(id); else dcSelected.delete(id);
        dcAll.checked = dcSelected.size === present.size && present.size > 0;
        paintDcToolbar();
      });
    });

    async function mutate(id: string, fn: (cfg2: Awaited<ReturnType<typeof api.getConfig>>, d: NonNullable<Awaited<ReturnType<typeof api.getConfig>>["discoveries"]>[number]) => void): Promise<void> {
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

    dcRows.querySelectorAll<HTMLButtonElement>("tr [class^=d]").forEach((b) => {
      const id = (b.closest("tr") as HTMLElement).dataset.id!;
      if (b.classList.contains("dListen")) b.addEventListener("click", async () => {
        const cfg2 = await api.getConfig();
        const d = (cfg2.discoveries ?? []).find((x) => x.id === id);
        if (d) api.monitor(d.freq, d.alphaTag);
      });
      if (b.classList.contains("dAdd")) b.addEventListener("click", () =>
        mutate(id, (cfg2, d) => cfg2.channels.push({
          id: `ch_${d.id.replace(/^cc_/, "")}`, freq: d.freq, alphaTag: d.alphaTag,
          mode: "nfm", enabled: true,
        })));
      if (b.classList.contains("dLock")) b.addEventListener("click", () =>
        mutate(id, (cfg2, d) => {
          cfg2.scan.lockoutHz = [...new Set([...(cfg2.scan.lockoutHz ?? []), d.freq])];
        }));
      if (b.classList.contains("dDismiss")) b.addEventListener("click", () => mutate(id, () => {}));
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
    if (!confirm(`${verb} ${n} ${n === 1 ? "discovery" : "discoveries"}?`)) return;
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
      : lo.map((f) => `<li>${fmtFreq(f)} <button data-hz="${f}" class="unlock">remove</button></li>`).join("");
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
    editingId = "new"; chErr.textContent = ""; renderRows(); tr0Focus();
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

  const resumeBtn = root.querySelector<HTMLButtonElement>("#resumeBtn")!;
  let monitoring: { freq: number; alphaTag: string } | null = null;

  function paintNow(): void {
    if (monitoring) {
      npName.textContent = `MONITORING ${monitoring.alphaTag || fmtFreq(monitoring.freq)}`;
      npFreq.textContent = fmtFreq(monitoring.freq);
    } else {
      npName.textContent = nowPlaying ? (nowPlaying.alphaTag || fmtFreq(nowPlaying.freq)) : "scanning…";
      npFreq.textContent = nowPlaying ? fmtFreq(nowPlaying.freq) : "";
    }
    resumeBtn.style.display = monitoring ? "" : "none";
    tlockBtn.disabled = monitoring !== null || nowPlaying === null;
    lockBtn.disabled = monitoring !== null && nowPlaying === null;
  }

  async function syncMode(): Promise<void> {
    try {
      const st = await api.getStatus();
      monitoring = st.mode === "monitor" && st.monitor
        ? { freq: st.monitor.freq, alphaTag: st.monitor.alphaTag } : null;
      paintNow();
    } catch { /* transient */ }
  }
  resumeBtn.addEventListener("click", async () => { await api.monitorStop(); syncMode(); });

  function onEngineEvent(ev: EngineEvent): void {
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
  syncMode();
  paintNow();

  tlockBtn.addEventListener("click", () => api.skip(1800));
  lockBtn.addEventListener("click", async () => {
    if (!nowPlaying) return;
    const label = nowPlaying.alphaTag || fmtFreq(nowPlaying.freq);
    if (!confirm(`Lock out ${label}? It will be removed and never trigger Close Call again.`)) return;
    const freq = nowPlaying.freq;
    const cfg = await api.getConfig();
    cfg.channels = cfg.channels.filter((c) => c.freq !== freq);
    cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), freq])];
    await api.putConfig(cfg);
    await refresh();
    renderLockouts();
  });

  // Volume/mute stay in sync with the server (another admin tab, a stale
  // page across service restarts): poll lightly and update the controls —
  // but never while the operator is actively holding the slider.
  function syncAudioControls(cfg: { audio: { volume: number; muted: boolean } }): void {
    if (document.activeElement !== vol) vol.value = String(cfg.audio.volume);
    if (document.activeElement !== mute) mute.checked = cfg.audio.muted;
  }
  api.getConfig().then(syncAudioControls);
  setInterval(() => { api.getConfig().then(syncAudioControls).catch(() => {}); }, 5000);
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
  const tCloseCall = root.querySelector<HTMLInputElement>("#tCloseCall")!;
  const tCloseCallDb = root.querySelector<HTMLInputElement>("#tCloseCallDb")!;
  const tErr = root.querySelector<HTMLElement>("#tErr")!;

  api.getConfig().then((cfg) => {
    tGroupDwell.value = cfg.scan.groupDwellMs != null ? String(cfg.scan.groupDwellMs) : "";
    tHang.value = String(cfg.scan.dwellMs);
    tOpenDb.value = cfg.scan.openAboveFloorDb != null ? String(cfg.scan.openAboveFloorDb) : "";
    tQuietDb.value = cfg.scan.noiseQuietDb != null ? String(cfg.scan.noiseQuietDb) : "";
    tCloseCall.checked = cfg.scan.closeCall ?? true;   // engine default: ON
    tCloseCallDb.value = cfg.scan.closeCallDb != null ? String(cfg.scan.closeCallDb) : "";
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
      const hang = num(tHang);
      if (hang !== undefined) cfg.scan.dwellMs = hang;
      await api.putConfig(cfg);
      tErr.textContent = "saved";
    } catch (e) { tErr.textContent = (e as Error).message; }
  });

  refresh();

  const wxFreq = root.querySelector<HTMLSelectElement>("#wxFreq")!;
  const wxTag = root.querySelector<HTMLInputElement>("#wxTag")!;
  const wxMode = root.querySelector<HTMLSelectElement>("#wxMode")!;
  const wxSave = root.querySelector<HTMLButtonElement>("#wxSave")!;
  const wxErr = root.querySelector<HTMLElement>("#wxErr")!;
  const wxToggle = root.querySelector<HTMLInputElement>("#wxToggle")!;
  const modeLabel = root.querySelector<HTMLElement>("#modeLabel")!;

  function paintMode(mode: "scan" | "weather"): void {
    wxToggle.checked = mode === "weather";
    modeLabel.textContent = mode === "weather" ? "WEATHER-ONLY" : "scanning";
  }

  api.getWeatherChannel().then(({ weatherChannel }) => {
    if (weatherChannel) {
      wxFreq.value = (weatherChannel.freq / 1e6).toFixed(3);
      wxTag.value = weatherChannel.alphaTag;
      wxMode.value = weatherChannel.mode;
    }
  }).catch(() => {});
  api.getStatus().then((s) => paintMode(s.mode)).catch(() => {});

  wxSave.addEventListener("click", async () => {
    wxErr.textContent = "";
    try {
      await api.setWeatherChannel(weatherFormToChannel({ mhz: wxFreq.value, alphaTag: wxTag.value, mode: wxMode.value }));
    } catch (e) {
      wxErr.textContent = (e as Error).message;
    }
  });
  wxToggle.addEventListener("change", () => {
    const intended = wxToggle.checked;
    api.setMode(intended ? "weather" : "scan")
      .then((r) => paintMode(r.mode))
      .catch(() => { wxToggle.checked = !intended; });
  });
}
