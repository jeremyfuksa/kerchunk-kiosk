import { describe, it, expect } from "vitest";
import { lockoutFreqIn, unlockFreqIn } from "../src/frontend/lib/lockout.js";

describe("lockout / unlock round trip", () => {
  // The channel the operator locked out: rich, expensively-identified metadata
  // that the lookup chain (RepeaterBook -> MyGMRS -> RadioReference -> FccProx
  // -> BusinessGuess) paid API calls to build.
  const arrowhead = {
    id: "ch_1", freq: 463562500, alphaTag: "Kansas City Chiefs Arrowhead",
    mode: "nfm" as const, enabled: true, audible: false,
    rfDb: -4.2, tags: ["business"],
    location: { lat: 39.04886, lon: -94.48389, city: "Kansas City", state: "MO", source: "fccprox" },
    lookedUpAt: 1780689240771,
  };
  const other = { id: "ch_2", freq: 463600000, alphaTag: "Argosy", mode: "nfm" as const, enabled: true };
  const cfg = () => ({
    channels: [{ ...arrowhead }, { ...other }],
    discoveries: [{ freq: 463562500 }, { freq: 464175000 }],
    scan: { lockoutHz: [146012500] },
  });

  it("lockout archives the channel instead of deleting it", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    const ch = out.channels.find((c) => c.freq === 463562500);
    expect(ch).toBeDefined();
    expect(ch!.enabled).toBe(false);
  });

  it("lockout keeps every field the lookup chain built", () => {
    const ch = lockoutFreqIn(cfg(), 463562500).channels.find((c) => c.freq === 463562500)!;
    expect(ch.alphaTag).toBe("Kansas City Chiefs Arrowhead");
    expect(ch.location).toEqual(arrowhead.location);
    expect(ch.rfDb).toBe(-4.2);
    expect(ch.lookedUpAt).toBe(1780689240771);
  });

  it("lockout suppresses Close Call and clears the pending discovery", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    expect(out.scan.lockoutHz).toContain(463562500);
    expect(out.scan.lockoutHz).toContain(146012500); // existing entries survive
    expect(out.discoveries.map((d) => d.freq)).toEqual([464175000]);
  });

  it("lockout leaves other channels untouched", () => {
    const out = lockoutFreqIn(cfg(), 463562500);
    expect(out.channels.find((c) => c.freq === 463600000)!.enabled).toBe(true);
  });

  it("unlock restores a scanning channel — not just an empty suppression list", () => {
    // The operator-reported bug: unlock cleared lockoutHz and left nothing to
    // scan, because lockout had deleted the channel outright.
    const locked = lockoutFreqIn(cfg(), 463562500);
    const out = unlockFreqIn(locked, 463562500);
    expect(out.scan.lockoutHz).not.toContain(463562500);
    const ch = out.channels.find((c) => c.freq === 463562500);
    expect(ch).toBeDefined();
    expect(ch!.enabled).toBe(true);
  });

  it("a lockout -> unlock round trip is lossless", () => {
    const before = cfg();
    const after = unlockFreqIn(lockoutFreqIn(before, 463562500), 463562500);
    expect(after.channels).toEqual(before.channels);
  });

  it("locking out an unknown frequency still suppresses it (Close-Call-only lockout)", () => {
    const out = lockoutFreqIn(cfg(), 999000000);
    expect(out.scan.lockoutHz).toContain(999000000);
    expect(out.channels).toEqual(cfg().channels);
  });
});
