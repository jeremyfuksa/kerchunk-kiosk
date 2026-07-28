---
target: admin
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 2
p1_count: 3
timestamp: 2026-07-28T18-55-23Z
slug: kiosk-src-frontend-admin-admin-ts
---
Method: dual-agent (A: a8d15322abf5647fb · B: adce948eec19c09d4)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | The radio is MUTED and Close Call is OFF; the hero says "Now playing / scanning…" and Triage says "Close Call is hunting". Excellent WS/watcher machinery reporting false state. |
| 2 | Match System / Real World | 3 | Domain language is precise, but six overlapping words mean "make this stop": archived, silent, locked out, suppressed, dismissed, paused. |
| 3 | User Control and Freedom | 2 | No undo anywhere. Bank "Make silent" mutates up to 29 channels with no confirm and no reversal. On phone the drawer covers its own scrim, so tap-outside-to-close does not exist. |
| 4 | Consistency and Standards | 2 | Two hour-clocks on Overview with contradictory encodings: `.clkBar.now` amber, `.inHr.now` green — and green is this system's adopt/healthy colour. |
| 5 | Error Prevention | 2 | Confirm copy is outstanding, but the two bulk-mutation paths have no confirm at all, and three irreversible power actions sit in a flat six-button row with benign ones. |
| 6 | Recognition Rather Than Recall | 2 | Empty field = engine default is an invisible convention; no way to see which settings you have customised. Channel rows hide priority, tags and archived state. |
| 7 | Flexibility and Efficiency | 1 | No search over 97 channels, no keyboard shortcuts, and one Audible tick costs five serialized round-trips on hardware documented to deadlock on two concurrent requests. |
| 8 | Aesthetic and Minimalist Design | 2 | The same 24-hour dataset renders three times on Overview. DESIGN.md's One Lit Thing Rule is broken 15 ways on that page alone. |
| 9 | Error Recovery | 2 | Success is written into a span styled `color: var(--red)` and never clears. The one moment the app should feel good looks like a failure, and stays. |
| 10 | Help and Documentation | 3 | Best-in-class inline hints and honest confirm copy; docked because the most load-bearing explanations are currently false. |
| **Total** | | **21/40** | **Acceptable — significant work needed** |

## Design Specificity Verdict

**The content is authored for a scanner. The composition and interaction model are not.**

Genuinely product-specific: four-decimal tabular frequencies as the leftmost column everywhere; the OUTBAND chip flagging allocations nothing matches; SEE/HEAR verdicts and "digital — not decodable here"; a DSP-helper core gauge sitting beside CPU and temp because that subprocess *is* the radio; and a reboot dialog that injects "A weather alert is on air right now." That sentence cannot exist in another product.

Interchangeable: the whole chassis. Masthead → icon+two-line nav rail → eyebrow/title/description → stat-tile row → card grid → right drawer → confirm dialog. Relabel the five tiles MRR/DAU/churn and nothing breaks. The interaction model is pure CRUD — nothing in it is shaped by the fact that a live radio is in the room. "Now playing" is a text string.

The sharpest evidence: **DESIGN.md names the LED signal meter as the system's signature component. It appears zero times in the admin.** `rfDb` is in the data model and renders as a 30-row list inside the analytics drawer. The signature instrument exists, is built, and is absent from the one surface where liveness is the point.

**Deterministic scan (Assessment B): the "clean" result is largely vacuous, and the reason matters.**
`detect.mjs` returns `[]`/exit 0 on `admin.ts` and `admin/`, configured and `--no-config` alike. B traced why: `loadDesignSystemForTarget()` walks UP from the scanned file and stops at the first project-root marker. `kiosk/package.json` exists; `kiosk/DESIGN.md` does not — so **the repo-root DESIGN.md is structurally invisible to the CLI detector for everything under `kiosk/`**. Separately, page-level analyzers are gated behind `isFullPage()`, which a `.ts` fragment building `root.innerHTML` can never satisfy. Two whole rule categories never engaged. This also explains the CLI-vs-hook discrepancy seen earlier (CLI 0, hook 53): the hook passes cwd and resolves DESIGN.md correctly.

Measured facts that did land: 0 form controls without an accessible name across all five routes; 13 distinct font sizes (matching the documented ramp exactly); every colour resolving to a token or `color-mix` of tokens; contrast independently recomputed and matching the in-source claims to rounding — with `--dim` at 4.61:1 and `--amber` at 4.66:1 flagged as *fragile* passes, under 0.2 of margin.

## Overall Impression

The engineering is better than the design, and the design is better than the *reporting*. Three times on the front page this interface states something that is not true: the radio is muted but the hero implies audio; Close Call is off but Triage says it is hunting; a save succeeds but renders in the failure colour. Each is small. Together they undermine the one thing an appliance console exists to provide — an accurate answer to "what is it doing right now?"

Biggest opportunity: make Overview *be the radio* rather than a dashboard about the radio.

## What's Working

1. **The drawer as single editor, with correct `inert` on both sides.** Not just a11y hygiene — it collapses "where do I change this?" to one answer across four unrelated object types, which is *why* a 97-row table can stay three columns wide and why the phone layout can drop the action column and still be complete.
2. **`SystemActionWatcher`.** It solves the hardest honesty problem in the app — a 202 that proves nothing, from a server about to kill itself — by polling until a different process answers, and distinguishing down / back / nothing-happened in plain language.
3. **Confirm copy.** "Archived, not deleted — unlock restores it." "It will not come back on until someone presses the power button on the laptop." Reassurance written by someone who pictured the person standing next to the dead radio.

## Priority Issues

### [P0] The hero misreports whether the radio is audible
Live config right now: `audio.muted: true`, `volume: 15`. The lit amber hero reads "Now playing / scanning…", and the only tell is a 14px checkbox among four controls. This is the first thing seen and it sets trust for every number on the page.
**Fix**: derive hero state from `audio.muted`/`volume`, not just the WS event. Drop `.npName` to `--dim` and put a caution MUTED chip beside the header. Then spend the reclaimed amber on something genuinely live: put `rfDb` on the LED signal meter DESIGN.md already specifies.
**Command**: `/impeccable layout`

### [P0] Success is rendered in danger red and never clears
Four call sites write the literal string `"saved"` into spans styled `.admin .err { color: var(--red) }` (admin.ts:1106, 1927, 1949, 1975). The operator tunes squelch by ear in minute-long loops; every success flashes failure red, then persists and makes the next save unverifiable.
**Fix**: add `.admin .ok { color: var(--green) }` and a `setFieldStatus(el, text, kind, clearAfterMs)` helper — the exact pattern already exists 300 lines away as `setSystemActionStatus`. Auto-clear ~4s, `role="status"`.
**Command**: `/impeccable clarify`

### [P1] Close Call is off and every surface asserts the opposite
`scan.closeCall === false`. Triage's empty state says "Close Call is hunting. New discoveries land here." The nav says "Review new discoveries". The threshold field sits enabled beneath the unchecked toggle. The operator is waiting on a queue that structurally cannot fill.
**Fix**: derive the empty state from config — "Close Call is off. No new discoveries will arrive. Turn it on in Settings ›". Disable dependent fields when the parent toggle is off.
**Command**: `/impeccable clarify`

### [P1] No undo, and no acknowledgement, after any destructive action
Lockout, dismiss, and the three bank bulk operations all mutate and re-render with zero feedback. `bkBulkAudible`/`bkBulkSilent` change up to 29 channels with neither confirm nor reversal.
**Fix**: one shared toast region (precedent: `#systemActionStatus`) emitting "Locked out 154.4450 · Undo." Undo is nearly free — `unlockFreqIn` already exists as the tested inverse of `lockoutFreqIn`, and archive undo is `{enabled: true}`. At minimum, confirm the two silent bulk paths.
**Command**: `/impeccable harden`

### [P1] 97 channels, no search; no keyboard accelerators anywhere
The only navigation aid is collapse-by-bank. Worse, one Audible tick costs five serialized round-trips (`updateChannel` → `refresh` → `getChannels` + `getConfig` + `duplicates` + `recommendations`), and every mutation is a whole-config read-modify-write racing the 15s discovery poll — a discovery landing between GET and PUT is silently erased with no conflict signal.
**Fix**: a filter input over freq/name/tag above the table, focused by `/`. Separately, narrow the post-mutation refresh.
**Command**: `/impeccable shape`

## Cognitive Load

**5 of 8 fail — high.**
- **Single focus FAIL** — four co-equal Overview regions, no primary.
- **Chunking FAIL** — System actions 6, bank menu 6, Scanning card 7 fields, hero 8 controls.
- **Visual hierarchy FAIL** — `.stValue` at 1.9rem amber ×4 out-shouts `.npName` at 1.5rem ink. The loudest thing on the live-radio page is a 24-hour history count.
- **Minimal choices FAIL** at seven decision points.
- **Working memory FAIL** — per-card save with no dirty indicator; after an interruption you cannot tell which of four Settings cards you already saved.
- Passing: grouping (partial), one-thing-at-a-time (partial), progressive disclosure (the strongest dimension).

## Persona Red Flags

**Alex (power user)** — worst served. No filter over 97 rows. Five serialized round-trips per Audible tick; a ten-channel sweep is ~50 requests on hardware documented to deadlock on two concurrent. Every mutation is whole-config read-modify-write racing a 15s poll, with silent loss. "Save scanning" restarts the engine and drops audio with no warning, while the System page's Restart button warns properly. `inHours` is a plain local, so a 7d/30d Insights selection silently reverts on every route change. Zero shortcuts in 2,034 lines.

**Sam (screen reader + keyboard)** — much improved, real gaps left. `tr.inChannel` is `tabindex="0"` with Enter/Space handlers but no `role="button"` — announced as a table row that mysteriously does something. `vol.blur()` on change throws focus to `<body>` when arrow-keying the volume. `#healthBanner` carries a permanent `role="alert"` and is rewritten by a 30s poll — an assertive live region on a polling target. `.bankMenuList` is six buttons ending in "Delete bank" with no `role="menu"`, no arrow-key nav, and no focus restore. The fixed bottom nav is first in DOM, so five stops precede content on every page, with no skip link.

**Casey (phone, interrupted)** — `.drawer { width: 100vw }` covers the scrim entirely, so tap-outside-to-close does not exist; the only exits are the top-right X (worst reachable point for a right thumb) and Escape. The drawer is not a hash route, so Android Back leaves the admin. "Lock out channel" (permanent) is the same size, shape and weight as "Skip transmission" (trivial), one diagonal thumb-slip apart. Switch-row checkboxes sit at the far right edge with labels ~250px away, at 1.35rem — under the 44px floor the same stylesheet enforces 200 lines earlier.

## Minor Observations

- `.stValue` is amber on all five tiles, including "Triage queue: 0" and "Alerts · 24h: 0". Amber on a zero claims liveness about nothing.
- The Triage tile is an `<a>` with a hover border; the other four are `<div>`s. Five identical-looking boxes, one clickable, no signal.
- Green currently means five unrelated things: analog voice, mode ok, survives-dedup, healthy, and current-hour.
- `.settingsCards` is `1fr 1fr` with `align-items: start`, so Integrations floats with ~150px of dead space above it.
- The code comments in `admin.ts` are the best documentation in this repo — nearly every one records a real production failure and its fix.

## Questions to Consider

1. **What if Overview *were* the radio?** A live band view — which lanes are open, at what level, right now — with all 24-hour history demoted to Insights. The one thing this surface has that no generic admin has is a real-time signal, and it currently renders as a text string.
2. **Six words mean "stop bothering me": archived, silent, locked out, suppressed, dismissed, paused.** Could that be two axes — *tracked?* and *audible?* — plus one permanent never-again list?
3. **The appliance is one room away. What is this app's answer to "why is it quiet right now?"** Mute, volume, Close Call off, safety mode, weather break-in and monitor mode all live on different surfaces and no single view composes them. That question is the app's actual job.
4. **If the operator can power the appliance off from a phone but cannot power it on from anywhere, does that button belong in this app at all?**
