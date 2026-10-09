# Zellamp

A frameless, always-on-top Winamp 2 skin ([Webamp](https://github.com/captbaritone/webamp)) that remote-controls and visualizes the **Spotify macOS app**. Spotify does all the playing. The widget handles transport, metadata, and a live spectrum.

## Run

```bash
npm install
npm run dev
```

If `npm run dev` says "Electron uninstall", the Electron binary didn't download during install. Run `node node_modules/electron/install.js` to fetch it.

Zellamp is a regular app, with a Dock icon, Cmd-Tab and its own menu bar. It also has a menu-bar tray icon (lightning bolt). **Widget › Show in Dock** turns it into a tray-only accessory. The **Controls** menu has Play/Pause (⌘P) and Next/Previous (⌘→ / ⌘←).

## Themes

**Widget › Skin Browser… (⌘T)** lists every installed skin with a preview rendered from the skin file. As in Winamp 2, clicking a skin (or arrowing through the list) applies it immediately. To install skins, drop `.wsz` files onto it, use **Install…**, or drop one onto the widget. **Remove** (or Delete) uninstalls the selected installed skin.

Zellamp's own windows (Skin Browser, Setup Assistant) are built from the active skin, and re-skin when you switch:
- window chrome and title font come from `gen.bmp`
- lettering comes from `text.bmp`
- list colors come from `pledit.txt`
- bevels are sampled from the chrome

They're drawn at Winamp pixel size and scaled 1.5x. The kit lives in `src/renderer/skinKit.ts` and `waui.ts`.

Built-in themes (generated, not hand-pixeled):

| Theme | Look |
| --- | --- |
| Winamp Classic | The untouched Winamp 2.91 base skin |
| Neon Arcade | Synthwave purple, cyan LCD, hot-pink sliders, scanlines |
| Walnut Hi-Fi | 70s receiver: wood grain, amber display, brass |
| Arctic Glass | Light, frosted, ice-blue display |
| Phosphor | Monochrome green-screen terminal |
| Bubblegum | Y2K candy plastic, pastel pink and mint |
| Graphite Pro | Brushed titanium, ice-blue readout, orange accents (default) |

`npm run themes` regenerates them into `resources/themes/`. Under the hood:
1. `scripts/extract-base-skin.mjs` pulls the base skin's sprites out of Webamp's bundle.
2. `scripts/themes/sheets.js` rebuilds the real Winamp sprite sheets from them.
3. `scripts/themes/engine.js` sorts every pixel into chrome, LCD, gold or red, and maps each class through that theme's color ramps.
4. It then adds a texture and re-letters the title bars "ZELLAMP".
5. The result is written out as real `.wsz` files, which work in any Winamp-compatible player.

To make a new theme, add a recipe to `scripts/themes/themes.cjs`.

### Install and first run

The DMG window shows drag-to-Applications instructions. A DMG can't run code, so the permission walkthrough happens in the app: on first launch, the **Setup Assistant** checks for Spotify, asks for Automation access, and optionally enables the real visualizer. It shows live status as you grant each one. Reopen it any time from **Widget › Setup Assistant…**. `npm run dmg-background` regenerates the DMG artwork.

### Stable permissions across rebuilds

macOS ties privacy permissions to the app's code signature. An ad-hoc signature is a hash of the build, so every rebuild looks like a new app. System Settings then still shows "Zellamp" switched on, but for an older copy. To make the identity stable, create a local signing certificate once:

1. Open **Keychain Access**, then choose **Keychain Access › Certificate Assistant › Create a Certificate…**
2. Name: `Zellamp Local Signing`. Identity Type: **Self-Signed Root**. Certificate Type: **Code Signing**. Click **Create**.

`npm run dist` then re-signs with it automatically (see `scripts/sign.cjs`). Grant permissions once, and they'll survive rebuilds.

If a permission looks on but Zellamp says it's denied, the entry is stale. Select Zellamp in that Settings list, click **−**, then click **Enable** again in the Setup Assistant.

### Permissions

| Prompt | Needed for | If denied |
| --- | --- | --- |
| Automation: control Spotify | All transport and metadata | Marquee says so. Re-enable in System Settings › Privacy & Security › Automation |
| Screen & System Audio Recording | Real spectrum and oscilloscope | A synthetic vis runs while playing. Grant it, then restart the app |

In dev these permissions attach to **Electron.app**. The packaged build asks as **Zellamp**. The package is ad-hoc signed, so macOS may ask again after each rebuild.

## Freeform skins

Beyond classic Winamp skins, Zellamp runs **freeform skins**: a single SVG of any shape, size or style. Only painted areas take the mouse, so everything transparent clicks through to the desktop. Built-in freeform skins live in `scripts/freeform/`. Run `npm run skins` after editing them. To install your own, drop an `.svg` onto the Skin Browser.

| Skin | Inspiration |
| --- | --- |
| Orb | 2001 console dashboard: green glass orb, radial spectrum, seek ring, translucent blade |
| Luna | XP-era desktop: Luna title bar, Bliss-hill display, block progress bar |
| Liquid Chrome | deviantArt chrome blob: aqua glass eye with a volume ring, sunken LCD |
| Redline | WindowBlinds-style carbon-fiber pod with speaker ears and a red LCD |
| Bondi | Translucent candy-plastic desktop computer, phone-style LCD, jelly buttons |

### Authoring one

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

## How it works

```
Renderer: Webamp + SpotifyMedia shim + VisSource
   ▲ state push              │ commands (contextBridge, sandboxed)
Main:  StateBridge ── SpotifyController (osascript)
       ├ com.spotify.client.PlaybackStateChanged (instant updates)
       └ poll: 5s resync, or 500ms if notifications go missing
```

- **`src/main/spotify.ts`**: the only code that talks to Spotify. It uses two static AppleScripts, and arguments only ever go through argv. A read is one Apple Event for all player properties, plus the track ID. Full track metadata is only fetched when the ID changes, so a steady-state read takes about 120ms.
- **`src/main/stateBridge.ts`**: holds the authoritative state.
  - Notifications are applied immediately, then confirmed by a read.
  - Commands are applied optimistically.
  - Reads that started before a command are discarded so the UI doesn't flicker back.
- **`src/renderer/spotifyMedia.ts`**: Webamp's `__customMediaClass`. Webamp drives it as if it were the audio element, and it forwards calls to Spotify. It also reports interpolated position and duration back to Webamp.
- **`src/renderer/visSource.ts`**: owns the `AnalyserNode` returned from `getAnalyser()`, so **Webamp's own visualizer** (bars or scope, using skin colors) draws Spotify's audio.
  - Captured audio is auto-gained to compensate for Spotify's volume, and silence stays flat.
  - When nothing is playing or the widget is hidden, the AudioContext is suspended.
- **Window**: one transparent, click-through overlay over the display's work area.
  - The renderer turns mouse passthrough off while the cursor is over a Webamp window.
  - Dragging, window docking and edge snapping are therefore Webamp's native behavior.

## Known limitations (v1)

- **The visualizer hears all system audio**, including notifications and calls, not just Spotify. The v2 plan is a Core Audio process tap filtered to Spotify's PID. Anything connected to `VisSource.input` works, so only `startCapture()` changes.
- **Next/Prev** work from the main-window and playlist-window buttons. The same items in Webamp's right-click menu are no-ops, because Webamp resolves them against its own one-track playlist.
- **Cosmetic only**: equalizer, balance and the playlist editor. There's no local-file playback.
- Webamp's marquee format is `1. Artist - Title (m:ss)`, as in real Winamp. Podcasts have no artist.
- Spotify's **Stop** doesn't exist. Stop means pause and rewind to 0:00.
- The overlay covers the primary display only.
- Dragging a skin onto the widget only works once the cursor has hovered it, because macOS doesn't deliver drag events to a click-through window before then. The Theme Gallery always accepts drops.
- **No Spotify queue (yet).** AppleScript only exposes the current track. Showing Spotify's queue in the playlist window needs the Spotify Web API: a free developer app and Client ID, plus a one-time OAuth login.

## Config

`~/Library/Application Support/Zellamp/config.json` holds window positions, double-size mode, always-on-top, Dock visibility and the active theme. Installed skins live in `themes/` next to it.

## Package

```bash
npm run dist   # ad-hoc-signed arm64 .dmg in dist/ (fine for personal use)
```

Set up signing and notarization in electron-builder before distributing. Hardened runtime and entitlements are already configured in `resources/entitlements.mac.plist`.

## Dev tooling

`WR_DEBUG_PORT=9333 npm run dev` opens a remote-debugging port. You can then attach Chrome DevTools at `chrome://inspect`, and `window.__webamp` exposes the Webamp instance. `WR_OPEN_GALLERY=1` opens the Theme Gallery at launch.
