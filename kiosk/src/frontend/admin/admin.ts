import type { Channel } from "../../backend/config/schema.js";
import { NOAA_CHANNELS } from "../../backend/config/noaa.js";
import { api } from "../lib/api.js";
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
      <section class="audio">
        <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
        <label><input id="mute" type="checkbox" /> Mute</label>
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
        <button id="tSave">Save tuning</button>
        <span id="tErr" class="err"></span>
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
      <td><button class="edit">edit</button> <button class="del">delete</button></td>
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

  addBtn.addEventListener("click", () => {
    editingId = "new"; chErr.textContent = ""; renderRows(); tr0Focus();
  });

  api.getConfig().then((cfg) => { vol.value = String(cfg.audio.volume); mute.checked = cfg.audio.muted; });
  vol.addEventListener("change", () => api.setVolume(Number(vol.value)));
  mute.addEventListener("change", () => api.setMuted(mute.checked));

  // Scan tuning knobs — optional config fields; empty input = engine default
  // (shown as the placeholder). Saved via whole-config PUT, which restarts
  // the engine so changes take effect immediately.
  const tGroupDwell = root.querySelector<HTMLInputElement>("#tGroupDwell")!;
  const tHang = root.querySelector<HTMLInputElement>("#tHang")!;
  const tOpenDb = root.querySelector<HTMLInputElement>("#tOpenDb")!;
  const tQuietDb = root.querySelector<HTMLInputElement>("#tQuietDb")!;
  const tErr = root.querySelector<HTMLElement>("#tErr")!;

  api.getConfig().then((cfg) => {
    tGroupDwell.value = cfg.scan.groupDwellMs != null ? String(cfg.scan.groupDwellMs) : "";
    tHang.value = String(cfg.scan.dwellMs);
    tOpenDb.value = cfg.scan.openAboveFloorDb != null ? String(cfg.scan.openAboveFloorDb) : "";
    tQuietDb.value = cfg.scan.noiseQuietDb != null ? String(cfg.scan.noiseQuietDb) : "";
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
