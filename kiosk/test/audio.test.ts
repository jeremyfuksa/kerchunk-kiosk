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
    // UI 70 lands at amixer 85%: the UI range is compressed into the mixer's
    // usable upper window (see VOLUME_FLOOR_PCT) so the slider isn't touchy.
    expect(run).toHaveBeenCalledWith("amixer", ["-M", "-c", "0", "sset", "Master", "85%"]);
  });

  it("setVolume compresses the UI range into the audible upper window", async () => {
    // Operator-reported: the slider was hyper-sensitive — on HDA codecs the
    // bottom ~half of the mapped scale is near-silence, so all audible change
    // crammed into a small slider segment. UI 0-100 now maps to 50-100%
    // (0 stays 0 = true silence), doubling slider resolution where it counts.
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setVolume(0, { run, control: "Master", card: 0 });
    await setVolume(1, { run, control: "Master", card: 0 });
    await setVolume(100, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenNthCalledWith(1, "amixer", ["-M", "-c", "0", "sset", "Master", "0%"]);
    expect(run).toHaveBeenNthCalledWith(2, "amixer", ["-M", "-c", "0", "sset", "Master", "51%"]);
    expect(run).toHaveBeenNthCalledWith(3, "amixer", ["-M", "-c", "0", "sset", "Master", "100%"]);
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
