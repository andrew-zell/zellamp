import { screen, type BrowserWindow } from 'electron'
import type { HitMask, HitRegion } from '../shared/types'

/**
 * Decides, in the main process, whether the full-screen overlay should take
 * the mouse. The renderer reports where the player is (rects, plus an alpha
 * mask for freeform skins); we poll the cursor and flip click-through
 * *before* a click lands. Relying on forwarded mousemove events from the
 * renderer was racy: a click could arrive while still click-through, fall
 * through to the app underneath, and bring that app in front of the widget.
 */
export class HitTester {
  private regions: HitRegion[] = []
  private masks = new Map<string, HitMask>()
  private dragging = false
  private ignoring = true
  private timer: NodeJS.Timeout | null = null

  constructor(private win: BrowserWindow) {
    win.setIgnoreMouseEvents(true)
    // ~30Hz: well under the time it takes to move onto the player and click.
    this.timer = setInterval(() => this.tick(), 33)
    win.on('closed', () => this.stop())
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setRegions(regions: HitRegion[]) {
    this.regions = regions
    this.tick()
  }

  setMask(mask: HitMask) {
    this.masks.set(mask.id, mask)
  }

  /** While a drag is in progress the overlay keeps the mouse, even off the player. */
  setDragging(dragging: boolean) {
    this.dragging = dragging
    this.tick()
  }

  private tick() {
    if (this.win.isDestroyed() || !this.win.isVisible()) return
    const p = screen.getCursorScreenPoint()
    const b = this.win.getContentBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    const over = this.dragging || this.regions.some((r) => this.hit(r, x, y))
    if (over !== this.ignoring) return
    this.ignoring = !over
    this.win.setIgnoreMouseEvents(this.ignoring)
  }

  private hit(r: HitRegion, x: number, y: number) {
    if (x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return false
    const mask = r.maskId ? this.masks.get(r.maskId) : undefined
    if (!mask) return true
    const mx = Math.floor(((x - r.x) / r.w) * mask.w)
    const my = Math.floor(((y - r.y) / r.h) * mask.h)
    return mask.data[my * mask.w + mx] > 0
  }
}
