# CLAUDE.md

Guidance for working in this repo. The READMEs cover *what* Kerchunk is and how
to run it — read [`README.md`](README.md) and [`kiosk/README.md`](kiosk/README.md)
first. This file is the *how to change it* layer: the conventions and gotchas
that are easy to get wrong.

## What you're standing on

Kerchunk is an SDR scanner **appliance**: a lid-closed Ubuntu 26.04 laptop
(i7-4770HQ MacBook Pro), RTL-SDR dongles, and a persistent native C++ DSP
helper (`kerchunk-dsp`, `kiosk/native/`) that demodulates every channel in a
~2.4 MHz window at once. Stack: TypeScript (Node ≥24, ESM) backend +
vanilla-TS/Vite frontends, the C++ DSP helper (cmake; librtlsdr, FFTW, ALSA),
zod-validated config, systemd. **No frontend framework — vanilla TS
only.** Icons are `lucide-static` only, never hand-rolled SVG (operator
mandate).

**The dev machine is usually the appliance itself** (`/home/kiosk`). It is a
live radio the operator listens to, and it runs ~1 °C under its 90 °C thermal
safety trip — treat restarts and CPU spikes as real costs, not free actions
(see "Deploy & restart discipline").

## The API has an external consumer

**jeremyfuksa.com polls `/api/status`, `/api/logs`, and `/api/weather` over
the Tailscale tailnet (`http://kiosk:8080`)** — changing those response
shapes breaks a live external site, not just the local frontends. It polls
**sequentially, never in parallel**, because the appliance has been observed
to deadlock on 2+ concurrent requests; don't "optimize" that on either side.
The full HTTP/WS surface is documented in [`docs/API.md`](docs/API.md) —
update it when routes change.

## Git workflow

**Every change ships through a pull request — never commit directly to `main`.**
Branch off `main` (`feat/*`, `fix/*`, `chore/*`, `docs/*`), then push the branch,
open a PR, and merge it on GitHub. `main` is never touched directly. Do not push
commits straight to `main`, and do not fast-forward local work onto `main` to
bypass review.

**Prove on hardware before the PR (the normal flow).** Work usually happens
directly on the kiosk machine, where you can build and deploy locally to prove a
change against real hardware. The order is: branch → build/deploy/prove on the
kiosk → push → PR → merge. The PR comes *after* the change is proven, not before.

**Off-machine is the exception.** When working from another machine (no kiosk
hardware to prove against), there's nothing to deploy locally — go straight to
branch → push → PR → merge and prove it after it lands. If a change has already
landed on local `main` by mistake, move it onto a branch and reset `main` to
`origin/main` before opening the PR.

**Clean up after every merge, without being asked.** Merge with
`gh pr merge <n> --merge --delete-branch`, then
`git checkout main && git pull --ff-only && git fetch --prune` and
`git branch -d <branch>`. A repo-local hook (`.claude/settings.json`,
PostToolUse on `gh pr merge`) also auto-deletes local branches already merged
to `main` — a branch vanishing right after a merge is the hook working, not
data loss.

## Where the code is

All application code, tests, and commands live under **`kiosk/`** — `cd kiosk`
before running anything. The repo root holds docs, bench notes, this file, and
`scripts/setup-pi.sh` — a legacy Pi-era bootstrap that is not used on the
appliance (kept, like `kiosk/scripts/deploy.sh`, for a possible future
Pi-class install; see [`docs/DEPLOY.md`](docs/DEPLOY.md)).

- `kiosk/src/backend/` — server, engines (`engine/`), config (`config/`),
  lookup/identification providers, SAME/weather, aircraft feed.
- `kiosk/src/frontend/` — four surfaces: `dashboard/` (the HDMI kiosk view —
  the fullscreen map *is* the dashboard), `admin/` (web admin from any
  device), `wall/` and `art/` (ambient canvas skins), plus `map/` (shared map
  layers) and `lib/`.
- `kiosk/test/` — vitest suite; `test/fakes/` has the fake engine + helper.
- `kiosk/systemd/`, `kiosk/scripts/` — appliance units and setup scripts.

## Commands (from `kiosk/`)

```sh
npm test                 # vitest, no hardware needed (FakeEngine + fake helper)
npm run test:native      # C++ DSP unit tests — builds native/build/kerchunk-dsp-tests
npm run build            # build:frontend (vite) + build:backend (tsc) + build:native:dist (cmake → dist/backend/engine/kerchunk-dsp)
npm run typecheck        # BOTH tsconfigs; vite does NOT typecheck (see below)
npm run dev:frontend     # vite dev server, proxies /api + /ws to :8080
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
```

`npm run build` also compiles the DSP helper (`build:native:dist`,
`kiosk/native/`) via cmake/C++ at `--parallel 2`. On the appliance that's a
real compile, not just `tsc`/`vite` — a thermal cost like any other build. The
binary is installed into `dist/` via temp file + `mv`, so rebuilding under a
running helper is safe.

## Deploy & restart discipline

Full deploy on the appliance:
`git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk`
(`sudo` is passwordless here). But **only restart the service for backend
changes** — the native helper restarts cheaply (well under a core, no
multi-second graph build), but every restart still interrupts live audio and
replays the warm-up overlay on the wall.

- **Frontend-only change:** `npm run build` (or at least `build:frontend` +
  `npm run typecheck` — vite/esbuild does no type checking, and a type error
  once shipped silently and killed the kiosk map. Use the npm script, not a
  bare `tsc -p tsconfig.json`: that config emits and covers only `src/backend`
  + `src/frontend/lib`, so for years it did **not** check admin, dashboard,
  wall, art or map — the exact surfaces that lesson was about. `typecheck`
  runs it plus `tsconfig.frontend.json`, which covers the rest. #224), then
  `curl -X POST localhost:8080/api/kiosk/reload` to refresh the wall page. A
  reload POST right after a backend restart can race the WS reconnect — wait
  a beat or re-send.
- **Two services.** `kerchunk-kiosk` is the backend; `kerchunk-display` is the
  chromium wall session. If the wall page wedges/goes stale (it can after
  repeated restarts or a thermal spike), `sudo systemctl restart
  kerchunk-display` — don't bounce the backend for a frozen page.
- **Hand-editing `config.json`:** stop `kerchunk-kiosk` first, or the running
  server will clobber your edit on its next persist.
- Config-only changes via `PUT /api/config` — non-scan fields (e.g. `alerts`)
  apply live with no engine restart.

## Conventions that bite

- **ESM, `.js` import extensions.** `package.json` is `"type": "module"` (Node
  ≥24). Relative imports must carry the `.js` extension even from `.ts` source
  (`import { createServer } from "./server.js"`). Omitting it breaks the build.
- **`tsconfig` is `strict` + `noUncheckedIndexedAccess`.** Indexed access
  (`arr[i]`, `map[key]`) is typed `T | undefined`; handle the undefined case.
- **The DSP helper is not TypeScript.** `kerchunk-dsp` is built by
  `build:native:dist` (part of `npm run build`), not `tsc` — a bare
  `build:backend` leaves `dist/` without (or with a stale) helper. Squelch
  defaults live in `kiosk/native/src/constants.hpp`; the operator-facing
  knobs are `config.scan.nativeQuietDb` (`--quiet-db`) and
  `config.scan.nativeAmGainDb` (`--am-gain-db`, the AM pre-gain into the AGC),
  `config.scan.fmAudioLpfHz` (`--audio-lpf-hz`, FM weak-signal hiss),
  `config.scan.fmAudioHpfHz` (`--audio-hpf-hz`, CTCSS hum; 0 = off).
  Group shape: `config.scan.lanesPerGroup` (`--lanes`, 12, 1…64) and
  `config.scan.sampleRateHz` (`--rate`, 2 400 000, 900k…3.2M in 50 kHz steps)
  with `windowBandwidthHz` (2 MHz, ≤ rate − 50 kHz — schema-enforced).
  Speaker loudness is a per-transmission AGC + peak limiter in the helper
  (the per-channel `levelTrimDb` learner is gone; old configs strip it):
  `config.audio.agcTargetDb` (−18) / `agcMaxGainDb` (15) / `agcMinGainDb`
  (−20) / `agcAttackMs` (10) / `agcReleaseMs` (400) / `agcHoldBelowDb` (−50)
  / `limiterCeiling` (0.7) / `limiterReleaseMs` (50) → `--agc-*` /
  `--limiter-*`, scanner helper only. Changing one via `PUT /api/config`
  respawns only the scanner helper; volume/mute stay live.
- **ALSA is addressed by name** (`plughw:CARD=PCH,DEV=0`) — card indices swap
  across boots. The sink is exclusive (no dmix): exactly one process owns
  audio.
- **SDRs are addressed by EEPROM serial** (`radios[].serial`, e.g. KIOSK01 =
  scan, KIOSK03 = weather; `port` is the fallback). Don't resurrect
  devnum/index addressing — it enumerated non-deterministically.

## Do-not-undo invariants

Hard-won fixes that look like cleanup targets. Each one broke in production;
do not "simplify" them away:

- **Boot goes through `toScanConfig`.** Boot must start the engine through the
  *same* `toScanConfig` path the API uses — a hand-built boot payload once
  dropped `knownHz` and made every reboot re-discover all filed frequencies.
- **SAME break-in is a `retune()`, never `stop()+start()`.** The weather
  break-in re-points the live helper; a restart replays the warm-up
  overlay, chops audio, and wipes the alert banner.
- **The `breakIn` guard in `server.ts` stays.** While a break-in holds the
  scanner on NWR, safetyMode logs temperature but must not bounce the engine —
  the restart cold-start spikes *caused* the overheating oscillation it tried
  to cure.
- **The weather helper runs at `niceness: 19`** — keep the scanner's audio
  thread first. At equal priority a second helper competed with it and the
  live repeater sounded choppy. Any additional radio helper gets niced down
  too.
- **WirePlumber is disabled on the scanner's audio card.**
  `kiosk/systemd/wireplumber-kerchunk-scanner-card.conf` (installed to
  `/etc/wireplumber/wireplumber.conf.d/`) sets `device.disabled` on the PCH
  card. Without it PipeWire claims the card at login — winning the boot race
  against the backend and its helper — and writes its default
  route volume (0.064 → −23.5 dB) over the ALSA `Master` control the backend
  owns, so the admin volume slider and the hardware disagree after every boot.
- **The engine must always drain the helper's fd-3 audio tee** (feeds
  `/api/stream.wav`) or the helper blocks.
- **Wideband hold-through is capped** (PR #194) so a stuck-open lane can't
  park the scanner on one window forever.
- **No `backdrop-filter` blur or full-screen overlays above the animating
  map** — measured +6 °C.

## Verifying changes

- **Logic:** `npm test` (and `npm run test:native` when touching `kiosk/native/`).
  Unit-test pure accumulator/loop logic headless-safe.
- **Anything audible/RF:** prove it on the live appliance by ear; the operator
  verifies within minutes.
- **Anything visual:** headless chromium verification is a dead end on this
  box (snap confinement blocks CDP; `--virtual-time-budget` stalls `fetch`).
  Instead screenshot the **live** wall:
  `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0 grim /tmp/claude-1000/kiosk.png`
  then Read the PNG. After a new build, restart `kerchunk-display` and wait
  ~12–15 s before capturing.
- **Previewing wall states:** the wall is a passive display — no mouse or
  keyboard. Drive states server-side (e.g. `POST /api/test/alert
  {alphaTag}`; `{clear:true}` dismisses) and cycle variants from a script so
  the operator just watches. Warning-banner styling is scoped under
  `.dash.mapStage` — it only applies when a Google Maps key is configured.

## Definition of done

A change is finished when all of these hold — report each honestly:

1. `npm test` passes, and `npm run test:native` passes (C++ DSP unit tests).
2. `npm run typecheck` is clean (vite won't catch it, and neither tsconfig
   covers the other — the script runs both).
3. Full `npm run build` succeeds.
4. Proven on hardware per "Verifying changes" (or explicitly flagged as
   awaiting on-hardware proof, in the off-machine flow).
5. Behavior knobs are exposed in config, not hardcoded, and their location is
   stated.
6. PR opened from a branch; after merge, the branch is deleted and pruned.

What CI actually runs (`.github/workflows/ci.yml`, every PR and push to
`main`, GitHub-hosted Linux): `npm ci`, `npm run typecheck` (both tsconfigs),
`npm run build:backend` (`tsc` emit), `npm test` (vitest), and
`npm run build:frontend`; a separate job installs the native build deps and
runs `npm run test:native`. CI never touches hardware — so 4 remains on you
even with green checks.

## Architecture notes

- **Engine abstraction.** Everything runs behind the `ScannerEngine` interface
  (`src/backend/engine/`), with three implementations: `WidebandEngine`
  (default; spawns the `kerchunk-dsp` C++ helper), `RtlFmEngine` (sequential
  fallback) and `FakeEngine` (tests). `WidebandEngine` passes `--quiet-db` from
  `scan.nativeQuietDb` (kerchunk-dsp's own dB scale, default −7) and runs
  liveness watchdogs (ready-timeout and silence-timeout) on the helper.
  Selected via `KERCHUNK_ENGINE=wideband|native|rtlfm|fake` — `native` is an
  alias for `wideband` (the appliance's systemd drop-in still sets it). Because tests use `FakeEngine`,
  the whole suite runs with no SDR attached.
- **The engine never sees banks.** The server resolves per-channel scan
  overrides into a concrete `ScanChannel` before handing config to the engine.
- **Dependency injection.** `createServer(deps: ServerDeps)` takes every
  collaborator (engine, config store, lookups, history, …) as an argument;
  `index.ts` wires the real ones and tests pass fakes.
- **Config is the single source of truth.** `ConfigStore` persists a zod-
  validated shape (`src/backend/config/schema.ts`). The server owns the
  derived `knownHz`/lockout lists (channels + discoveries + lockouts) and
  Close Call suppression.
- **Lane slots are a spawn-time knob.** `kerchunk-dsp` builds `--lanes` slots
  at spawn (`scan.lanesPerGroup`, default 12, max 64 = `MAX_LANES` in
  `native/src/constants.hpp`; the background/SAME lane is always the LAST
  slot). The front-end rate is `--rate` (`scan.sampleRateHz`, default 2.4 Msps)
  and the grouping window `scan.windowBandwidthHz` (default 2 MHz, must be ≤
  rate − 50 kHz). Grouping caps groups at the lane count, so a slot's FM/AM
  demod chosen per `tune` always fits (parked slots skip their extract+IFFT):
  channel edits, AM lanes and break-ins `retune()` in place. Respawns: an
  emptied channel set (to release the SDR), or a change to the lane count or
  rate. The weather helper pins 2 lanes at 250 kHz (`index.ts`).
- **Two engine instances can run at once:** the scanner (serial KIOSK01) and a
  low-rate (250 kHz) decode-only weather monitor (KIOSK03) watching NWR for
  SAME. Both share one antenna via a splitter; only the scanner owns audio.
  Roles bind in `config.radios` (`scan`/`weather`/`adsb`). During a SAME
  break-in, EOM (`NNNN`) resumes scanning after an 8 s grace window
  (`server.ts`), ending the alert hold early when the broadcast stops.
- **Remote listening is a gate, not just a route.** `/api/stream.wav` 404s
  unless `config.audio.remoteListening` is true, and the helper only builds
  its `--audio-fd` PCM tee when it's on — flipping the flag is an engine
  restart, not just an API change.
- **Identification chain** for naming discoveries: RepeaterBook (dormant,
  token pending) → MyGMRS → RadioReference → FccProx → BusinessGuess (Google
  Places, deliberately last — it only guesses when the authoritative
  providers come up empty); later providers merge in missing location data. Every
  lookup secret — `config.lookup.apiToken`, `radioReference` credentials,
  `config.display.placesApiKey` — lives in the appliance's config file
  (`config/schema.ts`), **not** env vars and never the repo.

## Product direction

- **Backlog and design decisions live in [`docs/ROADMAP.md`](docs/ROADMAP.md)**
  — the single source of truth for what to build; specs in
  `docs/superpowers/specs/`. Consult it before proposing anything.
- The operator's style is **tighten-before-expand**: don't pitch new features
  or re-pitch explicitly tabled ideas (e.g. more SDR hardware) unprompted.
  Small PRs, merged fast, tested by ear within minutes.
- UI structure/visual work must be *designed, not rearranged* — use the design
  skills and a brainstorm → mockups → pick flow for new surfaces.

## Other

- Env vars: `PORT` (8080), `KERCHUNK_CONFIG`, `KERCHUNK_STATIC`,
  `KERCHUNK_ENGINE=wideband|native|rtlfm|fake`, `USE_FAKE_ENGINE`.
- Deploy details (incl. the legacy SSH-to-Pi flow): [`docs/DEPLOY.md`](docs/DEPLOY.md).
