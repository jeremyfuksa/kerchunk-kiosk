import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decimate48kTo8k, encodeWav8k, PrerollRing, CcRecorder } from "../src/backend/ccRecorder.js";
import { CcSampleStore } from "../src/backend/ccSampleStore.js";

function s16(samples: number[]): Buffer {
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => buf.writeInt16LE(v, i * 2));
  return buf;
}
function readS16(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length / 2; i++) out.push(buf.readInt16LE(i * 2));
  return out;
}

describe("decimate48kTo8k", () => {
  it("averages each run of six samples into one", () => {
    const out = decimate48kTo8k(s16([0, 0, 0, 60, 60, 60, 12, 12, 12, 12, 12, 12]));
    expect(readS16(out)).toEqual([30, 12]);
  });

  it("drops a trailing partial run rather than distorting it", () => {
    const out = decimate48kTo8k(s16([6, 6, 6, 6, 6, 6, 100, 100]));
    expect(readS16(out)).toEqual([6]);
  });

  it("preserves negative amplitudes", () => {
    const out = decimate48kTo8k(s16([-30, -30, -30, -30, -30, -30]));
    expect(readS16(out)).toEqual([-30]);
  });
});

describe("encodeWav8k", () => {
  it("writes a 44-byte 8 kHz mono s16 header ahead of the data", () => {
    const data = s16([1, 2, 3, 4]);
    const wav = encodeWav8k(data);
    expect(wav.length).toBe(44 + data.length);
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(36 + data.length);
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1);      // PCM
    expect(wav.readUInt16LE(22)).toBe(1);      // mono
    expect(wav.readUInt32LE(24)).toBe(8000);   // sample rate
    expect(wav.readUInt32LE(28)).toBe(16000);  // byte rate
    expect(wav.readUInt16LE(32)).toBe(2);      // block align
    expect(wav.readUInt16LE(34)).toBe(16);     // bits
    expect(wav.subarray(36, 40).toString()).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(data.length);
    expect(wav.subarray(44)).toEqual(data);
  });
});

describe("PrerollRing", () => {
  it("returns everything written while under capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    expect(readS16(ring.read())).toEqual([1, 2]);
  });

  it("keeps only the most recent bytes once it wraps, in order", () => {
    const ring = new PrerollRing(8); // 4 samples
    ring.write(s16([1, 2, 3, 4]));
    ring.write(s16([5, 6]));
    expect(readS16(ring.read())).toEqual([3, 4, 5, 6]);
  });

  it("handles a single write larger than capacity", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2, 3, 4, 5, 6, 7]));
    expect(readS16(ring.read())).toEqual([4, 5, 6, 7]);
  });

  it("clear() empties it", () => {
    const ring = new PrerollRing(8);
    ring.write(s16([1, 2]));
    ring.clear();
    expect(ring.read().length).toBe(0);
  });
});

describe("CcRecorder", () => {
  let dir: string;
  let store: CcSampleStore;
  let enabled: boolean;
  let recordable: boolean;

  function makeRecorder(maxSeconds = 20) {
    return new CcRecorder({
      store,
      enabled: () => enabled,
      isRecordable: () => recordable,
      maxSeconds: () => maxSeconds,
      maxBytes: () => 50 * 1024 * 1024,
      knownFreqs: () => [],
      now: () => Date.now(),
    });
  }

  /** `seconds` of 48 kHz mono s16 tone-ish data (non-zero so it is distinguishable). */
  const feed = (seconds: number) => {
    const buf = Buffer.alloc(Math.round(seconds * 48_000) * 2);
    for (let i = 0; i < buf.length / 2; i++) buf.writeInt16LE(1000, i * 2);
    return buf;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccr-"));
    store = new CcSampleStore(join(dir, "cc-samples"));
    enabled = true;
    recordable = true;
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes a clip when a close call lane takes and then loses the speaker", () => {
    const rec = makeRecorder();
    rec.onPcm(feed(1));
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    const meta = store.meta(154_570_000);
    expect(meta).not.toBeNull();
    // 3 s of hit plus the 2 s pre-roll cap, of which only 1 s was buffered.
    expect(meta!.seconds).toBeCloseTo(4, 1);
  });

  it("includes pre-roll from before the audible event", () => {
    const rec = makeRecorder();
    rec.onPcm(feed(5));            // ring keeps the last 2 s
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)!.seconds).toBeCloseTo(3, 1);
  });

  it("ignores audible spans that are not close call lanes", () => {
    const rec = makeRecorder();
    rec.onAudible("ch_abc123");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("stops at the length cap even while the lane still holds the speaker", () => {
    const rec = makeRecorder(2);
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(10));
    expect(store.meta(154_570_000)!.seconds).toBeCloseTo(2, 1);
  });

  it("does not re-open a clip for the same span after the cap fires", () => {
    const rec = makeRecorder(2);
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(10));
    const first = store.meta(154_570_000)!.ts;
    rec.onPcm(feed(10));
    expect(store.meta(154_570_000)!.ts).toBe(first);
  });

  it("flushes the old clip and starts a new one when the lane changes", () => {
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(1));
    rec.onAudible("cc_155100000");
    rec.onPcm(feed(1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)).not.toBeNull();
    expect(store.meta(155_100_000)).not.toBeNull();
  });

  it("records nothing while disabled, and keeps no pre-roll", () => {
    enabled = false;
    const rec = makeRecorder();
    rec.onPcm(feed(3));
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("skips a frequency the server says is not recordable", () => {
    recordable = false;
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(3));
    rec.onAudible(null);
    expect(store.list()).toEqual([]);
  });

  it("discards a clip too short to be worth auditioning", () => {
    const rec = makeRecorder();
    rec.onAudible("cc_154570000");
    rec.onPcm(feed(0.1));
    rec.onAudible(null);
    expect(store.meta(154_570_000)).toBeNull();
  });
});
