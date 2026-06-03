# CI + Script-Based Deploy — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## Goal

1. **CI** on every pull request and push to `main`: typecheck, test, and build the
   `kiosk/` app on a GitHub-hosted Linux runner.
2. **Deploy**: a local script, run from the dev Mac (same LAN as the Pi), that
   SSHes to `admin@192.168.1.54`, updates the `~/kerchunk-kiosk` clone to
   `origin/main`, builds it, installs to `/opt/kerchunk-kiosk`, and restarts the
   kerchunk systemd services.
3. **Auto-deploy hook**: a per-repo `post-merge` hook so the deploy fires
   automatically after a `git pull` that advances local `main` — without
   breaking the existing global branch-prune hook.

## Context / constraints discovered (verified live)

- The app lives in `kiosk/` — TypeScript, Vite frontend + `tsc` backend, Vitest
  tests (13 files). `engines.node >= 20`. No ESLint/Prettier in the repo.
- Tests are **hermetic**: checked-in shell-script fakes
  (`kiosk/test/fakes/fake-rtl_fm-*.sh`) replace SDR hardware; they need only
  `bash`, which `ubuntu-latest` has. No dongle required in CI.
- **SSH to the Pi works today**: `ssh admin@192.168.1.54` succeeds passwordless
  (key-based, `BatchMode`), hostname `kerchunk-kiosk`, user `admin`.
- **Both target dirs already exist on the Pi**: `~/kerchunk-kiosk` (a clone) and
  `/opt/kerchunk-kiosk` (the live install). So deploy is an *update in place*,
  not first-time provisioning — no `setup-kiosk-pi.sh` rerun.
- Install model (from `kiosk/scripts/setup-kiosk-pi.sh`): build the repo, then
  copy `dist` + `package.json` + `node_modules` to `/opt/kerchunk-kiosk`,
  `chown kerchunk:kerchunk`. systemd unit: `User=kerchunk`,
  `WorkingDirectory=/opt/kerchunk-kiosk`,
  `ExecStart=/usr/bin/node /opt/kerchunk-kiosk/dist/backend/index.js`.
- **Global git hook collision**: `core.hooksPath` is globally set to
  `~/.config/git/hooks`, so Git ignores any repo-local `.git/hooks/`. The
  existing global `post-merge` prunes merged branches, only acts on
  `main`/`master`, respects `git config hook.auto-prune-branches`, runs
  `set -euo pipefail`, and ends `exit 0`.

## Decisions

| Question | Decision |
|---|---|
| CI | **Keep it** — GitHub Actions on PRs + push to `main` |
| Deploy mechanism | **Local script over SSH**, not a self-hosted runner |
| Pi address | **`192.168.1.54`** (default; overridable via env var) |
| What deploys | **`origin/main`** — the Pi `git fetch`es and resets to it |
| Auto-deploy | **Per-repo `post-merge` hook** that also chains the global hook |
| Hook safety | Acts **only when local `main` advanced**; deploy runs **async/non-blocking** so `git pull` never hangs on the Pi |

## Architecture

```
                 ┌─ GitHub Actions (cloud) ─┐
PR / push main ─►│  ci.yml: npm ci · tsc ·   │  ← validation gate, runs even
                 │  vitest · vite build      │    when you forget to test
                 └───────────────────────────┘

dev Mac ── deploy.sh ──SSH──► admin@192.168.1.54
                                 │ cd ~/kerchunk-kiosk
                                 │ git fetch && git reset --hard origin/main
                                 │ (cd kiosk && npm ci && npm run build)
                                 │ rsync dist/ node_modules/ + cp package.json → /opt
                                 │ chown -R kerchunk:kerchunk /opt/kerchunk-kiosk
                                 └ systemctl restart kerchunk-kiosk + kerchunk-display

git pull (main advances) ─► .githooks/post-merge ─► global prune hook, then
                                                     deploy.sh in background
```

CI and deploy are **independent**: CI validates in the cloud; deploy is a
local action you (or the hook) trigger. They don't gate each other — a solo,
same-LAN workflow doesn't need the cloud to reach the Pi.

## Components

### 1. `.github/workflows/ci.yml`
- **Triggers:** `pull_request` → `main`; `push` → `main`.
- **Runs-on:** `ubuntu-latest`.
- **Steps** (all `working-directory: kiosk`):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` — `node-version: 20`, `cache: npm`,
     `cache-dependency-path: kiosk/package-lock.json`
  3. `npm ci`
  4. `npm run build:backend`  *(`tsc -p tsconfig.json` — typecheck)*
  5. `npm test`  *(`vitest run`)*
  6. `npm run build:frontend`  *(`vite build`)*
- **Concurrency:** `group: ci-${{ github.ref }}`, `cancel-in-progress: true`.

### 2. `kiosk/scripts/deploy.sh`
Run from the dev Mac. `set -euo pipefail`. Idempotent (updates existing dirs).

- **Config:** `PI_HOST="${KERCHUNK_PI_HOST:-admin@192.168.1.54}"` — IP is the
  default, overridable via env var (e.g. to use `.local` or a different host).
- **Preflight (local):** confirm SSH reachability with a short `ConnectTimeout`;
  fail fast with a clear message if the Pi is offline.
- **Remote work** (one SSH invocation running a heredoc'd `bash -euo pipefail`
  on the Pi):
  1. `cd ~/kerchunk-kiosk`
  2. `git fetch origin && git reset --hard origin/main`  *(deploy exactly
     what's merged; discard any drift in the Pi clone)*
  3. `cd kiosk && npm ci && npm run build`  *(build BEFORE touching `/opt`)*
  4. Install to `/opt/kerchunk-kiosk`:
     `sudo rsync -a --delete dist/ /opt/kerchunk-kiosk/dist/`,
     `sudo rsync -a --delete node_modules/ /opt/kerchunk-kiosk/node_modules/`,
     `sudo cp package.json /opt/kerchunk-kiosk/`,
     `sudo chown -R kerchunk:kerchunk /opt/kerchunk-kiosk`.
     (`rsync --delete` because we update an *existing* install — stale files
     must go. `rsync` is preinstalled on RPi OS.)
  5. `sudo systemctl restart kerchunk-kiosk.service kerchunk-display.service`
     **last**, only after a successful install.
- **Output:** prints the deployed commit (`git rev-parse --short HEAD`) and the
  post-restart `systemctl is-active` of both units.

### 3. `.githooks/post-merge` + per-repo `core.hooksPath`
Because the global `core.hooksPath` shadows `.git/hooks/`, wire auto-deploy via
a **repo-scoped** hooks dir so the global hook is untouched everywhere else.

- **One-time:** `git config core.hooksPath .githooks` (local to this repo only).
- **`.githooks/post-merge`** (`set -euo pipefail`):
  1. **Chain the global hook first** so branch-pruning still works:
     run `~/.config/git/hooks/post-merge` by absolute path if it exists and is
     executable (its own `hook.auto-prune-branches` opt-out still applies).
  2. **Deploy guard:** only proceed if the current branch is `main`. Use
     `ORIG_HEAD` (which `git pull`/`merge` set to the pre-merge tip) to detect
     advancement: if `ORIG_HEAD` is unset or equals `HEAD` (no new commits),
     exit 0. This mirrors how the global prune hook scopes itself to `main`.
  3. **Opt-out:** respect `git config hook.kerchunk-deploy` (default on); set
     `false` to disable auto-deploy without removing the hook.
  4. **Fire deploy non-blocking:** launch `kiosk/scripts/deploy.sh` detached
     (background + `nohup`, log to a temp file) so `git pull` returns
     immediately and a slow/offline Pi never hangs the pull. Print a one-line
     "deploy started, tailing → <logfile>" notice.

## Pi-side prerequisite (one-time, manual)

Tightly-scoped passwordless sudo for `admin`, since `deploy.sh` runs
`sudo rsync`/`cp`/`chown` into `/opt/kerchunk-kiosk` and `sudo systemctl
restart` the two units. Provide `/etc/sudoers.d/kerchunk-deploy` granting
NOPASSWD for *only* those exact commands (validated with `visudo -c`). Not
blanket NOPASSWD. (SSH key auth already works — verified live.)

## Error handling

- `deploy.sh` and the hook both use `set -euo pipefail`.
- `git reset --hard origin/main` makes the Pi clone deterministic regardless of
  prior state.
- Build runs in `~/kerchunk-kiosk` **before** `/opt` is touched — a failed build
  leaves the previous `/opt` install and running services untouched.
- Services restart only at the very end, after a successful install.
- Hook deploy is non-blocking and guarded to `main`-advanced only, so normal
  feature-branch pulls and an offline Pi never disrupt `git pull`.

## Testing / verification

- **CI:** open a PR; confirm `ci.yml` is green on `ubuntu-latest` (typecheck +
  13 Vitest files + both builds).
- **Deploy script:** run `./kiosk/scripts/deploy.sh` manually; confirm it ends
  green, `/opt/kerchunk-kiosk/dist` reflects the deployed commit, and
  `systemctl is-active kerchunk-kiosk.service kerchunk-display.service` → both
  `active`.
- **Hook:** with the per-repo `core.hooksPath` set, do a `git pull` that
  advances `main`; confirm (a) merged branches still get pruned (global hook
  ran) and (b) a deploy kicks off in the background. Confirm a feature-branch
  pull does NOT deploy.

## Out of scope

- `firmware/` ESP-IDF build artifacts (`.gitignore` already excludes them).
- Linting/formatting (none configured; not introducing it here).
- First-time Pi provisioning (`setup-kiosk-pi.sh` already covers it; both target
  dirs exist).
