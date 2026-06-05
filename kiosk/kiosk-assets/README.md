# Kiosk assets

## map-style.json

The cloud-based map style for the `/map` view and the kiosk's map stage —
campfire dark cartography, minimal so the blips take precedence.

**This file is NOT loaded by code.** The live copy lives in the Google Cloud
console (Maps Platform → Map styles), associated with the Map ID stored in
`config.display.googleMapsMapId`. This is the version-controlled master; the
round-trip is manual:

1. Edit `map-style.json` here.
2. Console → Map styles → the kerchunk style → JSON tab → paste → Save →
   **Publish** (a saved-but-unpublished draft changes nothing).
3. Wait a couple of minutes for propagation, then reload the map page /
   `sudo systemctl restart kerchunk-display` for the kiosk.

Color map (campfire dark tokens):

| Layer | Token | Hex |
|---|---|---|
| Land / base | `neutral-950` / `--bg-base` | `#1c1f26` |
| Water | half-step below 950 (no token exists) | `#13161c` |
| Roads (geometry only, no labels/shields) | `neutral-900` | `#2b303b` |
| Highway stroke | `neutral-800` | `#42454e` |
| Water labels | `neutral-700` | `#4d515c` |
| Town names | `neutral-600` | `#5e6371` |

Town names are deliberately dimmed for across-the-room kiosk reading; if they
still pop, the ramp continues `#4d515c` → `"visible": false`. POIs are hidden
as a class — the activity blips are the map's subject — EXCEPT the categories
that anchor the RF picture, re-enabled labels-only (no geometry, dim pin) at
`neutral-500` text / `neutral-600` pin, one step brighter than town names:
hospitals, police, fire stations (public-safety banks), airports (airband),
theme parks (the WoF business channels).

Of those child ids only `pointOfInterest.emergency.hospital` is documented;
the rest are educated camelCase guesses. If the console checker flags one,
click the actual feature on the editor's preview map (the **map inspector**
names the styleable feature under the cursor), fix the id, and mirror it back
here. The same pattern extends to any future category (rail yards, marinas…).

If the console's checker rejects a feature `id`, the authoritative names are
in the style editor's visual-mode **Map features** panel (camelCase the
displayed name); update this file to match whatever the console accepts.

## blank-cursor

Transparent X cursor used by the kiosk display session (cage has no
hide-cursor flag; see `kerchunk-cursor-park.service`).
