import type { Channel } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import "./admin.css";

export function mhzToHz(mhz: string): number {
  const n = Number(mhz);
  if (!Number.isFinite(n)) throw new Error(`invalid frequency: ${mhz}`);
  return Math.round(n * 1e6);
}

export function formToChannel(form: { mhz: string; alphaTag: string; mode: string }): Omit<Channel, "id"> {
  const mode = form.mode as Channel["mode"];
  return { freq: mhzToHz(form.mhz), alphaTag: form.alphaTag, mode, enabled: true };
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
      <section class="add">
        <h2>Add channel</h2>
        <input id="mhz" placeholder="145.130" />
        <input id="tag" placeholder="KC0KW — Gibbs Rd" />
        <select id="mode"><option>nfm</option><option>fm</option><option>am</option></select>
        <button id="addBtn">Add</button>
        <span id="addErr" class="err"></span>
      </section>
      <section><h2>Channels</h2><ul id="chList"></ul></section>
    </main>`;

  const vol = root.querySelector<HTMLInputElement>("#vol")!;
  const mute = root.querySelector<HTMLInputElement>("#mute")!;
  const chList = root.querySelector<HTMLElement>("#chList")!;
  const addErr = root.querySelector<HTMLElement>("#addErr")!;

  async function refresh(): Promise<void> {
    const channels = await api.getChannels();
    chList.innerHTML = channels
      .map((c) => `<li>${fmtFreq(c.freq)} — ${esc(c.alphaTag)} (${esc(c.mode)})
        <button data-id="${esc(c.id)}" class="del">delete</button></li>`)
      .join("");
    chList.querySelectorAll<HTMLButtonElement>(".del").forEach((b) =>
      b.addEventListener("click", async () => { await api.deleteChannel(b.dataset.id!); refresh(); }));
  }

  api.getConfig().then((cfg) => { vol.value = String(cfg.audio.volume); mute.checked = cfg.audio.muted; });
  vol.addEventListener("change", () => api.setVolume(Number(vol.value)));
  mute.addEventListener("change", () => api.setMuted(mute.checked));

  root.querySelector<HTMLButtonElement>("#addBtn")!.addEventListener("click", async () => {
    addErr.textContent = "";
    try {
      const payload = formToChannel({
        mhz: root.querySelector<HTMLInputElement>("#mhz")!.value,
        alphaTag: root.querySelector<HTMLInputElement>("#tag")!.value,
        mode: root.querySelector<HTMLSelectElement>("#mode")!.value,
      });
      await api.addChannel(payload);
      refresh();
    } catch (e) { addErr.textContent = (e as Error).message; }
  });

  refresh();
}
