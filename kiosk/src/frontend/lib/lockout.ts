// Lockout / unlock as pure config transforms, shared by the classic admin and
// admin-next (moved out of admin/admin.ts, 2026-09-28).

import type { Channel } from "../../backend/config/schema.js";

/** Config shape the lockout pair mutates — the slice both need, so these stay
 *  callable from tests without standing up a whole config fixture. */
export type LockoutCfg = {
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
 *  location and rfDb the lookup chain paid API calls to
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
