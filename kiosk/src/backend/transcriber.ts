import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// Transcription (ROADMAP stretch, opt-in): what was SAID, not just when.
//
// Capture rides the remote-listening audio tee: while a channel owns the
// speaker, its PCM is the mixed feed — segment on audible transitions,
// write a wav, hand it to the python worker (faster-whisper tiny.en at
// nice 15), and file the text back onto the history row. The keystone
// store grows a searchable voice log.
//
// Honest limits: tiny.en quality on scanner audio is "gist", not court
// transcript; segments cap at 2 min; the worker is one process — a burst
// of transmissions queues and drains in order.

const MIN_SEGMENT_MS = 1_200;     // kerchunks aren't speech
const MAX_SEGMENT_MS = 120_000;   // runaway carriers get truncated
const RATE = 48_000;
const BYTES_PER_S = RATE * 2;

export interface TranscriberOptions {
  workerCmd: string[];            // e.g. [venv-python, worker.py]
  tmpDir: string;
  onText: (seg: { channelId: string; startedTs: number; text: string }) => void;
}

export class Transcriber {
  private worker: ChildProcess | null = null;
  private buf: Buffer[] = [];
  private bufBytes = 0;
  private current: { channelId: string; startedTs: number } | null = null;
  private pending = new Map<string, { channelId: string; startedTs: number }>();
  private seq = 0;

  constructor(private readonly opts: TranscriberOptions) {}

  start(): void {
    mkdirSync(this.opts.tmpDir, { recursive: true });
    this.worker = spawn(this.opts.workerCmd[0]!, this.opts.workerCmd.slice(1), {
      stdio: ["pipe", "pipe", "ignore"],
    });
    this.worker.on("error", () => { this.worker = null; });
    this.worker.on("exit", () => { this.worker = null; });
    const out = createInterface({ input: this.worker.stdout! });
    out.on("line", (line) => {
      try {
        const { path, text } = JSON.parse(line) as { path: string; text: string };
        const seg = this.pending.get(path);
        this.pending.delete(path);
        if (seg && text) this.opts.onText({ ...seg, text });
      } catch { /* worker noise */ }
    });
  }

  stop(): void {
    this.worker?.kill();
    this.worker = null;
  }

  /** Feed the live speaker PCM (only buffered while a segment is open). */
  audio(chunk: Buffer): void {
    if (!this.current || this.bufBytes > (MAX_SEGMENT_MS / 1000) * BYTES_PER_S) return;
    this.buf.push(chunk);
    this.bufBytes += chunk.length;
  }

  /** The speaker changed hands: close any open segment, open the next. */
  audible(channelId: string | null, ts: number): void {
    this.flush();
    this.current = channelId ? { channelId, startedTs: ts } : null;
  }

  private flush(): void {
    const seg = this.current;
    const ms = (this.bufBytes / BYTES_PER_S) * 1000;
    const pcm = this.bufBytes > 0 ? Buffer.concat(this.buf) : null;
    this.buf = [];
    this.bufBytes = 0;
    this.current = null;
    if (!seg || !pcm || ms < MIN_SEGMENT_MS || !this.worker?.stdin?.writable) return;
    const path = join(this.opts.tmpDir, `seg-${Date.now()}-${this.seq++}.wav`);
    try {
      writeFileSync(path, wav(pcm));
    } catch { return; }
    this.pending.set(path, seg);
    this.worker.stdin.write(path + "\n");
  }
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(BYTES_PER_S, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
