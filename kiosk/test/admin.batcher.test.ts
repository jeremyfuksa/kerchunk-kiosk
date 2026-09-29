import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApplyBatcher, TUNE_APPLY_DELAY_MS, type BatchState } from "../src/frontend/admin/batcher.js";

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
  it("a change during a failing save cancels its timer and folds into one error", async () => {
    let fail = true;
    let reject!: (e: Error) => void;
    const { b, saves } = make(() => fail
      ? new Promise<void>((_resolve, rj) => { reject = rj; })
      : Promise.resolve());
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"]]);
    b.change("b"); // arms a timer while "a"'s save is still in flight
    reject(new Error("409"));
    await vi.advanceTimersByTimeAsync(0);
    expect(b.state.kind).toBe("error");
    expect(b.state as { ids: string[] }).toMatchObject({ message: "409" });
    expect(([...(b.state as { ids: string[] }).ids]).sort()).toEqual(["a", "b"]);
    // No restart fires on its own — b's countdown must have been cancelled.
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
    expect(saves).toEqual([["a"]]);
    fail = false;
    b.change("c");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toHaveLength(2);
    expect([...saves[1]!].sort()).toEqual(["a", "b", "c"]);
    expect(b.state.kind).toBe("saved");
  });
  it("undo during an in-flight save returns only the not-yet-saved ids", async () => {
    let resolve!: () => void;
    const { b, saves } = make(() => new Promise<void>((r) => { resolve = r; }));
    b.change("a");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
    expect(saves).toEqual([["a"]]);
    b.change("b"); // collected after "a" went into flight; not part of that save
    expect(b.undo()).toEqual(["b"]);
    expect(b.state.kind).toBe("idle");
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    // "a"'s save succeeded after undo cleared the pending set; nothing else
    // is pending, so the batcher settles on "saved" (idle-then-saved).
    expect(b.state.kind).toBe("saved");
    await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
    expect(saves).toEqual([["a"]]);
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
  describe("drop", () => {
    it("removes one id and keeps the countdown for the rest", async () => {
      const { b, saves } = make();
      b.change("a"); b.change("b");
      b.drop("a");
      expect(b.state).toMatchObject({ kind: "pending", ids: ["b"] });
      await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
      expect(saves).toEqual([["b"]]);
    });
    it("dropping the last id cancels the timer and goes idle", async () => {
      const { b, saves } = make();
      b.change("a");
      b.drop("a");
      expect(b.state.kind).toBe("idle");
      await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
      expect(saves).toEqual([]);
    });
    it("an id it doesn't hold is ignored", () => {
      const { b, states } = make();
      b.change("a");
      const n = states.length;
      b.drop("zz");
      expect(states.length).toBe(n);
      expect(b.state).toMatchObject({ kind: "pending", ids: ["a"] });
    });
    it("dropping from a failed batch shrinks the error; the last one clears it", async () => {
      const { b } = make(async () => { throw new Error("409"); });
      b.change("a"); b.change("b");
      await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
      b.drop("a");
      expect(b.state).toEqual({ kind: "error", message: "409", ids: ["b"] });
      b.drop("b");
      expect(b.state.kind).toBe("idle");
    });
    it("dropping the only change queued behind an in-flight save shows that save again", async () => {
      let resolve!: () => void;
      const { b, saves } = make(() => new Promise<void>((r) => { resolve = r; }));
      b.change("a");
      await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS);
      b.change("b");
      b.drop("b");
      expect(b.state).toEqual({ kind: "saving", ids: ["a"] });
      resolve();
      await vi.advanceTimersByTimeAsync(TUNE_APPLY_DELAY_MS * 2);
      expect(saves).toEqual([["a"]]);
      expect(b.state.kind).toBe("saved");
    });
  });
});
