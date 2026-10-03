import { describe, it, expect, vi } from "vitest";
import { parseWind, fromDeg, setWind, onWind } from "../src/frontend/lib/wind.js";

describe("parseWind (NWS gives where wind comes FROM; smoke goes the other way)", () => {
  it("inverts all 16 compass points", () => {
    const pts = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
    pts.forEach((p, i) => {
      const from = [0, 22, 45, 67, 90, 112, 135, 157, 180, 202, 225, 247, 270, 292, 315, 337][i]!;
      expect(parseWind(`${p} 7 mph`)).toEqual({ towardDeg: (from + 180) % 360, mph: 7 });
    });
  });
  it("a range uses the upper bound", () => {
    expect(parseWind("SW 5 to 10 mph")).toEqual({ towardDeg: 45, mph: 10 });
  });
  it("calm, variable, zero, missing number and empty give null; never throws", () => {
    for (const s of ["Calm", "", "VRB 3 mph", "Variable 3 mph", "NE 0 mph", "NE", "7 mph"]) {
      expect(parseWind(s)).toBeNull();
    }
  });
  it("fromDeg reads the from-bearing (the dashboard arrow uses it)", () => {
    expect(fromDeg("NE 7 mph")).toBe(45);
    expect(fromDeg("Calm")).toBeUndefined();
  });
});

describe("wind store", () => {
  it("replays the current wind to a new subscriber and notifies on change", () => {
    setWind("NE 7 mph");
    const cb = vi.fn();
    const off = onWind(cb);
    expect(cb).toHaveBeenLastCalledWith({ towardDeg: 225, mph: 7 });
    setWind("Calm");
    expect(cb).toHaveBeenLastCalledWith(null);
    off();
    setWind("S 4 mph");
    expect(cb).toHaveBeenCalledTimes(2);
    setWind(undefined);
  });
});
