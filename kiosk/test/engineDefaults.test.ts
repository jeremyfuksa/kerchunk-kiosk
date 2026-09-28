import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { HELPER_DEFAULTS, MAX_LANES_PER_GROUP } from "../src/backend/config/engineDefaults.js";

// The admin shows these as placeholders ("blank = default"), so they must be
// the helper's real defaults. The helper's truth is native/src/constants.hpp.
const hpp = readFileSync(fileURLToPath(new URL("../native/src/constants.hpp", import.meta.url)), "utf8");
function cpp(name: string): number {
  const m = new RegExp(`constexpr\\s+(?:double|float|int)\\s+${name}\\s*=\\s*(-?[\\d.]+)`).exec(hpp);
  if (!m) throw new Error(`${name} not found in constants.hpp`);
  return Number(m[1]);
}

describe("engine defaults mirror native/src/constants.hpp", () => {
  it.each([
    ["agcTargetDb", "AGC_TARGET_DB"],
    ["agcMaxGainDb", "AGC_MAX_GAIN_DB"],
    ["agcMinGainDb", "AGC_MIN_GAIN_DB"],
    ["agcAttackMs", "AGC_ATTACK_MS"],
    ["agcReleaseMs", "AGC_RELEASE_MS"],
    ["agcHoldBelowDb", "AGC_HOLD_BELOW_DB"],
    ["limiterCeiling", "LIMITER_CEILING"],
    ["limiterReleaseMs", "LIMITER_RELEASE_MS"],
    ["fmAudioLpfHz", "SPEAKER_LPF_HZ"],
    ["fmAudioHpfHz", "SPEAKER_HPF_HZ"],
  ] as const)("%s == %s", (ts, c) => {
    expect(HELPER_DEFAULTS[ts]).toBe(cpp(c));
  });

  it("MAX_LANES_PER_GROUP == MAX_LANES", () => {
    expect(MAX_LANES_PER_GROUP).toBe(cpp("MAX_LANES"));
  });

  it("nativeAmGainDb defaults to 0 dB (Node sends no --am-gain-db)", () => {
    expect(HELPER_DEFAULTS.nativeAmGainDb).toBe(0);
  });
});
