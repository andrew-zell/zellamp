import Webamp from 'webamp'
import type { HitRegion, SpotifyState, ThemePayload, WindowLayoutEntry } from '../shared/types'
import { FreeformPlayer } from './freeform'
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
const guardMiddleware = (store: MiddlewareStore) => (next: (a: Action) => unknown) => (action: Action) => {
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
    enableDoubleSizeMode: true,
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
    __initialState: config.doubled ? ({ display: { doubled: true } } as never) : undefined,
  })

  webampRef = webamp
  if (import.meta.env.DEV) (window as unknown as { __webamp: Webamp }).__webamp = webamp
  await webamp.renderWhenReady(document.getElementById('app')!)
  if (config.layout) restorePositions(webamp, config.layout)
  trackId = webamp.store.getState().playlist.trackOrder[0]
  ready = true

  const media = SpotifyMedia.instance!
  const sync = new RemoteSync(webamp, media)
  const skins = new SkinSwitcher(webamp)
  skins.setZoom(config.zoom ?? 1)
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
  interceptWindowDrags(skins)
  watchWebampLayout(webamp, skins)
  addZoomToWebampMenu(() => config.zoom)
  window.widget.onZoom((z) => (config.zoom = z))
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
const WEBAMP_WINDOWS = '#main-window, #equalizer-window, #playlist-window, .gen-window'

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
  private zoom = 1
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
    if (webampEl) webampEl.style.zoom = String(this.zoom)
    if (this.freeform) this.freeform.root.style.zoom = String(this.zoom)
  }

  setState(s: SpotifyState) {
    this.state = s
    this.freeform?.setState(s)
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
    this.key = 'classic'
    this.onChange()
    void this.relayout()
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
      if (!this.freeform && (dx || dy)) shiftWebampWindows(this.webamp, dx / this.zoom, dy / this.zoom)
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

function shiftWebampWindows(webamp: Webamp, dx: number, dy: number) {
  const positions: Record<string, { x: number; y: number }> = {}
  for (const [id, w] of Object.entries(webamp.store.getState().windows.genWindows)) {
    positions[id] = { x: w.position.x + dx, y: w.position.y + dy }
  }
  webamp.store.dispatch({ type: 'UPDATE_WINDOW_POSITIONS', positions, absolute: true } as never)
}

/**
 * Dragging any Webamp title bar / window chrome moves the whole player
 * window (main follows the cursor), so it can cross displays. Webamp's own
 * in-page drag can't leave a window sized to the player.
 */
function interceptWindowDrags(skins: SkinSwitcher) {
  window.addEventListener(
    'mousedown',
    (e) => {
      const target = e.target as Element
      if (e.button !== 0 || !target.classList?.contains('draggable') || !target.closest('#webamp')) return
      e.stopPropagation()
      skins.dragStart()
      window.addEventListener('mouseup', () => skins.dragEnd(), { once: true, capture: true })
    },
    true,
  )
  window.addEventListener('blur', () => skins.dragEnd())
}

/**
 * Adds Zellamp items (Zoom, Skin Browser) to Webamp's right-click menu. The
 * menu is plain DOM (li / li.parent > ul, submenus open on hover), so new
 * items are appended whenever a menu appears.
 */
function addZoomToWebampMenu(currentZoom: () => number) {
  const item = (label: string, onClick: () => void, checked = false) => {
    const li = document.createElement('li')
    li.textContent = label
    if (checked) li.className = 'checked'
    li.addEventListener('click', onClick)
    return li
  }
  new MutationObserver(() => {
    const menu = document.querySelector<HTMLElement>('#webamp-context-menu ul.context-menu')
    if (!menu || menu.dataset.zellamp) return
    menu.dataset.zellamp = '1'
    const hr = document.createElement('li')
    hr.className = 'hr'
    hr.append(document.createElement('hr'))
    const zoom = document.createElement('li')
    zoom.className = 'parent'
    const sub = document.createElement('ul')
    for (const z of [1, 1.5, 2, 3]) sub.append(item(`${z * 100}%`, () => window.widget.setZoom(z), currentZoom() === z))
    zoom.append(sub, 'Zoom')
    menu.append(hr, zoom, item('Skin Browser...', () => window.widget.openSkins()))
  }).observe(document.body, { childList: true, subtree: true })
}

/** Watch for Webamp's context menu and re-fit when windows change. */
function watchWebampLayout(webamp: Webamp, skins: SkinSwitcher) {
  let lastKey = ''
  const check = () => {
    const menus = [...document.querySelectorAll('#webamp-context-menu ul')].map((m) => m.getBoundingClientRect())
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
      return { ...blank, key: 'not-running', title: 'Spotify is not running' }
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
    }
    // Webamp's right-click menus (and their submenus) live outside the windows.
    document.querySelectorAll('#webamp-context-menu ul').forEach(add)
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
