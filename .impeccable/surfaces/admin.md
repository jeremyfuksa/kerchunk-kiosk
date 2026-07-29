---
version: 1
slug: "admin"
primary_target: "admin"
related_targets: ["kiosk/src/frontend/admin"]
---

# Surface brief: admin

**Scope & mode.** The web admin (all five pages plus shell). Operate.

**Audience & job.** The one operator, at arm's length — phone beside the radio
or laptop on the bench. Two dominant jobs: the 5-second health glance, and
adjusting the radio (volume, mute, transport). Triage and library work are
secondary and must not regress.

**Chosen direction (2026-07-28, seed e5c00ed8).** The live radio is a
permanent region of the workspace, not a page: nav rail · work column ·
persistent **Now panel** (health verdict → live channel + four-decimal
frequency → transport → volume fader → vitals). ≤1100px the panel condenses
to a pinned strip above the tab bar that expands into a bottom sheet — one
element, two layouts, no duplicated controls. Home is the **Activity** page
(stat tiles, channel activity, alert feed); the old status hero dissolved
into the panel. Convention over concept: modern operator console at
Linear/Stripe/Vercel finish, no concept layer, no hardware cosplay.

**Memorable moment.** Opening the admin anywhere answers "is it healthy,
what's it on" without a single navigation.

**Constraints.** All DESIGN.md named rules bind (one amber, hairlines,
tabular numerals, four decimals, no blur). Panel polls stay sequential and
first in tick order; the appliance deadlocks on concurrent requests.

**Unresolved.** Command palette / keyboard-first layer explicitly tabled.
Whether the alert feed eventually merges into the activity column.
