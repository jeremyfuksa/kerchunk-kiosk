// CB via FernSDR (spec 2026-10-15-cb-fernsdr): owns the receiver session and
// the channel watch, emits the same engine events the SDR CB path did, and
// feeds the audible channel's audio to the parked helper as 50 kHz s16 PCM.
import type { Channel } from "../config/schema.js";
import type { CbNetConfig } from "../config/cb.js";
import type { EngineEvent, EngineListener } from "../engine/ScannerEngine.js";
import { CbWatch, type CbTransition } from "./cbWatch.js";
import { FernClient, type FernClientOpts, type FernEvent } from "./client.js";
import { LANE_RATE, Resampler, toS16le } from "./resample.js";

export interface CbSource {
  start(cfg: CbNetConfig): void;
  pause(): void;
  stop(): void;
  status(): { connected: boolean; error: string | null; retrying: boolean };
  on(l: EngineListener): void;
  off(l: EngineListener): void;
}
export interface FernClientLike { start(): void; stop(): void; tune(freq: number, mode: "am" | "lsb"): void; readonly connected: boolean; readonly error: string | null; readonly retrying: boolean }
interface CbNetDeps {
  writePcm: (chunk: Buffer) => void;
  now?: () => number;
  clientFactory?: (opts: FernClientOpts, onEvent: (e: FernEvent) => void) => FernClientLike;
  log?: (m: string) => void;
}

const SIGNAL_EVERY_MS = 250;
/** Linear fade applied to the last stretch of audio before the write gate
 *  closes, so the helper never hears a cut (or its ring running dry) as a click. */
const FADE_OUT_MS = 30;
const FADE_BYTES = Math.round((LANE_RATE * FADE_OUT_MS) / 1000) * 2;

export class CbNet implements CbSource {
  private state: "stopped" | "running" | "paused" = "stopped";
  private cfg: CbNetConfig | null = null;
  private client: FernClientLike | null = null;
  private watch: CbWatch | null = null;
  private resampler: Resampler | null = null;
  private lastSignalAt = -Infinity;
  private lastTune: { freq: number; mode: string } | null = null;
  private held: Buffer = Buffer.alloc(0);   // newest FADE_OUT_MS of PCM, written only once more follows
  private readonly listeners = new Set<EngineListener>();
  private readonly now: () => number;

  constructor(private readonly deps: CbNetDeps) {
    this.now = deps.now ?? Date.now;
  }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  status(): { connected: boolean; error: string | null; retrying: boolean } {
    if (this.state === "stopped" || !this.client) return { connected: false, error: null, retrying: false };
    return { connected: this.client.connected, error: this.client.connected ? null : this.client.error, retrying: this.client.retrying };
  }

  start(cfg: CbNetConfig): void {
    if (this.state !== "stopped" && this.cfg && (cfg.url !== this.cfg.url || cfg.band !== this.cfg.band)) this.stop();
    if (this.state === "stopped") {
      this.cfg = cfg;
      this.watch = this.makeWatch(cfg);
      const factory = this.deps.clientFactory ?? ((o, e) => new FernClient(o, e));
      this.client = factory({ url: cfg.url, band: cfg.band, backoffMaxMs: cfg.backoffMaxMs, staleMs: cfg.staleMs, log: this.deps.log }, (e) => this.onFern(e));
      this.state = "running";
      this.client.start();
      return;
    }
    if (watchKey(cfg) !== watchKey(this.cfg!)) {
      this.apply(this.watch?.closeAll(this.now()) ?? []);
      this.watch = this.makeWatch(cfg);
    }
    this.cfg = cfg;
    this.state = "running";
  }

  pause(): void {
    if (this.state !== "running") return;
    this.apply(this.watch?.closeAll(this.now()) ?? []);
    this.state = "paused";
  }

  stop(): void {
    if (this.state === "stopped") return;
    try {
      this.apply(this.watch?.closeAll(this.now()) ?? []);
    } finally {
      try { this.client?.stop(); } finally {
        this.client = null;
        this.watch = null;
        this.resampler = null;
        this.lastTune = null;
        this.held = Buffer.alloc(0);
        this.state = "stopped";
      }
    }
  }

  private makeWatch(cfg: CbNetConfig): CbWatch {
    return new CbWatch(
      cfg.channels.map((c) => ({
        n: Number(c.id.slice(3)), freq: c.freq,
        priority: cfg.priority.includes(Number(c.id.slice(3))),
        hangMs: c.mode === "lsb" ? cfg.ssbHangMs : cfg.hangMs,
      })),
      { openDb: cfg.openDb, openRows: cfg.openRows, maxOpenMs: cfg.maxOpenMs },
    );
  }

  private channel(n: number): Channel | undefined {
    return this.cfg?.channels.find((c) => c.id === `cb_${n}`);
  }

  private onFern(e: FernEvent): void {
    if (this.state !== "running" || !this.watch) return;
    if (e.type === "disconnected") {
      // Rows stop during an outage; don't leave a channel stuck open/audible.
      this.apply(this.watch.closeAll(this.now()));
    } else if (e.type === "row") {
      this.apply(this.watch.row(e, this.now()));
      this.gate();
    } else if (e.type === "audio") {
      if (!this.gate()) return;
      if (!this.resampler || this.resampler.inRate !== e.rate) this.resampler = new Resampler(e.rate);
      const y = this.resampler.push(e.samples);
      if (y.length) this.write(toS16le(y));
    } else if (e.type === "meter") {
      const t = this.now();
      if (this.watch.audible === null || t - this.lastSignalAt < SIGNAL_EVERY_MS) return;
      this.lastSignalAt = t;
      this.emit({ type: "signal", dbfs: e.dbfs, ts: t });
    }
  }

  /** Is audio being played? An AM channel plays only while it has had signal
   *  within cb.fernsdr.audioTailMs (the receiver's squelch is wide open, so the
   *  hang would otherwise play AGC-boosted noise); an LSB channel plays for its
   *  whole hang (SSB has syllable gaps). Closing the gate flushes the faded tail. */
  private gate(): boolean {
    const n = this.watch?.audible ?? null;
    let open = false;
    if (n !== null && this.watch && this.cfg) {
      const hot = this.watch.lastHotAt(n);
      open = this.channel(n)?.mode === "lsb" || (hot !== null && this.now() - hot <= this.cfg.audioTailMs);
    }
    if (!open) this.flushHeld();
    return open;
  }

  /** Hold back the newest FADE_OUT_MS so a close can ramp it to zero. */
  private write(chunk: Buffer): void {
    const all = this.held.length ? Buffer.concat([this.held, chunk]) : chunk;
    const keep = Math.min(FADE_BYTES, all.length);
    if (all.length > keep) this.deps.writePcm(all.subarray(0, all.length - keep));
    this.held = Buffer.from(all.subarray(all.length - keep));
  }

  private flushHeld(): void {
    const n = this.held.length >> 1;
    if (n === 0) return;
    const out = this.held;
    this.held = Buffer.alloc(0);
    for (let i = 0; i < n; i++) out.writeInt16LE(Math.round(out.readInt16LE(i * 2) * (1 - (i + 1) / n)), i * 2);
    this.deps.writePcm(out);
  }

  private apply(ts: CbTransition[]): void {
    let closed = false;
    let lastTs = 0;
    for (const t of ts) {
      lastTs = t.ts;
      if (t.kind === "open") {
        const ch = this.channel(t.n);
        if (ch) this.emit({ type: "active", channel: ch, freq: ch.freq, ts: t.ts });
      } else if (t.kind === "close") {
        closed = true;
        this.emit({ type: "release", channelId: `cb_${t.n}`, ts: t.ts });
      } else {
        const ch = t.n === null ? null : this.channel(t.n) ?? null;
        this.flushHeld();
        if (ch) {
          const mode = ch.mode === "lsb" ? "lsb" : "am";
          // Same channel again: the receiver is still tuned there.
          if (this.lastTune?.freq !== ch.freq || this.lastTune.mode !== mode) {
            this.lastTune = { freq: ch.freq, mode };
            this.client?.tune(ch.freq, mode);
          }
        }
        this.resampler = null;   // fresh stream per channel
        this.emit({ type: "audible", channel: ch, ts: t.ts });
      }
    }
    // idle once, after the last release, only if nothing is open any more
    if (closed && (this.watch?.openChannels().length ?? 0) === 0) this.emit({ type: "idle", ts: lastTs });
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) {
      try { l(e); } catch (err) { this.deps.log?.(`cbNet listener threw: ${String(err)}`); }
    }
  }
}

const watchKey = (c: CbNetConfig): string =>
  JSON.stringify([c.channels.map((x) => [x.id, x.mode]), c.priority, c.openDb, c.openRows, c.hangMs, c.ssbHangMs, c.maxOpenMs, c.audioTailMs]);
