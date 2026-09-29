import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplyBatcher, TUNE_APPLY_DELAY_MS, type BatchState } from "../src/frontend/admin-next/batcher.js";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function make(save: (ids: string[]) => Promise<void> = async () => {}) {
  const states: BatchState["kind"][] = [];
  const saves: string[][] = [];
  const b = new ApplyBatcher(async (ids) => { saves.push(ids); await save(ids); }, (s) => states.push(s.kind));
  return { b, states, saves };
}

describe("ApplyBatcher", () => {
  it("batches changes into one save after the delay", async () => {
    const { b, saves, states } = make();
    b.change("a"); b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS - 1);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(saves).toEqual([["a", "b"]]);
    expect(states.slice(-2)).toEqual(["saving", "saved"]);
  });
  it("a new change restarts the countdown", async () => {
    const { b, saves } = make();
    b.change("a");
    await vi.advanceTimersByTimeAsync(2000);
    b.change("b");
    await vi.advanceTimersByTimeAsync(2000);
    expect(saves).toEqual([]);
    await vi.advanceTimersByTimeAsync(1000);
    expect(saves).toEqual([["a", "b"]]);
  });
  it("undo cancels and hands back the ids", async () => {
    const { b, saves } = make();
    b.change("a");
    expect(b.undo()).toEqual(["a"]);
    expect(b.state.kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
    expect(saves).toEqual([]);
  });
  it("a failed save keeps its ids for the next change", async () => {
    let fail = true;
    const { b, saves } = make(async () => { if (fail) throw new Error("409"); });
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(b.state).toEqual({ kind: "error", message: "409", ids: ["a"] });
    fail = false;
    b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"], ["a", "b"]]);
    expect(b.state.kind).toBe("saved");
  });
  it("never saves concurrently: a change during a save waits for it", async () => {
    let release!: () => void;
    let inFlight = 0; let max = 0;
    const { b, saves } = make(() => { inFlight++; max = Math.max(max, inFlight); return new Promise<void>((r) => { release = () => { inFlight--; r(); }; }); });
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    b.change("b");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"]]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(saves).toEqual([["a"], ["b"]]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(max).toBe(1);
  });
});
