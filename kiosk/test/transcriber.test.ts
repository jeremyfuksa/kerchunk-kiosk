import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcriber } from "../src/backend/transcriber.js";

// Stub worker: echoes a fixed transcript for every path it receives.
const STUB = ["/bin/sh", "-c", `while read p; do printf '{"path":"%s","text":"hello world"}\\n' "$p"; done`];

function pcmSeconds(s: number): Buffer { return Buffer.alloc(48_000 * 2 * s, 7); }

describe("Transcriber", () => {
  it("segments on audible transitions and files worker text", async () => {
    const onText = vi.fn();
    const t = new Transcriber({ workerCmd: STUB, tmpDir: mkdtempSync(join(tmpdir(), "tr-")), onText });
    t.start();
    t.audible("ch1", 1000);
    t.audio(pcmSeconds(2));
    t.audible(null, 3000);          // close -> flush to worker
    await vi.waitFor(() => expect(onText).toHaveBeenCalled(), { timeout: 4000 });
    expect(onText.mock.calls[0]![0]).toMatchObject({ channelId: "ch1", startedTs: 1000, text: "hello world" });
    t.stop();
  });
  it("drops kerchunk-length segments", async () => {
    const onText = vi.fn();
    const t = new Transcriber({ workerCmd: STUB, tmpDir: mkdtempSync(join(tmpdir(), "tr-")), onText });
    t.start();
    t.audible("ch1", 1000);
    t.audio(Buffer.alloc(9600));    // 100 ms
    t.audible(null, 1100);
    await new Promise((r) => setTimeout(r, 600));
    expect(onText).not.toHaveBeenCalled();
    t.stop();
  });
});
