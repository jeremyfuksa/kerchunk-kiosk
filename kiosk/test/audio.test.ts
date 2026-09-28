import { describe, it, expect, vi } from "vitest";
import { setVolume, setMuted, listSinks, resolveControl, watchOutput } from "../src/backend/audio.js";

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
    // Only the Master level calls: driving Master also opens the speakers
    // (routing, covered by the jack tests below).
    const master = run.mock.calls.map(([, a]) => a as string[]).filter((a) => a.includes("Master"));
    expect(master).toEqual([
      ["-c", "0", "--", "sset", "Master", "0%"],
      ["-c", "0", "--", "sset", "Master", "-44.55dB"],
      ["-c", "0", "--", "sset", "Master", "0.00dB"],
    ]);
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

  it("auto control: Headphone when the jack is plugged, Master when not or when there's no jack sense", async () => {
    // Like real amixer on the CS4208: jack-sense controls live on the CARD
    // interface, so a cget that omits iface=CARD finds nothing (exit 1) —
    // the bug that pinned "auto" to Master on the appliance (2026-09-27).
    const jack = (on: boolean | null) => vi.fn(async (_c: string, args: string[]) =>
      args.includes("cget")
        ? (on === null || !args.some((a) => a.startsWith("iface=CARD,"))
            ? { stdout: "", stderr: "amixer: Cannot find the given element from control sysdefault:0", code: 1 }
            : { stdout: `  : values=${on ? "on" : "off"}\n`, stderr: "", code: 0 })
        : { stdout: "", stderr: "", code: 0 });
    expect(await resolveControl(undefined, "PCH", jack(true))).toBe("Headphone");
    expect(await resolveControl("auto", "PCH", jack(false))).toBe("Master");
    expect(await resolveControl(undefined, "PCH", jack(null))).toBe("Master");
    expect(await resolveControl("PCM", "PCH", jack(true))).toBe("PCM");   // explicit wins, no probe
    const run = jack(true);
    await setMuted(true, { run, card: "PCH" });
    expect(run).toHaveBeenLastCalledWith("amixer", ["-c", "PCH", "sset", "Headphone", "mute"]);
  });

  it("driving Headphone pins Master (the codec's vmaster) at 0 dB unmuted so the two never stack", async () => {
    // CS4208: the HP DAC gain is Headphone + Master. Master left at -27 dB from
    // the auto->Master era plus Headphone at -26 dB = -53 dB = silence (2026-09-27).
    const run = vi.fn(async (_c: string, args: string[]) =>
      args.includes("cget") ? { stdout: "  : values=on\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 });
    const ssets = () => run.mock.calls.map(([, a]) => a).filter((a) => a.includes("sset"));
    await setVolume(40, { run, card: "PCH" });                         // auto, jack plugged
    expect(ssets()).toContainEqual(["-c", "PCH", "--", "sset", "Master", "0dB", "unmute"]);
    expect(ssets()).toContainEqual(["-c", "PCH", "--", "sset", "Headphone", "-27.00dB"]);
    run.mockClear();
    await setMuted(true, { run, card: "PCH", control: "Headphone" });  // watchOutput passes the resolved name
    expect(ssets()).toContainEqual(["-c", "PCH", "--", "sset", "Master", "0dB", "unmute"]);
    expect(ssets()).toContainEqual(["-c", "PCH", "sset", "Headphone", "mute"]);
    // Auto-Mute is disabled on this codec: the internal speakers must be muted
    // explicitly while the jack carries the audio, or they play alongside it.
    expect(ssets()).toContainEqual(["-c", "PCH", "sset", "Speaker", "mute"]);
    expect(ssets()).toContainEqual(["-c", "PCH", "sset", "Bass Speaker", "mute"]);
  });

  it("driving Master (jack unplugged) opens the internal speakers at 0 dB so Master alone carries the volume", async () => {
    // Speaker/Bass Speaker sat at 0/off, so an unplugged jack meant silence.
    const run = vi.fn(async (_c: string, args: string[]) =>
      args.includes("cget") ? { stdout: "  : values=off\n", stderr: "", code: 0 } : { stdout: "", stderr: "", code: 0 });
    const ssets = () => run.mock.calls.map(([, a]) => a).filter((a) => a.includes("sset"));
    await setVolume(40, { run, card: "PCH" });                         // auto, jack unplugged
    expect(ssets()).toEqual([
      ["-c", "PCH", "--", "sset", "Speaker", "0dB", "unmute"],
      ["-c", "PCH", "--", "sset", "Bass Speaker", "0dB", "unmute"],
      ["-c", "PCH", "--", "sset", "Master", "-27.00dB"],
    ]);
    run.mockClear();
    await setMuted(true, { run, card: "PCH", control: "Master" });    // watchOutput passes the resolved name
    expect(ssets()).toContainEqual(["-c", "PCH", "sset", "Master", "mute"]);
    run.mockClear();
    await setVolume(40, { run, card: "PCH", control: "PCM" });        // any other explicit control: untouched routing
    expect(ssets()).toEqual([["-c", "PCH", "--", "sset", "PCM", "-27.00dB"]]);
  });

  it("watchOutput reports a jack change once, and never for an explicit control", async () => {
    vi.useFakeTimers();
    let on = true;
    const run = vi.fn(async () => ({ stdout: `  : values=${on ? "on" : "off"}\n`, stderr: "", code: 0 }));
    const seen: string[] = [];
    const stop = watchOutput({ run, card: "PCH" }, (c) => seen.push(c), 100);
    await vi.advanceTimersByTimeAsync(250);
    on = false;
    await vi.advanceTimersByTimeAsync(250);
    stop();
    expect(seen).toEqual(["Master"]);
    const never = watchOutput({ run, card: "PCH", control: "Master" }, () => seen.push("x"), 100);
    await vi.advanceTimersByTimeAsync(500);
    never();
    expect(seen).toEqual(["Master"]);
    vi.useRealTimers();
  });
});
