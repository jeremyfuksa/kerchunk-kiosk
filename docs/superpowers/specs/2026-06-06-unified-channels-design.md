# Unified Channels page — banks as structure, one UI

Status: approved design, 2026-06-06 (operator-selected model A of three mocked
in the visual companion; see `.superpowers/brainstorm/`). Consolidation-phase
work: **zero new functionality** — this merges two existing surfaces.

## Problem

The admin treats Banks and Channels as separate tabs, but the operator thinks
of a bank as *consisting of* channels and wants to work with both at once.
Underneath, a bank is a **predicate** (band / freq range / tags) over
channels — not a folder — and a channel can match several banks. The UI should
present the operator's mental model (structure) without lying about the data
model (filters).

## Design

### One page: `#/channels`

A single grouped list replaces both tabs:

- **Groups** appear in bank config order — the same precedence order
  `profileFor()` already uses, so "first match" means one thing everywhere.
- A channel's **home group is its first matching bank**; channels matching no
  bank land in a final **Unbanked** group.
- Channels sort by frequency within a group. Collapse state per bank id,
  persisted in localStorage like the existing collapsible modules.

### Bank header row (the old chip, unrolled)

`▾ RAIL · 29 ch · [HEAR] ⚙ ×   — dwell ×2 · hang 4 s`

- Collapse caret; name; live channel count.
- The existing Hear → See → Off cycle control (same handler as today's chip;
  off-wins / mute-wins semantics untouched).
- Profile gear opens the **existing** inline profile editor for that bank.
- Delete × uses the existing delete-bank flow (confirm; channels keep
  scanning).
- When a profile is set, a dim text summary of its knobs trails the header
  (replaces the bare amber `*`).
- The "+ Bank" creation form stays at the top of the page, unchanged.

### Channel rows

Unchanged from today's table (freq, name + location chip, mode, priority,
Listen tri-state, actions; row click opens the dossier drawer), plus:

- **Membership chips**: when a channel also matches banks other than its home,
  small dim chips name them — multi-membership stays visible.
- **Per-group add**: a `+` in each header opens the existing add-channel row
  pre-filled with the bank's first tag, so a channel added "into Rail"
  actually matches Rail. (Banks without tag predicates — pure band/range —
  pre-fill nothing; the channel joins by frequency or not at all.)

### Navigation

- Nav becomes `Home / Triage / Channels / Scan`.
- `#/banks` redirects to `#/channels` (bookmarks survive).

## What does not change

Schema, APIs, engine, off-wins / mute-wins resolution, per-bank profiles,
the channel drawer, Triage/promote, the kiosk bank rail. No new endpoints,
no new config.

## Mechanics

- Pure helper in `src/backend/config/banks.ts`:
  `groupChannelsByBank(channels, banks) → Array<{ bank: Bank | null, channels: Channel[] }>`
  (bank `null` = Unbanked). Unit-tested: first-match homing, config-order
  groups, unbanked last, empty-bank groups still listed (a bank with zero
  channels renders, so it can be found and deleted).
- `admin.ts`: `renderRows()` renders group headers + rows from the helper;
  bank-chip handlers (cycle / gear / delete) move onto header rows; the
  standalone Banks section and nav entry are removed.
- CSS: `bankRow` header styling (raised surface, sticky-ish weight),
  membership chips, group add affordance.

## Testing

- Unit: `groupChannelsByBank` cases above.
- Existing adminForm tests unaffected.
- Field check after deploy: cycle a bank from its header and confirm the
  kiosk rail + scanCount react exactly as the old chips did.

## Risks

- `admin.ts` is large; the change is concentrated in `renderRows`/banks
  wiring. The grouped renderer must keep row-level event wiring identical
  (drawer, tri-state, listen/lockout/delete) or channel editing regresses.
- Per-group add pre-fills tags via the existing inline editor — verify the
  editor's save path keeps tags it didn't render (it currently builds the
  channel from form fields; the pre-tag must survive).
