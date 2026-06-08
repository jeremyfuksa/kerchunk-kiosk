# CLAUDE.md

Guidance for working in this repo. The READMEs cover *what* Kerchunk is and how
to run it — read [`README.md`](README.md) and [`kiosk/README.md`](kiosk/README.md)
first. This file is the *how to change it* layer: the conventions and gotchas
that are easy to get wrong.

## Where the code is

All application code, tests, and commands live under **`kiosk/`** — `cd kiosk`
before running anything. The repo root holds only docs, bench notes, and this file.

## Commands (from `kiosk/`)

```sh
npm test                 # vitest, no hardware needed (FakeEngine + fake helper)
npm run build            # build:frontend (vite) + build:backend (tsc + copy helper)
npm run dev:frontend     # vite dev server, proxies /api + /ws to :8080
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
```

Deploy on the appliance: `git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk`.

## Conventions that bite

- **ESM, `.js` import extensions.** `package.json` is `"type": "module"` (Node
  ≥24). Relative imports must carry the `.js` extension even from `.ts` source
  (`import { createServer } from "./server.js"`). Omitting it breaks the build.
- **`tsconfig` is `strict` + `noUncheckedIndexedAccess`.** Indexed access
  (`arr[i]`, `map[key]`) is typed `T | undefined`; handle the undefined case.
- **`build:backend` is more than `tsc`.** It also copies
  `src/backend/engine/wideband_helper.py` into `dist/`. The DSP helper is not
  TypeScript and won't be emitted by the compiler — run the npm script, not bare `tsc`.
- **GNU Radio needs the system python** (`/usr/bin/python3`), not a
  pyenv/mise interpreter — the bindings aren't visible elsewhere. Squelch
  tuning knobs live at the top of `wideband_helper.py`.

## Architecture notes

- **Engine abstraction.** Everything runs behind the `ScannerEngine` interface
  (`src/backend/engine/`), with three implementations: `WidebandEngine`
  (default, GNU Radio), `RtlFmEngine` (sequential fallback), and `FakeEngine`
  (tests). Selected via `KERCHUNK_ENGINE=wideband|rtlfm|fake`. Because tests use
  `FakeEngine`, the whole suite runs with no SDR attached.
- **The engine never sees banks.** The server resolves per-channel scan
  overrides into a concrete `ScanChannel` before handing config to the engine.
- **Dependency injection.** `createServer(deps: ServerDeps)` takes every
  collaborator (engine, config store, lookups, history, …) as an argument;
  `index.ts` wires the real ones and tests pass fakes.
- **Config is the single source of truth.** `ConfigStore` persists a zod-
  validated shape (`src/backend/config/schema.ts`). The server owns the
  derived `knownHz`/lockout lists (channels + discoveries + lockouts) and
  Close Call suppression. Boot must start the engine through the *same*
  `toScanConfig` path the API uses — a hand-built boot payload once dropped
  `knownHz` and made every reboot re-discover all filed frequencies.

## Other

- Env vars: `PORT` (8080), `KERCHUNK_CONFIG`, `KERCHUNK_STATIC`,
  `KERCHUNK_ENGINE`, `USE_FAKE_ENGINE`.
- Backlog and design decisions: [`docs/ROADMAP.md`](docs/ROADMAP.md); specs in
  `docs/superpowers/specs/`.
