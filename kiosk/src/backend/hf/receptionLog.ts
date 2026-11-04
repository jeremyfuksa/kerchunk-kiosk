// What HF mode heard: one row per station per night, kept indefinitely (spec 2026-11-02-hf-mode).
// Its own database, so history.prune() can never reach it. No audio, only measurements.
import { DatabaseSync } from "node:sqlite";

// Half the 5 kHz raster: the same station's small tuning differences, but never the next channel.
const SAME_STATION_HZ = 2_500;

export interface Candidate {
  station: string;
  itu?: string;        // ITU code of the transmitter's country
  country?: string;
  language?: string;
  site?: string;
  lat?: number;
  lon?: number;
  powerKw?: number;
  distanceKm?: number;
}

export interface ReceptionRow {
  night: string;
  firstTs: number;
  lastTs: number;
  freqHz: number;
  band: string;
  peakDb: number;
  passes: number;
  onSpeaker: boolean;
  /** When it last played, or null if it never has. */
  playedTs: number | null;
  station: string | null;
  country: string | null;
  language: string | null;
  site: string | null;
  lat: number | null;
  lon: number | null;
  powerKw: number | null;
  distanceKm: number | null;
  others: string[];
}

/** A listening night runs noon to noon, local time, under the date it started. */
export function nightOf(ts: number): string {
  const d = new Date(ts - 12 * 3_600_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class ReceptionLog {
  private readonly db: DatabaseSync;

  constructor(opts: { path: string }) {
    this.db = new DatabaseSync(opts.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reception (
        id INTEGER PRIMARY KEY, night TEXT NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
        freq_hz INTEGER NOT NULL, band TEXT NOT NULL, peak_db REAL NOT NULL, passes INTEGER NOT NULL,
        on_speaker INTEGER NOT NULL DEFAULT 0, station TEXT, country TEXT, language TEXT, site TEXT,
        lat REAL, lon REAL, power_kw REAL, distance_km REAL, others TEXT NOT NULL DEFAULT '[]'
      );
      CREATE INDEX IF NOT EXISTS reception_night ON reception (night, freq_hz);
    `);
    const columns = this.db.prepare("PRAGMA table_info(reception)").all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === "played_ts")) {
      this.db.exec("ALTER TABLE reception ADD COLUMN played_ts INTEGER; UPDATE reception SET played_ts = last_ts WHERE on_speaker = 1;");
    }
  }

  /** One survey of one window. `candidates` lists the schedule matches, likeliest first. Sightings
   *  further apart than `windowMs` can't be one visit to the window, so they're another pass.
   *  `nameable` is the carrier check: a signal failing it gets no name, and joins whatever row that frequency
   *  already has tonight, since a named station can fail it for a survey as it fades. */
  record<C extends { hz: number; db: number }>(ts: number, band: string, carriers: readonly C[], candidates: (hz: number, ts: number) => readonly Candidate[], windowMs: number, nameable: (c: C) => boolean = () => true): void {
    const night = nightOf(ts);
    this.db.exec("BEGIN");
    try {
    for (const c of carriers) {
      const named = nameable(c);
      const cands = named ? candidates(c.hz, ts) : [];
      const top = cands[0] ?? null;
      const others = cands.slice(1).map((o) => o.station);
      const row = this.db.prepare(`
        SELECT id, peak_db, last_ts, passes, others FROM reception
        WHERE night = ? AND ABS(freq_hz - ?) <= ? AND (? OR station IS ?)
        ORDER BY last_ts DESC LIMIT 1
      `).get(night, c.hz, SAME_STATION_HZ, named ? 0 : 1, top?.station ?? null) as { id: number; peak_db: number; last_ts: number; passes: number; others: string } | undefined;
      if (row) {
        this.db.prepare("UPDATE reception SET last_ts = ?, peak_db = ?, passes = ?, others = ? WHERE id = ?").run(
          ts, Math.max(row.peak_db, c.db), ts - row.last_ts > windowMs ? row.passes + 1 : row.passes,
          JSON.stringify([...new Set([...(JSON.parse(row.others) as string[]), ...others])]), row.id,
        );
      } else {
        this.db.prepare(`
          INSERT INTO reception (night, first_ts, last_ts, freq_hz, band, peak_db, passes, station, country, language, site, lat, lon, power_kw, distance_km, others)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(night, ts, ts, c.hz, band, c.db, top?.station ?? null, top?.country ?? null, top?.language ?? null, top?.site ?? null,
          top?.lat ?? null, top?.lon ?? null, top?.powerKw ?? null, top?.distanceKm ?? null, JSON.stringify(others));
      }
    }
    this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** The most recent row for this frequency tonight was on the speaker. */
  markOnSpeaker(ts: number, hz: number): void {
    this.db.prepare(`
      UPDATE reception SET on_speaker = 1, played_ts = ? WHERE id = (
        SELECT id FROM reception WHERE night = ? AND ABS(freq_hz - ?) <= ? ORDER BY last_ts DESC, id DESC LIMIT 1
      )
    `).run(ts, nightOf(ts), hz, SAME_STATION_HZ);
  }

  rows(night: string): ReceptionRow[] {
    const rows = this.db.prepare("SELECT * FROM reception WHERE night = ? ORDER BY freq_hz, first_ts").all(night) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      night: r.night as string, firstTs: r.first_ts as number, lastTs: r.last_ts as number, freqHz: r.freq_hz as number,
      band: r.band as string, peakDb: r.peak_db as number, passes: r.passes as number, onSpeaker: r.on_speaker === 1,
      playedTs: r.played_ts as number | null,
      station: r.station as string | null, country: r.country as string | null, language: r.language as string | null,
      site: r.site as string | null, lat: r.lat as number | null, lon: r.lon as number | null,
      powerKw: r.power_kw as number | null, distanceKm: r.distance_km as number | null,
      others: JSON.parse(r.others as string) as string[],
    }));
  }

  nights(): Array<{ night: string; count: number }> {
    return this.db.prepare("SELECT night, COUNT(*) AS count FROM reception GROUP BY night ORDER BY night DESC").all() as Array<{ night: string; count: number }>;
  }

  close(): void { this.db.close(); }
}
