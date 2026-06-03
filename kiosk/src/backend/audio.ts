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

export interface AmixerOpts { run?: Runner; control?: string; card?: number; }

export async function setVolume(percent: number, opts: AmixerOpts = {}): Promise<void> {
  const run = opts.run ?? defaultRun;
  const card = opts.card ?? 0;
  const control = opts.control ?? "Master";
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  await run("amixer", ["-c", String(card), "sset", control, `${clamped}%`]);
}

export async function setMuted(muted: boolean, opts: AmixerOpts = {}): Promise<void> {
  const run = opts.run ?? defaultRun;
  const card = opts.card ?? 0;
  const control = opts.control ?? "Master";
  await run("amixer", ["-c", String(card), "sset", control, muted ? "mute" : "unmute"]);
}

export async function listSinks(opts: { run?: Runner } = {}): Promise<string[]> {
  const run = opts.run ?? defaultRun;
  const { stdout } = await run("aplay", ["-L"]);
  return stdout.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l));
}
