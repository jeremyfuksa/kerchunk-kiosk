import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcSampleStore, ORPHAN_GRACE_MS } from "../src/backend/ccSampleStore.js";

let dir: string;
let store: CcSampleStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccs-"));
  store = new CcSampleStore(join(dir, "cc-samples"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** `seconds` of 8 kHz mono s16 silence. */
const pcm = (seconds: number) => Buffer.alloc(Math.round(seconds * 8000) * 2);

/** Backdate a clip so age-sensitive rules can be exercised. */
function ageBy(freqHz: number, ms: number): void {
  const when = new Date(Date.now() - ms);
  utimesSync(store.pathFor(freqHz), when, when);
}

describe("CcSampleStore", () => {
  it("creates its directory lazily and writes a playable clip", () => {
    store.write(154_570_000, pcm(1));
    expect(existsSync(store.pathFor(154_570_000))).toBe(true);
    const meta = store.meta(154_570_000);
    expect(meta?.freqHz).toBe(154_570_000);
    expect(meta?.seconds).toBeCloseTo(1, 2);
  });

  it("overwrites the previous clip for the same frequency", () => {
    store.write(154_570_000, pcm(1));
    store.write(154_570_000, pcm(3));
    expect(store.meta(154_570_000)?.seconds).toBeCloseTo(3, 2);
    expect(store.list().length).toBe(1);
  });

  it("reports no metadata for a frequency it has never seen", () => {
    expect(store.meta(154_570_000)).toBeNull();
  });

  it("deletes a clip and reports whether there was one", () => {
    store.write(154_570_000, pcm(1));
    expect(store.delete(154_570_000)).toBe(true);
    expect(store.delete(154_570_000)).toBe(false);
    expect(store.meta(154_570_000)).toBeNull();
  });

  it("lists clips newest first", () => {
    store.write(154_570_000, pcm(1));
    store.write(155_100_000, pcm(1));
    ageBy(154_570_000, 60_000);
    expect(store.list().map((m) => m.freqHz)).toEqual([155_100_000, 154_570_000]);
  });

  it("sweeps orphans older than the grace period", () => {
    store.write(154_570_000, pcm(1));   // orphan, old
    store.write(155_100_000, pcm(1));   // orphan, fresh
    store.write(156_000_000, pcm(1));   // known
    ageBy(154_570_000, ORPHAN_GRACE_MS + 60_000);
    store.sweep({ knownFreqs: [156_000_000], maxBytes: 1024 * 1024 * 50, nowMs: Date.now() });
    expect(store.meta(154_570_000)).toBeNull();
    expect(store.meta(155_100_000)).not.toBeNull();
    expect(store.meta(156_000_000)).not.toBeNull();
  });

  it("evicts oldest first to stay under the size cap", () => {
    store.write(154_570_000, pcm(1));
    store.write(155_100_000, pcm(1));
    store.write(156_000_000, pcm(1));
    ageBy(154_570_000, 120_000);
    ageBy(155_100_000, 60_000);
    const oneClip = store.meta(156_000_000)!.bytes;
    store.sweep({
      knownFreqs: [154_570_000, 155_100_000, 156_000_000],
      maxBytes: oneClip * 2,
      nowMs: Date.now(),
    });
    expect(store.meta(154_570_000)).toBeNull();     // oldest goes first
    expect(store.meta(155_100_000)).not.toBeNull();
    expect(store.meta(156_000_000)).not.toBeNull();
  });

  it("ignores files that are not clips", () => {
    store.write(154_570_000, pcm(1));
    writeFileSync(join(dir, "cc-samples", "notes.txt"), "hi");
    expect(store.list().map((m) => m.freqHz)).toEqual([154_570_000]);
  });
});
