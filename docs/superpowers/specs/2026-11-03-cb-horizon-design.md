# CB wall: The Horizon

Replaces the layout of the CB stage from `2026-10-14` ("the dial"). The operator asked for CB to meet the visual standard of map mode and the Atlas (#323), and picked direction A from the [mockups](https://claude.ai/artifact/9aKPfHeuKoWjPDXawkN45c). What CB hears, logs and fades doesn't change.

## The picture

- **Sky:** full screen, in four states from the sun's real height at home (day, low sun, twilight, night), using the Atlas's colours, with its seeded still stars at night. It only changes when the state does.
- **Horizon:** a dark ground across the bottom. 40 masts stand on it, one per channel, at true frequency spacing. 6, 9 and 19 are taller and labelled, as are 1 and every fifth channel.
- **History:** a channel's mast is taller and brighter for its existing fade step (`display.cb.fadeStepsMin`).
- **The live station:** its mast turns amber. Rings grow out of its top over `display.hf.hitGrowMs` and hold still while it plays, then fade over `hitFadeMs`. A wall that loads while a channel plays draws them held, with no animation.
- **Text:** "CB" top left. The readout on a translucent plate below it, with all its current data and states. The log under the clock. A dim band along the bottom with the count heard.
- **Alert banner:** still shows over the stage.

## Constraints

As for the Atlas: only the live layer moves, no blur, no `backdrop-filter`, no standing animation. Layers repaint only when what they show changes. The fade steps and the sky change on the existing `stepTickMs` timer.

## Calls I made

Amber for live, teal for recent, matching the mockup. Rings hold still, without the HF wall's pulses: no line to travel along. Timings reuse `display.hf`, because a second set would never differ.
