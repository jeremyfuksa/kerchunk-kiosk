import { spawn } from "node:child_process";

export interface RunResult { stdout: string; stderr: string; code: number; }
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const defaultRun: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const p = spawn(cmd, args);
    let stdout = "", stderr = "";
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    p.on("error", () => resolve({ stdout, stderr, code: 1 }));
  });

// `card` may be a numeric index or an ALSA card NAME ("PCH") — amixer accepts
// both, and names are stable across boots while indices can swap probe order.
export interface AmixerOpts { run?: Runner; control?: string; card?: number | string; }

// Best-effort ALSA card index from a sink string like "hdmi:CARD=vc4hdmi1" or
// "plughw:CARD=Headphones,DEV=0".
//
// KNOWN LIMITATION: ALSA sinks identify the card by NAME (CARD=<name>), not by
// the numeric index amixer wants, and mapping name -> index requires parsing
// `aplay -l`. We deliberately do NOT do that here: we only recognize an
// explicit numeric form ("hw:1", "plughw:CARD=...,DEV=0" with a leading index,
// etc.) and otherwise return null so the caller falls back to the default card.
// Correct control discovery / name->index mapping is left as future work; this
// fix's goal is that a missing/wrong control degrades to a safe no-op rather
// than crashing the boot chain (see setVolume/setMuted).
export function cardFromSink(sink: string): number | null {
  if (!sink) return null;
  // Match a numeric card index after "hw:" / "plughw:" (e.g. "hw:1", "plughw:2,0").
  const m = /^(?:plug)?hw:(\d+)/.exec(sink.trim());
  if (m) return Number(m[1]);
  // Name-based sinks (CARD=<name>) cannot be mapped without `aplay -l`.
  return null;
}

// The slider is a LOG FADER: UI 1-100 maps linearly onto VOLUME_MIN_DB..0 dB
// (UI 0 = raw 0 = silence). Loudness perception is linear in dB, so this puts
// the same perceived step on every slider notch, across the whole travel.
// Percent-based control could not do this here: raw % is linear in register
// steps and even amixer -M's mapped curve bunched all audible change into a
// sliver on the CS4208 (operator: "5 pixels around the 5% mark between
// silence and full volume"). The codec spans -63.5..0 dB; below ~-45 dB is
// effectively inaudible in a car/room, so that's the fader's bottom.
const VOLUME_MIN_DB = -45;

function uiToDb(ui: number): string {
  const clamped = Math.max(0, Math.min(100, Math.round(ui)));
  const db = VOLUME_MIN_DB + (clamped * -VOLUME_MIN_DB) / 100;
  return `${db.toFixed(2)}dB`;
}

export async function setVolume(percent: number, opts: AmixerOpts = {}): Promise<void> {
  const run = opts.run ?? defaultRun;
  const card = opts.card ?? 0;
  const control = opts.control ?? "Master";
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  // Never reject: a non-zero exit (e.g. HDMI cards exposing no mixer control)
  // or a spawn error must degrade to a safe no-op, not crash the boot chain.
  //
  // UI 0 is true silence (raw 0%); everything else is the dB fader (uiToDb).
  // "--" stops amixer parsing the negative dB value as an option flag.
  const value = clamped === 0 ? "0%" : uiToDb(clamped);
  try {
    const result = await run("amixer", ["-c", String(card), "--", "sset", control, value]);
    if (result.code !== 0) return; // no mixer control available; swallow
  } catch {
    /* spawn/runner failure -> no-op */
  }
}

export async function setMuted(muted: boolean, opts: AmixerOpts = {}): Promise<void> {
  const run = opts.run ?? defaultRun;
  const card = opts.card ?? 0;
  const control = opts.control ?? "Master";
  try {
    const result = await run("amixer", ["-c", String(card), "sset", control, muted ? "mute" : "unmute"]);
    if (result.code !== 0) return; // no mixer control available; swallow
  } catch {
    /* spawn/runner failure -> no-op */
  }
}

export async function listSinks(opts: { run?: Runner } = {}): Promise<string[]> {
  const run = opts.run ?? defaultRun;
  const { stdout } = await run("aplay", ["-L"]);
  return stdout.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l));
}
