import { DatabaseSync } from "node:sqlite";
import { bandFor } from "./config/banks.js";

// Persistent activity history (ROADMAP Idea 5 — the keystone). Every channel
// opening and Close Call discovery lands in SQLite (node:sqlite — built into
// the system Node, zero dependencies) so map replay, stats, and alert review
// can outlive restarts. The in-memory ActivityLog ring buffer stays as the
// dashboard's hot cache; this is the durable tail.

export interface HistoryEvent {
  ts: number;
  kind: "active" | "closecall";
  channelId: string;
  freq: number;
  alphaTag: string;
  mode?: string;
  tags?: string[];
  lat?: number;
  lon?: number;
}

export interface HistoryRow {
  id: number;
  ts: number;
  kind: string;
  freq: number;
  alphaTag: string;
  mode: string | null;
  band: string;
  tags: string[];
  lat: number | null;
  lon: number | null;
  durationMs: number | null;
}

export interface HistoryQuery {
  sinceMs?: number;
  untilMs?: number;
  freq?: number;
  tag?: string;
  limit?: number;
}

export interface HistoryStoreOptions {
  /** SQLite path (":memory:" in tests; history.db next to config in prod). */
  path: string;
  retentionDays?: number;
}

export class HistoryStore {
  private db: DatabaseSync;
  private readonly retentionDays: number;
  // channelId -> rowid of its currently-open event, for duration pairing.
  private open = new Map<string, number>();

  constructor(opts: HistoryStoreOptions) {
    this.retentionDays = opts.retentionDays ?? 30;
    this.db = new DatabaseSync(opts.path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        freq INTEGER NOT NULL,
        alphaTag TEXT NOT NULL,
        mode TEXT,
        band TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        lat REAL,
        lon REAL,
        durationMs INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
      CREATE INDEX IF NOT EXISTS idx_events_freq ON events(freq);
    `);
  }

  record(ev: HistoryEvent): void {
    const res = this.db.prepare(
      `INSERT INTO events (ts, kind, freq, alphaTag, mode, band, tags, lat, lon)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      ev.ts, ev.kind, ev.freq, ev.alphaTag, ev.mode ?? null,
      bandFor(ev.freq), JSON.stringify(ev.tags ?? []),
      ev.lat ?? null, ev.lon ?? null,
    );
    if (ev.kind === "active") {
      this.open.set(ev.channelId, Number(res.lastInsertRowid));
    }
  }

  /** Pair a per-channel close with its opening to record the duration. */
  release(channelId: string, ts: number): void {
    const rowid = this.open.get(channelId);
    if (rowid === undefined) return;
    this.open.delete(channelId);
    this.db.prepare(
      `UPDATE events SET durationMs = MAX(0, ? - ts) WHERE id = ? AND durationMs IS NULL`,
    ).run(ts, rowid);
  }

  query(q: HistoryQuery): HistoryRow[] {
    const where: string[] = [];
    const args: Array<number | string> = [];
    if (q.sinceMs !== undefined) { where.push("ts >= ?"); args.push(q.sinceMs); }
    if (q.untilMs !== undefined) { where.push("ts <= ?"); args.push(q.untilMs); }
    if (q.freq !== undefined) { where.push("freq = ?"); args.push(q.freq); }
    if (q.tag !== undefined) {
      // tags is a JSON array; match the quoted element.
      where.push("tags LIKE ?"); args.push(`%"${q.tag.replaceAll('"', "")}"%`);
    }
    const sql = `SELECT * FROM events
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ts DESC LIMIT ?`;
    args.push(Math.min(q.limit ?? 500, 5000));
    return (this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>)
      .map((r) => ({ ...r, tags: JSON.parse(String(r.tags)) }) as unknown as HistoryRow);
  }

  /** Distinct transmitter sites for the map's persistent antenna layer. */
  sites(): Array<{ lat: number; lon: number; hits: number; lastTs: number; names: string[] }> {
    const rows = this.db.prepare(`
      SELECT ROUND(lat, 5) AS lat, ROUND(lon, 5) AS lon,
             COUNT(*) AS hits, MAX(ts) AS lastTs,
             GROUP_CONCAT(DISTINCT alphaTag) AS names
      FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL
      GROUP BY ROUND(lat, 5), ROUND(lon, 5)
    `).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      lat: Number(r.lat), lon: Number(r.lon),
      hits: Number(r.hits), lastTs: Number(r.lastTs),
      names: String(r.names ?? "").split(",").filter(Boolean),
    }));
  }

  /** Drop rows beyond the retention window (call at boot + daily). */
  prune(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    this.db.prepare("DELETE FROM events WHERE ts < ?").run(cutoff);
  }

  close(): void {
    this.db.close();
  }
}
