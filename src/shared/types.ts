export type PlayerState = 'playing' | 'paused' | 'stopped'

/** Whether we can talk to Spotify at all. */
export type Availability = 'ok' | 'not-running' | 'not-authorized' | 'error'

export interface Track {
  id: string
  name: string
  artist: string
  album: string
  durationMs: number
  artworkUrl: string
}

export interface SpotifyState {
  availability: Availability
  state: PlayerState
  track: Track | null
  /** Position at `sampledAt`. The renderer interpolates forward while playing. */
  positionSec: number
  /** Epoch ms (main-process clock) when positionSec was sampled. */
  sampledAt: number
  volume: number
  shuffling: boolean
  repeating: boolean
  /** Shown when nothing's available ("Spotify is not running" / "Nothing is playing"). */
  idleText?: string
}

export type SpotifyCommand =
  | { type: 'playpause' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; seconds: number }
  | { type: 'setVolume'; volume: number }
  | { type: 'setShuffle'; value: boolean }
  | { type: 'setRepeat'; value: boolean }

export interface WindowLayoutEntry {
  x: number
  y: number
  open: boolean
  shade: boolean
}

export interface AppConfig {
  alwaysOnTop: boolean
  /** Regular app (Dock, Cmd-Tab, menu bar) vs. tray-only accessory. */
  showInDock: boolean
  /** Setup Assistant completed (or dismissed). */
  onboarded: boolean
  /** Saved screen position of the player window, per skin ('classic' or a freeform id). */
  playerPos: Record<string, { x: number; y: number }>
  /** Player zoom (on top of Webamp's own double-size mode). */
  zoom: number
  /** Show album art on the player. */
  showArt: boolean
  /** Active theme id (see src/main/themes.ts). */
  theme: string
  /** Webamp window positions, keyed by window id ('main', 'equalizer', 'playlist'). */
  layout: Record<string, WindowLayoutEntry> | null
  doubled: boolean
}

/**
 * Zellamp's own windows (skin browser, setup) are drawn at Winamp pixel size
 * and scaled up. Pixel art needs a whole number of device pixels per skin
 * pixel, so the zoom depends on the display: 3 device px on Retina (1.5x),
 * 2 device px on standard-density displays (2x).
 */
export const ZOOM_LEVELS = [1, 1.5, 2, 3] as const

export const PANEL_SIZE = { width: 500, height: 348 } as const
export function panelScale(devicePixelRatio: number) {
  return (devicePixelRatio >= 1.5 ? 3 : 2) / devicePixelRatio
}

/** Where the player is, in overlay coordinates (CSS px). */
export interface HitRegion {
  x: number
  y: number
  w: number
  h: number
  /** Freeform skins: only pixels set in this mask count as the player. */
  maskId?: string
}

/** Alpha mask for a freeform skin: 1 byte per pixel, nonzero = painted. */
export interface HitMask {
  id: string
  w: number
  h: number
  data: Uint8Array
}

export interface ThemeInfo {
  id: string
  name: string
  description: string
  /** builtin: Winamp Classic; zellamp: shipped with the app; installed: added by the user */
  source: 'builtin' | 'zellamp' | 'installed'
  /** classic: a Winamp 2 .wsz rendered by Webamp; freeform: a Zellamp SVG skin. */
  kind: 'classic' | 'freeform'
  /** Freeform skins: which classic theme dresses Zellamp's own windows. */
  panel?: string
}

/** A theme as delivered to the widget. */
export interface ThemePayload {
  id: string
  kind: ThemeInfo['kind']
  data: Uint8Array
}

export interface ThemeList {
  themes: ThemeInfo[]
  active: string
}

export type VisMode = 'starting' | 'live' | 'fallback'

export interface SetupStatus {
  spotify: 'missing' | 'not-running' | 'running'
  /** Automation permission to send Apple Events to Spotify. */
  control: 'granted' | 'denied' | 'unknown'
  visualizer: VisMode
  platform: 'darwin' | 'win32' | 'linux'
  /** What macOS reports for Screen & System Audio Recording. */
  screenAccess: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
}

export type SetupAction =
  | 'open-spotify'
  | 'get-spotify'
  | 'request-control'
  | 'open-automation-settings'
  | 'request-visualizer'
  | 'open-screen-settings'
  | 'relaunch'
  | 'open-skins'
  | 'finish'

/**
 * The player's right-click menu, built by main and drawn in the page (in
 * Webamp's menu style) so it looks the same for every skin. `action` is
 * sent back to main when clicked; `slot` marks where the page inserts its
 * own items.
 */
export interface PlayerMenuItem {
  label?: string
  checked?: boolean
  separator?: boolean
  action?: number
  slot?: 'windows'
  submenu?: PlayerMenuItem[]
}

export interface AboutInfo {
  version: string
  platform: string
}

/** Links the About window may open. */
export type AboutLink = 'website' | 'licenses'

export const IPC = {
  command: 'spotify:command',
  getState: 'spotify:get-state',
  state: 'spotify:state',
  hitRegions: 'app:hit-regions',
  hitMask: 'app:hit-mask',
  dragging: 'app:dragging',
  getConfig: 'app:get-config',
  saveLayout: 'app:save-layout',
  saveSkin: 'app:save-skin',
  loadSkin: 'app:load-skin',
  applySkin: 'app:apply-skin',
  themesList: 'themes:list',
  themeRead: 'themes:read',
  themeApply: 'themes:apply',
  themeRemove: 'themes:remove',
  themeInstallDialog: 'themes:install-dialog',
  themeInstallData: 'themes:install-data',
  themesChanged: 'themes:changed',
  themesReveal: 'themes:reveal',
  visMode: 'vis:mode',
  openSkins: 'app:open-skins',
  playerLayout: 'player:layout',
  playerGrow: 'player:grow',
  playerExpand: 'player:expand',
  playerDragStart: 'player:drag-start',
  playerDragEnd: 'player:drag-end',
  playerSetZoom: 'player:set-zoom',
  playerZoom: 'player:zoom',
  playerMenu: 'player:menu',
  playerMenuAction: 'player:menu-action',
  playerSetArt: 'player:set-art',
  playerArt: 'player:art',
  visRestart: 'vis:restart',
  setupStatus: 'setup:status',
  setupAction: 'setup:action',
  setupChanged: 'setup:changed',
  hideWindow: 'app:hide-window',
  aboutInfo: 'about:info',
  aboutOpen: 'about:open',
  panelFit: 'app:panel-fit',
  shown: 'app:shown',
} as const
