# Freeform skins

Beyond classic Winamp skins, Zellamp runs **freeform skins**: a single SVG of any shape, size or style. Only painted areas take the mouse, so everything transparent clicks through to the desktop. To install one, drop the `.svg` onto the Skin Browser. The built-in ones live in [`scripts/freeform/`](../scripts/freeform/) and make good starting points.

| Skin | Inspiration |
| --- | --- |
| Orb | 2001 console dashboard: green glass orb, radial spectrum, seek ring, translucent blade |
| Luna | XP-era desktop: Luna title bar, Bliss-hill display, block progress bar |
| Liquid Chrome | deviantArt chrome blob: aqua glass eye with a volume ring, sunken LCD |
| Redline | WindowBlinds-style carbon-fiber pod with speaker ears and a red LCD |
| Bondi | Translucent candy-plastic desktop computer, phone-style LCD, jelly buttons |

## Authoring one

Draw it however you like (Illustrator, Figma, by hand), export it as SVG, and tag the parts with `data-za` attributes.

**Root `<svg>`.** Give it a `width` and `height`, plus `data-za-id`, `data-za-name` and `data-za-description`. Optionally add `data-za-panel`: the id of the classic theme that dresses the Skin Browser while your skin is active.

**Buttons.** Tag any element with one of: `play`, `pause`, `playpause`, `stop`, `prev`, `next`, `shuffle`, `repeat`, `vol-up`, `vol-down`, `skins`, `close` or `minimize`. Shuffle and repeat get the class `za-on` while active.

**Text.** Use a `<text data-za="…">` element with one of: `track` ("Artist - Title"), `title`, `artist`, `album`, `time`, `remaining`, `duration`, `status`, `kbps` or `volume-text`.
- `data-za-chars="N"` turns it into a scrolling marquee.
- `data-za-upper` makes it uppercase.
- `<g data-za="time" data-za-font="7seg" data-za-digit="24">` draws a 7-segment LCD clock in the group's `fill`, with dim "off" segments (`data-za-ghost`).

**Visualizer.** Use a `<rect data-za="vis">` to mark the area. Options:
- `data-za-style`: `bars`, `mirror`, `radial` or `scope`
- `data-za-bars`: number of bars
- `data-za-colors`: top-to-bottom colors, comma-separated
- `data-za-peak`: peak-cap color
- `data-za-gap`: space between bars
- `data-za-inner`: inner radius (radial only)
- `data-za-width`: stroke width (radial and scope)

**Seek and volume.**
- *Linear:* a `<g data-za="seek">` (or `volume`) containing a `data-za-part="track"` rect, plus an optional `fill` rect and/or a `thumb`. Add `data-za-orient="vertical"` for a vertical slider.
- *Ring:* a `<circle data-za="seek" data-za-shape="ring" transform="rotate(-90 cx cy)">`. Progress is drawn with a stroke dash, clockwise from 12 o'clock.

**Album art.** Use `<image data-za="art">`.

**Dragging.** Any painted element that isn't a control drags the player. It snaps to screen edges, and its position is remembered per skin.

**Styling.** CSS inside the SVG can key off the root classes `za-playing`, `za-paused`, `za-stopped`, `za-shuffle`, `za-repeat` and `za-offline`. For example, swap the play and pause icons with `.za-playing .play-icon { display: none }`. Pressed controls get `za-pressed`.

For safety, scripts, `foreignObject`, event-handler attributes and remote URLs are stripped. Images must be embedded as `data:` URLs.

## Iterating

Working from a source checkout, edit the SVG in `scripts/freeform/`, run `npm run skins`, and re-apply the skin. Outside a checkout, drop the edited file on the Skin Browser again: a skin installed under the same file name replaces the old copy.
