# CI + Self-Hosted Deploy — Design

**Date:** 2026-06-03
**Status:** Approved (pending spec review)

## Goal

1. **CI** on every pull request and push to `main`: typecheck, test, and build the
   `kiosk/` app on a GitHub-hosted Linux runner.
2. **Deploy**: after `main` advances and CI passes, a GitHub Actions self-hosted
   runner *on the Pi* (`admin@kerchunk-kiosk.local`) pulls that commit into
   `~/kerchunk-kiosk`, builds it, installs to `/opt/kerchunk-kiosk`, and restarts
   the kerchunk systemd services.

## Context / constraints discovered

- The app lives in `kiosk/` — TypeScript, Vite frontend + `tsc` backend, Vitest
  tests (13 files). `engines.node >= 20`. No ESLint/Prettier in the repo.
- Tests are **hermetic**: they use checked-in shell-script fakes
  (`kiosk/test/fakes/fake-rtl_fm-*.sh`) instead of real SDR hardware. They need
  only `bash`, which `ubuntu-latest` provides. No RTL-SDR dongle required in CI.
- The Pi at `kerchunk-kiosk.local` is on the LAN — **not reachable from a
  GitHub-hosted runner**. Deploy must run on a runner that lives on the Pi.
- The real install model (from `kiosk/scripts/setup-kiosk-pi.sh`) is:
  build the repo, then **copy `dist` + `package.json` + `node_modules` to
  `/opt/kerchunk-kiosk`**, `chown kerchunk:kerchunk`. The systemd unit runs
  `User=kerchunk`, `WorkingDirectory=/opt/kerchunk-kiosk`,
  `ExecStart=/usr/bin/node /opt/kerchunk-kiosk/dist/backend/index.js`.
  The repo clone itself can live anywhere; the user named `~/kerchunk-kiosk`.

## Decisions

| Question | Decision |
|---|---|
| Deploy trigger | GitHub Actions **self-hosted runner on the Pi** |
| What deploy does | **Pull + build + restart services** (full hands-off deploy) |
| Reconcile `~/kerchunk-kiosk` vs `/opt` | **Runner work dir IS `~/kerchunk-kiosk`**; build there, install to `/opt` |
| Deploy on | **Any push to `main`** (CI-gated), not just merged PRs |
| Sudo scope | **Tightly scoped** sudoers.d entry, least privilege |

## Architecture

```
PR opened/updated ──► ci.yml (ubuntu-latest) ──► npm ci · tsc · vitest · vite build
                                                   │
push to main ───────► ci.yml runs again ──────────┘
                          │ (conclusion == success, head_branch == main)
                          ▼
                     deploy.yml (workflow_run → self-hosted on the Pi)
                          └─► build in ~/kerchunk-kiosk ─► install to /opt ─► restart units
```

**Two workflows, not one gated job.** A single workflow with `deploy: needs: ci`
would make the deploy job wait on (or queue against) the Pi runner even for
pull-request events, where we never deploy — and fork PRs could land on the Pi.
Splitting them keeps the Pi entirely out of the PR path: CI runs on every
PR/push event; deploy is keyed off `workflow_run` success on `main` only.

## Components

### 1. `.github/workflows/ci.yml`
- **Triggers:** `pull_request` → `main`; `push` → `main`.
- **Runs-on:** `ubuntu-latest`.
- **`name: CI`** (the deploy workflow references this name in `workflow_run`).
- **Steps** (all `working-directory: kiosk`):
  1. `actions/checkout@v4`
  2. `actions/setup-node@v4` — `node-version: 20`, `cache: npm`,
     `cache-dependency-path: kiosk/package-lock.json`
  3. `npm ci`
  4. `npm run build:backend`  *(this is `tsc -p tsconfig.json` — our typecheck)*
  5. `npm test`  *(`vitest run`)*
  6. `npm run build:frontend`  *(`vite build`)*
- **Concurrency:** `group: ci-${{ github.ref }}`, `cancel-in-progress: true`
  so rapid pushes to the same ref don't pile up.

### 2. `.github/workflows/deploy.yml`
- **Trigger:** `workflow_run` on workflow `CI`, `types: [completed]`.
- **Job guard:**
  `if: github.event.workflow_run.conclusion == 'success' && github.event.workflow_run.head_branch == 'main'`
- **Runs-on:** `[self-hosted, kerchunk-kiosk]`.
- **Checkout:** `actions/checkout@v4` with
  `ref: ${{ github.event.workflow_run.head_sha }}` — deploys exactly the commit
  CI validated. The runner's work dir is configured to be `~/kerchunk-kiosk`
  (set at runner registration), so the checkout lands there.
- **Deploy step:** `run: bash kiosk/scripts/deploy-pi.sh`
- **Concurrency:** `group: deploy-pi`, `cancel-in-progress: false` — never
  interrupt a half-finished install; deploys serialize.

### 3. `kiosk/scripts/deploy-pi.sh`
Checked-in, idempotent, `set -euo pipefail`. Mirrors the *install half* of
`setup-kiosk-pi.sh` so deploy logic isn't duplicated in YAML and can be run by
hand. Steps:
1. Resolve `REPO_DIR` (the `kiosk/` dir) from the script's own location.
2. `npm ci && npm run build` in `REPO_DIR` — **build before touching `/opt`**,
   so a broken build never corrupts the live install.
3. Install to `/opt/kerchunk-kiosk`: `sudo rsync -a --delete` each of `dist/`
   and `node_modules/` (so removed files/deps don't linger across deploys),
   `sudo cp package.json`, then `sudo chown -R kerchunk:kerchunk
   /opt/kerchunk-kiosk`. `setup-kiosk-pi.sh` uses `cp -r`; the deploy uses
   `rsync --delete` because it is updating an *existing* install in place, where
   stale files matter. (`rsync` is preinstalled on RPi OS.)
4. `sudo systemctl restart kerchunk-kiosk.service kerchunk-display.service`
   **last**, only after a successful install.

*Optional follow-up (not in this scope):* have `setup-kiosk-pi.sh` source
`deploy-pi.sh` for its install block, giving one install path. Noted, deferred.

## Pi-side prerequisites (one-time manual ops — documented, not automated)

These run on the Pi as `admin`; they involve a registration secret and root
config, so they are not automated by this change. The spec/plan will include
exact commands.

1. **Register the self-hosted runner** (`actions/runner`) as `admin`, with:
   - work directory = `~/kerchunk-kiosk` (so checkout lands there),
   - label `kerchunk-kiosk`,
   - installed via `svc.sh install && svc.sh start` so it survives reboots.
   - Registration token from repo → Settings → Actions → Runners (user obtains).
2. **Tightly-scoped passwordless sudo** — `/etc/sudoers.d/kerchunk-deploy`
   granting `admin` NOPASSWD for *only*:
   - the `cp`/`chown` into `/opt/kerchunk-kiosk`, and
   - `systemctl restart kerchunk-kiosk.service` / `kerchunk-display.service`.
   Not blanket NOPASSWD. Validated with `visudo -c`.

## Error handling

- `deploy-pi.sh` uses `set -euo pipefail`; any failed step fails the job.
- Build happens in `~/kerchunk-kiosk` **before** `/opt` is touched — a failed
  build leaves the previous `/opt` install running untouched.
- Services restart only at the very end, after a successful install.
- The `workflow_run` success gate means a red CI never triggers a deploy.

## Testing / verification

- **CI:** open a PR; confirm `ci.yml` is green on `ubuntu-latest` (typecheck +
  13 Vitest files + both builds).
- **Deploy:** not exercisable from the dev machine. Manual checklist after the
  runner is registered:
  1. Merge a PR (or push) to `main`.
  2. `deploy.yml` appears under Actions, running on `[self-hosted]`.
  3. Job ends green; `/opt/kerchunk-kiosk/dist` reflects the new commit.
  4. `systemctl is-active kerchunk-kiosk.service kerchunk-display.service` →
     `active` for both.

## Out of scope

- `firmware/` ESP-IDF build artifacts (`.gitignore` already excludes them).
- Linting/formatting (none configured; not introducing it here).
- Secrets management beyond the runner registration token the user generates.
