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
units, and exits non-zero if either service fails to come back up. Requires:
SSH key access to the Pi (already set up) and that `origin/main` is what you
want live — it deploys `origin/main`, not your local working tree.

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
