import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import {
  IPC,
  type AboutInfo,
  type AboutLink,
  type AppConfig,
  type HitMask,
  type HitRegion,
  type PlayerMenuItem,
  type SetupAction,
  type SetupStatus,
  type SpotifyCommand,
  type SpotifyState,
  type ThemeList,
  type ThemePayload,
  type VisMode,
  type WindowLayoutEntry,
} from '../shared/types'

const command = (cmd: SpotifyCommand) => ipcRenderer.invoke(IPC.command, cmd) as Promise<void>

const spotify = {
  playpause: () => command({ type: 'playpause' }),
  play: () => command({ type: 'play' }),
  pause: () => command({ type: 'pause' }),
  next: () => command({ type: 'next' }),
  prev: () => command({ type: 'prev' }),
  seek: (seconds: number) => command({ type: 'seek', seconds }),
  setVolume: (volume: number) => command({ type: 'setVolume', volume }),
  setShuffle: (value: boolean) => command({ type: 'setShuffle', value }),
  setRepeat: (value: boolean) => command({ type: 'setRepeat', value }),
  getState: () => ipcRenderer.invoke(IPC.getState) as Promise<SpotifyState>,
  onState: (cb: (state: SpotifyState) => void) => {
    const listener = (_e: IpcRendererEvent, state: SpotifyState) => cb(state)
    ipcRenderer.on(IPC.state, listener)
    return () => void ipcRenderer.removeListener(IPC.state, listener)
  },
}

const widget = {
  setHitRegions: (regions: HitRegion[]) => ipcRenderer.send(IPC.hitRegions, regions),
  setHitMask: (mask: HitMask) => ipcRenderer.send(IPC.hitMask, mask),
  setDragging: (dragging: boolean) => ipcRenderer.send(IPC.dragging, dragging),
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<AppConfig>,
  saveLayout: (layout: Record<string, WindowLayoutEntry>, doubled: boolean) =>
    ipcRenderer.send(IPC.saveLayout, layout, doubled),
  saveSkin: (name: string, data: Uint8Array) => ipcRenderer.invoke(IPC.saveSkin, name, data) as Promise<void>,
  loadSkin: () => ipcRenderer.invoke(IPC.loadSkin) as Promise<ThemePayload | null>,
  openSkins: () => ipcRenderer.send(IPC.openSkins),
  /** Make the window exactly `rect` (page coords); returns the content shift to apply. */
  playerLayout: (key: string, rect: { x: number; y: number; width: number; height: number }) =>
    ipcRenderer.invoke(IPC.playerLayout, key, rect) as Promise<{ dx: number; dy: number }>,
  playerGrow: (width: number, height: number) => ipcRenderer.send(IPC.playerGrow, width, height),
  playerExpand: () => ipcRenderer.invoke(IPC.playerExpand) as Promise<{ dx: number; dy: number }>,
  dragStart: () => ipcRenderer.send(IPC.playerDragStart),
  dragEnd: () => ipcRenderer.send(IPC.playerDragEnd),
  setZoom: (zoom: number) => ipcRenderer.send(IPC.playerSetZoom, zoom),
  onZoom: (cb: (zoom: number) => void) => {
    ipcRenderer.on(IPC.playerZoom, (_e, z: number) => cb(z))
  },
  /** The right-click menu's items (see PlayerMenuItem). */
  getMenu: () => ipcRenderer.invoke(IPC.playerMenu) as Promise<PlayerMenuItem[]>,
  menuAction: (action: number) => ipcRenderer.send(IPC.playerMenuAction, action),
  setShowArt: (show: boolean) => ipcRenderer.send(IPC.playerSetArt, show),
  onShowArt: (cb: (show: boolean) => void) => {
    ipcRenderer.on(IPC.playerArt, (_e, show: boolean) => cb(show))
  },
  hide: () => ipcRenderer.send(IPC.hideWindow),
  /** Size a Zellamp panel window to PANEL_SIZE at the given zoom. */
  fitPanel: (scale: number) => ipcRenderer.send(IPC.panelFit, scale),
  onShown: (cb: () => void) => {
    ipcRenderer.on(IPC.shown, () => cb())
  },
  reportVisMode: (mode: VisMode) => ipcRenderer.send(IPC.visMode, mode),
  /** A theme chosen in the gallery or menus (already persisted by main). */
  onApplySkin: (cb: (skin: ThemePayload) => void) => {
    ipcRenderer.on(IPC.applySkin, (_e, skin) => cb(skin))
  },
}

const themes = {
  list: () => ipcRenderer.invoke(IPC.themesList) as Promise<ThemeList>,
  read: (id: string) => ipcRenderer.invoke(IPC.themeRead, id) as Promise<Uint8Array | null>,
  apply: (id: string) => ipcRenderer.invoke(IPC.themeApply, id) as Promise<void>,
  remove: (id: string) => ipcRenderer.invoke(IPC.themeRemove, id) as Promise<void>,
  installDialog: () => ipcRenderer.invoke(IPC.themeInstallDialog) as Promise<void>,
  install: (name: string, data: Uint8Array) =>
    ipcRenderer.invoke(IPC.themeInstallData, name, data) as Promise<{ error?: string }>,
  reveal: () => ipcRenderer.send(IPC.themesReveal),
  onChanged: (cb: (list: ThemeList) => void) => {
    ipcRenderer.on(IPC.themesChanged, (_e, list: ThemeList) => cb(list))
  },
}

const setup = {
  status: () => ipcRenderer.invoke(IPC.setupStatus) as Promise<SetupStatus>,
  action: (action: SetupAction) => ipcRenderer.invoke(IPC.setupAction, action) as Promise<SetupStatus>,
  onChanged: (cb: (status: SetupStatus) => void) => {
    ipcRenderer.on(IPC.setupChanged, (_e, status: SetupStatus) => cb(status))
  },
}

const about = {
  info: () => ipcRenderer.invoke(IPC.aboutInfo) as Promise<AboutInfo>,
  open: (link: AboutLink) => ipcRenderer.send(IPC.aboutOpen, link),
}

contextBridge.exposeInMainWorld('about', about)
contextBridge.exposeInMainWorld('spotify', spotify)
contextBridge.exposeInMainWorld('setup', setup)
contextBridge.exposeInMainWorld('widget', widget)
contextBridge.exposeInMainWorld('themes', themes)

export type SpotifyApi = typeof spotify
export type WidgetApi = typeof widget
export type ThemesApi = typeof themes
export type SetupApi = typeof setup
export type AboutApi = typeof about
