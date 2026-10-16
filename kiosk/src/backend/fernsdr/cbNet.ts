// CB via FernSDR (spec 2026-10-15-cb-fernsdr): owns the receiver session and
// the channel watch, emits the same engine events the SDR CB path did, and
// feeds the audible channel's audio to the parked helper as 50 kHz s16 PCM.
import type { Channel } from "../config/schema.js";
import type { CbNetConfig } from "../config/cb.js";
import type { EngineEvent, EngineListener } from "../engine/ScannerEngine.js";
import { CbWatch, type CbTransition } from "./cbWatch.js";
import { FernClient, type FernClientOpts, type FernEvent } from "./client.js";
import { Resampler, toS16le } from "./resample.js";

export interface CbSource {
  start(cfg: CbNetConfig): void;
  pause(): void;
  stop(): void;
  status(): { connected: boolean; error: string | null };
  on(l: EngineListener): void;
  off(l: EngineListener): void;
}
export interface FernClientLike { start(): void; stop(): void; tune(freq: number, mode: "am" | "lsb"): void; readonly connected: boolean; readonly error: string | null }
interface CbNetDeps {
  writePcm: (chunk: Buffer) => void;
  now?: () => number;
  clientFactory?: (opts: FernClientOpts, onEvent: (e: FernEvent) => void) => FernClientLike;
  log?: (m: string) => void;
}

const SIGNAL_EVERY_MS = 250;

export class CbNet implements CbSource {
  private state: "stopped" | "running" | "paused" = "stopped";
  private cfg: CbNetConfig | null = null;
  private client: FernClientLike | null = null;
  private watch: CbWatch | null = null;
  private resampler: Resampler | null = null;
  private lastSignalAt = -Infinity;
  private readonly listeners = new Set<EngineListener>();
  private readonly now: () => number;

  constructor(private readonly deps: CbNetDeps) {
    this.now = deps.now ?? Date.now;
  }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  status(): { connected: boolean; error: string | null } {
    if (this.state === "stopped" || !this.client) return { connected: false, error: null };
    return { connected: this.client.connected, error: this.client.connected ? null : this.client.error };
  }

  start(cfg: CbNetConfig): void {
    if (this.state !== "stopped" && this.cfg && (cfg.url !== this.cfg.url || cfg.band !== this.cfg.band)) this.stop();
    if (this.state === "stopped") {
      this.cfg = cfg;
      this.watch = this.makeWatch(cfg);
      const factory = this.deps.clientFactory ?? ((o, e) => new FernClient(o, e));
      this.client = factory({ url: cfg.url, band: cfg.band, backoffMaxMs: cfg.backoffMaxMs, log: this.deps.log }, (e) => this.onFern(e));
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
    this.apply(this.watch?.closeAll(this.now()) ?? []);
    this.client?.stop();
    this.client = null;
    this.watch = null;
    this.resampler = null;
    this.state = "stopped";
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
    if (e.type === "row") {
      this.apply(this.watch.row(e, this.now()));
    } else if (e.type === "audio") {
      if (this.watch.audible === null) return;
      if (!this.resampler || this.resampler.inRate !== e.rate) this.resampler = new Resampler(e.rate);
      const y = this.resampler.push(e.samples);
      if (y.length) this.deps.writePcm(toS16le(y));
    } else if (e.type === "meter") {
      const t = this.now();
      if (this.watch.audible === null || t - this.lastSignalAt < SIGNAL_EVERY_MS) return;
      this.lastSignalAt = t;
      this.emit({ type: "signal", dbfs: e.dbfs, ts: t });
    }
  }

  private apply(ts: CbTransition[]): void {
    for (const t of ts) {
      if (t.kind === "open") {
        const ch = this.channel(t.n);
        if (ch) this.emit({ type: "active", channel: ch, freq: ch.freq, ts: t.ts });
      } else if (t.kind === "close") {
        this.emit({ type: "release", channelId: `cb_${t.n}`, ts: t.ts });
        if ((this.watch?.openChannels().length ?? 0) === 0) this.emit({ type: "idle", ts: t.ts });
      } else {
        const ch = t.n === null ? null : this.channel(t.n) ?? null;
        if (ch) this.client?.tune(ch.freq, ch.mode === "lsb" ? "lsb" : "am");
        this.resampler = null;   // fresh stream per channel
        this.emit({ type: "audible", channel: ch, ts: t.ts });
      }
    }
  }

  private emit(e: EngineEvent): void {
    for (const l of this.listeners) l(e);
  }
}

const watchKey = (c: CbNetConfig): string =>
  JSON.stringify([c.channels.map((x) => [x.id, x.mode]), c.priority, c.openDb, c.openRows, c.hangMs, c.ssbHangMs, c.maxOpenMs]);
