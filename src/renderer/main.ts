import Webamp from 'webamp'
import type { HitRegion, SpotifyState, ThemePayload, WindowLayoutEntry } from '../shared/types'
import { ArtPanel } from './artPanel'
import { FreeformPlayer } from './freeform'
import { PlayerMenu } from './playerMenu'
import { kitThemeId, loadKit } from './skinKit'
import { SpotifyMedia } from './spotifyMedia'
import { VisSource } from './visSource'
import './style.css'

const vis = new VisSource()
SpotifyMedia.vis = vis

// Webamp's playlist holds exactly one placeholder track; its tags are rewritten
// with whatever Spotify is playing. The URL is never fetched.
const PLACEHOLDER_URL = 'spotify://now-playing'
const SKIN_FILE = /\.(wsz|zip)$/i

let ready = false
let trackId = -1
let webampRef: Webamp | null = null

type Action = { type: string; [k: string]: unknown }
type MiddlewareStore = { getState: () => any; dispatch: (a: Action) => unknown }

/**
 * Sits after Webamp's media middleware. Keeps the single-track playlist intact
 * and forwards shuffle/repeat toggles (which the media middleware ignores).
 */
// Webamp follows every resize with an "ensure windows are on screen" pass.
// Zellamp sizes the window to the player itself (and shifts the windows to
// match), so that pass only fights it: swallow the reposition it dispatches
// in the same tick as the size change.
let suppressReposition = false

const guardMiddleware = (store: MiddlewareStore) => (next: (a: Action) => unknown) => (action: Action) => {
  if (action.type === 'BROWSER_WINDOW_SIZE_CHANGED') {
    suppressReposition = true
    queueMicrotask(() => (suppressReposition = false))
  } else if (action.type === 'UPDATE_WINDOW_POSITIONS' && suppressReposition) {
    return action
  } else if (action.type === 'TOGGLE_WINDOW' && action.windowId === 'equalizer') {
    // The EQ can't shape another app's audio; don't show one that does nothing.
    return action
  }
  const media = SpotifyMedia.instance
  if (ready && !media?.syncing) {
    switch (action.type) {
      // No local files / playlist editing in v1.
      case 'ADD_TRACK_FROM_URL':
      case 'REMOVE_TRACKS':
      case 'REMOVE_ALL_TRACKS':
      // Next/prev from Webamp's menus resolve against the one-track playlist:
      // they arrive as a replay of the same track or a "stopped". Drop them;
      // the real next/prev buttons are routed in interceptTransportClicks().
      case 'PLAY_TRACK':
      case 'BUFFER_TRACK':
      case 'IS_STOPPED':
        return action
    }
  }
  const result = next(action)
  if (ready && !media?.syncing) {
    const { shuffle, repeat } = store.getState().media
    if (action.type === 'TOGGLE_SHUFFLE') void window.spotify.setShuffle(shuffle)
    if (action.type === 'TOGGLE_REPEAT') void window.spotify.setRepeat(repeat)
  }
  return result
}

async function main() {
  // Webamp reports some errors (e.g. an unparseable skin) with alert(). In
  // Electron that's a blocking native dialog attached to our invisible
  // overlay window, which would freeze the widget. Show it in the marquee.
  window.alert = (message?: unknown) => {
    console.warn('[webamp]', message)
    if (webampRef) flashMessage(webampRef, String(message ?? ''))
  }

  const [config, savedSkin] = await Promise.all([window.widget.getConfig(), window.widget.loadSkin()])

  const webamp = new Webamp({
    initialTracks: [{ url: PLACEHOLDER_URL, metaData: { title: 'Connecting to Spotify…', artist: '' }, duration: 0 }],
    initialSkin: savedSkin?.kind === 'classic' ? { url: blobUrl(savedSkin.data) } : undefined,
    windowLayout: config.layout ? toWindowLayout(config.layout) : undefined,
    // Zellamp's Zoom replaces Webamp's double-size mode.
    enableDoubleSizeMode: false,
    enableHotkeys: false,
    enableMediaSession: false,
    zIndex: 10,
    filePickers: [] as never,
    handleTrackDropEvent: () => null,
    handleAddUrlEvent: () => null,
    handleLoadListEvent: () => null,
    handleSaveListEvent: () => null,
    __customMediaClass: SpotifyMedia as never,
    __customMiddlewares: [guardMiddleware as never],
  })

  webampRef = webamp
  if (import.meta.env.DEV) (window as unknown as { __webamp: Webamp }).__webamp = webamp
  await webamp.renderWhenReady(document.getElementById('app')!)
  if (config.layout) restorePositions(webamp, config.layout)
  // First run (or after Reset Window Positions): just the main window. The
  // playlist only ever holds the current track; it's in the right-click menu.
  else webamp.store.dispatch({ type: 'CLOSE_WINDOW', windowId: 'playlist' } as never)
  hideEqualizer(webamp)
  trackId = webamp.store.getState().playlist.trackOrder[0]
  ready = true

  const media = SpotifyMedia.instance!
  const sync = new RemoteSync(webamp, media)
  const skins = new SkinSwitcher(webamp)
  skins.setZoom(config.zoom ?? 1)
  skins.setShowArt(config.showArt ?? true)
  window.widget.onShowArt((show) => skins.setShowArt(show))
  watchDevicePixelRatio(() => skins.setZoom(config.zoom ?? 1))
  window.widget.onZoom((z) => skins.setZoom(z))
  if (import.meta.env.DEV) Object.assign(window, { __skins: skins, __vis: vis })
  const onState = (s: SpotifyState) => {
    sync.apply(s)
    skins.setState(s)
  }
  window.spotify.onState(onState)
  onState(await window.spotify.getState())
  skins.show(savedSkin, false)

  interceptTransportClicks()
  interceptWindowDrags(webamp, skins)
  const menu = installPlayerMenu(webamp)
  watchWebampLayout(webamp, skins, menu)
  window.widget.onZoom((z) => (config.zoom = z))
  window.widget.onShowArt((show) => (config.showArt = show))
  reportHitRegions(webamp, skins)
  persistLayout(webamp)
  persistSkins()
  window.widget.onApplySkin((skin) => skins.show(skin, true))

  // Closing or minimizing Webamp hides the widget; the tray brings it back.
  webamp.onClose(() => window.widget.hide())
  webamp.onMinimize(() => window.widget.hide())
  window.widget.onShown(() => {
    if (webamp.store.getState().media.status === 'CLOSED') webamp.reopen()
  })

  vis.onModeChange = (mode, reason) => {
    window.widget.reportVisMode(mode)
    if (mode === 'fallback') flashMessage(webamp, reason ?? 'Visualizer: no audio capture')
  }
  window.widget.reportVisMode(vis.mode)
  if (vis.mode === 'fallback') flashMessage(webamp, 'Visualizer: no audio capture')
  document.addEventListener('visibilitychange', vis.onVisibilityChange)
}

// Main triggers this with a user gesture so getDisplayMedia is allowed.
let captureStarted = false
;(window as unknown as { __startCapture: () => void }).__startCapture = () => {
  if (captureStarted) return
  captureStarted = true
  void vis.startCapture()
}
// Setup Assistant: try again after the user grants the permission.
;(window as unknown as { __restartCapture: () => void }).__restartCapture = () => {
  if (vis.mode !== 'live') void vis.startCapture()
}

/** Margin around the player for drop shadows. */
const PAD = 10
/** Open menus: ours, plus Webamp's remaining popups (e.g. the playlist's). */
const MENUS = '#za-menu ul, #webamp-context-menu ul'
const WEBAMP_WINDOWS = '#main-window, #equalizer-window, #playlist-window, .gen-window, #za-art:not([hidden])'

/**
 * Swaps between Webamp (classic .wsz skins) and a freeform SVG player, and
 * keeps the window sized to whatever is drawn. Webamp keeps running hidden
 * under freeform skins: it owns the Spotify sync.
 */
class SkinSwitcher {
  private freeform: FreeformPlayer | null = null
  private state: SpotifyState | null = null
  private key = 'classic'
  private laying = false
  private pending = false
  private dragging = false
  private menuOpen = false
  zoom = 1
  private showArt = true
  readonly art = new ArtPanel()
  /** Called when the player appears, moves, or goes away. */
  onChange: () => void = () => {}

  constructor(private webamp: Webamp) {}

  hitRegion(): HitRegion | null {
    return this.freeform?.hitRegion() ?? null
  }

  /** Scale the player (CSS zoom); the window re-fits around it. */
  setZoom(zoom: number) {
    this.zoom = zoom
    this.applyZoom()
    void this.relayout()
  }

  private applyZoom() {
    const webampEl = document.getElementById('webamp')
    if (webampEl) applyPixelZoom(webampEl, this.zoom, () => void this.relayout())
    // Vector skins scale cleanly at any size.
    if (this.freeform) this.freeform.root.style.zoom = String(this.zoom)
  }

  setState(s: SpotifyState) {
    this.state = s
    this.freeform?.setState(s)
    this.art.setState(s)
  }

  setShowArt(show: boolean) {
    this.showArt = show
    this.art.setShow(show)
    this.freeform?.setShowArt(show)
    void this.relayout()
  }

  show(skin: ThemePayload | null, fromUser: boolean) {
    this.freeform?.dispose()
    this.freeform = null
    const webampEl = document.getElementById('webamp')
    if (skin?.kind === 'freeform') {
      if (webampEl) webampEl.style.display = 'none'
      try {
        this.freeform = new FreeformPlayer(
          document.getElementById('app')!,
          new TextDecoder().decode(skin.data),
          {
            analyser: vis.analyser,
            close: () => window.widget.hide(),
            openSkins: () => window.widget.openSkins(),
            dragStart: () => this.dragStart(),
            dragEnd: () => this.dragEnd(),
            moved: () => this.onChange(),
          },
          { x: PAD, y: PAD },
        )
        if (this.state) this.freeform.setState(this.state)
        this.freeform.setShowArt(this.showArt)
        this.art.setActive(false)
        this.applyZoom()
        this.key = skin.id
        this.onChange()
        void this.relayout()
        return
      } catch (err) {
        console.warn('[freeform] could not load skin:', err)
      }
    }
    if (webampEl) webampEl.style.display = ''
    if (skin?.kind === 'classic' && fromUser) this.webamp.setSkinFromUrl(blobUrl(skin.data))
    this.art.setActive(true)
    void this.loadArtFrame(skin)
    this.key = 'classic'
    this.onChange()
    void this.relayout()
  }

  /** Frame the classic art panel in the skin's own chrome colors. */
  private async loadArtFrame(skin: ThemePayload | null) {
    try {
      const { themes, active } = await window.themes.list()
      const read = (id: string) => window.themes.read(id) as Promise<Uint8Array<ArrayBuffer> | null>
      const data = skin?.kind === 'classic' ? (skin.data as Uint8Array<ArrayBuffer>) : await read(kitThemeId(themes, active))
      const kit = await loadKit(data, () => read('classic'))
      this.art.setColors(kit.colors)
    } catch {
      // Keep the default frame.
    }
  }

  /** Size the window to what's drawn (plus shadow margin). */
  async relayout() {
    if (this.laying || this.dragging || this.menuOpen) {
      this.pending = true
      return
    }
    this.laying = true
    try {
      let rect: { x: number; y: number; width: number; height: number } | null = null
      if (this.freeform) {
        const r = this.freeform.hitRegion()
        rect = { x: 0, y: 0, width: r.x + r.w + PAD, height: r.y + r.h + PAD }
      } else {
        this.art.place()
        const boxes = [...document.querySelectorAll(WEBAMP_WINDOWS)]
          .map((el) => el.getBoundingClientRect())
          .filter((r) => r.width > 0 && r.height > 0)
        if (boxes.length) {
          const x = Math.min(...boxes.map((b) => b.left))
          const y = Math.min(...boxes.map((b) => b.top))
          const right = Math.max(...boxes.map((b) => b.right))
          const bottom = Math.max(...boxes.map((b) => b.bottom))
          rect = { x: x - PAD, y: y - PAD, width: right - x + PAD * 2, height: bottom - y + PAD * 2 }
        }
      }
      if (!rect) return
      const { dx, dy } = await window.widget.playerLayout(this.key, rect)
      // The window moved by -dx/-dy on screen; shift Webamp's windows back so
      // nothing visibly jumps.
      // Webamp positions are in its own (unzoomed) pixels.
      if (!this.freeform && (dx || dy)) {
        shiftWebampWindows(this.webamp, dx / this.zoom, dy / this.zoom)
        // React applies the move on a later frame; measuring again before
        // then would see stale positions and shift everything twice.
        await nextFrames(2)
        this.art.place()
      }
    } finally {
      this.laying = false
      if (this.pending) {
        this.pending = false
        void this.relayout()
      }
    }
  }

  dragStart() {
    this.dragging = true
    window.widget.dragStart()
  }

  /** Grow to the whole display for an in-page Webamp drag; returns the content shift. */
  async expandForDrag() {
    this.dragging = true
    const before = [innerWidth, innerHeight].join()
    const { dx, dy } = await window.widget.playerExpand()
    // Wait for the page to see its new size (a few frames at most).
    for (let i = 0; i < 20 && [innerWidth, innerHeight].join() === before; i++) {
      await new Promise((r) => requestAnimationFrame(r))
    }
    if (dx || dy) {
      shiftWebampWindows(this.webamp, dx / this.zoom, dy / this.zoom)
      await nextFrames(2)
    }
    // Webamp keeps dragged windows inside its idea of the page size, which it
    // only updates on resize events; set it now, in its unzoomed pixels.
    this.webamp.store.dispatch({
      type: 'BROWSER_WINDOW_SIZE_CHANGED',
      width: innerWidth / this.zoom,
      height: innerHeight / this.zoom,
    } as never)
    return { dx, dy }
  }

  endExpandedDrag() {
    this.dragging = false
    void this.relayout()
  }

  dragEnd() {
    if (!this.dragging) return
    this.dragging = false
    window.widget.dragEnd()
    void this.relayout()
  }

  /** Right-click menus can extend past the player; grow while one is open. */
  setMenuOpen(open: boolean, extent?: { right: number; bottom: number }) {
    this.menuOpen = open
    if (open && extent) window.widget.playerGrow(extent.right + 4, extent.bottom + 4)
    else void this.relayout()
  }
}

/**
 * Scale pixel art. When zoom × devicePixelRatio is a whole number (100/200/300%
 * anywhere, 150% on Retina) nearest-neighbor is exact. Otherwise (150% on a
 * standard display) each skin pixel would be 1.5 screen pixels, which comes
 * out uneven; instead render at a whole multiple with hard pixels and shrink
 * smoothly ("sharp bilinear"): crisp edges, evenly distributed softening.
 */
function applyPixelZoom(el: HTMLElement, zoom: number, applied: () => void) {
  const device = zoom * devicePixelRatio
  if (Number.isInteger(device)) {
    el.style.zoom = String(zoom)
    el.style.transform = ''
    el.style.willChange = ''
    return applied()
  }
  // e.g. 1.5 → render at 3 device px per skin pixel, then scale by 0.5.
  const k = Number.isInteger(device * 2) ? device * 2 : Math.ceil(device)
  const renderZoom = k / devicePixelRatio
  el.style.zoom = String(renderZoom)
  el.style.transformOrigin = '0 0'
  // Rasterize at the full render size first, then shrink on the compositor
  // (will-change keeps that raster instead of re-rasterizing at 1.5x).
  el.style.willChange = 'transform'
  el.style.transform = 'scale(1)'
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      el.style.transform = `scale(${zoom / renderZoom})`
      applied()
    }),
  )
}

// Re-pick the scaling mode when the player moves to a display with a
// different pixel density.
function watchDevicePixelRatio(onChange: () => void) {
  const watch = () =>
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        onChange()
        watch()
      },
      { once: true },
    )
  watch()
}

const nextFrames = async (n: number) => {
  for (let i = 0; i < n; i++) await new Promise((r) => requestAnimationFrame(r))
}

function shiftWebampWindows(webamp: Webamp, dx: number, dy: number) {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, w] of Object.entries(webamp.store.getState().windows.genWindows)) {
    positions[id] = { x: w.position.x + dx, y: w.position.y + dy }
  }
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true } as never)
}

/** True if every open Webamp window is docked (edge-to-edge) to the main one. */
function webampDocked() {
  const rects = [...document.querySelectorAll(WEBAMP_WINDOWS)]
    .map((el) => ({ id: el.id, r: el.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 0 && r.height > 0)
  const touches = (a: DOMRect, b: DOMRect) =>
    a.left <= b.right + 1 && b.left <= a.right + 1 && a.top <= b.bottom + 1 && b.top <= a.bottom + 1
  const start = rects.find((w) => w.id === 'main-window') ?? rects[0]
  if (!start) return true
  const seen = new Set([start])
  const queue = [start]
  while (queue.length) {
    const cur = queue.shift()!
    for (const w of rects) if (!seen.has(w) && touches(cur.r, w.r)) seen.add(w) && queue.push(w)
  }
  return seen.size === rects.length
}

/**
 * Two kinds of Webamp window drags:
 * - main window while everything's docked: move the whole player window
 *   (main follows the cursor, so it can cross displays);
 * - anything else (undocking the EQ/playlist, moving an undocked window):
 *   expand the window to this display, then let Webamp's own drag run, with
 *   its window-to-window snapping. On release the window shrinks back.
 */
function interceptWindowDrags(webamp: Webamp, skins: SkinSwitcher) {
  let replaying = false
  // Webamp moves a dragged window by the raw mouse delta, but its windows are
  // zoomed, so at 200% they'd move twice as fast as the cursor. While Webamp
  // drags, re-send mouse moves scaled down by the zoom.
  let scaled: { x: number; y: number; zoom: number } | null = null
  window.addEventListener(
    'mousemove',
    (e) => {
      if (!scaled || replaying || scaled.zoom === 1) return
      e.stopPropagation()
      replaying = true
      window.dispatchEvent(
        new MouseEvent('mousemove', {
          clientX: scaled.x + (e.clientX - scaled.x) / scaled.zoom,
          clientY: scaled.y + (e.clientY - scaled.y) / scaled.zoom,
          screenX: e.screenX,
          screenY: e.screenY,
          buttons: e.buttons,
        }),
      )
      replaying = false
    },
    true,
  )
  window.addEventListener(
    'mousedown',
    (e) => {
      if (replaying) return
      const target = e.target as Element
      if (e.button === 0 && target.closest?.('#za-art')) {
        e.preventDefault()
        skins.dragStart()
        window.addEventListener('mouseup', () => skins.dragEnd(), { once: true, capture: true })
        return
      }
      if (e.button !== 0 || !target.classList?.contains('draggable') || !target.closest('#webamp')) return
      const onMain = !!target.closest('#main-window')
      e.stopPropagation()
      e.preventDefault()
      if (onMain && webampDocked()) {
        skins.dragStart()
        window.addEventListener('mouseup', () => skins.dragEnd(), { once: true, capture: true })
        return
      }
      void (async () => {
        const { dx, dy } = await skins.expandForDrag()
        // Replay the press so Webamp starts its own drag at the shifted spot.
        replaying = true
        target.dispatchEvent(
          new MouseEvent('mousedown', {
            bubbles: true,
            cancelable: true,
            clientX: e.clientX + dx,
            clientY: e.clientY + dy,
            screenX: e.screenX,
            screenY: e.screenY,
            button: 0,
            buttons: 1,
          }),
        )
        replaying = false
        scaled = { x: e.clientX + dx, y: e.clientY + dy, zoom: skins.zoom }
        window.addEventListener(
          'mouseup',
          () => {
            scaled = null
            skins.endExpandedDrag()
          },
          { once: true },
        )
      })()
    },
    true,
  )
  window.addEventListener('blur', () => skins.dragEnd())
  void webamp
}

/**
 * One right-click menu for every skin (see PlayerMenu). Takes over Webamp's
 * own menus: right-click anywhere, the title bar's menu button, and the
 * clutter bar's "O".
 */
function installPlayerMenu(webamp: Webamp) {
  const menu = new PlayerMenu((slot) => {
    if (slot !== 'windows') return []
    const webampEl = document.getElementById('webamp')
    if (!webampEl || webampEl.style.display === 'none') return []
    const playlistOpen = Boolean(webamp.store.getState().windows.genWindows.playlist?.open)
    return [
      {
        label: 'Playlist Editor',
        checked: playlistOpen,
        run: () => webamp.store.dispatch({ type: 'TOGGLE_WINDOW', windowId: 'playlist' } as never),
      },
    ]
  })
  window.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault()
      if (menu.el.contains(e.target as Node)) return
      e.stopPropagation()
      void menu.open(e.clientX, e.clientY)
    },
    true,
  )
  window.addEventListener(
    'click',
    (e) => {
      const button = (e.target as Element | null)?.closest('#webamp #option-context, #webamp #button-o')
      if (!button) return
      e.stopPropagation()
      if (menu.isOpen) return menu.close()
      const r = button.getBoundingClientRect()
      void menu.open(r.left, r.bottom)
    },
    true,
  )
  return menu
}

/**
 * Zellamp can't shape another app's audio, so the EQ would do nothing: close
 * it, and close the gap if the playlist was docked under it.
 */
function hideEqualizer(webamp: Webamp) {
  const { genWindows } = webamp.store.getState().windows
  const eq = genWindows.equalizer
  if (!eq?.open) return
  const pl = genWindows.playlist
  const height = eq.shade ? 14 : 116
  if (pl?.open && pl.position.x === eq.position.x && pl.position.y === eq.position.y + height) {
    webamp.store.dispatch({
      type: 'UPDATE_WINDOW_POSITIONS',
      positions: { playlist: { x: pl.position.x, y: eq.position.y } },
      absolute: true,
    } as never)
  }
  webamp.store.dispatch({ type: 'CLOSE_WINDOW', windowId: 'equalizer' } as never)
}

/** Watch for an open menu (grow to fit it) and re-fit when windows change. */
function watchWebampLayout(webamp: Webamp, skins: SkinSwitcher, menu: PlayerMenu) {
  let lastKey = ''
  const check = () => {
    skins.art.place()
    const menus = [...document.querySelectorAll(MENUS)].map((m) => m.getBoundingClientRect())
    const open = menus.some((r) => r.width > 0)
    if (open) {
      skins.setMenuOpen(true, {
        right: Math.max(...menus.map((r) => r.right)),
        bottom: Math.max(...menus.map((r) => r.bottom)),
      })
    } else if (lastKey.startsWith('menu')) skins.setMenuOpen(false)
    const sizes = [...document.querySelectorAll(WEBAMP_WINDOWS)].map((el) => {
      const r = el.getBoundingClientRect()
      return [r.left, r.top, r.width, r.height].map(Math.round).join(',')
    })
    const key = (open ? 'menu' : '') + sizes.join('|')
    if (key !== lastKey) {
      const wasMenu = lastKey.startsWith('menu')
      lastKey = key
      if (!open && !wasMenu) void skins.relayout()
    }
  }
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      check()
    })
  }
  webamp.store.subscribe(schedule)
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  // Submenus open by inline style.
  new MutationObserver(schedule).observe(menu.el, { subtree: true, attributes: true, attributeFilter: ['style'] })
}

/** Pushes Spotify's state into Webamp's store without echoing it back. */
class RemoteSync {
  private metaKey = ''

  constructor(
    private webamp: Webamp,
    private media: SpotifyMedia,
  ) {}

  apply(s: SpotifyState) {
    const { store } = this.webamp
    const dispatch = (a: Action) => store.dispatch(a as never)
    const live = s.availability === 'ok'

    this.media.setRemote(s)
    vis.setPlaying(live && s.state === 'playing')
    if (live) vis.setSpotifyVolume(s.volume)

    this.media.syncing = true
    try {
      const meta = describe(s)
      if (meta.key !== this.metaKey) {
        this.metaKey = meta.key
        dispatch({
          type: 'SET_MEDIA_TAGS',
          id: trackId,
          title: meta.title,
          artist: meta.artist,
          album: meta.album,
          albumArtUrl: meta.art,
          // Spotify Premium streams at up to 320kbps / 44.1kHz. Webamp reads
          // these from the tags action, not SET_MEDIA.
          bitrate: 320_000,
          sampleRate: 44_100,
          numberOfChannels: 2,
        })
        dispatch({ type: 'SET_MEDIA', id: trackId, length: meta.duration })
      }

      const state = store.getState()
      const status = state.media.status as 'PLAYING' | 'PAUSED' | 'STOPPED' | 'CLOSED'
      if (status !== 'CLOSED') {
        if (!live || s.state === 'stopped') {
          if (status !== 'STOPPED') dispatch({ type: 'STOP' })
        } else if (s.state === 'playing') {
          if (status !== 'PLAYING') dispatch({ type: 'IS_PLAYING' })
        } else if (status === 'PLAYING') {
          dispatch({ type: 'PAUSE' })
        } else if (status === 'STOPPED' && s.positionSec > 0.5) {
          // Our Stop is pause+rewind; only show "paused" once Spotify moved on.
          dispatch({ type: 'PAUSE' })
        }
      }

      if (live) {
        // Let a local volume drag settle before trusting Spotify's echo.
        const recentLocal = Date.now() - this.media.lastLocalVolumeAt < 1500
        if (!recentLocal && Math.round(s.volume) !== state.media.volume) {
          dispatch({ type: 'SET_VOLUME', volume: Math.round(s.volume) })
        }
        if (s.shuffling !== state.media.shuffle) dispatch({ type: 'TOGGLE_SHUFFLE' })
        if (s.repeating !== state.media.repeat) dispatch({ type: 'TOGGLE_REPEAT' })
      }
    } finally {
      this.media.syncing = false
    }
  }
}

function describe(s: SpotifyState) {
  const blank = { artist: '', album: '', art: null as string | null, duration: 0 }
  switch (s.availability) {
    case 'not-running':
      return { ...blank, key: 'not-running', title: s.idleText ?? 'Spotify is not running' }
    case 'not-authorized':
      return {
        ...blank,
        key: 'not-authorized',
        title: 'Allow control of Spotify in System Settings > Privacy & Security > Automation',
      }
    case 'error':
      return { ...blank, key: 'error', title: "Can't reach Spotify" }
  }
  if (!s.track) return { ...blank, key: 'idle', title: 'Spotify: nothing playing' }
  const t = s.track
  return {
    key: `${t.id}|${t.name}|${t.artist}|${t.durationMs}|${t.artworkUrl}`,
    title: t.name,
    artist: t.artist,
    album: t.album,
    art: t.artworkUrl || null,
    duration: t.durationMs / 1000,
  }
}

/**
 * Webamp's next/prev walk its own playlist. Route the real buttons straight to
 * Spotify instead, in the capture phase so Webamp's handlers never see them.
 * Eject would open a file dialog for local media, which v1 doesn't support.
 */
function interceptTransportClicks() {
  const routes: [string, () => void][] = [
    ['#next, .playlist-next-button', () => void window.spotify.next()],
    ['#previous, .playlist-previous-button', () => void window.spotify.prev()],
    ['#eject, .playlist-eject-button', () => {}],
  ]
  window.addEventListener(
    'click',
    (e) => {
      const target = e.target as Element | null
      for (const [selector, run] of routes) {
        if (target?.closest(`#webamp ${selector.split(', ').join(', #webamp ')}`)) {
          e.stopPropagation()
          e.preventDefault()
          run()
          return
        }
      }
    },
    true,
  )
}

/**
 * The overlay covers the screen; main decides when it takes the mouse by
 * polling the cursor against these regions (see main/hitTest.ts). Report
 * them whenever the player moves, a menu opens, or the skin changes.
 */
function reportHitRegions(webamp: Webamp, skins: SkinSwitcher) {
  let last = ''
  const report = () => {
    const regions: HitRegion[] = []
    const add = (el: Element) => {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0) regions.push({ x: r.x, y: r.y, w: r.width, h: r.height })
    }
    const webampEl = document.getElementById('webamp')
    if (webampEl && webampEl.style.display !== 'none') {
      webampEl.querySelectorAll('#main-window, #equalizer-window, #playlist-window, .gen-window').forEach(add)
      document.querySelectorAll('#za-art:not([hidden])').forEach(add)
    }
    // Menus (and their submenus) live outside the windows.
    document.querySelectorAll(MENUS).forEach(add)
    const ff = skins.hitRegion()
    if (ff) regions.push(ff)
    const key = JSON.stringify(regions)
    if (key === last) return
    last = key
    window.widget.setHitRegions(regions)
  }
  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      report()
    })
  }
  webamp.store.subscribe(schedule)
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style'] })
  window.addEventListener('resize', schedule)
  skins.onChange = schedule
  // Safety net for anything the observers miss.
  setInterval(report, 1000)
  report()

  // Keep the mouse while dragging, even if the cursor outruns the player.
  window.addEventListener('pointerdown', () => window.widget.setDragging(true), true)
  window.addEventListener('pointerup', () => window.widget.setDragging(false), true)
  window.addEventListener('blur', () => window.widget.setDragging(false))
}

function persistLayout(webamp: Webamp) {
  let last = ''
  webamp.store.subscribe(() => {
    const state = webamp.store.getState()
    const layout: Record<string, WindowLayoutEntry> = {}
    for (const [id, w] of Object.entries(state.windows.genWindows)) {
      layout[id] = { x: w.position.x, y: w.position.y, open: w.open, shade: Boolean(w.shade) }
    }
    const doubled = state.display.doubled
    const key = JSON.stringify([layout, doubled])
    if (key === last) return
    last = key
    window.widget.saveLayout(layout, doubled)
  })
}

function toWindowLayout(layout: Record<string, WindowLayoutEntry>) {
  const out: Record<string, { position: { left: number; top: number }; shadeMode: boolean; closed: boolean }> = {}
  for (const id of ['main', 'equalizer', 'playlist']) {
    const w = layout[id]
    if (w) out[id] = { position: { left: w.x, top: w.y }, shadeMode: w.shade, closed: !w.open }
  }
  return out
}

/** Webamp centers windows on first render; put them back where they were. */
function restorePositions(webamp: Webamp, layout: Record<string, WindowLayoutEntry>) {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, w] of Object.entries(layout)) positions[id] = { x: w.x, y: w.y }
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true } as never)
}

/**
 * Webamp loads dropped / menu-picked skins itself; we just keep a copy so the
 * skin survives restarts.
 */
function persistSkins() {
  const save = async (file: File | undefined) => {
    if (!file || !SKIN_FILE.test(file.name)) return
    await window.widget.saveSkin(file.name, new Uint8Array(await file.arrayBuffer()))
  }
  window.addEventListener('drop', (e) => void save(e.dataTransfer?.files[0]), true)

  // Webamp's "Load Skin…" menu uses a detached <input type=file>, whose
  // change event never reaches the document. Hook it at the source.
  const originalClick = HTMLInputElement.prototype.click
  HTMLInputElement.prototype.click = function (this: HTMLInputElement) {
    if (this.type === 'file' && !this.isConnected) {
      this.addEventListener('change', () => void save(this.files?.[0]), { once: true })
    }
    return originalClick.call(this)
  }
}

function flashMessage(webamp: Webamp, message: string) {
  webamp.store.dispatch({ type: 'SET_USER_MESSAGE', message } as never)
  setTimeout(() => webamp.store.dispatch({ type: 'UNSET_USER_MESSAGE' } as never), 6000)
}

function blobUrl(data: Uint8Array) {
  return URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>]))
}

void main()
