// The HF reception log, as the Log tab shows it. Names come from schedules, so they're only ever "likely".
export interface HfLogRow {
  night: string; firstTs: number; lastTs: number; freqHz: number; band: string; peakDb: number; passes: number; onSpeaker: boolean;
  station: string | null; country: string | null; language: string | null; site: string | null;
  lat: number | null; lon: number | null; powerKw: number | null; distanceKm: number | null; others: string[];
}

export type HfLogSort = "freqHz" | "station" | "peakDb" | "passes" | "lastTs";

export interface HfLogLine {
  freq: string; band: string; station: string; likely: boolean; others: string; language: string; where: string;
  power: string; distance: string; peak: string; passes: number; first: number; last: number; onSpeaker: boolean;
}

export function sortRows(rows: readonly HfLogRow[], by: HfLogSort): HfLogRow[] {
  const out = [...rows];
  if (by === "freqHz") return out.sort((a, b) => a.freqHz - b.freqHz);
  if (by === "station") {
    return out.sort((a, b) => (a.station === null ? 1 : 0) - (b.station === null ? 1 : 0) || (a.station ?? "").localeCompare(b.station ?? ""));
  }
  return out.sort((a, b) => b[by] - a[by]);
}

export function logRows(rows: readonly HfLogRow[]): HfLogLine[] {
  return rows.map((r) => ({
    freq: String(r.freqHz / 1000),
    band: r.band,
    station: r.station ?? "Unidentified",
    likely: r.station !== null,
    others: r.others.join(", "),
    language: r.language ?? "",
    where: [r.site, r.country].filter(Boolean).join(", "),
    power: r.powerKw === null ? "" : `${r.powerKw} kW`,
    distance: r.distanceKm === null ? "" : `${Math.round(r.distanceKm).toLocaleString("en-US")} km`,
    peak: `+${r.peakDb.toFixed(1)}`,
    passes: r.passes,
    first: r.firstTs,
    last: r.lastTs,
    onSpeaker: r.onSpeaker,
  }));
}
