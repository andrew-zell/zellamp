import { screen, type BrowserWindow, type Rectangle } from 'electron'

/**
 * The player window is sized to the player itself (not the whole screen), so
 * Mission Control shows its real outline and it can be dragged to any display.
 *
 * The renderer reports what it draws (`layout`); dragging is done here by
 * following the cursor, since the page can't move its own window smoothly
 * across displays.
 */
export class PlayerWindow {
  private key = ''
  private placed = false
  private dragTimer: NodeJS.Timeout | null = null

  constructor(
    private win: BrowserWindow,
    private positions: () => Record<string, { x: number; y: number }>,
    private savePosition: (key: string, x: number, y: number) => void,
  ) {}

  /**
   * The renderer wants `rect` (page coords) to be the window's content.
   * Returns how far the page must shift its content so it stays put on screen.
   */
  layout(key: string, rect: Rectangle): { dx: number; dy: number } {
    const b = this.win.getContentBounds()
    const w = Math.max(1, Math.round(rect.width))
    const h = Math.max(1, Math.round(rect.height))
    if (key !== this.key) {
      this.key = key
      this.placed = false
    }
    const saved = this.positions()[key]
    let x = b.x + Math.round(rect.x)
    let y = b.y + Math.round(rect.y)
    // First layout for this skin: go back to where the user left it.
    if (!this.placed && saved && this.onSomeDisplay(saved.x, saved.y, w, h)) {
      x = saved.x
      y = saved.y
    }
    this.placed = true
    // Keep it inside the display it's mostly on.
    const area = screen.getDisplayMatching({ x, y, width: w, height: h }).workArea
    x = Math.min(Math.max(x, area.x), area.x + Math.max(0, area.width - w))
    y = Math.min(Math.max(y, area.y), area.y + Math.max(0, area.height - h))
    this.win.setContentBounds({ x, y, width: w, height: h })
    return { dx: -Math.round(rect.x), dy: -Math.round(rect.y) }
  }

  /** Temporarily enlarge to the right/bottom (e.g. for a context menu). */
  grow(width: number, height: number) {
    const b = this.win.getContentBounds()
    const w = Math.max(b.width, Math.ceil(width))
    const h = Math.max(b.height, Math.ceil(height))
    if (w !== b.width || h !== b.height) this.win.setContentBounds({ ...b, width: w, height: h })
  }

  dragStart() {
    this.dragEnd(false)
    const start = screen.getCursorScreenPoint()
    const [wx, wy] = this.win.getPosition()
    this.dragTimer = setInterval(() => {
      const p = screen.getCursorScreenPoint()
      const [w, h] = this.win.getSize()
      let x = wx + p.x - start.x
      let y = wy + p.y - start.y
      // Snap to the edges of whichever display the cursor is on.
      const area = screen.getDisplayNearestPoint(p).workArea
      const SNAP = 12
      if (Math.abs(x - area.x) < SNAP) x = area.x
      if (Math.abs(y - area.y) < SNAP) y = area.y
      if (Math.abs(area.x + area.width - (x + w)) < SNAP) x = area.x + area.width - w
      if (Math.abs(area.y + area.height - (y + h)) < SNAP) y = area.y + area.height - h
      this.win.setPosition(Math.round(x), Math.round(y))
    }, 8)
  }

  dragEnd(save = true) {
    if (!this.dragTimer) return
    clearInterval(this.dragTimer)
    this.dragTimer = null
    if (save && this.key) {
      const b = this.win.getContentBounds()
      this.savePosition(this.key, b.x, b.y)
    }
  }

  /** After display changes, pull the player back if it's now off-screen. */
  ensureVisible() {
    const b = this.win.getContentBounds()
    if (this.onSomeDisplay(b.x, b.y, b.width, b.height)) return
    const area = screen.getPrimaryDisplay().workArea
    this.win.setPosition(area.x + Math.round((area.width - b.width) / 2), area.y + 80)
  }

  private onSomeDisplay(x: number, y: number, w: number, h: number) {
    // At least a 40px corner of the title area must be on a display.
    return screen.getAllDisplays().some(({ workArea: a }) => {
      const ix = Math.min(x + w, a.x + a.width) - Math.max(x, a.x)
      const iy = Math.min(y + Math.min(h, 40), a.y + a.height) - Math.max(y, a.y)
      return ix >= 40 && iy >= 20
    })
  }
}
