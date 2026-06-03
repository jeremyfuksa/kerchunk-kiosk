# CI + Script-Based Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add GitHub Actions CI (typecheck/test/build) for the `kiosk/` app, plus a local `deploy.sh` that SSHes to the Pi and a per-repo `post-merge` hook that auto-deploys when `main` advances.

**Architecture:** CI runs in the cloud on `ubuntu-latest` on every PR and push to `main`. Deploy is a local script run from the dev Mac that SSHes to `admin@192.168.1.54`, resets the Pi clone to `origin/main`, builds, installs to `/opt/kerchunk-kiosk`, and restarts the two systemd units. A repo-scoped `core.hooksPath` points at `.githooks/`, whose `post-merge` chains the existing global branch-prune hook and then fires the deploy in the background.

**Tech Stack:** GitHub Actions, Node 20, npm, Vitest, Vite, `tsc`, bash, ssh, rsync, systemd.

---

## Verified environment facts (do not re-litigate)

These were confirmed live against the Pi at `192.168.1.54` on 2026-06-03:

- SSH `admin@192.168.1.54` works passwordless (key-based).
- `admin` **already has passwordless sudo** (`sudo -n true` succeeds) — so **no
  sudoers.d setup task is needed**. The deploy's `sudo` calls just work.
- Pi clone: `/home/admin/kerchunk-kiosk`, on branch `main`, remote `origin` =
  `https://github.com/jeremyfuksa/kerchunk-kiosk`. `kiosk/package.json` present.
- Live install `/opt/kerchunk-kiosk` contains exactly `dist/`, `node_modules/`,
  `package.json`, owned `kerchunk:kerchunk`.
- Pi has `/usr/bin/node` v20.20.2, `/usr/bin/rsync`, git 2.47.3.
- systemd units: `kerchunk-kiosk.service`, `kerchunk-display.service` (both enabled).
- Dev-Mac global git config: `core.hooksPath = ~/.config/git/hooks`; that dir's
  `post-merge` prunes merged branches, only acts on `main`/`master`, respects
  `git config hook.auto-prune-branches`, runs `set -euo pipefail`, ends `exit 0`.

## File Structure

- **Create** `.github/workflows/ci.yml` — CI workflow (PRs + push to main).
- **Create** `kiosk/scripts/deploy.sh` — local SSH deploy script.
- **Create** `.githooks/post-merge` — repo-scoped auto-deploy hook (chains global hook).
- **Create** `docs/DEPLOY.md` — short operator doc: how to deploy, how the hook works, opt-out.
- **One-time config (documented, run once):** `git config core.hooksPath .githooks`.

No application code changes. All work is CI/ops tooling.

---

## Task 1: CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`

CI cannot be unit-tested locally the way code can; the "test" is that the YAML is
valid and the steps mirror the local build/test commands. We validate by (a) a
local dry-run of the same npm commands, then (b) confirming the run is green on a
pushed branch.

- [ ] **Step 1: Verify the underlying commands pass locally (this is the test)**

Run:
```bash
cd kiosk && npm ci && npm run build:backend && npm test && npm run build:frontend
```
Expected: all four succeed — `tsc` exits 0, Vitest reports all files passing
(13 test files), `vite build` writes `dist/`. If anything fails, STOP — CI would
fail too; fix the project before wiring CI.

- [ ] **Step 2: Create the workflow**

Create `.github/workflows/ci.yml`:
```yaml
name: CI

on:
  pull_request:
    branches: [main]
  push:
    branches: [main]

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  build-and-test:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: kiosk
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: kiosk/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Typecheck (tsc)
        run: npm run build:backend

      - name: Test (vitest)
        run: npm test

      - name: Build frontend (vite)
        run: npm run build:frontend
```

- [ ] **Step 3: Validate the YAML parses**

Run (from repo root):
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"
```
Expected: `YAML OK`

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: add GitHub Actions workflow (typecheck, test, build)"
```

- [ ] **Step 5: Push a branch and confirm CI is green**

```bash
git push -u origin HEAD
```
Then open a PR (or view the Actions tab) and confirm the `CI` workflow runs and
passes. Expected: green check on all four steps. (This is the real verification;
do it before relying on the hook.)

---

## Task 2: Deploy script

**Files:**
- Create: `kiosk/scripts/deploy.sh`

This script runs on the **dev Mac** and drives the Pi over SSH. It is idempotent:
it resets the Pi clone to `origin/main` every run, so prior state never matters.

- [ ] **Step 1: Create the script**

Create `kiosk/scripts/deploy.sh`:
```bash
#!/usr/bin/env bash
#
# Deploy the current origin/main to the Kerchunk Kiosk Pi.
#
# Run from the dev Mac (same LAN as the Pi). SSHes in, resets the Pi's repo
# clone to origin/main, builds, installs to /opt/kerchunk-kiosk, and restarts
# the systemd units. Idempotent: it hard-resets the Pi clone every run.
#
# Override the target with KERCHUNK_PI_HOST (default admin@192.168.1.54), e.g.
#   KERCHUNK_PI_HOST=admin@kerchunk-kiosk.local ./kiosk/scripts/deploy.sh
#
set -euo pipefail

PI_HOST="${KERCHUNK_PI_HOST:-admin@192.168.1.54}"
PI_REPO="${KERCHUNK_PI_REPO:-/home/admin/kerchunk-kiosk}"
INSTALL_DIR=/opt/kerchunk-kiosk

echo "[deploy] target: $PI_HOST  repo: $PI_REPO"

# Preflight: fail fast (and clearly) if the Pi is unreachable, rather than
# hanging on the real SSH session below.
if ! ssh -o BatchMode=yes -o ConnectTimeout=5 "$PI_HOST" true 2>/dev/null; then
  echo "[deploy] ERROR: cannot reach $PI_HOST over SSH. Is the Pi on and on the LAN?" >&2
  exit 1
fi

# All remote work in one session. The remote runs its own strict bash; the
# heredoc is quoted ('REMOTE') so it is sent verbatim, not expanded locally.
ssh "$PI_HOST" "INSTALL_DIR='$INSTALL_DIR' PI_REPO='$PI_REPO' bash -s" <<'REMOTE'
set -euo pipefail

cd "$PI_REPO"

echo "[deploy] fetching origin and resetting to origin/main..."
git fetch --quiet origin
git reset --hard origin/main

cd "$PI_REPO/kiosk"
echo "[deploy] building (npm ci && npm run build)..."
npm ci
npm run build

echo "[deploy] installing to $INSTALL_DIR..."
sudo rsync -a --delete dist/ "$INSTALL_DIR/dist/"
sudo rsync -a --delete node_modules/ "$INSTALL_DIR/node_modules/"
sudo cp package.json "$INSTALL_DIR/package.json"
sudo chown -R kerchunk:kerchunk "$INSTALL_DIR"

echo "[deploy] restarting services..."
sudo systemctl restart kerchunk-kiosk.service kerchunk-display.service

deployed="$(git -C "$PI_REPO" rev-parse --short HEAD)"
echo "[deploy] deployed commit: $deployed"
echo "[deploy] kerchunk-kiosk:   $(systemctl is-active kerchunk-kiosk.service)"
echo "[deploy] kerchunk-display: $(systemctl is-active kerchunk-display.service)"
REMOTE

echo "[deploy] done."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x kiosk/scripts/deploy.sh
```

- [ ] **Step 3: Syntax-check the script (this is the test)**

Run:
```bash
bash -n kiosk/scripts/deploy.sh && echo "syntax OK"
```
Expected: `syntax OK` (no output from `bash -n` means no syntax errors).

- [ ] **Step 4: Commit**

```bash
git add kiosk/scripts/deploy.sh
git commit -m "deploy: add deploy.sh to push origin/main to the Pi over SSH"
```

- [ ] **Step 5: Live verification — run a real deploy**

First commit/push something to `main` (e.g. Task 1's CI file), then:
```bash
./kiosk/scripts/deploy.sh
```
Expected output ends with `kerchunk-kiosk: active` and `kerchunk-display: active`,
and a `deployed commit:` line matching `git rev-parse --short origin/main`.

Independently confirm the install updated:
```bash
ssh admin@192.168.1.54 'cat /opt/kerchunk-kiosk/package.json | head -3; systemctl is-active kerchunk-kiosk.service kerchunk-display.service'
```
Expected: both units `active`.

---

## Task 3: Auto-deploy post-merge hook

**Files:**
- Create: `.githooks/post-merge`
- One-time config: `git config core.hooksPath .githooks`

The dev Mac's global `core.hooksPath` shadows `.git/hooks/`, so we point this
repo at `.githooks/` and have the hook explicitly chain the global hook (so
branch-pruning still happens) before deploying.

- [ ] **Step 1: Create the hook**

Create `.githooks/post-merge`:
```bash
#!/usr/bin/env bash
#
# Repo-scoped post-merge hook for kerchunk-kiosk.
#
# This repo sets core.hooksPath=.githooks, which makes Git ignore both the
# global hooks dir AND .git/hooks. So we must:
#   1. chain the global post-merge (branch-prune) so that still runs, then
#   2. fire a background deploy when a pull advanced local `main`.
#
# Disable auto-deploy without removing the hook:
#   git config hook.kerchunk-deploy false
#
set -euo pipefail

# --- 1. Chain the global branch-prune hook (if present) -------------------
GLOBAL_HOOK="$HOME/.config/git/hooks/post-merge"
if [ -x "$GLOBAL_HOOK" ]; then
  # Pass through the same args Git gave us ($1 = is-squash flag).
  "$GLOBAL_HOOK" "$@" || true
fi

# --- 2. Auto-deploy guard -------------------------------------------------
# Opt-out switch (defaults on).
if [ "$(git config --get hook.kerchunk-deploy || echo true)" = "false" ]; then
  exit 0
fi

# Only deploy from main.
branch="$(git symbolic-ref --short -q HEAD || true)"
if [ "$branch" != "main" ]; then
  exit 0
fi

# Only deploy if the merge actually advanced HEAD. git pull/merge set ORIG_HEAD
# to the pre-merge tip; if it's missing or unchanged, there's nothing new.
orig="$(git rev-parse -q --verify ORIG_HEAD || true)"
head="$(git rev-parse -q --verify HEAD || true)"
if [ -z "$orig" ] || [ "$orig" = "$head" ]; then
  exit 0
fi

# --- 3. Fire deploy in the background -------------------------------------
# Non-blocking so `git pull` returns immediately and an offline Pi never hangs
# the pull. Output goes to a log file the user can tail.
repo_root="$(git rev-parse --show-toplevel)"
log="$(mktemp -t kerchunk-deploy.XXXXXX.log)"
echo "[post-merge] main advanced ($orig -> $head); starting background deploy."
echo "[post-merge] logging to $log  (tail -f to watch)"
nohup "$repo_root/kiosk/scripts/deploy.sh" >"$log" 2>&1 &
disown || true

exit 0
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x .githooks/post-merge
```

- [ ] **Step 3: Point this repo at the .githooks dir**

```bash
git config core.hooksPath .githooks
```
Verify:
```bash
git config --get core.hooksPath
```
Expected: `.githooks`

- [ ] **Step 4: Syntax-check the hook (this is the test)**

```bash
bash -n .githooks/post-merge && echo "syntax OK"
```
Expected: `syntax OK`

- [ ] **Step 5: Verify the guard logic without deploying — non-main branch**

Simulate a post-merge on a non-main branch; the branch guard must make the hook
exit before the deploy block. Run from repo root:
```bash
git checkout -b tmp-hook-test
.githooks/post-merge 2>&1 | grep -q "background deploy" && echo "UNEXPECTED: would deploy" || echo "OK: no deploy on non-main"
git checkout main
git branch -D tmp-hook-test
```
Expected: `OK: no deploy on non-main`
(The global hook may print branch-prune output; that's fine. We only assert the
deploy did NOT start. The `git checkout -b` does not set `ORIG_HEAD`, but the
branch guard returns first regardless.)

- [ ] **Step 6: Verify the guard logic — main but no advance**

On `main` with `ORIG_HEAD` unset (no new commits), the hook must not deploy:
```bash
git rev-parse -q --verify ORIG_HEAD >/dev/null 2>&1 && git update-ref -d ORIG_HEAD
.githooks/post-merge 2>&1 | grep -q "background deploy" && echo "UNEXPECTED: would deploy" || echo "OK: no deploy without advance"
```
Expected: `OK: no deploy without advance`

- [ ] **Step 7: Commit**

```bash
git add .githooks/post-merge
git commit -m "deploy: add post-merge hook to auto-deploy on main advance"
```

Note: `core.hooksPath` is a **local** git config (in `.git/config`), not a
committed file. The operator doc (Task 4) records that anyone cloning this repo
must run `git config core.hooksPath .githooks` once to enable auto-deploy.

---

## Task 4: Operator documentation

**Files:**
- Create: `docs/DEPLOY.md`

- [ ] **Step 1: Write the doc**

Create `docs/DEPLOY.md`:
```markdown
# Deploying Kerchunk Kiosk

## What deploys where

- **CI** (`.github/workflows/ci.yml`) runs typecheck + tests + build on every
  pull request and every push to `main`, on GitHub-hosted Linux. It does not
  touch the Pi.
- **Deploy** is a local action. `kiosk/scripts/deploy.sh` SSHes from your Mac to
  the Pi (`admin@192.168.1.54`), resets the Pi's clone to `origin/main`, builds,
  installs to `/opt/kerchunk-kiosk`, and restarts the systemd services.

## Deploy manually

```bash
./kiosk/scripts/deploy.sh
```

Target a different host (e.g. by mDNS name) with an env var:

```bash
KERCHUNK_PI_HOST=admin@kerchunk-kiosk.local ./kiosk/scripts/deploy.sh
```

The script prints the deployed commit and the post-restart status of both
units. Requires: SSH key access to the Pi (already set up) and that `origin/main`
is what you want live — it deploys `origin/main`, not your local working tree.

## Auto-deploy on pull

A repo-scoped `post-merge` hook (`.githooks/post-merge`) runs the deploy in the
background whenever a `git pull` advances your local `main`. It also chains the
global branch-prune hook so that keeps working.

**Enable it once per clone** (it's local git config, not committed):

```bash
git config core.hooksPath .githooks
```

**Disable auto-deploy** without removing the hook:

```bash
git config hook.kerchunk-deploy false
```

The hook never blocks `git pull`: it launches the deploy detached and logs to a
temp file (path printed when it fires; `tail -f` to watch).

## Prerequisites (already satisfied)

- SSH key auth to `admin@192.168.1.54`.
- `admin` has passwordless sudo on the Pi (the deploy uses `sudo` for the `/opt`
  install and `systemctl restart`).
- `/home/admin/kerchunk-kiosk` is a clone of this repo on `main`;
  `/opt/kerchunk-kiosk` is the live install (`dist`, `node_modules`,
  `package.json`).
```

- [ ] **Step 2: Commit**

```bash
git add docs/DEPLOY.md
git commit -m "docs: add deploy + auto-deploy hook operator guide"
```

---

## Final verification (end-to-end)

After all tasks, run the full loop once to prove it works:

- [ ] CI is green on a PR (Task 1, Step 5).
- [ ] `./kiosk/scripts/deploy.sh` deploys cleanly; both units `active` (Task 2, Step 5).
- [ ] With `core.hooksPath=.githooks` set, a `git pull` that advances `main`
  prints "starting background deploy" and writes a log; a non-main pull does not
  (Task 3, Steps 5–6).
- [ ] `docs/DEPLOY.md` accurately describes the above.
