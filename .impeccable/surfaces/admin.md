---
version: 1
slug: "admin"
primary_target: "admin"
related_targets: ["kiosk/src/frontend/admin"]
---

# Surface brief: admin

**Scope & mode.** The web admin at `/admin`: four tabs, **Radio · Tune ·
Library · System**, with Radio as home. It also covers the shell (top bar or
bottom tab bar, mini-player, health verdict), the channel-detail sheet/pane,
the management sheets, toasts and the confirm dialog. Mode: Operate. Shipped
2026-09-29 (PRs #266–#271). Spec:
`docs/superpowers/specs/2026-09-28-admin-redesign-design.md`.

**Audience & jobs.** One operator, at arm's length: a phone next to the radio
or a laptop on the bench. The jobs, in the operator's order:
1. **Listen to and control the radio right now.** See what's live, listen
   here, skip, park on weather, pause, lock out, set the volume. That is
   Radio.
2. **Tune settings.** Plain-language groups (Sound, Scanning, Discovery,
   Alerts, Weather channel) are saved as you go, and each save says what it
   costs. Engine internals sit behind Advanced. That is Tune.
3. **Secondary jobs.** Curate channels and banks, triage new Close Call
   signals (Library → Channels | New), and check health, vitals, kiosk-screen
   actions, connections and power (System). These must not regress, and they
   don't compete with Radio for attention.

**Chosen direction: the Faceplate × Night desk.** The admin is the scanner's
front panel. An LCD (glow on glass, sea-glass characters on a recessed well)
shows what is live. Tactile keys sit under it. Settings are groups of rows.
The surfaces are a blue-slate ground and raised groups, separated by tone.
Schibsted Grotesk, sentence case, tabular numerals. Sea-glass is spent only
on what is live or the one primary action, hay on attention, and coral on
destruction. Tokens: `tokens.css` layer 2 (`--kc-*`) only. Components:
`admin/ui/kit.ts`, `ui/sheet.ts`, `dialogs.ts`.

**Refusals.** No dashboard cards: no stat-tile walls and no persistent
status side panel repeating System. No nav rail. No borders on surfaces
(`--kc-line` goes between rows only). No all-caps or tracked-legend labels.
No second glow (the LCD frequency owns it). No hardware cosplay beyond glow on
glass and a key that depresses. No `backdrop-filter`.

**Memorable moment.** Opening the admin on a phone shows what the radio is on
right now, on glass, with the key to hear it under your thumb.

**Constraints.**
- All DESIGN.md named rules bind.
- **One request on the wire:** every poll and write goes through
  `Poller.run()`, and writes are refused ("Wait for the radio to come back.")
  while a power action is being watched.
- Every write names its cost (applies live / re-tunes / restarts scanning
  briefly), and restart-cost edits are batched per group behind
  `TUNE_APPLY_DELAY_MS`.
- Channel detail is a bottom sheet on a phone and a right-side pane at
  ≥900px.
- The wall, dashboard, map and art are a separate language (layer 1) and are
  out of scope here.

**Unresolved.** Restyling the ambient displays in the admin's language is a
possible later follow-up, not planned. A command palette / keyboard-first
layer stays tabled.
