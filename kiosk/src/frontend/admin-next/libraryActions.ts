// Library writes that span more than one channel field: lockout (with its
// exact Undo) and discovery mutations. Every write is inside lib.run.
import { api } from "../lib/api.js";
import { lockoutFreqIn } from "../lib/lockout.js";
import { lockoutSnapshot, type Discovery } from "./libraryModel.js";
import type { LibCtx } from "./libraryStore.js";

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Confirm, lock out (archives the channel, drops discoveries, adds to the
 *  lockout list — restarts scanning when a channel is archived), offer Undo. */
export async function lockout(lib: LibCtx, freq: number, label: string): Promise<boolean> {
  const ok = await lib.dialogs.confirm({
    title: `Lock out ${label}?`,
    message: "It stops being scanned and Close Call never reports it again. The channel is archived, not deleted. Scanning restarts briefly.",
    confirmLabel: "Lock out", danger: true,
  });
  if (!ok) return false;
  let s: ReturnType<typeof lockoutSnapshot>;
  try {
    s = await lib.run(async () => {
      const cfg = await api.getConfig();
      const snap = lockoutSnapshot(cfg, freq);
      await api.putConfig(lockoutFreqIn(cfg, freq));
      return snap;
    });
  } catch (e) { lib.dialogs.toast(`Couldn't lock out ${label}: ${msg(e)}`); return false; }
  lib.dialogs.toast(`Locked out ${label}.`, {
    undo: () => lib.run(async () => {
      const cfg = await api.getConfig();
      cfg.scan = { ...cfg.scan, lockoutHz: (cfg.scan.lockoutHz ?? []).filter((f) => f !== freq) };
      cfg.channels = cfg.channels.map((c) => (s.enabled.has(c.id) ? { ...c, enabled: s.enabled.get(c.id)! } : c));
      if (s.discoveries.length) {
        const have = new Set((cfg.discoveries ?? []).map((d) => d.id));
        cfg.discoveries = [...(cfg.discoveries ?? []), ...s.discoveries.filter((d) => !have.has(d.id))];
      }
      await api.putConfig(cfg);
    }),
  });
  return true;
}

/** Remove discoveries (and optionally lock their frequencies out) in one
 *  config write — live, no restart — with an Undo that puts them back. */
export async function removeDiscoveries(lib: LibCtx, ids: ReadonlySet<string>, o: { lockout: boolean }): Promise<Discovery[]> {
  const back = await lib.run(async () => {
    const cfg = await api.getConfig();
    const gone = (cfg.discoveries ?? []).filter((d) => ids.has(d.id));
    cfg.discoveries = (cfg.discoveries ?? []).filter((d) => !ids.has(d.id));
    if (o.lockout) cfg.scan.lockoutHz = [...new Set([...(cfg.scan.lockoutHz ?? []), ...gone.map((d) => d.freq)])];
    await api.putConfig(cfg);
    return gone;
  });
  if (back.length) {
    const what = back.length === 1 ? (back[0]!.alphaTag || "1 discovery") : `${back.length} discoveries`;
    lib.dialogs.toast(`${o.lockout ? "Locked out" : "Dismissed"} ${what}.`, {
      undo: () => lib.run(async () => {
        const cfg = await api.getConfig();
        const have = new Set((cfg.discoveries ?? []).map((d) => d.id));
        cfg.discoveries = [...(cfg.discoveries ?? []), ...back.filter((d) => !have.has(d.id))];
        if (o.lockout) {
          const f = new Set(back.map((d) => d.freq));
          cfg.scan.lockoutHz = (cfg.scan.lockoutHz ?? []).filter((x) => !f.has(x));
        }
        await api.putConfig(cfg);
      }),
    });
  }
  return back;
}
