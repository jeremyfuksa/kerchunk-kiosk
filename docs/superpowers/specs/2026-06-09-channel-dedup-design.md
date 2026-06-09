# Channel de-duplication (design)

> Status: design, approved 2026-06-09. Surfaced during the artistic-kiosk
> brainstorm (see [[channel-dedup-followup]] memory) and split out as its own
> off-server-buildable project. Not a ROADMAP idea — a config-hygiene feature.

## Intent

The channel list has no uniqueness constraint: nothing stops two rows from
landing on the same frequency. The operator wants distinct things to stay
distinct — a frequency identifies a channel, so two non-GMRS rows on one
frequency are a data-entry mistake. GMRS/FRS is the one legitimate exception:
it is shared, channelized spectrum, so many rows on one GMRS frequency are
expected. This project adds the uniqueness rule across its full lifecycle:
prevent new duplicates, detect existing ones, and resolve them.

It is entirely software over data the appliance already holds — buildable and
testable off the kiosk. Only the *audit's output* depends on the real config;
the logic is fixture-tested.

## The core rule (single source of truth)

A small pure module (`src/backend/config/channelDedup.ts`) is the foundation all
three features consume. No I/O, no DOM — pure functions over `Channel[]`.

**Collision:** two channels *collide* when they have the **same `freq`** and
**neither is GMRS/FRS**. GMRS membership is derived from frequency, not tags:

```
isGmrs(freq)  ===  serviceFor(freq) === "GMRS/FRS"
```

(`serviceFor` from `src/backend/config/banks.ts` already classifies the GMRS/FRS
allocations: 462.5375–462.7375 MHz and 467.5375–467.7375 MHz.)

**Duplicate set:** a group of 2+ channels sharing one non-GMRS frequency.

**Exports:**
- `isGmrs(freqHz: number): boolean`
- `collides(a: Channel, b: Channel): boolean` — same freq, neither GMRS.
- `findDuplicateSets(channels: Channel[]): DuplicateSet[]` — groups non-GMRS
  channels by freq, returns only the groups of size ≥ 2, each with its rows
  ranked by completeness (richest first).
- `completeness(c: Channel): number` — the "richest row" score (below).

```ts
interface DuplicateSet {
  freq: number;
  channels: Array<{ channel: Channel; completeness: number }>; // richest first
}
```

**Completeness score** (ranks which row survives a cleanup; deterministic):
- `location.lat` and `location.lon` both present → **+2** (expensive to recover)
- `tags` non-empty → **+1**
- `priority === true` → **+1**
- `alert === true` → **+1**
- `levelTrimDb` present OR `rfDb` present (learned telemetry) → **+1**

Ties broken by **lowest `id`** (string compare) so ranking is never random.

## Consumer 1 — Block on add/edit (prevention)

The gate that stops new duplicates from entering.

- `POST /api/channels` and `PUT /api/channels/:id` in `server.ts` run
  `collides()` against the current `config.channels` (excluding, on edit, the
  row being edited itself) before accepting.
- A non-GMRS collision is rejected with **`409 Conflict`** and body
  `{ error: string, conflictsWith: { id, alphaTag } }`.
- GMRS frequencies never collide, so they pass through unchanged.
- Admin add/edit form catches the 409 and shows the message inline, e.g.
  "146.5200 MHz is already **W0XYZ** — edit that channel or pick another
  frequency." No silent failure.

## Consumer 2 — Audit existing list (detection)

Read-only surfacing of duplicates already in the config.

- `GET /api/channels/duplicates` → `DuplicateSet[]` (empty array when clean).
- Admin **Channels page**: a collapsible **"Duplicates"** panel at the top of
  the channel-table page, rendered **only when the array is non-empty**. Header:
  "N frequencies have duplicate rows." Each set expands to list its rows with
  their completeness, and marks which row **would win** a cleanup — so the
  outcome is visible before any destructive action.

## Consumer 3 — One-click cleanup (resolution)

Resolves duplicate sets by keeping the richest row and deleting the rest.

- `POST /api/channels/duplicates/resolve` → for each duplicate set: keep the
  highest-completeness row, **delete** the losers from `config.channels`, persist
  via the existing config store. Returns `{ removed: number, kept: number }`.
- **Guardrails (non-negotiable):**
  - **Never automatic** — only on explicit operator action.
  - **Preview then confirm** — the audit panel *is* the preview (it shows which
    rows die); the action requires a confirmation ("Delete 4 duplicate rows
    across 3 frequencies?").
  - **GMRS sets never appear** in `findDuplicateSets`, so cleanup cannot touch
    them.
- Deletion is permanent (operator's choice: keep config clean over reversible).
  The preview-then-confirm flow is the safety net: irreversible only *after* the
  operator has seen exactly what will be removed.

## Architecture / isolation

- **`channelDedup.ts`** — pure logic, the only place the rule is defined. One
  responsibility. Unit-tested in isolation with fixture `Channel[]`.
- **`server.ts`** — thin: the three endpoints call into `channelDedup` and the
  existing config store. No rule logic in the server.
- **`admin.ts`/`admin.css`** — the Duplicates panel + the inline 409 handling on
  the channel form. Presentation only.

## Testing

- `channelDedup.test.ts` (off-server, vitest): `isGmrs` boundaries (just inside/
  outside the GMRS edges), `collides` (same freq non-GMRS = true; same freq GMRS
  = false; different freq = false), `findDuplicateSets` (groups of 2+, GMRS
  excluded, ranking order), `completeness` (each scoring field, tie-break by id).
- Server-handler tests for the 409 on add/edit and the resolve count, using the
  existing dependency-injected `createServer` + fake config store pattern.

## Out of scope

- Any change to how frequencies are *entered* (units, parsing) — unchanged.
- Merging field data between duplicate rows — the survivor is kept as-is; losers
  are deleted, not merged into the survivor.
- Uniqueness on anything but frequency (mode, alphaTag) — freq is the key.
- A separate diagnostics-home placement — the panel lives on the Channels page.

## Success criteria

- Adding/editing a channel onto an occupied non-GMRS frequency is rejected with
  a clear, inline reason; GMRS frequencies are never blocked.
- The Channels page shows a Duplicates panel iff duplicates exist, listing each
  set and its would-be survivor.
- Cleanup, after explicit confirmation, removes exactly the non-survivor rows
  and leaves GMRS untouched.
- All rule logic is covered by off-server unit tests; no hardware needed to
  build or verify anything but the audit's real-config output.
