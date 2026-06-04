import { describe, it, expect, vi } from "vitest";
import { setVolume, setMuted, listSinks } from "../src/backend/audio.js";

describe("audio", () => {
  it("setVolume drives the mixer in dB — a true log fader", async () => {
    // Percent-based control (raw OR -M mapped) bunches all audible change
    // into a sliver of the slider on this codec (operator: "5 pixels around
    // the 5% mark between silence and full volume"). Loudness is linear in
    // dB, so the slider maps UI 1-100 linearly onto VOLUME_MIN_DB..0 dB:
    // every notch is the same perceived step, across the WHOLE slider.
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setVolume(70, { run, control: "Master", card: 0 });
    // UI 70 -> -45 + 0.70*45 = -13.5 dB
    expect(run).toHaveBeenCalledWith("amixer", ["-c", "0", "--", "sset", "Master", "-13.50dB"]);
  });

  it("setVolume endpoints: 0 = silence, 100 = 0 dB, 1 = bottom of range", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setVolume(0, { run, control: "Master", card: 0 });
    await setVolume(1, { run, control: "Master", card: 0 });
    await setVolume(100, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenNthCalledWith(1, "amixer", ["-c", "0", "--", "sset", "Master", "0%"]);
    expect(run).toHaveBeenNthCalledWith(2, "amixer", ["-c", "0", "--", "sset", "Master", "-44.55dB"]);
    expect(run).toHaveBeenNthCalledWith(3, "amixer", ["-c", "0", "--", "sset", "Master", "0.00dB"]);
  });

  it("setMuted true calls amixer mute", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setMuted(true, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenCalledWith("amixer", ["-c", "0", "sset", "Master", "mute"]);
  });

  it("setMuted false calls amixer unmute", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setMuted(false, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenCalledWith("amixer", ["-c", "0", "sset", "Master", "unmute"]);
  });

  it("setVolume does not throw when amixer reports no simple control", async () => {
    // HDMI cards on real Pi may expose NO amixer control. A non-zero exit must
    // degrade to a safe no-op, never reject (which could crash the boot chain).
    const run = vi.fn().mockResolvedValue({
      stdout: "", stderr: "amixer: Unable to find simple control", code: 1,
    });
    await expect(setVolume(70, { run })).resolves.toBeUndefined();
  });

  it("setMuted does not throw when amixer reports no simple control", async () => {
    const run = vi.fn().mockResolvedValue({
      stdout: "", stderr: "amixer: Unable to find simple control", code: 1,
    });
    await expect(setMuted(true, { run })).resolves.toBeUndefined();
  });

  it("listSinks parses aplay -L output into device ids", async () => {
    const aplayOut = [
      "null",
      "    Discard all samples",
      "hdmi:CARD=vc4hdmi0,DEV=0",
      "    Built-in Audio",
      "default:CARD=vc4hdmi0",
      "    Default Audio Device",
    ].join("\n");
    const run = vi.fn().mockResolvedValue({ stdout: aplayOut, stderr: "", code: 0 });
    const sinks = await listSinks({ run });
    expect(sinks).toContain("hdmi:CARD=vc4hdmi0,DEV=0");
    expect(sinks).toContain("default:CARD=vc4hdmi0");
    expect(sinks).not.toContain("    Discard all samples");
  });
});
