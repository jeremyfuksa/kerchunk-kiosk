# CLAUDE.md

Guidance for working in this repo. The READMEs cover *what* Kerchunk is and how
to run it — read [`README.md`](README.md) and [`kiosk/README.md`](kiosk/README.md)
first. This file is the *how to change it* layer: the conventions and gotchas
that are easy to get wrong.

## What you're standing on

Kerchunk is an SDR scanner **appliance**: a lid-closed Ubuntu 26.04 laptop
(i7-4770HQ MacBook Pro), RTL-SDR dongles, and a persistent GNU Radio flowgraph
that demodulates every channel in a ~2 MHz window at once. Stack: TypeScript
(Node ≥24, ESM) backend + vanilla-TS/Vite frontends, a Python DSP helper under
GNU Radio, zod-validated config, systemd. **No frontend framework — vanilla TS
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
npm run test:py          # DSP-math tests — runs /usr/bin/python3 (system python)
npm run build            # build:frontend (vite) + build:backend (tsc + copy helpers)
npx tsc -p tsconfig.json --noEmit   # typecheck; vite does NOT typecheck (see below)
npm run dev:frontend     # vite dev server, proxies /api + /ws to :8080
USE_FAKE_ENGINE=1 KERCHUNK_CONFIG=/tmp/kc.json npm run dev:backend
```

## Deploy & restart discipline

Full deploy on the appliance:
`git pull && (cd kiosk && npm run build) && sudo systemctl restart kerchunk-kiosk`
(`sudo` is passwordless here). But **only restart the service for backend
changes** — every restart respawns the GNU Radio helper (~2.7 cores of
flowgraph rebuild), spikes thermals, and interrupts live audio.

- **Frontend-only change:** `npm run build` (or at least `build:frontend` +
  `npx tsc --noEmit` — vite/esbuild does no type checking, and a type error
  once shipped silently and killed the kiosk map), then
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
- **`build:backend` is more than `tsc`.** It also copies
  `src/backend/engine/wideband_helper.py` *and* `wideband_dsp_math.py` into
  `dist/`. The DSP helpers are not TypeScript and won't be emitted by the
  compiler — run the npm script, not bare `tsc`.
- **GNU Radio needs the system python** (`/usr/bin/python3`), not a
  pyenv/mise interpreter — the bindings aren't visible elsewhere. Squelch
  tuning knobs live at the top of `wideband_helper.py`.
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
  break-in re-points the live flowgraph; a restart replays the warm-up
  overlay, chops audio, and wipes the alert banner.
- **The `breakIn` guard in `server.ts` stays.** While a break-in holds the
  scanner on NWR, safetyMode logs temperature but must not bounce the engine —
  the restart cold-start spikes *caused* the overheating oscillation it tried
  to cure.
- **The weather helper runs at `niceness: 19`.** At equal priority its ~300 GR
  threads starve the scanner's audio thread and the live repeater sounds
  choppy. Any additional radio helper gets niced down too.
- **WirePlumber is disabled on the scanner's audio card.**
  `kiosk/systemd/wireplumber-kerchunk-scanner-card.conf` (installed to
  `/etc/wireplumber/wireplumber.conf.d/`) sets `device.disabled` on the PCH
  card. Without it PipeWire claims the card at login — winning the boot race
  while the helper is still building its flowgraph — and writes its default
  route volume (0.064 → −23.5 dB) over the ALSA `Master` control the backend
  owns, so the admin volume slider and the hardware disagree after every boot.
- **The engine must always drain the helper's fd-3 audio tee** (feeds
  `/api/stream.wav`) or the helper blocks.
- **Wideband hold-through is capped** (PR #194) so a stuck-open lane can't
  park the scanner on one window forever.
- **No `backdrop-filter` blur or full-screen overlays above the animating
  map** — measured +6 °C.

## Verifying changes

- **Logic:** `npm test` (and `npm run test:py` when touching the DSP math).
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

1. `npm test` passes (and `test:py` if DSP math changed).
2. `npx tsc -p tsconfig.json --noEmit` is clean (vite won't catch it).
3. Full `npm run build` succeeds.
4. Proven on hardware per "Verifying changes" (or explicitly flagged as
   awaiting on-hardware proof, in the off-machine flow).
5. Behavior knobs are exposed in config, not hardcoded, and their location is
   stated.
6. PR opened from a branch; after merge, the branch is deleted and pruned.

What CI actually runs (`.github/workflows/ci.yml`, every PR and push to
`main`, GitHub-hosted Linux): `npm ci`, `npm run build:backend` (this is the
typecheck — `tsc` plus the helper copies), `npm test` (vitest), and
`npm run build:frontend`. It does **not** run `test:py` (needs numpy on the
system python) and never touches hardware — so 1's `test:py` and 4 remain on
you even with green checks.

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
  Close Call suppression.
- **Lane-fit DSP.** The helper sizes its channelizer to the config and builds
  only each lane's needed demod path (`engine/lanePlan.ts` — assignment is
  positional, background channels pin to the last lane). Power detection is
  switchable via `config.scan.detectVia: "lane" | "fft"` (default lane;
  passed to the helper as `--detect-via`).
- **Two engine instances can run at once:** the scanner (serial KIOSK01) and a
  low-rate (240 kHz) decode-only weather monitor (KIOSK03) watching NWR for
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
  `KERCHUNK_ENGINE`, `USE_FAKE_ENGINE`.
- Deploy details (incl. the legacy SSH-to-Pi flow): [`docs/DEPLOY.md`](docs/DEPLOY.md).
