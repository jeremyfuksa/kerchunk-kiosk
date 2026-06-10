# SAME EOM-triggered scan resume

**Status:** design approved, pending implementation
**Branch:** `feat/same-eom-resume`
**Date:** 2026-06-10

## Problem

When a covered, non-test SAME alert breaks in (`server.ts` weather break-in),
the kiosk switches to the weather channel and reverts to scanning on a fixed
timer: `min(10min, max(120s, purgeMinutes × 60s))`.

That `purgeMinutes` is the alert's **validity window** (how long the watch/
warning is *in effect* — often hours for a tornado watch, clamped down to the
10-minute ceiling), not the length of the **voice broadcast**. So the kiosk can
camp on the weather channel for up to 10 minutes after a ~75-second announcement
has already ended.

A SAME transmission ends with three **EOM** bursts (`NNNN`), which mark the true
end of the broadcast. They carry no payload — all alert data (event code, FIPS
counties, purge time, sender) is in the *header* bursts at the start, which
`same.ts` already decodes. The EOM is purely an end-of-message marker, and it is
exactly the signal needed to resume scanning when the announcement actually ends.

## Goal

Resume scanning shortly after the broadcast genuinely ends (detected via EOM),
while keeping the existing timer as a safety net, and without bouncing in and out
of weather mode when alerts are broadcast in back-to-back clusters.

## Non-goals

- Changing the weather alert banner lifecycle (see "Banner stays decoupled").
- Decoding or surfacing any new data from the EOM bursts — there is none.
- Any change to the `ScannerEngine` interface or the helper protocol.

## Design

### 1. No new engine event — branch on the line already emitted

`wideband_helper.py` already pushes `NNNN` lines up to Node as
`{ev: "same", raw}` (same path as `ZCZC` headers). The server's SAME handler
currently calls `parseSameHeader()`, which silently drops `NNNN` (it does not
match the header regex).

The change adds a branch at the top of the SAME handler:

```ts
if (isEom(raw)) { /* grace logic, below */ return; }
```

`isEom()` (`same.ts:61`) already exists and is unit-tested; it just is not called
at runtime yet. No new event type, no interface change.

### 2. Grace-window resume

Factor the existing revert into a shared `revertToScan()` helper that:

- clears **both** timers (the long safety-net timer and the new grace timer),
- sets `breakIn = false`,
- guards with the existing `if (mode !== "weather") return` check (operator may
  have changed mode in the meantime),
- flips `mode → "scan"` and calls `switchMode(toScanConfig(config, "scan"))`.

Then:

- **On a covered header break-in:** also clear any pending grace timer — a new
  message is starting, so keep holding.
- **On EOM** (only while `mode === "weather" && breakIn`): clear any existing
  grace timer and start a fresh one for `EOM_GRACE_MS` (default **8000 ms**)
  → `revertToScan()`. A new covered header arriving inside that window cancels
  the grace timer (via the line above), so clustered alerts hold straight through
  with no audible bounce.
- **The existing long timer stays** as the hard cap. Whichever timer fires first
  calls `revertToScan()`, which clears the other.

Both timers are `unref()`'d as today.

### 3. Banner stays decoupled

EOM does **not** clear the weather alert banner. Audio resume answers "is the
broadcast still talking"; the banner answers "is this alert still in effect" — a
tornado watch remains valid for hours after its 75-second announcement. The
banner continues to run out its own `holdSeconds` on the frontend, independent of
audio resume.

### 4. Failure modes — all degrade to current behavior

- **EOM never decodes** (squelch clips the tail, noise): the long safety-net
  timer fires exactly as it does today. No regression.
- **Stray `NNNN` with no active break-in:** ignored by the
  `mode === "weather" && breakIn` guard.
- **EOM during a test alert:** test alerts never trigger a break-in, so there is
  no weather mode to revert from; the EOM is ignored.

## Components touched

| File | Change |
|------|--------|
| `kiosk/src/backend/server.ts` | Add `isEom` import; add `sameEomTimer`; factor `revertToScan()`; branch on EOM in the SAME handler; clear grace timer on new break-in. |
| `kiosk/src/backend/same.ts` | None (uses existing `isEom`). |

No frontend, helper, or engine-interface changes.

## Testing

Server-level vitest with fake timers (extend the existing break-in test):

1. **Lone alert:** emit a covered `ZCZC` `same` event → assert `mode → weather`
   + retune to the weather channel. Emit `NNNN` → advance past `EOM_GRACE_MS` →
   assert `mode → scan` + retune to scan config.
2. **Cluster:** `ZCZC → NNNN → second covered ZCZC before grace elapses →
   NNNN → advance past grace`. Assert it held weather mode through the middle
   (no premature revert) and reverted only after the final grace window.
3. **Safety net:** covered `ZCZC` with no following `NNNN` → advance past the
   long timer → assert revert (proves no regression when EOM is missed).
4. The `isEom` unit test in `same.test.ts` already exists.

## Open knob

`EOM_GRACE_MS` default **8000 ms**. Long enough to bridge clustered messages,
short enough that the trailing squelched silence on the weather channel is brief.
Easy to tune later if real-world clusters show a longer inter-message gap.
