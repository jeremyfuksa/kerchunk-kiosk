// FernSDR listener session (upstream docs/PROTOCOL.md): one WebSocket,
// plain NAC audio + plain WFC rows + JSON meters. Reconnects with backoff
// and jitter, replaying its settings; never after close 4001/4002.
import WebSocket from "ws";
import { NacDecoder } from "./nac.js";
import { WfcDecoder, parseWaterfallFrame } from "./wfc.js";

export interface FernBand { id: string; low: number; high: number; center: number }
export type FernEvent =
  | { type: "connected"; band: FernBand }
  | { type: "disconnected"; reason: string; retrying: boolean }
  | { type: "row"; lowHz: number; highHz: number; levels: number[] }
  | { type: "audio"; samples: Float32Array; rate: number }
  | { type: "meter"; dbfs: number }
  | { type: "offair"; note: string | null; untilMs: number | null }
  | { type: "onair" };
export interface OffAir { note: string | null; untilMs: number | null }
export interface FernClientOpts { url: string; band: string; backoffMaxMs: number; backoffBaseMs?: number; staleMs?: number; random?: () => number; log?: (m: string) => void }

const CAPABILITIES = ["audio-discontinuity"];
const VIEW_WIDTH = 456;   // ~1 kHz bins over the 456 kHz CB band
const VIEW_FPS = 10;
const DEFAULT_STALE_MS = 8000;   // cb.fernsdr.staleMs overrides (via CbNet)
const ACK_WARN_MS = 2000;        // a tune un-acked this long is logged once (audio stays gated)
const MAX_CONCEAL = 8;           // frames concealed for a gap; bigger = discontinuity
const NO_RETRY: Record<number, string> = { 4001: "receiver listener timeout", 4002: "disconnected by the receiver operator" };

export class FernClient {
  private ws: WebSocket | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private attempt = 0;
  private running = false;
  private _connected = false;
  private _error: string | null = null;
  private band: FernBand | null = null;
  private target: { freq: number; mode: "am" | "lsb" } | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private ackTimer: NodeJS.Timeout | null = null;
  private requestId = 0;
  private ackedTune = 0;
  private rates = new Map<number, number>();
  private lastSeq: number | null = null;
  // Schedule: the receiver moves every listener to another band when ours is off the air.
  private serverBand: string | null = null;
  private bandInfo: { running?: boolean; on_air?: boolean; next_change?: number } = {};
  private note: string | null = null;
  private _offAir: OffAir | null = null;
  private wasOnAir = true;
  private awaitingReturn = false;   // our band is back on air; waiting for the receiver to confirm we are on it
  private lastRetuneAt = -Infinity;
  private readonly nac = new NacDecoder();
  private readonly wfc = new WfcDecoder();

  constructor(private readonly opts: FernClientOpts, private readonly onEvent: (e: FernEvent) => void) {}

  get connected(): boolean { return this._connected; }
  get error(): string | null { return this._error; }
  /** Still trying: connecting, connected, or backing off (false once stopped or after 4001/4002/bad URL). */
  get retrying(): boolean { return this.running; }
  /** Connected but not hearing our band (night schedule): the note and when it returns. */
  get offAir(): OffAir | null { return this._offAir; }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.clearStale();
    this.clearAckWatch();
    const ws = this.ws;
    this.ws = null;
    this._connected = false;
    ws?.removeAllListeners();
    ws?.on("error", () => {});
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close(1000);
  }

  tune(freq: number, mode: "am" | "lsb"): void {
    this.target = { freq, mode };
    this.requestId++;
    this.sendTune();
    this.armAckWatch();
  }

  private clearStale(): void { if (this.staleTimer) { clearTimeout(this.staleTimer); this.staleTimer = null; } }
  private clearAckWatch(): void { if (this.ackTimer) { clearTimeout(this.ackTimer); this.ackTimer = null; } }

  /** Rows arrive ~10/s, so silence means a half-open socket (power or network
   *  loss never sends a FIN): terminate it and let close → backoff reconnect run. */
  private armStale(ws: WebSocket): void {
    this.clearStale();
    this.staleTimer = setTimeout(() => {
      this.staleTimer = null;
      if (this.ws !== ws) return;
      this.opts.log?.(`[fernsdr] no data for ${this.opts.staleMs ?? DEFAULT_STALE_MS} ms; reconnecting`);
      this._error = "receiver stopped sending";
      ws.terminate();
    }, this.opts.staleMs ?? DEFAULT_STALE_MS);
  }

  /** Audio stays gated until the receiver acks the tune; say so if it never does. */
  private armAckWatch(): void {
    this.clearAckWatch();
    if (!this.target || this.ackedTune >= this.requestId) return;
    const { freq } = this.target;
    const id = this.requestId;
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (this.running && this._connected && this.ackedTune < id) this.opts.log?.(`[fernsdr] tune ${freq} not acknowledged after 2 s`);
    }, ACK_WARN_MS);
  }

  private sendTune(): void {
    if (!this.target || !this._connected || !this.band) return;
    this.send({ type: "tune", band: this.band.id, freq: this.target.freq, mode: this.target.mode, request_id: this.requestId });
  }

  private send(m: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private connect(): void {
    // _error is deliberately NOT cleared here: a reconnect that hangs never sets
    // a new one, and the outage must keep reading as offline until a welcome.
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, { maxPayload: 1 << 20 });
    } catch (e) {
      // A malformed URL won't fix itself: report it and stop retrying.
      const reason = e instanceof Error ? e.message : String(e);
      this._error = reason;
      this.running = false;
      this.onEvent({ type: "disconnected", reason, retrying: false });
      return;
    }
    this.ws = ws;
    this.armStale(ws);
    ws.on("message", (data, isBinary) => {
      if (this.ws !== ws) return;
      this.armStale(ws);
      try {
        if (isBinary) this.onBinary(data as Buffer);
        else this.onText(String(data));
      } catch (e) {
        this.opts.log?.(`[fernsdr] protocol error: ${e instanceof Error ? e.message : String(e)}`);
      }
    });
    ws.on("error", (e) => { if (this.ws === ws) this._error = e.message; });
    ws.on("close", (code, reasonBuf) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._connected = false;
      this.clearStale();
      this.clearAckWatch();
      this._offAir = null;   // CbNet clears its own flag on "disconnected"; a welcome recomputes
      const reason = NO_RETRY[code] ?? (this._error || String(reasonBuf) || `closed (${code})`);
      this._error = reason;
      const retrying = this.running && !(code in NO_RETRY);
      this.onEvent({ type: "disconnected", reason, retrying });
      if (retrying) this.scheduleRetry();
      else this.running = false;
    });
  }

  private scheduleRetry(): void {
    const base = this.opts.backoffBaseMs ?? 1000;
    const delay = Math.min(this.opts.backoffMaxMs, base * 2 ** this.attempt) * (0.5 + (this.opts.random ?? Math.random)() / 2);
    this.attempt++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; if (this.running) this.connect(); }, delay);
  }

  private onText(text: string): void {
    let m: any;
    try { m = JSON.parse(text); } catch { return; }
    switch (m?.type) {
      case "welcome": return this.onWelcome(m);
      case "state":
        if (typeof m.band === "string") this.serverBand = m.band;
        if (typeof m.note === "string") this.note = m.note;
        else if (this.serverBand === this.opts.band) this.note = null;
        if (typeof m.ack?.tune === "number" && m.ack.tune > this.ackedTune) {
          const caughtUp = m.ack.tune >= this.requestId && this.ackedTune < this.requestId;
          this.ackedTune = m.ack.tune;
          if (caughtUp) { this.nac.reset(); this.lastSeq = null; this.clearAckWatch(); }
        }
        if (this.awaitingReturn && this.serverBand === this.opts.band && this.ackedTune >= this.requestId) this.awaitingReturn = false;
        this.retuneIfDrifted(m);
        return this.updateOffAir();
      case "band-status":
        this.mergeBands(m.bands);
        return this.updateOffAir(true);
      case "audio-config":
        if (typeof m.generation === "number" && typeof m.rate === "number") this.rates.set(m.generation & 0xf, m.rate);
        return;
      case "meter":
        if (typeof m.dbfs === "number") this.onEvent({ type: "meter", dbfs: m.dbfs });
        return;
      case "inactivity": return this.send({ type: "active" });
      case "error": this.opts.log?.(`[fernsdr] server error: ${m.message}`); return;
      default: return;   // chat, station, theme, rds, band-status
    }
  }

  private onWelcome(m: any): void {
    const bands: any[] = Array.isArray(m.bands) ? m.bands : [];
    const band = bands.find((b: any) => b?.id === this.opts.band);
    if (!band || !Number.isFinite(band.low) || !Number.isFinite(band.high) || !Number.isFinite(band.center)) {
      this._error = `band ${this.opts.band} not on the receiver`;
      this.ws?.close(1000);
      return;
    }
    this.serverBand = null;
    this.note = null;
    this.bandInfo = {};
    this.awaitingReturn = false;
    this.mergeBands(bands);
    this.band = { id: band.id, low: band.low, high: band.high, center: band.center };
    const caps = CAPABILITIES.filter((c) => (Array.isArray(m.capabilities) ? m.capabilities : []).includes(c));
    this.rates.clear();
    this.ackedTune = 0;
    this.lastSeq = null;
    this.nac.reset();
    this.wfc.reset();
    this._connected = true;
    this._error = null;
    this.attempt = 0;
    this.send({ type: "hello", capabilities: caps });
    this.send({ type: "audio", enabled: true, rate: 12000 });
    this.send({ type: "dsp", squelch: -200, agc: "auto" });
    this.send({ type: "viewport", enabled: true, low: band.low, high: band.high, width: VIEW_WIDTH, fps: VIEW_FPS });
    // request_ids restart per connection: re-send the current tune as id 1+.
    if (this.target) { this.requestId = Math.max(1, this.requestId); this.sendTune(); this.armAckWatch(); }
    this.onEvent({ type: "connected", band: this.band });
    this.wasOnAir = this.ourBandOnAir();
    this.updateOffAir();
  }

  private retune(): void {
    this.lastRetuneAt = Date.now();
    this.requestId++;
    this.sendTune();
    this.armAckWatch();
  }

  /** A state that puts us on our band at a different freq/mode than we want: re-tune (at most every 5 s). */
  private retuneIfDrifted(m: any): void {
    if (!this.target || this.serverBand !== this.opts.band || this.ackedTune < this.requestId) return;
    if (typeof m.freq !== "number" || Date.now() - this.lastRetuneAt < 5000) return;
    if (m.freq !== this.target.freq || (typeof m.mode === "string" && m.mode !== this.target.mode)) this.retune();
  }

  private mergeBands(bands: unknown): void {
    const b = Array.isArray(bands) ? bands.find((x: any) => x?.id === this.opts.band) : undefined;
    if (!b) return;
    if (typeof b.running === "boolean") this.bandInfo.running = b.running;
    if (typeof b.on_air === "boolean") this.bandInfo.on_air = b.on_air;
    if (typeof b.next_change === "number") this.bandInfo.next_change = b.next_change;
  }

  private ourBandOnAir(): boolean { return this.bandInfo.running !== false && this.bandInfo.on_air !== false; }

  /** Recompute off-air from the server's actual band + our band's schedule; emit on change.
   *  `bandStatus`: a schedule update, where a return to air re-sends our tune (once per transition). */
  private updateOffAir(bandStatus = false): void {
    if (!this._connected) return;
    const onAir = this.ourBandOnAir();
    const elsewhere = this.serverBand !== null && this.serverBand !== this.opts.band;
    if (bandStatus && onAir && !this.wasOnAir && this.band) {
      // Whatever the receiver last told us, it may have parked us elsewhere: always re-tune,
      // and stay off-air until a state on our band acks it (the ack gate also drops stale audio).
      if (!this.target) this.target = { freq: this.band.center, mode: "am" };
      this.retune();
      this.awaitingReturn = true;
    }
    if (!onAir) this.awaitingReturn = false;
    if (bandStatus) this.wasOnAir = onAir;
    const off = elsewhere || !onAir || this.awaitingReturn;
    const nc = this.bandInfo.next_change;
    // next_change is only "back at" while our band is off; on air it is the next sunset.
    const next: OffAir | null = off ? { note: this.note, untilMs: !onAir && typeof nc === "number" && Number.isFinite(nc) && nc > Date.now() ? nc : null } : null;
    const prev = this._offAir;
    this._offAir = next;
    if (!!prev !== !!next) this.wfc.reset();   // deltas must not decode against the other band's rows
    if (next && (!prev || prev.note !== next.note || prev.untilMs !== next.untilMs)) this.onEvent({ type: "offair", note: next.note, untilMs: next.untilMs });
    else if (!next && prev) this.onEvent({ type: "onair" });
  }

  private onBinary(buf: Buffer): void {
    if (buf.length < 2 || this._offAir) return;   // off the air: whatever arrives is another band
    if (buf[0] === 0x01) return this.onAudio(buf);
    if (buf[0] === 0x02) {
      const f = parseWaterfallFrame(buf);
      if (!f) return;
      if (f.flags !== 0) { this.wfc.reset(); return; }   // never negotiated: not ours to decode
      const levels = this.wfc.decode(f.payload, f.width);
      if (levels) this.onEvent({ type: "row", lowHz: f.lowHz, highHz: f.highHz, levels });
    }
  }

  private onAudio(buf: Buffer): void {
    if (buf.length < 4) return;
    if (this.ackedTune < this.requestId) return;   // still the previous channel's audio
    const flags = buf[1]!;
    const rate = this.rates.get(flags >> 4);
    if (rate === undefined) return;
    const seq = buf.readUInt16LE(2);
    if (flags & 0b100) {
      this.nac.reset();
    } else if (this.lastSeq !== null) {
      const gap = (seq - this.lastSeq - 1) & 0xffff;
      if (gap >= 0x8000) return;   // duplicate or late
      if (gap > MAX_CONCEAL) this.nac.reset();   // a long hole is a discontinuity, not worth faking
      else for (let i = 0; i < gap; i++) this.onEvent({ type: "audio", samples: this.nac.conceal(), rate });
    }
    this.lastSeq = seq;
    const out = this.nac.decode(buf.subarray(4)) ?? this.nac.conceal();
    this.onEvent({ type: "audio", samples: out, rate });
  }
}
