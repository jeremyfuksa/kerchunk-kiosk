import { describe, it, expect, vi } from "vitest";
import { setVolume, setMuted, listSinks } from "../src/backend/audio.js";

describe("audio", () => {
  it("setVolume calls amixer with mapped volume (-M) and a percent", async () => {
    // -M (mapped-volume) is REQUIRED: amixer's default raw mode maps the percent
    // linearly over the control's raw dB-scaled range. On the bcm2835 headphone
    // jack the PCM control spans -102.39..+4.00 dB, so raw "70%" lands at ~-28 dB
    // (near silent) — i.e. moving the slider mutes the audio. Mapped mode makes
    // the percent perceptually correct.
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setVolume(70, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenCalledWith("amixer", ["-M", "-c", "0", "sset", "Master", "70%"]);
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
