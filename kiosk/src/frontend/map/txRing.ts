// Live-transmission ring radius, latched for the hold. The ring's steady-state
// radius borrows from sources with independent lifetimes — FCC coverage (static)
// or the co-located blip circle's last-rendered radius (pruned at blip expiry,
// which a >60s continuous carrier outlives, since `signal` re-arms the ring but
// never refreshes the blip's ts). Re-deriving per tick let the source vanish
// mid-hold and pop the ring to the flat default. Resolve once per transmission
// and latch it on the entry; a fresh transmission resolves from scratch.

const DEFAULT_RADIUS_M = 7_500; // kiosk-scaled fallback when nothing is known

export function heldTxRadius(
  tx: { key: string; radiusM?: number },
  coverage: ReadonlyMap<string, number>,
  blipRadiusM: number | undefined,
  geo: number,
): number {
  tx.radiusM ??= coverage.get(tx.key) ?? blipRadiusM ?? DEFAULT_RADIUS_M * geo;
  return tx.radiusM;
}
