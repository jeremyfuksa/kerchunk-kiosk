/** Local midnight (ms) for the day containing `ts`. The daily portrait's lower
 *  bound; shared by the art skins (The Day's Map, the Kerchunk Wall). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Local midnight (ms) that STARTS the day AFTER the one containing `ts` — the
 *  daily-reset scheduler's re-arm target. `startOfLocalDay(ts) + 24h` is wrong
 *  across DST: fall-back is a 25h day, so that target lands an hour BEFORE the
 *  real midnight — already in the past for the final hour, which makes the
 *  timer fire every second. Calendar-advancing one day then snapping to
 *  midnight is DST-safe regardless of the current time of day. */
export function startOfNextLocalDay(ts: number): number {
  const d = new Date(startOfLocalDay(ts));
  d.setDate(d.getDate() + 1);
  d.setHours(0, 0, 0, 0); // re-normalize in case the +1 day crossed a DST edge
  return d.getTime();
}
