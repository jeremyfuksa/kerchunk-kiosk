# Kerchunk Kiosk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Pi 4 + HD-display scanner kiosk: a Node/TypeScript backend that supervises `rtl_fm` (serial squelch-scan over a channel list), pipes audio to HDMI, serves an output-only fullscreen dashboard plus a web admin, and persists config across reboots.

**Architecture:** Single Node process (monolith). The radio is isolated behind a `ScannerEngine` interface; v1 ships an `RtlFmEngine`. Audio flows `rtl_fm | aplay` kernel-side (never through Node); Node parses `rtl_fm` stderr into `active`/`idle`/`signal` events broadcast over WebSocket to both the dashboard and admin. Config is a single validated JSON file written atomically. Two systemd units: the backend, and a `cage`+Chromium kiosk that loads the dashboard.

**Tech Stack:** Node 20+ / TypeScript, Vite (frontend SPA), `ws` (WebSocket), `zod` (config schema + types), `vitest` (tests), `supertest` (HTTP integration). Pi-side runtime: `rtl-sdr`, `alsa-utils`, `cage`, `chromium`. Dev happens on macOS; everything hardware-touching is tested against fakes, with real-hardware verification as a documented Pi bench step.

**Reference spec:** [docs/superpowers/specs/2026-06-02-kerchunk-kiosk-design.md](../specs/2026-06-02-kerchunk-kiosk-design.md)

---

## Critical context for the implementer

You may know nothing about RTL-SDR or this repo. Here is everything load-bearing:

- **`rtl_fm`** is a command-line FM/AM demodulator that reads I/Q from an RTL-SDR
  USB dongle and writes raw signed-16-bit-LE mono PCM to stdout. It is Linux-only;
  it does **not** exist on macOS. You will never run the real thing in dev.
- **Serial scanning:** passing multiple `-f` flags makes `rtl_fm` squelch-scan
  across those frequencies (confirmed in the man page: "use multiple -f for
  scanning, requires squelch"). It requires a squelch level (`-l`). It dwells on a
  channel while squelch is open and resumes scanning when it closes.
- **`-t squelch_delay`** with a **positive** value makes it mute/scan (vs. exit).
  We always want positive.
- **`aplay -D <device>`** (from `alsa-utils`) plays raw PCM from stdin to an ALSA
  device. `aplay -L` lists devices. The HDMI device on a Pi 4 looks like
  `hdmi:CARD=vc4hdmi0`.
- **`amixer`** controls ALSA volume/mute (e.g. `amixer -c 0 sset <control> 70%`).
- **The exact stderr format of `rtl_fm` is NOT documented and is version-dependent.**
  We do NOT guess it. Task 6 captures real stderr on the Pi into a fixture file,
  and Task 7 writes the parser against that captured fixture. Until Task 6 runs on
  hardware, Task 7 uses a synthetic fixture that documents our *assumed* format,
  clearly marked, and the parser is written to be trivially re-pointed at real
  captures.
- **The existing repo** ([bench/03-stream-fm.sh](../../../bench/03-stream-fm.sh)) shows the real `rtl_fm` invocation idiom:
  `rtl_fm -f <hz> -M fm -s 200000 -r 48000 -g 30 - | <sink>`. Mirror this.
- All paths in this plan are relative to the repo root `/Users/jeremyfuksa/Dev/kerchunk-kiosk`.

---

## File structure

Everything new lives under `kiosk/`. Nothing in the existing `docs/`, `scripts/`,
`bench/` is modified except adding `kiosk/scripts/setup-kiosk.sh`.

```
kiosk/
├── package.json                      # deps + scripts (build/test/dev)
├── tsconfig.json                     # backend TS config
├── vite.config.ts                    # frontend bundling
├── vitest.config.ts                  # test config
├── src/
│   ├── backend/
│   │   ├── index.ts                  # entrypoint: wire everything, listen
│   │   ├── server.ts                 # HTTP routes + static SPA serving
│   │   ├── ws.ts                     # WebSocket broadcast hub
│   │   ├── engine/
│   │   │   ├── ScannerEngine.ts      # interface + event/config types
│   │   │   ├── stderrParser.ts       # rtl_fm stderr line → event (pure fn)
│   │   │   ├── RtlFmEngine.ts        # v1 implementation
│   │   │   └── FakeEngine.ts         # test double implementing ScannerEngine
│   │   ├── audio.ts                  # amixer volume/mute + aplay sink listing
│   │   ├── config/
│   │   │   ├── schema.ts             # zod schema = source of truth for types
│   │   │   └── ConfigStore.ts        # load/validate/atomic-write/backup
│   │   └── activityLog.ts            # in-memory ring buffer
│   └── frontend/
│       ├── index.html                # SPA host page
│       ├── main.ts                   # bootstrap + route (dashboard vs admin)
│       ├── lib/wsClient.ts           # reconnecting WebSocket consumer
│       ├── lib/api.ts                # typed fetch wrappers for /api/*
│       ├── dashboard/dashboard.ts    # Now Playing + Activity Log render
│       ├── dashboard/dashboard.css
│       ├── admin/admin.ts            # config forms
│       └── admin/admin.css
├── test/
│   ├── stderrParser.test.ts
│   ├── ConfigStore.test.ts
│   ├── schema.test.ts
│   ├── activityLog.test.ts
│   ├── RtlFmEngine.test.ts
│   ├── audio.test.ts
│   ├── api.test.ts
│   ├── fixtures/
│   │   ├── rtl_fm-stderr.synthetic.txt   # assumed format (Task 7)
│   │   └── rtl_fm-stderr.captured.txt    # real capture (Task 6, on Pi)
│   └── fakes/
│       └── fake-rtl_fm.sh             # emits canned stderr + silence stdout
├── systemd/
│   ├── kerchunk-kiosk.service
│   └── kerchunk-display.service
└── scripts/
    └── setup-kiosk.sh
```

---

## Task 0: Project scaffold

**Files:**
- Create: `kiosk/package.json`
- Create: `kiosk/tsconfig.json`
- Create: `kiosk/vitest.config.ts`
- Create: `kiosk/.gitignore` additions are already covered by root `.gitignore` (`node_modules/`, `dist/`)

- [ ] **Step 1: Create `kiosk/package.json`**

```json
{
  "name": "kerchunk-kiosk",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "dev:backend": "tsx watch src/backend/index.ts",
    "dev:frontend": "vite",
    "build": "npm run build:frontend && npm run build:backend",
    "build:frontend": "vite build",
    "build:backend": "tsc -p tsconfig.json",
    "start": "node dist/backend/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "ws": "^8.18.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/ws": "^8.5.10",
    "supertest": "^7.0.0",
    "@types/supertest": "^6.0.2",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create `kiosk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "noUncheckedIndexedAccess": true
  },
  "include": ["src/backend/**/*", "src/frontend/lib/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `kiosk/vitest.config.ts`**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `cd kiosk && npm install`
Expected: `node_modules/` created, no errors. A `package-lock.json` appears.

- [ ] **Step 5: Verify the toolchain runs**

Run: `cd kiosk && npx vitest run`
Expected: vitest runs and reports "No test files found" (exit 0 or a clear "no tests" message). This confirms the test runner is wired before any tests exist.

- [ ] **Step 6: Commit**

```bash
git add kiosk/package.json kiosk/tsconfig.json kiosk/vitest.config.ts kiosk/package-lock.json
git commit -m "chore(kiosk): scaffold Node/TS project"
```

---

## Task 1: Config schema (zod = source of truth for types)

**Files:**
- Create: `kiosk/src/backend/config/schema.ts`
- Test: `kiosk/test/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/schema.test.ts
import { describe, it, expect } from "vitest";
import { configSchema, defaultConfig } from "../src/backend/config/schema.js";

describe("configSchema", () => {
  it("accepts a valid config", () => {
    const cfg = {
      version: 1,
      scan: { sampleRate: 12000, squelchLevel: 150, gain: "auto", dwellMs: 2000 },
      audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false },
      channels: [
        { id: "ch_001", freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true },
      ],
    };
    expect(configSchema.parse(cfg)).toEqual(cfg);
  });

  it("rejects a negative frequency", () => {
    const bad = { ...defaultConfig(), channels: [
      { id: "x", freq: -1, alphaTag: "", mode: "fm", enabled: true },
    ] };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects an unknown mode", () => {
    const bad = { ...defaultConfig(), channels: [
      { id: "x", freq: 1, alphaTag: "", mode: "p25", enabled: true },
    ] };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("clamps volume range via schema (0-100)", () => {
    const bad = { ...defaultConfig(), audio: { ...defaultConfig().audio, volume: 250 } };
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("defaultConfig() is itself valid", () => {
    expect(() => configSchema.parse(defaultConfig())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/schema.test.ts`
Expected: FAIL — cannot import `configSchema`/`defaultConfig` (module not found).

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/config/schema.ts
import { z } from "zod";

export const channelSchema = z.object({
  id: z.string().min(1),
  freq: z.number().int().positive(),
  alphaTag: z.string(),
  mode: z.enum(["fm", "nfm", "am"]),
  enabled: z.boolean(),
});

export const configSchema = z.object({
  version: z.literal(1),
  scan: z.object({
    sampleRate: z.number().int().positive(),
    squelchLevel: z.number().int().nonnegative(),
    gain: z.union([z.number(), z.literal("auto")]),
    dwellMs: z.number().int().positive(),
  }),
  audio: z.object({
    sink: z.string().min(1),
    volume: z.number().int().min(0).max(100),
    muted: z.boolean(),
  }),
  channels: z.array(channelSchema),
});

export type Channel = z.infer<typeof channelSchema>;
export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return {
    version: 1,
    scan: { sampleRate: 12000, squelchLevel: 150, gain: "auto", dwellMs: 2000 },
    audio: { sink: "hdmi:CARD=vc4hdmi0", volume: 70, muted: false },
    channels: [],
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/config/schema.ts kiosk/test/schema.test.ts
git commit -m "feat(kiosk): config schema and defaults (zod)"
```

---

## Task 2: ConfigStore (load / validate / atomic-write / backup)

**Files:**
- Create: `kiosk/src/backend/config/ConfigStore.ts`
- Test: `kiosk/test/ConfigStore.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/ConfigStore.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { defaultConfig } from "../src/backend/config/schema.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kcfg-"));
  path = join(dir, "config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("ConfigStore", () => {
  it("writes a default config when the file is missing", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    expect(cfg).toEqual(defaultConfig());
    expect(existsSync(path)).toBe(true);
  });

  it("round-trips a saved config", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    cfg.audio.volume = 42;
    store.save(cfg);
    const reloaded = new ConfigStore(path).load();
    expect(reloaded.audio.volume).toBe(42);
  });

  it("writes a .bak before overwriting", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 10 } });
    store.save({ ...cfg, audio: { ...cfg.audio, volume: 20 } });
    expect(existsSync(path + ".bak")).toBe(true);
    const bak = JSON.parse(readFileSync(path + ".bak", "utf8"));
    expect(bak.audio.volume).toBe(10);
  });

  it("falls back to .bak when the main file is corrupt", () => {
    const store = new ConfigStore(path);
    const good = store.load();
    store.save({ ...good, audio: { ...good.audio, volume: 33 } });
    // corrupt main, leave .bak intact (the .bak holds the prior default save)
    writeFileSync(path, "{ not json");
    const result = new ConfigStore(path).load();
    expect(result.audio.volume).toBe(good.audio.volume); // came from .bak
  });

  it("falls back to defaults when both files are corrupt", () => {
    writeFileSync(path, "garbage");
    writeFileSync(path + ".bak", "also garbage");
    const store = new ConfigStore(path);
    expect(store.load()).toEqual(defaultConfig());
    expect(store.lastLoadWasReset).toBe(true);
  });

  it("rejects a schema-invalid config on save", () => {
    const store = new ConfigStore(path);
    const cfg = store.load();
    // @ts-expect-error deliberately invalid
    expect(() => store.save({ ...cfg, audio: { ...cfg.audio, volume: 999 } })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/ConfigStore.test.ts`
Expected: FAIL — `ConfigStore` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/config/ConfigStore.ts
import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, openSync, fsyncSync, closeSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { configSchema, defaultConfig, type Config } from "./schema.js";

export class ConfigStore {
  lastLoadWasReset = false;

  constructor(private readonly path: string) {}

  load(): Config {
    this.lastLoadWasReset = false;
    const fromMain = this.tryRead(this.path);
    if (fromMain) return fromMain;
    const fromBak = this.tryRead(this.path + ".bak");
    if (fromBak) return fromBak;
    const def = defaultConfig();
    this.lastLoadWasReset = existsSync(this.path) || existsSync(this.path + ".bak");
    this.writeAtomic(def); // persist defaults so the file exists going forward
    return def;
  }

  save(cfg: Config): void {
    const valid = configSchema.parse(cfg); // throws on invalid
    if (existsSync(this.path)) copyFileSync(this.path, this.path + ".bak");
    this.writeAtomic(valid);
  }

  private tryRead(p: string): Config | null {
    if (!existsSync(p)) return null;
    try {
      const parsed = JSON.parse(readFileSync(p, "utf8"));
      return configSchema.parse(parsed);
    } catch {
      return null;
    }
  }

  private writeAtomic(cfg: Config): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    const json = JSON.stringify(cfg, null, 2);
    writeFileSync(tmp, json, "utf8");
    const fd = openSync(tmp, "r+");
    fsyncSync(fd);
    closeSync(fd);
    renameSync(tmp, this.path);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/ConfigStore.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/config/ConfigStore.ts kiosk/test/ConfigStore.test.ts
git commit -m "feat(kiosk): ConfigStore with atomic write, backup, corrupt-fallback"
```

---

## Task 3: Activity log ring buffer

**Files:**
- Create: `kiosk/src/backend/activityLog.ts`
- Test: `kiosk/test/activityLog.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/activityLog.test.ts
import { describe, it, expect } from "vitest";
import { ActivityLog } from "../src/backend/activityLog.js";

describe("ActivityLog", () => {
  it("stores entries newest-first", () => {
    const log = new ActivityLog(3);
    log.add({ freq: 1, alphaTag: "a", ts: 100 });
    log.add({ freq: 2, alphaTag: "b", ts: 200 });
    expect(log.entries().map((e) => e.freq)).toEqual([2, 1]);
  });

  it("caps at capacity, dropping oldest", () => {
    const log = new ActivityLog(2);
    log.add({ freq: 1, alphaTag: "a", ts: 1 });
    log.add({ freq: 2, alphaTag: "b", ts: 2 });
    log.add({ freq: 3, alphaTag: "c", ts: 3 });
    expect(log.entries().map((e) => e.freq)).toEqual([3, 2]);
  });

  it("returns a copy (caller cannot mutate internals)", () => {
    const log = new ActivityLog(2);
    log.add({ freq: 1, alphaTag: "a", ts: 1 });
    log.entries().push({ freq: 9, alphaTag: "x", ts: 9 });
    expect(log.entries().length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/activityLog.test.ts`
Expected: FAIL — `ActivityLog` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/activityLog.ts
export interface LogEntry {
  freq: number;
  alphaTag: string;
  ts: number;
}

export class ActivityLog {
  private buf: LogEntry[] = [];
  constructor(private readonly capacity: number) {}

  add(entry: LogEntry): void {
    this.buf.unshift(entry);
    if (this.buf.length > this.capacity) this.buf.length = this.capacity;
  }

  entries(): LogEntry[] {
    return this.buf.slice();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/activityLog.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/activityLog.ts kiosk/test/activityLog.test.ts
git commit -m "feat(kiosk): in-memory activity log ring buffer"
```

---

## Task 4: ScannerEngine interface + event/config types

**Files:**
- Create: `kiosk/src/backend/engine/ScannerEngine.ts`
- Test: none yet (interface only; exercised by Tasks 5, 8). A compile check stands in.

- [ ] **Step 1: Write the interface and types**

```typescript
// kiosk/src/backend/engine/ScannerEngine.ts
import type { Channel } from "../config/schema.js";

export interface ScanConfig {
  channels: Channel[];
  sampleRate: number;
  squelchLevel: number;
  gain: number | "auto";
  audioSink: string;
}

export type EngineState = "stopped" | "starting" | "running" | "error";

export type EngineEvent =
  | { type: "active"; channel: Channel; freq: number; ts: number }
  | { type: "idle"; ts: number }
  | { type: "signal"; dbfs: number; ts: number }
  | { type: "status"; state: EngineState; ts: number }
  | { type: "error"; code: string; message: string; ts: number };

export type EngineListener = (event: EngineEvent) => void;

export interface ScannerEngine {
  start(config: ScanConfig): Promise<void>;
  stop(): Promise<void>;
  setVolume(percent: number): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  readonly state: EngineState;
  on(listener: EngineListener): void;
  off(listener: EngineListener): void;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd kiosk && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add kiosk/src/backend/engine/ScannerEngine.ts
git commit -m "feat(kiosk): ScannerEngine interface and event types"
```

---

## Task 5: FakeEngine (test double, also drives dev without hardware)

**Files:**
- Create: `kiosk/src/backend/engine/FakeEngine.ts`
- Test: `kiosk/test/RtlFmEngine.test.ts` will reuse the contract; here we add a small smoke test inline.
- Test: `kiosk/test/FakeEngine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/FakeEngine.test.ts
import { describe, it, expect, vi } from "vitest";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const cfg: ScanConfig = {
  channels: [{ id: "c1", freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true }],
  sampleRate: 12000, squelchLevel: 150, gain: "auto", audioSink: "test",
};

describe("FakeEngine", () => {
  it("emits a status=running event on start", async () => {
    const e = new FakeEngine();
    const events: EngineEvent[] = [];
    e.on((ev) => events.push(ev));
    await e.start(cfg);
    expect(e.state).toBe("running");
    expect(events.some((ev) => ev.type === "status" && ev.state === "running")).toBe(true);
  });

  it("can emit a scripted active event", async () => {
    const e = new FakeEngine();
    const fn = vi.fn();
    e.on(fn);
    await e.start(cfg);
    e.emitActive(cfg.channels[0]!);
    expect(fn).toHaveBeenCalledWith(expect.objectContaining({ type: "active" }));
  });

  it("emits status=stopped on stop", async () => {
    const e = new FakeEngine();
    await e.start(cfg);
    await e.stop();
    expect(e.state).toBe("stopped");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/FakeEngine.test.ts`
Expected: FAIL — `FakeEngine` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/engine/FakeEngine.ts
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener,
} from "./ScannerEngine.js";
import type { Channel } from "../config/schema.js";

// Deterministic timestamp source so tests never depend on the clock.
let seq = 0;
const nextTs = () => ++seq;

export class FakeEngine implements ScannerEngine {
  private listeners = new Set<EngineListener>();
  private _state: EngineState = "stopped";

  get state(): EngineState { return this._state; }

  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }

  private emit(ev: EngineEvent): void { for (const l of this.listeners) l(ev); }

  async start(_config: ScanConfig): Promise<void> {
    this._state = "running";
    this.emit({ type: "status", state: "running", ts: nextTs() });
  }

  async stop(): Promise<void> {
    this._state = "stopped";
    this.emit({ type: "status", state: "stopped", ts: nextTs() });
  }

  async setVolume(_percent: number): Promise<void> {}
  async setMuted(_muted: boolean): Promise<void> {}

  // Test/dev hooks — not part of the interface.
  emitActive(channel: Channel): void {
    this.emit({ type: "active", channel, freq: channel.freq, ts: nextTs() });
  }
  emitIdle(): void { this.emit({ type: "idle", ts: nextTs() }); }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/FakeEngine.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/engine/FakeEngine.ts kiosk/test/FakeEngine.test.ts
git commit -m "feat(kiosk): FakeEngine test double"
```

---

## Task 6: Capture real `rtl_fm` stderr on the Pi (HARDWARE — produces a fixture)

> This task runs on a Raspberry Pi with an RTL-SDR dongle, NOT on the dev Mac.
> Its only output is a checked-in fixture file. If you are building on the Mac and
> have no Pi yet, SKIP to Task 7 using the synthetic fixture, and return here when
> hardware is available. The plan is structured so Task 7's parser is re-pointed at
> this capture with a one-line fixture swap.

**Files:**
- Create: `kiosk/test/fixtures/rtl_fm-stderr.captured.txt`
- Create: `kiosk/bench/capture-stderr.sh`

- [ ] **Step 1: Write the capture script**

```bash
# kiosk/bench/capture-stderr.sh
#!/usr/bin/env bash
# Capture ~60s of real rtl_fm stderr while serial-scanning a few frequencies.
# Run ON THE PI with a dongle attached and at least one active local repeater.
# Usage: ./capture-stderr.sh 145130000 146940000 442150000
set -euo pipefail
FREQS=("$@")
[[ ${#FREQS[@]} -ge 1 ]] || { echo "give 1+ frequencies in Hz" >&2; exit 64; }
ARGS=(); for f in "${FREQS[@]}"; do ARGS+=(-f "$f"); done
echo "Capturing 60s of stderr to /tmp/rtl_fm-stderr.txt ... key up a repeater now." >&2
timeout 60 rtl_fm "${ARGS[@]}" -M fm -s 12000 -l 150 -t 5 - \
  >/dev/null 2>/tmp/rtl_fm-stderr.txt || true
echo "Done. Lines captured: $(wc -l < /tmp/rtl_fm-stderr.txt)" >&2
echo "Copy /tmp/rtl_fm-stderr.txt into kiosk/test/fixtures/rtl_fm-stderr.captured.txt" >&2
```

- [ ] **Step 2: Run it on the Pi**

Run (on Pi): `chmod +x kiosk/bench/capture-stderr.sh && kiosk/bench/capture-stderr.sh 145130000 146940000`
Expected: `/tmp/rtl_fm-stderr.txt` with non-zero lines. While it runs, key up a local repeater so squelch opens at least once.

- [ ] **Step 3: Inspect the format and save the fixture**

Run (on Pi): `cat /tmp/rtl_fm-stderr.txt` — read the actual lines. Note how a squelch-open / frequency-change appears (e.g. a line containing the tuned frequency, or a "Tuned to ..." line, or signal-level numbers). Copy the file:
`cp /tmp/rtl_fm-stderr.txt kiosk/test/fixtures/rtl_fm-stderr.captured.txt`

- [ ] **Step 4: Record the observed format**

Add a comment block at the TOP of `kiosk/test/fixtures/rtl_fm-stderr.captured.txt` (lines starting with `#`) describing what each relevant line means, e.g.:
```
# CAPTURED FROM rtl_fm <version> on Pi 4, <date>.
# Frequency-change/squelch-open lines look like: <paste an example>
# Signal-level lines look like: <paste an example>
```

- [ ] **Step 5: Commit**

```bash
git add kiosk/bench/capture-stderr.sh kiosk/test/fixtures/rtl_fm-stderr.captured.txt
git commit -m "test(kiosk): capture real rtl_fm stderr fixture from Pi"
```

> After this task, revisit Task 7's parser: adjust the regexes to match the REAL
> captured lines and point the test at `rtl_fm-stderr.captured.txt`. The parser's
> structure does not change — only the patterns.

---

## Task 7: stderr parser (pure function: line → event-or-null)

**Files:**
- Create: `kiosk/src/backend/engine/stderrParser.ts`
- Create: `kiosk/test/fixtures/rtl_fm-stderr.synthetic.txt`
- Test: `kiosk/test/stderrParser.test.ts`

> Until Task 6 runs on hardware, this parser targets the SYNTHETIC fixture below,
> which documents our ASSUMED format. The synthetic format models the two signals
> the dashboard needs: a frequency-lock line (→ active on that freq) and a
> squelch-open/close indicator. When the real capture exists, update the regexes
> and switch the fixture filename in the test; behavior contracts stay identical.

- [ ] **Step 1: Create the synthetic fixture**

```
# kiosk/test/fixtures/rtl_fm-stderr.synthetic.txt
# SYNTHETIC — assumed rtl_fm stderr until a real Pi capture replaces it (Task 6).
# Line meanings:
#   "Tuned to NNNNNNNN Hz." -> radio locked onto a frequency (treat as active)
#   "Signal level: -NN"     -> periodic signal level in dBFS
#   "Squelch closed"        -> back to scanning (idle)
Tuned to 145130000 Hz.
Signal level: -28
Signal level: -25
Squelch closed
Tuned to 146940000 Hz.
Signal level: -40
Squelch closed
```

- [ ] **Step 2: Write the failing test**

```typescript
// kiosk/test/stderrParser.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStderrLine } from "../src/backend/engine/stderrParser.js";

const FIXTURE = join(__dirname, "fixtures", "rtl_fm-stderr.synthetic.txt");

describe("parseStderrLine", () => {
  it("ignores comment and blank lines", () => {
    expect(parseStderrLine("# a comment", 1000)).toBeNull();
    expect(parseStderrLine("", 1000)).toBeNull();
  });

  it("parses a frequency lock into an active-freq event", () => {
    const ev = parseStderrLine("Tuned to 145130000 Hz.", 1000);
    expect(ev).toEqual({ kind: "freq", freq: 145130000, ts: 1000 });
  });

  it("parses a signal level into a signal event", () => {
    const ev = parseStderrLine("Signal level: -28", 1000);
    expect(ev).toEqual({ kind: "signal", dbfs: -28, ts: 1000 });
  });

  it("parses squelch closed into an idle event", () => {
    const ev = parseStderrLine("Squelch closed", 1000);
    expect(ev).toEqual({ kind: "idle", ts: 1000 });
  });

  it("returns null for unrecognised lines", () => {
    expect(parseStderrLine("some unknown diagnostic", 1000)).toBeNull();
  });

  it("processes the whole synthetic fixture into the expected event sequence", () => {
    const lines = readFileSync(FIXTURE, "utf8").split("\n");
    const kinds = lines
      .map((l, i) => parseStderrLine(l, i))
      .filter((e) => e !== null)
      .map((e) => e!.kind);
    expect(kinds).toEqual(["freq", "signal", "signal", "idle", "freq", "signal", "idle"]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/stderrParser.test.ts`
Expected: FAIL — `parseStderrLine` not found.

- [ ] **Step 4: Write minimal implementation**

```typescript
// kiosk/src/backend/engine/stderrParser.ts
// Pure function. Translates one line of rtl_fm stderr into a low-level parse
// result, or null if the line carries nothing we care about. The RtlFmEngine
// (Task 8) maps these into ScannerEngine events (active/idle/signal) using the
// channel list to resolve a freq to a Channel.
//
// NOTE: patterns target the SYNTHETIC fixture. Replace with patterns from the
// real Pi capture (Task 6) when available — keep the return shapes identical.

export type ParseResult =
  | { kind: "freq"; freq: number; ts: number }
  | { kind: "signal"; dbfs: number; ts: number }
  | { kind: "idle"; ts: number };

const FREQ_RE = /Tuned to (\d+) Hz/;
const SIGNAL_RE = /Signal level:\s*(-?\d+)/;
const IDLE_RE = /Squelch closed/;

export function parseStderrLine(line: string, ts: number): ParseResult | null {
  const trimmed = line.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return null;

  const freq = FREQ_RE.exec(trimmed);
  if (freq) return { kind: "freq", freq: Number(freq[1]), ts };

  const signal = SIGNAL_RE.exec(trimmed);
  if (signal) return { kind: "signal", dbfs: Number(signal[1]), ts };

  if (IDLE_RE.test(trimmed)) return { kind: "idle", ts };

  return null;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/stderrParser.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/backend/engine/stderrParser.ts kiosk/test/stderrParser.test.ts kiosk/test/fixtures/rtl_fm-stderr.synthetic.txt
git commit -m "feat(kiosk): rtl_fm stderr line parser (pure fn) + synthetic fixture"
```

---

## Task 8: RtlFmEngine (spawn, supervise, restart) tested with a fake rtl_fm

**Files:**
- Create: `kiosk/src/backend/engine/RtlFmEngine.ts`
- Create: `kiosk/test/fakes/fake-rtl_fm.sh`
- Test: `kiosk/test/RtlFmEngine.test.ts`

The engine spawns a command (default `rtl_fm`) and a sink command (default
`aplay`), wires `rtl_fm.stdout → sink.stdin`, and reads `rtl_fm.stderr` line by
line through `parseStderrLine`. For testing we inject a **fake rtl_fm** script and
a sink of `cat >/dev/null`, so the spawn/pipe/parse/restart logic is verified with
zero hardware.

- [ ] **Step 1: Write the fake rtl_fm**

```bash
# kiosk/test/fakes/fake-rtl_fm.sh
#!/usr/bin/env bash
# Emits canned stderr matching the synthetic format, plus silence on stdout,
# then exits. Used to test RtlFmEngine without a dongle.
set -euo pipefail
{
  echo "Tuned to 145130000 Hz."
  echo "Signal level: -28"
  echo "Squelch closed"
} >&2
# a little silence on stdout so the pipe to the sink is exercised
head -c 1024 /dev/zero
exit 0
```

- [ ] **Step 2: Write the failing test**

```typescript
// kiosk/test/RtlFmEngine.test.ts
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { RtlFmEngine } from "../src/backend/engine/RtlFmEngine.js";
import type { ScanConfig, EngineEvent } from "../src/backend/engine/ScannerEngine.js";

const FAKE = join(__dirname, "fakes", "fake-rtl_fm.sh");
chmodSync(FAKE, 0o755);

const cfg: ScanConfig = {
  channels: [{ id: "c1", freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true }],
  sampleRate: 12000, squelchLevel: 150, gain: "auto", audioSink: "test",
};

function collect(e: RtlFmEngine, ms: number): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  e.on((ev) => out.push(ev));
  return new Promise((r) => setTimeout(() => r(out), ms));
}

describe("RtlFmEngine", () => {
  it("emits active when the fake reports a tuned frequency", async () => {
    const e = new RtlFmEngine({ rtlFmCmd: FAKE, sinkCmd: ["cat"], autoRestart: false });
    await e.start(cfg);
    const events = await collect(e, 500);
    await e.stop();
    expect(events.some((ev) => ev.type === "active" && ev.freq === 145130000)).toBe(true);
  });

  it("emits idle on squelch closed", async () => {
    const e = new RtlFmEngine({ rtlFmCmd: FAKE, sinkCmd: ["cat"], autoRestart: false });
    await e.start(cfg);
    const events = await collect(e, 500);
    await e.stop();
    expect(events.some((ev) => ev.type === "idle")).toBe(true);
  });

  it("builds rtl_fm argv with one -f per enabled channel and squelch", async () => {
    const e = new RtlFmEngine({ rtlFmCmd: FAKE, sinkCmd: ["cat"], autoRestart: false });
    const argv = e.buildArgs({
      ...cfg,
      channels: [
        { id: "a", freq: 145130000, alphaTag: "", mode: "nfm", enabled: true },
        { id: "b", freq: 146940000, alphaTag: "", mode: "nfm", enabled: true },
        { id: "c", freq: 442150000, alphaTag: "", mode: "fm", enabled: false },
      ],
    });
    expect(argv).toContain("-f");
    expect(argv).toContain("145130000");
    expect(argv).toContain("146940000");
    expect(argv).not.toContain("442150000"); // disabled channel excluded
    expect(argv).toContain("-l"); // squelch present (required for scanning)
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/RtlFmEngine.test.ts`
Expected: FAIL — `RtlFmEngine` not found.

- [ ] **Step 4: Write minimal implementation**

```typescript
// kiosk/src/backend/engine/RtlFmEngine.ts
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type {
  ScannerEngine, ScanConfig, EngineState, EngineEvent, EngineListener,
} from "./ScannerEngine.js";
import { parseStderrLine } from "./stderrParser.js";

export interface RtlFmEngineOptions {
  rtlFmCmd?: string;          // default "rtl_fm"
  sinkCmd?: string[];         // default ["aplay","-r","12000","-f","S16_LE","-t","raw","-c","1"]
  autoRestart?: boolean;      // default true
  restartDelayMs?: number;    // default 1000
  now?: () => number;         // injectable clock; default Date.now
}

export class RtlFmEngine implements ScannerEngine {
  private listeners = new Set<EngineListener>();
  private _state: EngineState = "stopped";
  private rtl?: ChildProcess;
  private sink?: ChildProcess;
  private config?: ScanConfig;
  private stopping = false;

  private readonly rtlFmCmd: string;
  private readonly sinkCmd: string[];
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly now: () => number;

  constructor(opts: RtlFmEngineOptions = {}) {
    this.rtlFmCmd = opts.rtlFmCmd ?? "rtl_fm";
    this.sinkCmd = opts.sinkCmd ?? ["aplay", "-r", "12000", "-f", "S16_LE", "-t", "raw", "-c", "1"];
    this.autoRestart = opts.autoRestart ?? true;
    this.restartDelayMs = opts.restartDelayMs ?? 1000;
    this.now = opts.now ?? (() => Date.now());
  }

  get state(): EngineState { return this._state; }
  on(l: EngineListener): void { this.listeners.add(l); }
  off(l: EngineListener): void { this.listeners.delete(l); }
  private emit(ev: EngineEvent): void { for (const l of this.listeners) l(ev); }

  buildArgs(config: ScanConfig): string[] {
    const args: string[] = [];
    for (const ch of config.channels) {
      if (ch.enabled) args.push("-f", String(ch.freq));
    }
    args.push("-M", "fm");                       // nfm/fm both demod via fm; am handled later
    args.push("-s", String(config.sampleRate));
    args.push("-l", String(config.squelchLevel)); // squelch required for multi-f scanning
    args.push("-t", "5");                          // positive squelch_delay -> mute/scan, never exit
    if (config.gain !== "auto") args.push("-g", String(config.gain));
    args.push("-");                                // PCM to stdout
    return args;
  }

  async start(config: ScanConfig): Promise<void> {
    this.config = config;
    this.stopping = false;
    this._state = "starting";
    this.emit({ type: "status", state: "starting", ts: this.now() });
    this.spawnPipeline(config);
    this._state = "running";
    this.emit({ type: "status", state: "running", ts: this.now() });
  }

  private spawnPipeline(config: ScanConfig): void {
    const sink = spawn(this.sinkCmd[0]!, this.sinkCmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    const rtl = spawn(this.rtlFmCmd, this.buildArgs(config), { stdio: ["ignore", "pipe", "pipe"] });
    this.sink = sink;
    this.rtl = rtl;

    if (rtl.stdout && sink.stdin) rtl.stdout.pipe(sink.stdin);

    if (rtl.stderr) {
      const rl = createInterface({ input: rtl.stderr });
      rl.on("line", (line) => this.handleStderr(line, config));
    }

    rtl.on("error", (err) => {
      this.emit({ type: "error", code: "SPAWN_FAILED", message: err.message, ts: this.now() });
      this.handleExit();
    });
    rtl.on("exit", () => this.handleExit());
  }

  private handleStderr(line: string, config: ScanConfig): void {
    const r = parseStderrLine(line, this.now());
    if (!r) return;
    if (r.kind === "freq") {
      const channel = config.channels.find((c) => c.freq === r.freq);
      if (channel) this.emit({ type: "active", channel, freq: r.freq, ts: r.ts });
    } else if (r.kind === "signal") {
      this.emit({ type: "signal", dbfs: r.dbfs, ts: r.ts });
    } else if (r.kind === "idle") {
      this.emit({ type: "idle", ts: r.ts });
    }
  }

  private handleExit(): void {
    this.killSink();
    if (this.stopping) return;
    if (this.autoRestart && this.config) {
      this._state = "error";
      this.emit({ type: "error", code: "RTL_EXITED", message: "rtl_fm exited; restarting", ts: this.now() });
      setTimeout(() => {
        if (!this.stopping && this.config) this.spawnPipeline(this.config);
      }, this.restartDelayMs);
    } else {
      this._state = "stopped";
      this.emit({ type: "status", state: "stopped", ts: this.now() });
    }
  }

  private killSink(): void {
    if (this.sink && !this.sink.killed) this.sink.kill("SIGTERM");
    this.sink = undefined;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.rtl && !this.rtl.killed) this.rtl.kill("SIGTERM");
    this.killSink();
    this.rtl = undefined;
    this._state = "stopped";
    this.emit({ type: "status", state: "stopped", ts: this.now() });
  }

  // amixer integration lands in Task 9; these no-op safely until then.
  async setVolume(_percent: number): Promise<void> {}
  async setMuted(_muted: boolean): Promise<void> {}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/RtlFmEngine.test.ts`
Expected: PASS (3 tests). If the pipeline tests are flaky on timing, raise the `collect` window to 800ms — the fake exits fast.

- [ ] **Step 6: Commit**

```bash
git add kiosk/src/backend/engine/RtlFmEngine.ts kiosk/test/RtlFmEngine.test.ts kiosk/test/fakes/fake-rtl_fm.sh
git commit -m "feat(kiosk): RtlFmEngine spawn/pipe/parse/restart, tested with fake rtl_fm"
```

---

## Task 9: audio.ts (amixer volume/mute + sink enumeration), wired into RtlFmEngine

**Files:**
- Create: `kiosk/src/backend/audio.ts`
- Modify: `kiosk/src/backend/engine/RtlFmEngine.ts` (replace the no-op setVolume/setMuted)
- Test: `kiosk/test/audio.test.ts`

`audio.ts` shells out to `amixer`/`aplay`. To stay hardware-free in tests, every
function takes an injectable `run` executor (default spawns the real command).

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/audio.test.ts
import { describe, it, expect, vi } from "vitest";
import { setVolume, setMuted, listSinks } from "../src/backend/audio.js";

describe("audio", () => {
  it("setVolume calls amixer with a percent", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: "", stderr: "", code: 0 });
    await setVolume(70, { run, control: "Master", card: 0 });
    expect(run).toHaveBeenCalledWith("amixer", ["-c", "0", "sset", "Master", "70%"]);
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
    expect(sinks).not.toContain("    Discard all samples"); // indented descriptions excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/audio.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/audio.ts
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
  // Device ids are non-indented lines; descriptions are indented.
  return stdout.split("\n").filter((l) => l.length > 0 && !/^\s/.test(l));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/audio.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire audio into RtlFmEngine**

Modify `kiosk/src/backend/engine/RtlFmEngine.ts`: add an import and replace the two no-op methods.

Add near the top imports:
```typescript
import { setVolume as amixerVolume, setMuted as amixerMuted } from "../audio.js";
```

Replace:
```typescript
  async setVolume(_percent: number): Promise<void> {}
  async setMuted(_muted: boolean): Promise<void> {}
```
with:
```typescript
  async setVolume(percent: number): Promise<void> {
    await amixerVolume(percent);
  }
  async setMuted(muted: boolean): Promise<void> {
    await amixerMuted(muted);
  }
```

- [ ] **Step 6: Run all engine + audio tests to confirm no regression**

Run: `cd kiosk && npx vitest run test/RtlFmEngine.test.ts test/audio.test.ts`
Expected: PASS (all). The RtlFmEngine tests do not call setVolume/setMuted, so they remain hardware-free.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/backend/audio.ts kiosk/src/backend/engine/RtlFmEngine.ts kiosk/test/audio.test.ts
git commit -m "feat(kiosk): amixer volume/mute + aplay sink enumeration; wire into engine"
```

---

## Task 10: WebSocket hub

**Files:**
- Create: `kiosk/src/backend/ws.ts`
- Test: `kiosk/test/api.test.ts` covers WS+HTTP together in Task 12. Here, a focused unit test.
- Test: `kiosk/test/ws.test.ts`

The hub holds connected clients and broadcasts `EngineEvent`s as JSON. It also
exposes a `broadcast()` the engine listener calls.

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/ws.test.ts
import { describe, it, expect, vi } from "vitest";
import { WsHub } from "../src/backend/ws.js";

function fakeClient() {
  return { readyState: 1, OPEN: 1, send: vi.fn() } as any;
}

describe("WsHub", () => {
  it("broadcasts a JSON-serialised event to all open clients", () => {
    const hub = new WsHub();
    const a = fakeClient(), b = fakeClient();
    hub.add(a); hub.add(b);
    hub.broadcast({ type: "idle", ts: 5 });
    expect(a.send).toHaveBeenCalledWith(JSON.stringify({ type: "idle", ts: 5 }));
    expect(b.send).toHaveBeenCalledWith(JSON.stringify({ type: "idle", ts: 5 }));
  });

  it("skips clients that are not open", () => {
    const hub = new WsHub();
    const closed = fakeClient(); closed.readyState = 3;
    hub.add(closed);
    hub.broadcast({ type: "idle", ts: 1 });
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("drops a client on remove", () => {
    const hub = new WsHub();
    const a = fakeClient();
    hub.add(a); hub.remove(a);
    hub.broadcast({ type: "idle", ts: 1 });
    expect(a.send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/ws.test.ts`
Expected: FAIL — `WsHub` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/ws.ts
import type { WebSocket } from "ws";
import type { EngineEvent } from "./engine/ScannerEngine.js";

// Minimal structural type so unit tests can pass fakes without a real socket.
interface Sendable { readyState: number; OPEN: number; send(data: string): void; }

export class WsHub {
  private clients = new Set<Sendable>();

  add(ws: Sendable): void { this.clients.add(ws); }
  remove(ws: Sendable): void { this.clients.delete(ws); }

  broadcast(event: EngineEvent): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  // Convenience for index.ts to register a real ws.WebSocket.
  attach(ws: WebSocket): void {
    this.add(ws as unknown as Sendable);
    ws.on("close", () => this.remove(ws as unknown as Sendable));
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/ws.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/ws.ts kiosk/test/ws.test.ts
git commit -m "feat(kiosk): WebSocket broadcast hub"
```

---

## Task 11: HTTP server + API (config, channels, scan, audio, status, logs)

**Files:**
- Create: `kiosk/src/backend/server.ts`
- Test: `kiosk/test/api.test.ts`

`server.ts` exports `createServer(deps)` returning a Node `http.Server` (so
supertest can drive it) plus the underlying handler. Dependencies (engine,
configStore, activityLog, wsHub, staticDir) are injected so tests use the
`FakeEngine` and a temp config dir. The server uses only Node's built-in `http`
(no Express needed) with a tiny router.

- [ ] **Step 1: Write the failing test**

```typescript
// kiosk/test/api.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "../src/backend/server.js";
import { ConfigStore } from "../src/backend/config/ConfigStore.js";
import { ActivityLog } from "../src/backend/activityLog.js";
import { WsHub } from "../src/backend/ws.js";
import { FakeEngine } from "../src/backend/engine/FakeEngine.js";

let dir: string;
function makeApp() {
  dir = mkdtempSync(join(tmpdir(), "ksrv-"));
  const configStore = new ConfigStore(join(dir, "config.json"));
  const engine = new FakeEngine();
  const activityLog = new ActivityLog(100);
  const wsHub = new WsHub();
  const { server } = createServer({ configStore, engine, activityLog, wsHub, staticDir: dir });
  return { server, engine, configStore };
}
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("HTTP API", () => {
  it("GET /api/config returns the current config", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/config");
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(1);
  });

  it("POST /api/channels adds a channel and persists it", async () => {
    const { server } = makeApp();
    const res = await request(server)
      .post("/api/channels")
      .send({ freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    const after = await request(server).get("/api/channels");
    expect(after.body.length).toBe(1);
  });

  it("PUT /api/config rejects an invalid body with 400", async () => {
    const { server } = makeApp();
    const res = await request(server).put("/api/config").send({ nope: true });
    expect(res.status).toBe(400);
  });

  it("POST /api/audio/volume calls the engine", async () => {
    const { server, engine } = makeApp();
    let got = -1;
    engine.setVolume = async (p: number) => { got = p; };
    const res = await request(server).post("/api/audio/volume").send({ percent: 55 });
    expect(res.status).toBe(200);
    expect(got).toBe(55);
  });

  it("GET /api/status returns engine state", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/status");
    expect(res.status).toBe(200);
    expect(res.body.state).toBeTruthy();
  });

  it("GET /api/logs returns an array", async () => {
    const { server } = makeApp();
    const res = await request(server).get("/api/logs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/api.test.ts`
Expected: FAIL — `createServer` not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// kiosk/src/backend/server.ts
import { createServer as httpCreateServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { randomUUID } from "node:crypto";
import { configSchema, channelSchema, type Config, type Channel } from "./config/schema.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import { WsHub } from "./ws.js";
import type { ScannerEngine, ScanConfig } from "./engine/ScannerEngine.js";

export interface ServerDeps {
  configStore: ConfigStore;
  engine: ScannerEngine;
  activityLog: ActivityLog;
  wsHub: WsHub;
  staticDir: string;
}

const MIME: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml",
};

function toScanConfig(cfg: Config): ScanConfig {
  return {
    channels: cfg.channels,
    sampleRate: cfg.scan.sampleRate,
    squelchLevel: cfg.scan.squelchLevel,
    gain: cfg.scan.gain,
    audioSink: cfg.audio.sink,
  };
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

export function createServer(deps: ServerDeps): { server: Server } {
  const { configStore, engine, activityLog, staticDir } = deps;
  let config = configStore.load();

  const server = httpCreateServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method ?? "GET";

      if (path.startsWith("/api/")) {
        await handleApi(method, path, req, res);
        return;
      }
      serveStatic(path, res);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  });

  async function handleApi(method: string, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (method === "GET" && path === "/api/config") return json(res, 200, config);

    if (method === "PUT" && path === "/api/config") {
      const body = await readBody(req);
      const parsed = configSchema.safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid config", issues: parsed.error.issues });
      config = parsed.data;
      configStore.save(config);
      await engine.stop();
      await engine.start(toScanConfig(config));
      return json(res, 200, config);
    }

    if (method === "GET" && path === "/api/channels") return json(res, 200, config.channels);

    if (method === "POST" && path === "/api/channels") {
      const body = await readBody(req);
      const parsed = channelSchema.omit({ id: true }).safeParse(body);
      if (!parsed.success) return json(res, 400, { error: "invalid channel", issues: parsed.error.issues });
      const channel: Channel = { id: `ch_${randomUUID().slice(0, 8)}`, ...parsed.data };
      config = { ...config, channels: [...config.channels, channel] };
      configStore.save(config);
      return json(res, 201, channel);
    }

    const chMatch = /^\/api\/channels\/([^/]+)$/.exec(path);
    if (chMatch) {
      const id = chMatch[1]!;
      if (method === "PUT") {
        const body = await readBody(req);
        const parsed = channelSchema.partial().safeParse(body);
        if (!parsed.success) return json(res, 400, { error: "invalid channel" });
        config = { ...config, channels: config.channels.map((c) => c.id === id ? { ...c, ...parsed.data, id } : c) };
        configStore.save(config);
        return json(res, 200, config.channels.find((c) => c.id === id));
      }
      if (method === "DELETE") {
        config = { ...config, channels: config.channels.filter((c) => c.id !== id) };
        configStore.save(config);
        return json(res, 204, null);
      }
    }

    if (method === "POST" && path === "/api/scan/start") { await engine.start(toScanConfig(config)); return json(res, 200, { state: engine.state }); }
    if (method === "POST" && path === "/api/scan/stop") { await engine.stop(); return json(res, 200, { state: engine.state }); }

    if (method === "POST" && path === "/api/audio/volume") {
      const body = await readBody(req);
      await engine.setVolume(Number(body?.percent));
      config = { ...config, audio: { ...config.audio, volume: Number(body?.percent) } };
      configStore.save(config);
      return json(res, 200, { volume: config.audio.volume });
    }
    if (method === "POST" && path === "/api/audio/mute") {
      const body = await readBody(req);
      await engine.setMuted(Boolean(body?.muted));
      config = { ...config, audio: { ...config.audio, muted: Boolean(body?.muted) } };
      configStore.save(config);
      return json(res, 200, { muted: config.audio.muted });
    }

    if (method === "GET" && path === "/api/status") return json(res, 200, { state: engine.state, config });
    if (method === "GET" && path === "/api/logs") return json(res, 200, activityLog.entries());

    return json(res, 404, { error: "not found" });
  }

  function serveStatic(path: string, res: ServerResponse): void {
    // SPA: serve index.html for any non-file path.
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, "");
    let filePath = join(staticDir, safe === "/" ? "index.html" : safe);
    if (!existsSync(filePath) || !extname(filePath)) filePath = join(staticDir, "index.html");
    if (!existsSync(filePath)) { res.writeHead(404); res.end("not found"); return; }
    const mime = MIME[extname(filePath)] ?? "application/octet-stream";
    res.writeHead(200, { "content-type": mime });
    res.end(readFileSync(filePath));
  }

  return { server };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/api.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add kiosk/src/backend/server.ts kiosk/test/api.test.ts
git commit -m "feat(kiosk): HTTP API for config/channels/scan/audio/status/logs"
```

---

## Task 12: Backend entrypoint (wires everything; engine → log + WS)

**Files:**
- Create: `kiosk/src/backend/index.ts`
- Test: manual smoke (no unit test — pure wiring). A startup assertion stands in.

- [ ] **Step 1: Write the entrypoint**

```typescript
// kiosk/src/backend/index.ts
import { WebSocketServer } from "ws";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "./server.js";
import { ConfigStore } from "./config/ConfigStore.js";
import { ActivityLog } from "./activityLog.js";
import { WsHub } from "./ws.js";
import { RtlFmEngine } from "./engine/RtlFmEngine.js";
import { FakeEngine } from "./engine/FakeEngine.js";
import type { EngineEvent } from "./engine/ScannerEngine.js";

const PORT = Number(process.env.PORT ?? 8080);
const CONFIG_PATH = process.env.KERCHUNK_CONFIG ?? "/var/lib/kerchunk-kiosk/config.json";
const STATIC_DIR = process.env.KERCHUNK_STATIC
  ?? join(fileURLToPath(new URL("../frontend", import.meta.url)));
// USE_FAKE_ENGINE=1 lets you run the whole stack on a Mac with no dongle.
const useFake = process.env.USE_FAKE_ENGINE === "1";

const configStore = new ConfigStore(CONFIG_PATH);
const config = configStore.load();
const activityLog = new ActivityLog(500);
const wsHub = new WsHub();
const engine = useFake ? new FakeEngine() : new RtlFmEngine();

// Engine events → activity log (on "active") + broadcast to all clients.
engine.on((ev: EngineEvent) => {
  if (ev.type === "active") {
    activityLog.add({ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts });
  }
  wsHub.broadcast(ev);
});

const { server } = createServer({ configStore, engine, activityLog, wsHub, staticDir: STATIC_DIR });

const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => wsHub.attach(ws));

server.listen(PORT, () => {
  console.log(`kerchunk-kiosk listening on :${PORT} (engine: ${useFake ? "fake" : "rtl_fm"})`);
  engine.start({
    channels: config.channels,
    sampleRate: config.scan.sampleRate,
    squelchLevel: config.scan.squelchLevel,
    gain: config.scan.gain,
    audioSink: config.audio.sink,
  }).catch((err) => console.error("engine start failed:", err));
});

process.on("SIGTERM", async () => { await engine.stop(); server.close(); process.exit(0); });
process.on("SIGINT", async () => { await engine.stop(); server.close(); process.exit(0); });
```

- [ ] **Step 2: Verify it compiles**

Run: `cd kiosk && npx tsc -p tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 3: Smoke-test the whole backend with the fake engine (no hardware)**

Run: `cd kiosk && USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc-smoke.json KERCHUNK_STATIC=/tmp PORT=8099 npx tsx src/backend/index.ts &`
Then: `sleep 1 && curl -s localhost:8099/api/status && echo && curl -s localhost:8099/api/config | head -c 80 && echo`
Expected: a JSON status with `"state":"running"` and a config blob. Then: `kill %1`.

- [ ] **Step 4: Commit**

```bash
git add kiosk/src/backend/index.ts
git commit -m "feat(kiosk): backend entrypoint wiring engine, WS, HTTP, activity log"
```

---

## Task 13: Frontend SPA shell + reconnecting WS client + typed API

**Files:**
- Create: `kiosk/vite.config.ts`
- Create: `kiosk/src/frontend/index.html`
- Create: `kiosk/src/frontend/main.ts`
- Create: `kiosk/src/frontend/lib/wsClient.ts`
- Create: `kiosk/src/frontend/lib/api.ts`
- Test: `kiosk/test/wsClient.test.ts`

- [ ] **Step 1: Write the failing test for the WS client reconnect logic**

```typescript
// kiosk/test/wsClient.test.ts
import { describe, it, expect, vi } from "vitest";
import { ReconnectingWs } from "../src/frontend/lib/wsClient.js";

class FakeSocket {
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  static instances: FakeSocket[] = [];
  constructor(public url: string) { FakeSocket.instances.push(this); }
  close() { this.onclose?.(); }
}

describe("ReconnectingWs", () => {
  it("delivers parsed messages to the handler", () => {
    FakeSocket.instances = [];
    const got: any[] = [];
    const r = new ReconnectingWs("ws://x/ws", (m) => got.push(m), { SocketImpl: FakeSocket as any, reconnectMs: 1 });
    r.connect();
    const sock = FakeSocket.instances[0]!;
    sock.onmessage?.({ data: JSON.stringify({ type: "idle", ts: 1 }) });
    expect(got).toEqual([{ type: "idle", ts: 1 }]);
  });

  it("reconnects after a close", () => {
    FakeSocket.instances = [];
    vi.useFakeTimers();
    const r = new ReconnectingWs("ws://x/ws", () => {}, { SocketImpl: FakeSocket as any, reconnectMs: 10 });
    r.connect();
    FakeSocket.instances[0]!.close();
    vi.advanceTimersByTime(11);
    expect(FakeSocket.instances.length).toBe(2);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/wsClient.test.ts`
Expected: FAIL — `ReconnectingWs` not found.

- [ ] **Step 3: Write the WS client**

```typescript
// kiosk/src/frontend/lib/wsClient.ts
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";

interface Opts { SocketImpl?: typeof WebSocket; reconnectMs?: number; }

export class ReconnectingWs {
  private readonly SocketImpl: typeof WebSocket;
  private readonly reconnectMs: number;
  private sock?: WebSocket;

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: EngineEvent) => void,
    opts: Opts = {},
  ) {
    this.SocketImpl = opts.SocketImpl ?? WebSocket;
    this.reconnectMs = opts.reconnectMs ?? 2000;
  }

  connect(): void {
    const sock = new this.SocketImpl(this.url);
    this.sock = sock;
    sock.onmessage = (e: MessageEvent) => {
      try { this.onEvent(JSON.parse(e.data) as EngineEvent); } catch { /* ignore */ }
    };
    sock.onclose = () => { setTimeout(() => this.connect(), this.reconnectMs); };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/wsClient.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the typed API client**

```typescript
// kiosk/src/frontend/lib/api.ts
import type { Config, Channel } from "../../backend/config/schema.js";

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json() as Promise<T>;
}

export const api = {
  getConfig: () => fetch("/api/config").then(j<Config>),
  getChannels: () => fetch("/api/channels").then(j<Channel[]>),
  addChannel: (c: Omit<Channel, "id">) =>
    fetch("/api/channels", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(c) }).then(j<Channel>),
  deleteChannel: (id: string) => fetch(`/api/channels/${id}`, { method: "DELETE" }),
  setVolume: (percent: number) =>
    fetch("/api/audio/volume", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ percent }) }),
  setMuted: (muted: boolean) =>
    fetch("/api/audio/mute", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ muted }) }),
  getStatus: () => fetch("/api/status").then(j<{ state: string; config: Config }>),
  getLogs: () => fetch("/api/logs").then(j<{ freq: number; alphaTag: string; ts: number }[]>),
};
```

- [ ] **Step 6: Write the SPA host page and router**

```html
<!-- kiosk/src/frontend/index.html -->
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Kerchunk Kiosk</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="/main.ts"></script>
  </body>
</html>
```

```typescript
// kiosk/src/frontend/main.ts
import { renderDashboard } from "./dashboard/dashboard.js";
import { renderAdmin } from "./admin/admin.js";

const root = document.getElementById("app")!;
// /admin -> admin; anything else -> dashboard (kiosk default).
if (location.pathname.startsWith("/admin")) {
  renderAdmin(root);
} else {
  renderDashboard(root);
}
```

- [ ] **Step 7: Write the Vite config**

```typescript
// kiosk/vite.config.ts
import { defineConfig } from "vite";

export default defineConfig({
  root: "src/frontend",
  build: { outDir: "../../dist/frontend", emptyOutDir: true },
  server: {
    proxy: {
      "/api": "http://localhost:8080",
      "/ws": { target: "ws://localhost:8080", ws: true },
    },
  },
});
```

- [ ] **Step 8: Add placeholder render functions so the build compiles**

```typescript
// kiosk/src/frontend/dashboard/dashboard.ts (placeholder; fleshed out in Task 14)
export function renderDashboard(root: HTMLElement): void {
  root.textContent = "Dashboard loading…";
}
```

```typescript
// kiosk/src/frontend/admin/admin.ts (placeholder; fleshed out in Task 15)
export function renderAdmin(root: HTMLElement): void {
  root.textContent = "Admin loading…";
}
```

- [ ] **Step 9: Verify the frontend builds**

Run: `cd kiosk && npx vite build`
Expected: builds to `dist/frontend/` with no errors.

- [ ] **Step 10: Commit**

```bash
git add kiosk/vite.config.ts kiosk/src/frontend/index.html kiosk/src/frontend/main.ts kiosk/src/frontend/lib/wsClient.ts kiosk/src/frontend/lib/api.ts kiosk/src/frontend/dashboard/dashboard.ts kiosk/src/frontend/admin/admin.ts kiosk/test/wsClient.test.ts
git commit -m "feat(kiosk): frontend shell, reconnecting WS client, typed API"
```

---

## Task 14: Dashboard view (Now Playing + Activity Log)

**Files:**
- Modify: `kiosk/src/frontend/dashboard/dashboard.ts`
- Create: `kiosk/src/frontend/dashboard/dashboard.css`
- Test: `kiosk/test/dashboardState.test.ts` (pure state-reducer test; DOM is verified manually on the Pi)

To keep the view testable without a DOM, the channel/log state lives in a pure
reducer that the render function consumes.

- [ ] **Step 1: Write the failing reducer test**

```typescript
// kiosk/test/dashboardState.test.ts
import { describe, it, expect } from "vitest";
import { reduce, initialState } from "../src/frontend/dashboard/dashboard.js";

describe("dashboard reduce", () => {
  it("active sets nowPlaying and prepends to log", () => {
    const ch = { id: "c1", freq: 145130000, alphaTag: "KC0KW", mode: "nfm" as const, enabled: true };
    const s = reduce(initialState(), { type: "active", channel: ch, freq: ch.freq, ts: 10 });
    expect(s.nowPlaying?.freq).toBe(145130000);
    expect(s.log[0]?.freq).toBe(145130000);
  });

  it("idle clears nowPlaying but keeps the log", () => {
    const ch = { id: "c1", freq: 1, alphaTag: "x", mode: "fm" as const, enabled: true };
    let s = reduce(initialState(), { type: "active", channel: ch, freq: 1, ts: 1 });
    s = reduce(s, { type: "idle", ts: 2 });
    expect(s.nowPlaying).toBeNull();
    expect(s.log.length).toBe(1);
  });

  it("error sets an error message", () => {
    const s = reduce(initialState(), { type: "error", code: "NO_DONGLE", message: "No RTL-SDR", ts: 1 });
    expect(s.error).toBe("No RTL-SDR");
  });

  it("status running clears any error", () => {
    let s = reduce(initialState(), { type: "error", code: "X", message: "boom", ts: 1 });
    s = reduce(s, { type: "status", state: "running", ts: 2 });
    expect(s.error).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/dashboardState.test.ts`
Expected: FAIL — `reduce`/`initialState` not exported.

- [ ] **Step 3: Write the dashboard (reducer + render)**

```typescript
// kiosk/src/frontend/dashboard/dashboard.ts
import type { EngineEvent } from "../../backend/engine/ScannerEngine.js";
import { ReconnectingWs } from "../lib/wsClient.js";
import { api } from "../lib/api.js";
import "./dashboard.css";

export interface NowPlaying { freq: number; alphaTag: string; }
export interface LogRow { freq: number; alphaTag: string; ts: number; }
export interface DashState { nowPlaying: NowPlaying | null; log: LogRow[]; error: string | null; }

export function initialState(): DashState {
  return { nowPlaying: null, log: [], error: null };
}

export function reduce(s: DashState, ev: EngineEvent): DashState {
  switch (ev.type) {
    case "active":
      return {
        ...s,
        nowPlaying: { freq: ev.freq, alphaTag: ev.channel.alphaTag },
        log: [{ freq: ev.freq, alphaTag: ev.channel.alphaTag, ts: ev.ts }, ...s.log].slice(0, 100),
      };
    case "idle":
      return { ...s, nowPlaying: null };
    case "error":
      return { ...s, error: ev.message };
    case "status":
      return ev.state === "running" ? { ...s, error: null } : s;
    default:
      return s;
  }
}

function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(3); }
function fmtTime(ts: number): string { return new Date(ts).toLocaleTimeString(); }

export function renderDashboard(root: HTMLElement): void {
  let state = initialState();

  root.innerHTML = `
    <div class="dash">
      <section class="now" id="now"></section>
      <aside class="log"><h2>Recent</h2><ul id="logList"></ul></aside>
    </div>`;
  const nowEl = root.querySelector<HTMLElement>("#now")!;
  const logEl = root.querySelector<HTMLElement>("#logList")!;

  function paint(): void {
    if (state.error) {
      nowEl.innerHTML = `<div class="err">${state.error}</div>`;
    } else if (state.nowPlaying) {
      nowEl.innerHTML = `<div class="active">● ACTIVE</div>
        <div class="freq">${fmtFreq(state.nowPlaying.freq)}</div>
        <div class="tag">${state.nowPlaying.alphaTag}</div>`;
    } else {
      nowEl.innerHTML = `<div class="scanning">scanning…</div>`;
    }
    logEl.innerHTML = state.log
      .map((r) => `<li><span class="t">${fmtTime(r.ts)}</span> ${fmtFreq(r.freq)} ${r.alphaTag}</li>`)
      .join("");
  }

  // Seed the log from the server, then go live.
  api.getLogs().then((rows) => { state = { ...state, log: rows }; paint(); }).catch(() => {});
  const proto = location.protocol === "https:" ? "wss" : "ws";
  new ReconnectingWs(`${proto}://${location.host}/ws`, (ev) => { state = reduce(state, ev); paint(); }).connect();
  paint();
}
```

- [ ] **Step 4: Write the dashboard CSS**

```css
/* kiosk/src/frontend/dashboard/dashboard.css */
:root { color-scheme: dark; }
body { margin: 0; font-family: ui-monospace, monospace; background: #0d1117; color: #e6edf3; }
.dash { display: flex; height: 100vh; }
.now { flex: 1.4; display: flex; flex-direction: column; align-items: center; justify-content: center; background: #161b22; border-right: 1px solid #30363d; }
.now .active { color: #3fb950; letter-spacing: 3px; font-size: 1.2rem; }
.now .freq { font-size: 6rem; font-weight: 700; line-height: 1.1; }
.now .tag { color: #8b949e; font-size: 1.6rem; }
.now .scanning { color: #8b949e; font-size: 2rem; }
.now .err { color: #f85149; font-size: 1.8rem; text-align: center; padding: 1rem; }
.log { flex: 1; padding: 1.5rem; overflow-y: auto; }
.log h2 { color: #8b949e; font-size: 0.9rem; text-transform: uppercase; letter-spacing: 2px; }
.log ul { list-style: none; padding: 0; margin: 0; }
.log li { padding: 0.4rem 0; border-bottom: 1px solid #21262d; font-size: 1.1rem; }
.log .t { color: #8b949e; margin-right: 0.6rem; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/dashboardState.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Build to confirm the CSS import and types resolve**

Run: `cd kiosk && npx vite build`
Expected: builds clean.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/frontend/dashboard/dashboard.ts kiosk/src/frontend/dashboard/dashboard.css kiosk/test/dashboardState.test.ts
git commit -m "feat(kiosk): dashboard view (Now Playing + Activity Log) with tested reducer"
```

---

## Task 15: Admin view (channel list + scan/audio controls)

**Files:**
- Modify: `kiosk/src/frontend/admin/admin.ts`
- Create: `kiosk/src/frontend/admin/admin.css`
- Test: `kiosk/test/adminForm.test.ts` (pure helper: form values → channel payload)

- [ ] **Step 1: Write the failing test for the form-to-payload helper**

```typescript
// kiosk/test/adminForm.test.ts
import { describe, it, expect } from "vitest";
import { formToChannel, mhzToHz } from "../src/frontend/admin/admin.js";

describe("admin form helpers", () => {
  it("mhzToHz converts MHz string to integer Hz", () => {
    expect(mhzToHz("145.130")).toBe(145130000);
    expect(mhzToHz("146.94")).toBe(146940000);
  });

  it("formToChannel builds a valid payload", () => {
    const payload = formToChannel({ mhz: "145.130", alphaTag: "KC0KW", mode: "nfm" });
    expect(payload).toEqual({ freq: 145130000, alphaTag: "KC0KW", mode: "nfm", enabled: true });
  });

  it("formToChannel throws on a non-numeric frequency", () => {
    expect(() => formToChannel({ mhz: "abc", alphaTag: "x", mode: "fm" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd kiosk && npx vitest run test/adminForm.test.ts`
Expected: FAIL — helpers not found.

- [ ] **Step 3: Write the admin view + helpers**

```typescript
// kiosk/src/frontend/admin/admin.ts
import type { Channel } from "../../backend/config/schema.js";
import { api } from "../lib/api.js";
import "./admin.css";

export function mhzToHz(mhz: string): number {
  const n = Number(mhz);
  if (!Number.isFinite(n)) throw new Error(`invalid frequency: ${mhz}`);
  return Math.round(n * 1e6);
}

export function formToChannel(form: { mhz: string; alphaTag: string; mode: string }): Omit<Channel, "id"> {
  const mode = form.mode as Channel["mode"];
  return { freq: mhzToHz(form.mhz), alphaTag: form.alphaTag, mode, enabled: true };
}

function fmtFreq(hz: number): string { return (hz / 1e6).toFixed(3); }

export function renderAdmin(root: HTMLElement): void {
  root.innerHTML = `
    <main class="admin">
      <h1>Kerchunk Kiosk — Admin</h1>
      <section class="audio">
        <label>Volume <input id="vol" type="range" min="0" max="100" /></label>
        <label><input id="mute" type="checkbox" /> Mute</label>
      </section>
      <section class="add">
        <h2>Add channel</h2>
        <input id="mhz" placeholder="145.130" />
        <input id="tag" placeholder="KC0KW — Gibbs Rd" />
        <select id="mode"><option>nfm</option><option>fm</option><option>am</option></select>
        <button id="addBtn">Add</button>
        <span id="addErr" class="err"></span>
      </section>
      <section><h2>Channels</h2><ul id="chList"></ul></section>
    </main>`;

  const vol = root.querySelector<HTMLInputElement>("#vol")!;
  const mute = root.querySelector<HTMLInputElement>("#mute")!;
  const chList = root.querySelector<HTMLElement>("#chList")!;
  const addErr = root.querySelector<HTMLElement>("#addErr")!;

  async function refresh(): Promise<void> {
    const channels = await api.getChannels();
    chList.innerHTML = channels
      .map((c) => `<li>${fmtFreq(c.freq)} — ${c.alphaTag} (${c.mode})
        <button data-id="${c.id}" class="del">delete</button></li>`)
      .join("");
    chList.querySelectorAll<HTMLButtonElement>(".del").forEach((b) =>
      b.addEventListener("click", async () => { await api.deleteChannel(b.dataset.id!); refresh(); }));
  }

  api.getConfig().then((cfg) => { vol.value = String(cfg.audio.volume); mute.checked = cfg.audio.muted; });
  vol.addEventListener("change", () => api.setVolume(Number(vol.value)));
  mute.addEventListener("change", () => api.setMuted(mute.checked));

  root.querySelector<HTMLButtonElement>("#addBtn")!.addEventListener("click", async () => {
    addErr.textContent = "";
    try {
      const payload = formToChannel({
        mhz: root.querySelector<HTMLInputElement>("#mhz")!.value,
        alphaTag: root.querySelector<HTMLInputElement>("#tag")!.value,
        mode: root.querySelector<HTMLSelectElement>("#mode")!.value,
      });
      await api.addChannel(payload);
      refresh();
    } catch (e) { addErr.textContent = (e as Error).message; }
  });

  refresh();
}
```

- [ ] **Step 4: Write the admin CSS**

```css
/* kiosk/src/frontend/admin/admin.css */
body { font-family: system-ui, sans-serif; background: #0d1117; color: #e6edf3; margin: 0; }
.admin { max-width: 640px; margin: 0 auto; padding: 2rem; }
.admin h1 { font-size: 1.3rem; }
.admin section { margin: 1.5rem 0; padding: 1rem; background: #161b22; border: 1px solid #30363d; border-radius: 8px; }
.admin input, .admin select, .admin button { font-size: 1rem; padding: 0.4rem; margin: 0.2rem; }
.admin ul { list-style: none; padding: 0; }
.admin li { padding: 0.5rem 0; border-bottom: 1px solid #21262d; }
.admin .err { color: #f85149; margin-left: 0.5rem; }
.admin .del { background: #21262d; color: #f85149; border: 1px solid #30363d; border-radius: 4px; cursor: pointer; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd kiosk && npx vitest run test/adminForm.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Build + run the full test suite**

Run: `cd kiosk && npx vite build && npx vitest run`
Expected: build clean; ALL tests pass.

- [ ] **Step 7: Commit**

```bash
git add kiosk/src/frontend/admin/admin.ts kiosk/src/frontend/admin/admin.css kiosk/test/adminForm.test.ts
git commit -m "feat(kiosk): admin view (channels + audio controls)"
```

---

## Task 16: systemd units

**Files:**
- Create: `kiosk/systemd/kerchunk-kiosk.service`
- Create: `kiosk/systemd/kerchunk-display.service`

- [ ] **Step 1: Write the backend service unit**

```ini
# kiosk/systemd/kerchunk-kiosk.service
[Unit]
Description=Kerchunk Kiosk backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=kerchunk
Group=kerchunk
SupplementaryGroups=audio plugdev
WorkingDirectory=/opt/kerchunk-kiosk
Environment=PORT=8080
Environment=KERCHUNK_CONFIG=/var/lib/kerchunk-kiosk/config.json
Environment=KERCHUNK_STATIC=/opt/kerchunk-kiosk/dist/frontend
ExecStart=/usr/bin/node /opt/kerchunk-kiosk/dist/backend/index.js
Restart=on-failure
RestartSec=2
StateDirectory=kerchunk-kiosk

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Write the display service unit**

```ini
# kiosk/systemd/kerchunk-display.service
[Unit]
Description=Kerchunk Kiosk display (cage + Chromium)
After=kerchunk-kiosk.service
Wants=kerchunk-kiosk.service

[Service]
Type=simple
User=kerchunk
Group=kerchunk
SupplementaryGroups=video render input
# cage is a minimal Wayland kiosk compositor; it runs one fullscreen app.
ExecStart=/usr/bin/cage -- chromium --kiosk --noerrdialogs --disable-infobars --app=http://localhost:8080/dashboard
Restart=always
RestartSec=3

[Install]
WantedBy=graphical.target
```

- [ ] **Step 3: Validate unit syntax (Linux only; skip on Mac)**

Run (on Pi): `systemd-analyze verify kiosk/systemd/kerchunk-kiosk.service` and same for the display unit.
Expected: no errors. (On a Mac there is no `systemd`; defer this check to Pi setup.)

- [ ] **Step 4: Commit**

```bash
git add kiosk/systemd/kerchunk-kiosk.service kiosk/systemd/kerchunk-display.service
git commit -m "feat(kiosk): systemd units for backend and display"
```

---

## Task 17: setup-kiosk.sh (Pi provisioning)

**Files:**
- Create: `kiosk/scripts/setup-kiosk.sh`

- [ ] **Step 1: Write the setup script**

```bash
# kiosk/scripts/setup-kiosk.sh
#!/usr/bin/env bash
#
# Provision a Raspberry Pi 4 (Raspberry Pi OS) as a Kerchunk Kiosk.
# Run on the Pi as a user with sudo. Idempotent where practical.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"   # the kiosk/ dir
INSTALL_DIR=/opt/kerchunk-kiosk
STATE_DIR=/var/lib/kerchunk-kiosk

echo "[setup] Installing packages..."
sudo apt-get update
sudo apt-get install -y rtl-sdr alsa-utils cage chromium-browser curl ca-certificates

echo "[setup] Installing Node.js LTS (NodeSource) if node is missing or <20..."
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi

echo "[setup] Blacklisting the DVB kernel module (frees the dongle for rtl_fm)..."
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null

echo "[setup] Installing RTL-SDR udev rule (plugdev access, no root needed)..."
sudo tee /etc/udev/rules.d/20-rtlsdr.rules >/dev/null <<'RULE'
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2838", GROUP="plugdev", MODE="0666"
SUBSYSTEM=="usb", ATTRS{idVendor}=="0bda", ATTRS{idProduct}=="2832", GROUP="plugdev", MODE="0666"
RULE
sudo udevadm control --reload-rules

echo "[setup] Creating the kerchunk service user..."
if ! id kerchunk >/dev/null 2>&1; then
  sudo useradd --system --create-home --shell /usr/sbin/nologin kerchunk
fi
sudo usermod -aG audio,plugdev,video,render,input kerchunk

echo "[setup] Building the app..."
( cd "$REPO_DIR" && npm ci && npm run build )

echo "[setup] Installing to $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo cp -r "$REPO_DIR/dist" "$REPO_DIR/package.json" "$REPO_DIR/node_modules" "$INSTALL_DIR/"
sudo chown -R kerchunk:kerchunk "$INSTALL_DIR"

echo "[setup] Preparing state dir $STATE_DIR..."
sudo mkdir -p "$STATE_DIR"
sudo chown kerchunk:kerchunk "$STATE_DIR"

echo "[setup] Installing systemd units..."
sudo cp "$REPO_DIR/systemd/kerchunk-kiosk.service" /etc/systemd/system/
sudo cp "$REPO_DIR/systemd/kerchunk-display.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kerchunk-kiosk.service
# Enable the local display only if a screen is attached; safe to enable anyway.
sudo systemctl enable --now kerchunk-display.service || true

echo "[setup] Done. Admin: http://$(hostname -I | awk '{print $1}'):8080/admin"
echo "[setup] If the dongle was plugged in before blacklisting, reboot once."
```

- [ ] **Step 2: Lint the script with shellcheck (if available)**

Run: `shellcheck kiosk/scripts/setup-kiosk.sh || echo "shellcheck not installed; skipping"`
Expected: no errors (or a clean skip). Fix any genuine warnings.

- [ ] **Step 3: Make it executable and commit**

```bash
chmod +x kiosk/scripts/setup-kiosk.sh
git add kiosk/scripts/setup-kiosk.sh
git commit -m "feat(kiosk): Pi provisioning script (setup-kiosk.sh)"
```

---

## Task 18: Bench protocol + kiosk README (the real success gate)

**Files:**
- Create: `kiosk/README.md`
- Create: `kiosk/bench/README.md`

- [ ] **Step 1: Write the kiosk README**

```markdown
# Kerchunk Kiosk

A Pi 4 + HD-display sibling to the headless pocket Kerchunk. Output-only
dashboard on the attached screen, HDMI audio, web admin from any device. v1 runs
`rtl_fm` serial squelch-scan over a channel list; the radio sits behind a
`ScannerEngine` interface so a future parallel engine drops in cleanly.

See [the design spec](../docs/superpowers/specs/2026-06-02-kerchunk-kiosk-design.md).

## Develop on a Mac/PC (no dongle)

```sh
cd kiosk
npm install
# Terminal 1 — backend with the fake engine (no hardware needed):
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
# Terminal 2 — frontend dev server (proxies /api and /ws to :8080):
npm run dev:frontend
```

Open the Vite URL; `/` is the dashboard, `/admin` is the admin.

## Test

```sh
cd kiosk && npm test
```

## Deploy to a Pi 4

```sh
git clone <repo> && cd kerchunk-kiosk/kiosk
./scripts/setup-kiosk.sh   # installs deps, builds, installs services
```

Then browse to `http://<pi-ip>:8080/admin` to add channels.
```

- [ ] **Step 2: Write the bench protocol (mirrors the existing bench/README convention)**

```markdown
# Kerchunk Kiosk — Hardware Bench Protocol

The unit tests prove the software in isolation. THIS is the real success gate:
the whole stack on a Pi 4 with a real dongle and display. Run these in order.

## Prerequisites
- Pi 4, Raspberry Pi OS, HD display on micro-HDMI (audio-capable).
- RTL-SDR dongle + antenna.
- At least one active local repeater you can key up (or wait for traffic).
- Ran `scripts/setup-kiosk.sh`, rebooted once.

## B1 — Dongle detected
Run: `rtl_test -t`
Pass: prints tuner info, no "usb_claim_interface error". If it fails, confirm the
DVB module is blacklisted and reboot.

## B2 — Capture stderr fixture (feeds the parser)
Run: `kiosk/bench/capture-stderr.sh 145130000 <another-freq>`; key up a repeater
during the 60s. Copy `/tmp/rtl_fm-stderr.txt` to
`kiosk/test/fixtures/rtl_fm-stderr.captured.txt`. Inspect the lines; if they
differ from the synthetic format, update `stderrParser.ts` regexes and re-run
`npm test`.

## B3 — Dashboard appears on boot
Reboot. Pass: the HD display shows the dashboard fullscreen within ~30s, in the
"scanning…" state.

## B4 — Audio out HDMI on activity
From a laptop open `http://<pi-ip>:8080/admin`, add 2-3 local repeater freqs.
Pass: when one is active, audio plays through the HDMI display, and the dashboard
"Now Playing" shows the right frequency + tag within ~1s; the log grows.

## B5 — Volume/mute live
Move the volume slider and toggle mute in admin. Pass: audio responds without the
scan stopping or the dashboard resetting.

## B6 — Dongle loss + recovery
Unplug the dongle. Pass: dashboard shows an error within a few seconds. Replug.
Pass: it recovers and resumes scanning without a manual restart.

## B7 — Reboot persistence
Reboot. Pass: comes back scanning the saved channel list with no manual steps.

Record pass/fail for B1-B7. All seven passing = v1 success criteria met.
```

- [ ] **Step 3: Commit**

```bash
git add kiosk/README.md kiosk/bench/README.md
git commit -m "docs(kiosk): README and hardware bench protocol"
```

---

## Task 19: Full suite green + final integration check

**Files:** none (verification only)

- [ ] **Step 1: Run the entire test suite**

Run: `cd kiosk && npx vitest run`
Expected: ALL tests pass across schema, ConfigStore, activityLog, FakeEngine, stderrParser, RtlFmEngine, audio, ws, api, wsClient, dashboardState, adminForm.

- [ ] **Step 2: Full build**

Run: `cd kiosk && npm run build`
Expected: `dist/frontend/` and `dist/backend/` both produced, no TS errors.

- [ ] **Step 3: End-to-end smoke with the fake engine**

Run:
```sh
cd kiosk
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc-e2e.json KERCHUNK_STATIC=dist/frontend PORT=8088 node dist/backend/index.js &
sleep 1
curl -s localhost:8088/api/status
curl -s -X POST localhost:8088/api/channels -H 'content-type: application/json' -d '{"freq":145130000,"alphaTag":"KC0KW","mode":"nfm","enabled":true}'
curl -s localhost:8088/api/channels
kill %1
```
Expected: status JSON shows `"state":"running"`; the POST returns a channel with an `id`; the GET lists one channel.

- [ ] **Step 4: Final commit (if any wiring fixes were needed)**

```bash
git add -A kiosk
git commit -m "test(kiosk): full suite green; e2e smoke with fake engine" || echo "nothing to commit"
```

---

## Notes on what is deliberately NOT here (deferred to v2, per spec)

Parallel multi-channel monitoring (`kerchunk-rxd`), spectrum/waterfall, P25,
RepeaterBook CSV import, web admin auth, persistent disk logging, OTA updates, and
multi-audio-sink switching beyond HDMI. The `ScannerEngine` interface is the seam
the parallel engine plugs into; the `audioSink` config field already anticipates
multiple sinks.
