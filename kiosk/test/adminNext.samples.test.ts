import { describe, it, expect, vi } from "vitest";
import { SamplePlayer, sampleUrl } from "../src/frontend/admin-next/samples.js";

function fakeAudio() {
  const handlers: Record<string, Array<() => void>> = {};
  const a = {
    currentTime: 0, paused: true,
    play: vi.fn(async () => { a.paused = false; }),
    pause: vi.fn(() => { a.paused = true; }),
    addEventListener: (t: string, fn: () => void) => { (handlers[t] ??= []).push(fn); },
    fire: (t: string) => { for (const fn of handlers[t] ?? []) fn(); },
  };
  return a;
}

describe("SamplePlayer", () => {
  it("plays one clip at a time and toggles off", () => {
    const made: ReturnType<typeof fakeAudio>[] = [];
    const p = new SamplePlayer((url) => { const a = fakeAudio(); made.push(a); expect(url).toContain("/sample.wav?t="); return a as unknown as HTMLAudioElement; });
    const seen: Array<string | null> = [];
    p.subscribe(() => seen.push(p.playingId));
    p.toggle("cc_1", 5);
    expect(p.playingId).toBe("cc_1");
    p.toggle("cc_2", 6);
    expect(made[0]!.pause).toHaveBeenCalled();
    expect(p.playingId).toBe("cc_2");
    p.toggle("cc_2", 6);
    expect(p.playingId).toBeNull();
    expect(seen).toEqual(["cc_1", null, "cc_2", null]);
  });
  it("stops at the end and reports time left", () => {
    let a!: ReturnType<typeof fakeAudio>;
    const p = new SamplePlayer(() => { a = fakeAudio(); return a as unknown as HTMLAudioElement; });
    p.toggle("cc_1", 1);
    a.currentTime = 4;
    expect(p.remaining(10)).toBe(6);
    a.fire("ended");
    expect(p.playingId).toBeNull();
    expect(p.remaining(10)).toBeNull();
  });
  it("cache-busts by clip timestamp and encodes the id", () => {
    expect(sampleUrl("cc 1", 42)).toBe("/api/discoveries/cc%201/sample.wav?t=42");
  });
});
