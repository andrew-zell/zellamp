import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  type MenuItemConstructorOptions,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray,
} from 'electron'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  IPC,
  PANEL_SIZE,
  type AboutLink,
  ZOOM_LEVELS,
  panelScale,
  type AppConfig,
  type HitMask,
  type HitRegion,
  type PlayerMenuItem,
  type SetupAction,
  type SetupStatus,
  type SpotifyCommand,
  type ThemeList,
  type VisMode,
  type WindowLayoutEntry,
} from '../shared/types'
import { loadConfig, saveConfig } from './config'
import { MacSpotifySource } from './sources/macSpotify'
import type { MediaSource } from './sources/types'
import { WindowsMediaSource } from './sources/windowsMedia'
import { HitTester } from './hitTest'
import { PlayerWindow } from './player'
import { StateBridge } from './stateBridge'
import { installTheme, listThemes, readTheme, removeTheme, themeExists, themeInfo, userThemesDir } from './themes'
import { TRAY_ICON_1X, TRAY_ICON_2X, TRAY_ICON_COLOR_1X, TRAY_ICON_COLOR_2X } from './trayIcon'

// Never let Chromium grab the hardware media keys: those belong to Spotify.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling,MediaSessionService')
// Dev-only: attach DevTools/CDP tooling, e.g. WR_DEBUG_PORT=9333 npm run dev
if (!app.isPackaged && process.env.WR_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.WR_DEBUG_PORT)
}

// One Zellamp at a time (dev and packaged builds share settings): a second
// launch just brings the running one forward.
// Dev-only: a separate profile, so a dev build can run beside the installed app.
if (!app.isPackaged && process.env.WR_USER_DATA) app.setPath('userData', process.env.WR_USER_DATA)

if (!app.requestSingleInstanceLock()) {
  app.quit()
}
app.on('second-instance', () => showWindow())

let win: BrowserWindow | null = null
let hits: HitTester | null = null
let player: PlayerWindow | null = null
let gallery: BrowserWindow | null = null
let setup: BrowserWindow | null = null
let about: BrowserWindow | null = null
let visMode: VisMode = 'starting'
let tray: Tray | null = null
let config: AppConfig
const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'

/** What's playing and how to control it, per platform (see sources/types.ts). */
function createSource(): MediaSource {
  if (isWindows) return new WindowsMediaSource()
  return new MacSpotifySource()
}

const bridge = new StateBridge(createSource(), (state) => {
  win?.webContents.send(IPC.state, state)
  pushSetupStatus()
})

/**
 * The window is a transparent, click-through overlay covering the display's
 * work area. Webamp's own windows live inside it, so dragging, docking and
 * edge-snapping are Webamp's native behavior. The renderer turns mouse
 * passthrough off whenever the cursor is over a Webamp window.
 */
const preloadPath = () => join(__dirname, '../preload/index.js')

/** Loads a renderer page from the dev server or the built output. */
function loadPage(target: BrowserWindow, page: 'index.html' | 'gallery.html' | 'setup.html' | 'about.html') {
  // No remote content, no popups, no navigation away from the app.
  target.webContents.setWindowOpenHandler(({ url }) => {
    // Webamp's "Webamp..." / About links: open the project page in the browser.
    if (/^https:\/\/webamp\.org\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  target.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.ELECTRON_RENDERER_URL) {
    target.webContents.on('console-message', (e) => console.log(`[${page}:${e.level}] ${e.message}`))
    void target.loadURL(`${process.env.ELECTRON_RENDERER_URL}/${page}`)
  } else {
    void target.loadFile(join(__dirname, '../renderer', page))
  }
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay()
  win = new BrowserWindow({
    ...workArea,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: true,
    },
  })
  hits = new HitTester(win)
  player = new PlayerWindow(
    win,
    () => config.playerPos,
    (key, x, y) => {
      config.playerPos = { ...config.playerPos, [key]: { x, y } }
      saveConfig(config)
    },
  )
  // skipTransformProcessType: otherwise macOS briefly flips the app to an
  // accessory process, which hides the Dock icon and drops focus/levels.
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
  applyAlwaysOnTop()

  win.once('ready-to-show', () => win?.showInactive())
  win.webContents.on('did-finish-load', () => {
    // Run with userGesture=true so getDisplayMedia's activation check passes.
    void win?.webContents.executeJavaScript('window.__startCapture && window.__startCapture()', true)
  })

  loadPage(win, 'index.html')

  win.on('closed', () => {
    win = null
  })
}

function keepPlayerVisible() {
  player?.ensureVisible()
}

function applyAlwaysOnTop() {
  if (!win) return
  // 'floating' keeps us above normal windows without covering system UI.
  win.setAlwaysOnTop(config.alwaysOnTop, 'floating')
}

function showWindow() {
  if (!win) return createWindow()
  win.showInactive()
  win.webContents.send(IPC.shown)
}

function toggleWindow() {
  if (win?.isVisible()) win.hide()
  else showWindow()
}

function buildTray() {
  const icon = nativeImage.createEmpty()
  icon.addRepresentation({ scaleFactor: 1, dataURL: isMac ? TRAY_ICON_1X : TRAY_ICON_COLOR_1X })
  icon.addRepresentation({ scaleFactor: 2, dataURL: isMac ? TRAY_ICON_2X : TRAY_ICON_COLOR_2X })
  // macOS: monochrome template icon that adapts to the menu bar.
  if (isMac) icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Zellamp')
  // Windows convention: left-click opens the tray menu too.
  if (!isMac) tray.on('click', () => tray?.popUpContextMenu())
}

// ---------- zoom ----------

function setZoom(zoom: number) {
  const z = ZOOM_LEVELS.reduce((a, b) => (Math.abs(b - zoom) < Math.abs(a - zoom) ? b : a))
  config.zoom = z
  saveConfig(config)
  win?.webContents.send(IPC.playerZoom, z)
  refreshMenus()
}

function setShowArt(show: boolean) {
  config.showArt = show
  saveConfig(config)
  win?.webContents.send(IPC.playerArt, show)
  refreshMenus()
}

function artMenuItem(withShortcut: boolean): MenuItemConstructorOptions {
  return {
    label: 'Show Album Art',
    type: 'checkbox',
    checked: config.showArt,
    accelerator: withShortcut ? 'CmdOrCtrl+Shift+A' : undefined,
    click: (item) => setShowArt(item.checked),
  }
}

function stepZoom(dir: 1 | -1) {
  const i = ZOOM_LEVELS.findIndex((z) => z === config.zoom)
  setZoom(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, (i < 0 ? 0 : i) + dir))])
}

function zoomMenuItems(withShortcuts: boolean): MenuItemConstructorOptions[] {
  return [
    { label: 'Actual Size', accelerator: withShortcuts ? 'CmdOrCtrl+0' : undefined, click: () => setZoom(1) },
    { label: 'Zoom In', accelerator: withShortcuts ? 'CmdOrCtrl+=' : undefined, click: () => stepZoom(1) },
    { label: 'Zoom Out', accelerator: withShortcuts ? 'CmdOrCtrl+-' : undefined, click: () => stepZoom(-1) },
    { type: 'separator' },
    ...ZOOM_LEVELS.map((z) => ({
      label: `${z * 100}%`,
      type: 'radio' as const,
      checked: config.zoom === z,
      click: () => setZoom(z),
    })),
  ]
}

/** Skin Browser, the installed skins, and Install Skin. */
function skinsMenuItems(withShortcut: boolean): MenuItemConstructorOptions[] {
  return [
    { label: 'Skin Browser…', accelerator: withShortcut ? 'CmdOrCtrl+T' : undefined, click: openGallery },
    { type: 'separator' },
    ...listThemes().map((t) => ({
      label: t.name,
      type: 'radio' as const,
      checked: t.id === activeThemeId(),
      click: () => applyTheme(t.id),
    })),
    { type: 'separator' },
    { label: 'Install Skin…', click: () => void pickSkin() },
  ]
}

function optionsMenuItems(): MenuItemConstructorOptions[] {
  const screenAccess = isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted'
  return [
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked
        saveConfig(config)
        applyAlwaysOnTop()
        refreshMenus()
      },
    },
    ...(isMac
      ? [
          {
            label: 'Show in Dock',
            type: 'checkbox' as const,
            checked: config.showInDock,
            click: (item: Electron.MenuItem) => {
              config.showInDock = item.checked
              saveConfig(config)
              applyDockVisibility()
              refreshMenus()
            },
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Setup Assistant…', click: openSetup },
    {
      label: 'Reset Window Positions',
      click: () => {
        config.layout = null
        saveConfig(config)
        win?.reload()
      },
    },
    ...(screenAccess !== 'granted'
      ? [
          { type: 'separator' as const },
          {
            label: 'Enable Visualizer (Screen & System Audio Recording)…',
            click: () =>
              void shell.openExternal(
                'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
              ),
          },
        ]
      : []),
  ]
}

/** Items shared by the tray menu and the app's "Widget" menu. */
function widgetMenuItems(): MenuItemConstructorOptions[] {
  return [
    { label: 'Skins', submenu: skinsMenuItems(true) },
    { label: 'Zoom', submenu: zoomMenuItems(false) },
    artMenuItem(false),
    { type: 'separator' },
    ...optionsMenuItems(),
  ]
}

/** The player's right-click menu: the same for every skin. */
function playerMenuItems(): MenuItemConstructorOptions[] {
  const s = bridge.current
  const command = (cmd: SpotifyCommand) => () => void bridge.command(cmd)
  return [
    { label: 'About Zellamp…', click: openAbout },
    { type: 'separator' },
    {
      label: 'Playback',
      submenu: [
        { label: 'Play / Pause', click: command({ type: 'playpause' }) },
        { label: 'Previous', click: command({ type: 'prev' }) },
        { label: 'Next', click: command({ type: 'next' }) },
        { type: 'separator' },
        {
          label: 'Shuffle',
          type: 'checkbox',
          checked: s.shuffling,
          click: (item) => void bridge.command({ type: 'setShuffle', value: item.checked }),
        },
        {
          label: 'Repeat',
          type: 'checkbox',
          checked: s.repeating,
          click: (item) => void bridge.command({ type: 'setRepeat', value: item.checked }),
        },
      ],
    },
    { type: 'separator' },
    { id: 'slot:windows' },
    { type: 'separator' },
    { label: 'Skins', submenu: skinsMenuItems(false) },
    {
      label: 'Zoom',
      submenu: ZOOM_LEVELS.map((z) => ({
        label: `${z * 100}%`,
        type: 'radio' as const,
        checked: config.zoom === z,
        click: () => setZoom(z),
      })),
    },
    artMenuItem(false),
    { label: 'Options', submenu: optionsMenuItems() },
    { type: 'separator' },
    { label: 'Hide Zellamp', click: () => win?.hide() },
    { label: 'Exit', click: () => app.quit() },
  ]
}

/** Flatten menu templates for the page; clicks come back by index. */
let playerMenuClicks: (() => void)[] = []
function serializeMenu(items: MenuItemConstructorOptions[]): PlayerMenuItem[] {
  return items.map((item) => {
    if (item.type === 'separator') return { separator: true }
    if (item.id === 'slot:windows') return { slot: 'windows' }
    const out: PlayerMenuItem = { label: item.label ?? '' }
    if (item.type === 'checkbox' || item.type === 'radio') out.checked = Boolean(item.checked)
    if (Array.isArray(item.submenu)) out.submenu = serializeMenu(item.submenu)
    else if (item.click) {
      const click = item.click as unknown as (menuItem: { checked: boolean }) => void
      // Checkbox handlers read the toggled value, as Electron's would.
      out.action = playerMenuClicks.push(() => click({ checked: !item.checked })) - 1
    }
    return out
  })
}

function refreshMenus() {
  const command = (cmd: SpotifyCommand) => () => void bridge.command(cmd)
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { label: `About ${app.name}`, click: openAbout },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { label: 'View', submenu: [artMenuItem(true), { type: 'separator' }, ...zoomMenuItems(true)] },
      {
        label: 'Controls',
        submenu: [
          { label: 'Play / Pause', accelerator: 'CmdOrCtrl+P', click: command({ type: 'playpause' }) },
          { label: 'Next Track', accelerator: 'CmdOrCtrl+Right', click: command({ type: 'next' }) },
          { label: 'Previous Track', accelerator: 'CmdOrCtrl+Left', click: command({ type: 'prev' }) },
        ],
      },
      { label: 'Widget', submenu: [{ label: 'Show / Hide', click: toggleWindow }, ...widgetMenuItems()] },
    ]),
  )
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show / Hide', click: toggleWindow },
      ...widgetMenuItems(),
      { type: 'separator' },
      { label: 'About Zellamp…', click: openAbout },
      { type: 'separator' },
      { label: 'Quit Zellamp', role: 'quit' },
    ]),
  )
}

function applyDockVisibility() {
  // Hidden from the Dock the app becomes an accessory: no Dock icon, no
  // Cmd-Tab entry, and no menu bar of its own.
  if (config.showInDock) void app.dock?.show()
  else app.dock?.hide()
}

function activeThemeId() {
  return themeExists(config.theme) ? config.theme : 'classic'
}

function themeList(): ThemeList {
  return { themes: listThemes(), active: activeThemeId() }
}

function notifyThemesChanged() {
  gallery?.webContents.send(IPC.themesChanged, themeList())
  refreshMenus()
}

/** Makes a theme active and pushes it to the widget. */
function themePayload(id: string) {
  const data = readTheme(id)
  const info = themeInfo(id)
  return data && info ? { id, kind: info.kind, data } : null
}

function applyTheme(id: string) {
  const payload = themePayload(id)
  if (!payload) return
  config.theme = id
  saveConfig(config)
  if (!win) createWindow()
  else win.webContents.send(IPC.applySkin, payload)
  notifyThemesChanged()
}

async function pickSkin() {
  const result = await dialog.showOpenDialog({
    title: 'Install Winamp Skin',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Winamp 2 or Zellamp skins', extensions: ['wsz', 'zip', 'svg'] }],
  })
  if (result.canceled) return
  let last: string | null = null
  const errors: string[] = []
  for (const path of result.filePaths) {
    try {
      last = installTheme(basename(path), new Uint8Array(readFileSync(path)))
    } catch (err) {
      errors.push((err as Error).message)
    }
  }
  if (last) applyTheme(last)
  if (errors.length) void dialog.showMessageBox({ type: 'warning', message: 'Some skins could not be installed', detail: errors.join('\n') })
}

/**
 * Frameless window for Zellamp's own Winamp-style panels; the page draws its
 * own gen.bmp chrome (title bar drag region, close button).
 */
function createPanelWindow(title: string) {
  // Initial size for the display under the cursor; the page re-fits itself
  // (IPC.panelFit) once it knows its real devicePixelRatio.
  const { scaleFactor } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const scale = panelScale(scaleFactor)
  const panel = new BrowserWindow({
    width: Math.round(PANEL_SIZE.width * scale),
    height: Math.round(PANEL_SIZE.height * scale),
    useContentSize: true,
    title,
    frame: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#000000',
    show: false,
    webPreferences: { preload: preloadPath(), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  // Sit above the always-on-top widget layer.
  panel.setAlwaysOnTop(true, 'floating', 1)
  return panel
}

// ---------- Setup Assistant ----------

function spotifyInstalled() {
  return (
    Boolean(app.getApplicationNameForProtocol('spotify://')) ||
    existsSync('/Applications/Spotify.app') ||
    existsSync(join(homedir(), 'Applications/Spotify.app'))
  )
}

function setupStatus(): SetupStatus {
  const { availability } = bridge.current
  return {
    spotify: availability === 'not-running' ? (spotifyInstalled() ? 'not-running' : 'missing') : 'running',
    control: availability === 'ok' ? 'granted' : availability === 'not-authorized' ? 'denied' : 'unknown',
    visualizer: visMode,
    platform: process.platform as SetupStatus['platform'],
    screenAccess: isMac ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
  }
}

let lastSetupStatus = ''
function pushSetupStatus() {
  if (!setup) return
  const status = setupStatus()
  const key = JSON.stringify(status)
  if (key === lastSetupStatus) return
  lastSetupStatus = key
  setup.webContents.send(IPC.setupChanged, status)
}

const SETTINGS = {
  automation: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Automation',
  screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
}

async function runSetupAction(action: SetupAction) {
  switch (action) {
    case 'open-spotify':
      // `open -b` launches by bundle id without us scripting Spotify.
      if (isMac) execFile('open', ['-b', 'com.spotify.client'])
      else void shell.openExternal('spotify:')
      break
    case 'get-spotify':
      void shell.openExternal('https://www.spotify.com/download/mac/')
      break
    case 'request-control':
      // Any Apple Event to Spotify triggers macOS's "control Spotify" prompt.
      await bridge.refresh()
      break
    case 'open-automation-settings':
      void shell.openExternal(SETTINGS.automation)
      break
    case 'request-visualizer':
      // Needs a user gesture for getDisplayMedia; also triggers the
      // Screen & System Audio Recording prompt on first use.
      void win?.webContents.executeJavaScript('window.__restartCapture && window.__restartCapture()', true)
      break
    case 'open-screen-settings':
      void shell.openExternal(SETTINGS.screen)
      break
    case 'relaunch':
      config.onboarded = false // come back to the assistant after relaunch
      saveConfig(config)
      app.relaunch()
      app.exit(0)
      return
    case 'open-skins':
      openGallery()
      break
    case 'finish':
      config.onboarded = true
      saveConfig(config)
      setup?.close()
      return
  }
  pushSetupStatus()
}

function openSetup() {
  if (setup) {
    setup.show()
    setup.focus()
    return
  }
  setup = createPanelWindow('Zellamp Setup')
  setup.once('ready-to-show', () => setup?.show())
  // macOS doesn't tell apps when a privacy switch is flipped; poll while open.
  const poll = setInterval(pushSetupStatus, 1500)
  setup.on('closed', () => {
    clearInterval(poll)
    setup = null
    lastSetupStatus = ''
    // Closing the assistant counts as done; it's always in the menus.
    if (!config.onboarded) {
      config.onboarded = true
      saveConfig(config)
    }
  })
  loadPage(setup, 'setup.html')
}

// ---------- About ----------

const WEBSITE = 'https://github.com/andrew-zell/zellamp'

function openAbout() {
  if (about) {
    about.show()
    about.focus()
    return
  }
  about = createPanelWindow('About Zellamp')
  about.once('ready-to-show', () => about?.show())
  about.on('closed', () => (about = null))
  loadPage(about, 'about.html')
}

function openAboutLink(link: AboutLink) {
  if (link === 'website') void shell.openExternal(WEBSITE)
  else if (link === 'licenses') {
    const file = app.isPackaged
      ? join(process.resourcesPath, 'THIRD_PARTY_NOTICES.txt')
      : join(app.getAppPath(), 'THIRD_PARTY_NOTICES.txt')
    void shell.openPath(file)
  }
}

function openGallery() {
  if (gallery) {
    gallery.show()
    gallery.focus()
    return
  }
  gallery = createPanelWindow('Zellamp Skin Browser')
  gallery.once('ready-to-show', () => gallery?.show())
  gallery.on('closed', () => {
    gallery = null
  })
  loadPage(gallery, 'gallery.html')
}

function isCommand(c: unknown): c is SpotifyCommand {
  if (!c || typeof c !== 'object') return false
  const cmd = c as Record<string, unknown>
  switch (cmd.type) {
    case 'playpause':
    case 'play':
    case 'pause':
    case 'next':
    case 'prev':
      return true
    case 'seek':
      return typeof cmd.seconds === 'number' && Number.isFinite(cmd.seconds)
    case 'setVolume':
      return typeof cmd.volume === 'number' && Number.isFinite(cmd.volume)
    case 'setShuffle':
    case 'setRepeat':
      return typeof cmd.value === 'boolean'
    default:
      return false
  }
}

function registerIpc() {
  ipcMain.handle(IPC.command, (_e, cmd: unknown) => {
    if (isCommand(cmd)) return bridge.command(cmd)
  })
  ipcMain.handle(IPC.getState, () => bridge.current)
  ipcMain.on(IPC.hitRegions, (_e, regions: unknown) => {
    if (!Array.isArray(regions)) return
    hits?.setRegions(
      regions.filter(
        (r): r is HitRegion =>
          !!r && [r.x, r.y, r.w, r.h].every((n) => typeof n === 'number' && Number.isFinite(n)),
      ),
    )
  })
  ipcMain.on(IPC.hitMask, (_e, mask: HitMask) => {
    if (mask && typeof mask.id === 'string' && mask.data instanceof Uint8Array && mask.data.length === mask.w * mask.h) {
      hits?.setMask(mask)
    }
  })
  ipcMain.on(IPC.dragging, (_e, dragging: unknown) => hits?.setDragging(Boolean(dragging)))
  ipcMain.handle(IPC.getConfig, () => config)
  ipcMain.on(IPC.saveLayout, (_e, layout: Record<string, WindowLayoutEntry>, doubled: boolean) => {
    config.layout = layout
    config.doubled = Boolean(doubled)
    saveConfig(config)
  })
  // Skins loaded through Webamp itself (drag-drop, its Load Skin menu):
  // Webamp already shows it, so just add it to the library and remember it.
  ipcMain.handle(IPC.saveSkin, (_e, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) return
    try {
      config.theme = installTheme(name, data)
      saveConfig(config)
      notifyThemesChanged()
    } catch {
      // Webamp already rejected / showed it; nothing to persist.
    }
  })
  ipcMain.handle(IPC.loadSkin, () => themePayload(activeThemeId()))
  ipcMain.on(IPC.openSkins, () => openGallery())
  const isNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)
  ipcMain.handle(IPC.playerLayout, (_e, key: unknown, r: { x: unknown; y: unknown; width: unknown; height: unknown }) => {
    if (typeof key !== 'string' || !r || ![r.x, r.y, r.width, r.height].every(isNum)) return { dx: 0, dy: 0 }
    return player?.layout(key, r as Electron.Rectangle) ?? { dx: 0, dy: 0 }
  })
  ipcMain.on(IPC.playerGrow, (_e, w: unknown, h: unknown) => {
    if (isNum(w) && isNum(h)) player?.grow(w, h)
  })
  ipcMain.on(IPC.playerDragStart, () => player?.dragStart())
  ipcMain.handle(IPC.playerExpand, () => player?.expand() ?? { dx: 0, dy: 0 })
  ipcMain.on(IPC.playerSetArt, (_e, show: unknown) => setShowArt(Boolean(show)))
  ipcMain.on(IPC.playerSetZoom, (_e, z: unknown) => {
    if (isNum(z)) setZoom(z)
  })
  ipcMain.handle(IPC.playerMenu, () => {
    playerMenuClicks = []
    return serializeMenu(playerMenuItems())
  })
  ipcMain.on(IPC.playerMenuAction, (_e, i: unknown) => {
    if (typeof i === 'number') playerMenuClicks[i]?.()
  })
  ipcMain.on(IPC.playerDragEnd, () => player?.dragEnd())

  ipcMain.handle(IPC.themesList, () => themeList())
  ipcMain.handle(IPC.themeRead, (_e, id: unknown) => (typeof id === 'string' ? readTheme(id) : null))
  ipcMain.handle(IPC.themeApply, (_e, id: unknown) => {
    if (typeof id === 'string') applyTheme(id)
  })
  ipcMain.handle(IPC.themeRemove, (_e, id: unknown) => {
    if (typeof id !== 'string' || !removeTheme(id)) return
    if (config.theme === id) applyTheme('classic')
    else notifyThemesChanged()
  })
  ipcMain.handle(IPC.themeInstallDialog, () => pickSkin())
  ipcMain.handle(IPC.themeInstallData, (_e, name: unknown, data: unknown) => {
    if (typeof name !== 'string' || !(data instanceof Uint8Array)) return { error: 'Invalid file.' }
    try {
      applyTheme(installTheme(name, data))
      return {}
    } catch (err) {
      return { error: (err as Error).message }
    }
  })
  ipcMain.on(IPC.themesReveal, () => void shell.openPath(userThemesDir()))

  ipcMain.on(IPC.visMode, (_e, mode: unknown) => {
    if (mode === 'starting' || mode === 'live' || mode === 'fallback') {
      visMode = mode
      pushSetupStatus()
    }
  })
  ipcMain.handle(IPC.setupStatus, () => setupStatus())
  ipcMain.handle(IPC.setupAction, async (_e, action: unknown) => {
    const allowed: SetupAction[] = [
      'open-spotify', 'get-spotify', 'request-control', 'open-automation-settings',
      'request-visualizer', 'open-screen-settings', 'relaunch', 'open-skins', 'finish',
    ]
    if (allowed.includes(action as SetupAction)) await runSetupAction(action as SetupAction)
    return setupStatus()
  })
  ipcMain.on(IPC.hideWindow, () => win?.hide())
  ipcMain.handle(IPC.aboutInfo, () => ({ version: app.getVersion(), platform: process.platform }))
  ipcMain.on(IPC.aboutOpen, (_e, link: unknown) => {
    if (link === 'website' || link === 'licenses') openAboutLink(link)
  })
  ipcMain.on(IPC.panelFit, (e, scale: unknown) => {
    const panel = BrowserWindow.fromWebContents(e.sender)
    if (!panel || panel === win || typeof scale !== 'number' || !(scale > 0 && scale <= 4)) return
    const [w, h] = [Math.round(PANEL_SIZE.width * scale), Math.round(PANEL_SIZE.height * scale)]
    const [cw, ch] = panel.getContentSize()
    if (cw !== w || ch !== h) panel.setContentSize(w, h)
  })
}

/**
 * v1 visualizer source: system audio loopback. getDisplayMedia requires a
 * video source, which the renderer drops immediately.
 */
function registerCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      // Electron throws if a video request is answered without video, but the
      // request is still denied, which is what we want (renderer falls back).
      const deny = () => {
        try {
          callback({})
        } catch {}
      }
      desktopCapturer
        .getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          if (sources.length === 0) return deny()
          callback({ video: sources[0], audio: 'loopback' })
        })
        .catch((err) => {
          console.warn('[capture] no screen source (Screen Recording permission?):', String(err))
          deny()
        })
        .finally(refreshMenus)
    },
    { useSystemPicker: false },
  )
}

app.whenReady().then(() => {
  config = loadConfig()
  applyDockVisibility()
  registerIpc()
  registerCaptureHandler()
  createWindow()
  buildTray()
  refreshMenus()
  bridge.start()
  if (!app.isPackaged && process.env.WR_OPEN_GALLERY) openGallery()
  if (!app.isPackaged && process.env.WR_OPEN_ABOUT) openAbout()
  if (!config.onboarded || (!app.isPackaged && process.env.WR_OPEN_SETUP)) openSetup()
  screen.on('display-metrics-changed', keepPlayerVisible)
  screen.on('display-added', keepPlayerVisible)
  screen.on('display-removed', keepPlayerVisible)
})

// Dock icon click (or relaunch) brings the widget back.
app.on('activate', () => showWindow())

app.on('window-all-closed', () => {
  // Stay alive in the tray.
})

app.on('before-quit', () => bridge.stop())
