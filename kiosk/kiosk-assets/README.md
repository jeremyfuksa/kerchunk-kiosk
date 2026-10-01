# Kiosk assets

## map-style.json

The cloud-based map style for the `/map` view and the kiosk's map stage —
Night desk cartography, minimal so the blips take precedence.

**This file is NOT loaded by code.** The live copy lives in the Google Cloud
console (Maps Platform → Map styles), associated with the Map ID stored in
`config.display.googleMapsMapId`. This is the version-controlled master; the
round-trip is manual:

1. Edit `map-style.json` here.
2. Console → Map styles → the kerchunk style → JSON tab → paste → Save →
   **Publish** (a saved-but-unpublished draft changes nothing).
3. Wait a couple of minutes for propagation, then reload the map page /
   `sudo systemctl restart kerchunk-display` for the kiosk.

Color map (Night desk, the `--kc-map-*` tokens):

| Layer | Token | Hex |
|---|---|---|
| Land / base | `--kc-map-land` (= `--kc-ground`) | `#15191f` |
| Water | `--kc-map-water` (= `--kc-well`, the LCD glass) | `#0c1113` |
| Roads (geometry only, no labels/shields) | `--kc-map-road` (= `--kc-line`) | `#232a31` |
| Highway stroke | `--kc-map-road-edge` | `#2c343e` |
| Water labels, town names | `--kc-map-label` | `#5d6672` |
| Emergency / airport / theme-park labels, their pins | `--kc-map-poi` / `--kc-map-label` | `#747e8b` / `#5d6672` |

The tokens live in `kiosk/src/frontend/tokens.css` (Night desk, spec
`docs/superpowers/specs/2026-10-01-kiosk-faceplate-design.md`), and
`test/mapStyle.test.ts` fails if this file or `map.ts` `DARK_STYLE` uses a
colour that isn't one of them — edit the token and the hex together.

Town names are deliberately dimmed for across-the-room kiosk reading (≈2.9:1
on land). POIs are hidden as a class — the activity blips are the map's
subject — EXCEPT the categories that anchor the RF picture, re-enabled
labels-only (no geometry, dim pin) at `--kc-map-poi`, one step brighter than
town names:
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
