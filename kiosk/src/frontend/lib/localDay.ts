/** Local midnight (ms) for the day containing `ts`. The daily portrait's lower
 *  bound; shared by the art skins (The Day's Map, the Kerchunk Wall). */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
