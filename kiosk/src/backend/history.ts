import { DatabaseSync } from "node:sqlite";
import { bandFor } from "./config/banks.js";

// Persistent activity history (ROADMAP Idea 5 — the keystone). Every channel
// opening and Close Call discovery lands in SQLite (node:sqlite — built into
// the system Node, zero dependencies) so map replay, stats, and alert review
// can outlive restarts. The in-memory ActivityLog ring buffer stays as the
// dashboard's hot cache; this is the durable tail.

export interface HistoryEvent {
  ts: number;
  kind: "active" | "closecall" | "alert";
  channelId: string;
  freq: number;
  alphaTag: string;
  mode?: string;
  tags?: string[];
  lat?: number;
  lon?: number;
  rfDb?: number;
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
  rfDb: number | null;
}

export interface HistoryQuery {
  kind?: string;
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
  // channelId -> rowid of its most recently CLOSED event — a stray post-release
  // RF reading pairs against this (see setRf).
  private lastClosed = new Map<string, number>();

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
    // Lazy column migration for stores created before rfDb existed. (A vestigial
    // `transcript` column may also linger from the removed transcription feature;
    // it is harmless — never written or read.)
    const cols = this.db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "rfDb")) {
      this.db.exec("ALTER TABLE events ADD COLUMN rfDb REAL");
    }
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
    this.lastClosed.set(channelId, rowid);
    this.db.prepare(
      `UPDATE events SET durationMs = MAX(0, ? - ts) WHERE id = ? AND durationMs IS NULL`,
    ).run(ts, rowid);
  }

  /** Attach received RF strength to the channel's in-progress transmission.
   *  rf events fire while the channel is open, so the open row wins — falling
   *  back to lastClosed only for a stray reading that lands just after release. */
  setRf(channelId: string, db: number): void {
    const rowid = this.open.get(channelId) ?? this.lastClosed.get(channelId);
    if (rowid === undefined) return;
    this.db.prepare("UPDATE events SET rfDb = ? WHERE id = ?").run(db, rowid);
  }

  query(q: HistoryQuery): HistoryRow[] {
    const where: string[] = [];
    const args: Array<number | string> = [];
    if (q.kind !== undefined) { where.push("kind = ?"); args.push(q.kind); }
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
      FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL AND kind != 'alert'
      GROUP BY ROUND(lat, 5), ROUND(lon, 5)
    `).all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      lat: Number(r.lat), lon: Number(r.lon),
      hits: Number(r.hits), lastTs: Number(r.lastTs),
      names: String(r.names ?? "").split(",").filter(Boolean),
    }));
  }

  /** Aggregates for the admin Insights panel (ROADMAP Idea 9). */
  stats(sinceMs: number): {
    totalHits: number;
    totalAirtimeMs: number;
    discoveries: number;
    topChannels: Array<{ alphaTag: string; freq: number; hits: number; airtimeMs: number }>;
    byTag: Array<{ tag: string; hits: number }>;
    byBand: Array<{ band: string; hits: number }>;
    byHour: number[];
  } {
    const one = (sql: string) =>
      this.db.prepare(sql).get(sinceMs) as Record<string, unknown>;
    const all = (sql: string) =>
      this.db.prepare(sql).all(sinceMs) as Array<Record<string, unknown>>;

    // kind != 'alert' throughout: an alert row annotates an active row —
    // counting both would double every alerted hit.
    const totals = one(`SELECT COUNT(*) n, COALESCE(SUM(durationMs), 0) air,
        SUM(kind = 'closecall') cc FROM events WHERE ts >= ? AND kind != 'alert'`);
    const top = all(`SELECT alphaTag, freq, COUNT(*) hits,
        COALESCE(SUM(durationMs), 0) airtimeMs
      FROM events WHERE ts >= ? AND kind = 'active'
      GROUP BY freq ORDER BY hits DESC, airtimeMs DESC LIMIT 12`);
    const byTag = all(`SELECT je.value tag, COUNT(*) hits
      FROM events, json_each(events.tags) je WHERE ts >= ? AND kind != 'alert'
      GROUP BY je.value ORDER BY hits DESC`);
    const byBand = all(`SELECT band, COUNT(*) hits FROM events
      WHERE ts >= ? AND kind != 'alert' GROUP BY band ORDER BY hits DESC`);
    // Hour-of-day activity clock in the appliance's local time.
    const hours = all(`SELECT CAST(strftime('%H', ts / 1000, 'unixepoch', 'localtime') AS INTEGER) h,
        COUNT(*) n FROM events WHERE ts >= ? AND kind != 'alert' GROUP BY h`);
    const byHour = Array.from({ length: 24 }, () => 0);
    for (const r of hours) byHour[Number(r.h)] = Number(r.n);

    return {
      totalHits: Number(totals.n),
      totalAirtimeMs: Number(totals.air),
      discoveries: Number(totals.cc ?? 0),
      topChannels: top.map((r) => ({
        alphaTag: String(r.alphaTag), freq: Number(r.freq),
        hits: Number(r.hits), airtimeMs: Number(r.airtimeMs),
      })),
      byTag: byTag.map((r) => ({ tag: String(r.tag), hits: Number(r.hits) })),
      byBand: byBand.map((r) => ({ band: String(r.band), hits: Number(r.hits) })),
      byHour,
    };
  }

  /** Dismiss a single reviewed alert. The `kind = 'alert'` guard makes this
   *  safe to expose: it can never delete an 'active'/'closecall' hit row, only
   *  the alert annotation. Returns true if a row was removed. */
  deleteAlert(id: number): boolean {
    const res = this.db.prepare("DELETE FROM events WHERE id = ? AND kind = 'alert'").run(id);
    return Number(res.changes) > 0;
  }

  /** Clear the whole alert feed ("mark all seen"). Returns the count removed.
   *  Only alert rows go — the underlying hits and all stats are untouched. */
  clearAlerts(): number {
    return Number(this.db.prepare("DELETE FROM events WHERE kind = 'alert'").run().changes);
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
