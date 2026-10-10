import type { SpotifyState } from '../shared/types'

/**
 * Album art for classic (Webamp) skins: a square docked to the left of the
 * main window, the same height, framed with the skin's chrome colors.
 * Positioned in page coordinates from the main window's rendered box, so it
 * follows zoom, double-size, and drags.
 */
export class ArtPanel {
  readonly el: HTMLDivElement
  private readonly img: HTMLImageElement
  private url = ''
  private show = true
  private active = true

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'za-art'
    this.img = document.createElement('img')
    this.img.alt = ''
    this.img.draggable = false
    this.el.append(this.img)
    this.el.hidden = true
    document.body.append(this.el)
  }

  /** Frame colors from the active skin (see skinKit). */
  setColors(c: { face: string; light: string; dark: string }) {
    this.el.style.setProperty('--art-face', c.face)
    this.el.style.setProperty('--art-light', c.light)
    this.el.style.setProperty('--art-dark', c.dark)
  }

  setShow(show: boolean) {
    this.show = show
    this.place()
  }

  /** Only while a classic skin is showing. */
  setActive(active: boolean) {
    this.active = active
    this.place()
  }

  setState(s: SpotifyState) {
    const url = s.availability === 'ok' ? (s.track?.artworkUrl ?? '') : ''
    if (url !== this.url) {
      this.url = url
      if (url) this.img.src = url
      this.place()
    }
  }

  /** Dock to the left of Webamp's main window. */
  place() {
    const main = document.querySelector('#main-window')
    const r = main?.getBoundingClientRect()
    // Hide in shade mode (a thin strip) or when there's nothing to show.
    const visible = this.show && this.active && !!this.url && !!r && r.height > r.width / 4
    if (!visible || !r) {
      this.el.hidden = true
      return
    }
    const size = Math.round(r.height)
    Object.assign(this.el.style, {
      left: `${Math.round(r.left) - size}px`,
      top: `${Math.round(r.top)}px`,
      width: `${size}px`,
      height: `${size}px`,
    })
    this.el.hidden = false
  }
}
