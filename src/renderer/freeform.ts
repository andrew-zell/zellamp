import type { HitRegion, SpotifyState } from '../shared/types'
import './freeform.css'

/**
 * Freeform skins: a single SVG whose parts are tagged with `data-za`.
 * Any shape works; transparent areas stay click-through because only
 * painted SVG elements take the mouse.
 *
 * Bindings (data-za="…"):
 *   buttons   play pause playpause stop next prev shuffle repeat
 *             close minimize skins vol-up vol-down
 *   text      title artist album track time remaining duration status kbps volume-text
 *             <text> gets textContent; data-za-chars="N" makes it a marquee.
 *             <g data-za-font="7seg" data-za-digit="24"> draws an LCD clock.
 *   vis       <rect data-za="vis" data-za-style="bars|mirror|radial|scope"
 *             data-za-bars data-za-colors="top,…,bottom" data-za-peak data-za-gap
 *             data-za-inner (radial) data-za-width (radial/scope stroke)>
 *   seek / volume
 *             linear: <g> containing data-za-part="track" (rect, required),
 *             "fill" (rect, width follows), "thumb" (moves along);
 *             data-za-orient="vertical" fills bottom-up.
 *             ring:   <circle data-za-shape="ring" transform="rotate(-90 cx cy)">
 *             progress via stroke dash, clockwise from 12 o'clock.
 *   art       <image> gets the album artwork.
 *   drag      any painted element that isn't a control drags the player window.
 *
 * Root classes for skin CSS: za-playing za-paused za-stopped za-shuffle
 * za-repeat za-offline; toggles get za-on, pressed controls za-pressed.
 */

export interface FreeformHost {
  analyser: AnalyserNode
  close(): void
  openSkins(): void
  /** Drag the player window (main follows the cursor until dragEnd). */
  dragStart(): void
  dragEnd(): void
  /** The player moved or its hit mask became ready. */
  moved(): void
}

const BUTTONS = new Set([
  'play', 'pause', 'playpause', 'stop', 'next', 'prev', 'shuffle', 'repeat',
  'close', 'minimize', 'skins', 'vol-up', 'vol-down',
])
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Parses skin SVG and strips anything executable or remote. */
export function sanitizeSvg(text: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (root.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new Error('Not a valid SVG skin.')
  doc.querySelectorAll('script, foreignObject, iframe, object, embed, audio, video').forEach((n) => n.remove())
  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name)
      else if (attr.localName === 'href' && !/^(#|data:image\/)/i.test(attr.value.trim())) el.removeAttribute(attr.name)
    }
  }
  for (const style of doc.querySelectorAll('style')) {
    style.textContent = (style.textContent ?? '').replace(/@import[^;]*;?/gi, '').replace(/url\(\s*['"]?(?!#|data:)[^)]*\)/gi, 'none')
  }
  return document.importNode(root, true) as unknown as SVGSVGElement
}

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

// ---------- 7-segment LCD ----------

const SEGMENTS: Record<string, string> = {
  '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd',
  '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg', '-': 'g', ' ': '',
}

function hexSeg(cx: number, cy: number, len: number, t: number, vertical: boolean) {
  const a = len / 2
  const b = t / 2
  const pts = [
    [-a, 0], [-a + b, -b], [a - b, -b], [a, 0], [a - b, b], [-a + b, b],
  ].map(([x, y]) => (vertical ? [cx + y, cy + x] : [cx + x, cy + y]))
  return pts.map((p) => p.join(',')).join(' ')
}

function drawSevenSeg(g: SVGGElement, str: string) {
  const h = Number(g.dataset.zaDigit ?? 24)
  const w = h * 0.55
  const t = h * 0.13
  const ghost = Number(g.dataset.zaGhost ?? 0.12)
  const parts: string[] = []
  let x = 0
  for (const ch of str) {
    if (ch === ':') {
      const s = t * 1.1
      parts.push(`<rect x="${x}" y="${h * 0.28}" width="${s}" height="${s}"/>`)
      parts.push(`<rect x="${x}" y="${h * 0.66}" width="${s}" height="${s}"/>`)
      x += s + t * 1.2
      continue
    }
    const on = SEGMENTS[ch] ?? ''
    const lh = w - t * 0.7
    const lv = h / 2 - t * 0.7
    const seg: Record<string, string> = {
      a: hexSeg(x + w / 2, t / 2, lh, t, false),
      g: hexSeg(x + w / 2, h / 2, lh, t, false),
      d: hexSeg(x + w / 2, h - t / 2, lh, t, false),
      f: hexSeg(x + t / 2, (t / 2 + h / 2) / 2, lv, t, true),
      b: hexSeg(x + w - t / 2, (t / 2 + h / 2) / 2, lv, t, true),
      e: hexSeg(x + t / 2, (h / 2 + h - t / 2) / 2, lv, t, true),
      c: hexSeg(x + w - t / 2, (h / 2 + h - t / 2) / 2, lv, t, true),
    }
    for (const [name, pts] of Object.entries(seg)) {
      const lit = on.includes(name)
      if (lit || ghost > 0) parts.push(`<polygon points="${pts}"${lit ? '' : ` opacity="${ghost}"`}/>`)
    }
    x += w + t * 0.9
  }
  g.innerHTML = parts.join('')
}

// ---------- visualizer ----------

class VisLayer {
  private readonly group: SVGGElement
  private readonly style: string
  private readonly n: number
  private readonly els: SVGElement[] = []
  private readonly peaks: SVGRectElement[] = []
  private readonly levels: Float32Array
  private readonly peakLevels: Float32Array
  private readonly freq: Uint8Array<ArrayBuffer>
  private readonly wave: Uint8Array<ArrayBuffer>
  private readonly box: { x: number; y: number; w: number; h: number }
  private readonly inner: number
  private readonly gap: number
  private scope: SVGPolylineElement | null = null

  constructor(rect: SVGGraphicsElement, svg: SVGSVGElement, private analyser: AnalyserNode, uid: string) {
    const ds = (rect as SVGElement).dataset
    this.style = ds.zaStyle ?? 'bars'
    this.n = Number(ds.zaBars ?? (this.style === 'radial' ? 48 : 20))
    this.inner = Number(ds.zaInner ?? 0.55)
    this.gap = Number(ds.zaGap ?? 1)
    this.levels = new Float32Array(this.n)
    this.peakLevels = new Float32Array(this.n)
    this.freq = new Uint8Array(analyser.frequencyBinCount)
    this.wave = new Uint8Array(analyser.fftSize)
    const bb = rect.getBBox()
    this.box = { x: bb.x, y: bb.y, w: bb.width, h: bb.height }
    const colors = (ds.zaColors ?? '#ffffff,#00ff00').split(',').map((c) => c.trim())

    // Gradient in user space so every bar samples the same ramp.
    const defs = svg.querySelector('defs') ?? svg.insertBefore(document.createElementNS(SVG_NS, 'defs'), svg.firstChild)
    const gradId = `za-vis-${uid}`
    const radial = this.style === 'radial'
    const grad = document.createElementNS(SVG_NS, radial ? 'radialGradient' : 'linearGradient')
    grad.id = gradId
    grad.setAttribute('gradientUnits', 'userSpaceOnUse')
    const { x, y, w, h } = this.box
    if (radial) {
      const r = Math.min(w, h) / 2
      grad.setAttribute('cx', String(x + w / 2))
      grad.setAttribute('cy', String(y + h / 2))
      grad.setAttribute('r', String(r))
      ;[...colors].reverse().forEach((c, i, arr) => {
        const stop = document.createElementNS(SVG_NS, 'stop')
        stop.setAttribute('offset', String(this.inner + (1 - this.inner) * (i / Math.max(1, arr.length - 1))))
        stop.setAttribute('stop-color', c)
        grad.append(stop)
      })
    } else {
      grad.setAttribute('x1', '0')
      grad.setAttribute('x2', '0')
      grad.setAttribute('y1', String(y))
      grad.setAttribute('y2', String(y + h))
      colors.forEach((c, i) => {
        const stop = document.createElementNS(SVG_NS, 'stop')
        stop.setAttribute('offset', String(i / Math.max(1, colors.length - 1)))
        stop.setAttribute('stop-color', c)
        grad.append(stop)
      })
    }
    defs.append(grad)

    this.group = document.createElementNS(SVG_NS, 'g')
    this.group.setAttribute('class', 'za-vis')
    rect.after(this.group)
    const paint = `url(#${gradId})`
    const peakColor = ds.zaPeak
    const strokeW = Number(ds.zaWidth ?? (radial ? 3 : 1.5))

    if (this.style === 'scope') {
      this.scope = document.createElementNS(SVG_NS, 'polyline')
      this.scope.setAttribute('fill', 'none')
      this.scope.setAttribute('stroke', colors[0])
      this.scope.setAttribute('stroke-width', String(strokeW))
      this.scope.setAttribute('stroke-linejoin', 'round')
      this.group.append(this.scope)
      return
    }
    for (let i = 0; i < this.n; i++) {
      if (radial) {
        const line = document.createElementNS(SVG_NS, 'line')
        line.setAttribute('stroke', paint)
        line.setAttribute('stroke-width', String(strokeW))
        line.setAttribute('stroke-linecap', 'round')
        this.els.push(line)
        this.group.append(line)
      } else {
        const bar = document.createElementNS(SVG_NS, 'rect')
        bar.setAttribute('fill', paint)
        this.els.push(bar)
        this.group.append(bar)
        if (peakColor) {
          const pk = document.createElementNS(SVG_NS, 'rect')
          pk.setAttribute('fill', peakColor)
          this.peaks.push(pk)
          this.group.append(pk)
        }
      }
    }
  }

  /** Returns true while anything is still moving. */
  frame(active: boolean): boolean {
    const { x, y, w, h } = this.box
    if (this.style === 'scope') {
      if (active) this.analyser.getByteTimeDomainData(this.wave)
      const pts: string[] = []
      const N = 64
      for (let i = 0; i < N; i++) {
        const v = active ? (this.wave[Math.floor((i / N) * this.wave.length)] - 128) / 128 : 0
        pts.push(`${(x + (i / (N - 1)) * w).toFixed(1)},${(y + h / 2 - v * h * 0.45).toFixed(1)}`)
      }
      this.scope!.setAttribute('points', pts.join(' '))
      return active
    }

    if (active) this.analyser.getByteFrequencyData(this.freq)
    const bins = this.freq.length
    let moving = false
    for (let i = 0; i < this.n; i++) {
      // Log-spaced bands from ~40Hz up.
      const lo = Math.floor(2 * Math.pow((bins * 0.7) / 2, i / this.n))
      const hi = Math.max(lo + 1, Math.floor(2 * Math.pow((bins * 0.7) / 2, (i + 1) / this.n)))
      let v = 0
      if (active) for (let b = lo; b < hi; b++) v = Math.max(v, this.freq[b])
      const target = Math.pow(v / 255, 1.3)
      const level = Math.max(target, this.levels[i] - 0.035)
      this.levels[i] = level
      this.peakLevels[i] = Math.max(level, this.peakLevels[i] - 0.008)
      if (level > 0.001 || this.peakLevels[i] > 0.001) moving = true
    }

    if (this.style === 'radial') {
      const cx = x + w / 2
      const cy = y + h / 2
      const R = Math.min(w, h) / 2
      const r0 = R * this.inner
      this.els.forEach((line, i) => {
        // Mirror the spectrum around the circle so lows sit at the top.
        const k = i < this.n / 2 ? i * 2 : (this.n - 1 - i) * 2 + 1
        const level = this.levels[Math.min(this.n - 1, k)]
        const ang = (i / this.n) * Math.PI * 2 - Math.PI / 2
        const r1 = r0 + (R - r0) * Math.max(0.04, level)
        line.setAttribute('x1', (cx + Math.cos(ang) * r0).toFixed(1))
        line.setAttribute('y1', (cy + Math.sin(ang) * r0).toFixed(1))
        line.setAttribute('x2', (cx + Math.cos(ang) * r1).toFixed(1))
        line.setAttribute('y2', (cy + Math.sin(ang) * r1).toFixed(1))
      })
      return moving
    }

    const gap = this.gap
    const bw = (w - gap * (this.n - 1)) / this.n
    const mirror = this.style === 'mirror'
    this.els.forEach((bar, i) => {
      const bh = Math.max(mirror ? 1 : 0, this.levels[i] * h)
      const bx = x + i * (bw + gap)
      bar.setAttribute('x', bx.toFixed(2))
      bar.setAttribute('width', bw.toFixed(2))
      bar.setAttribute('y', (mirror ? y + (h - bh) / 2 : y + h - bh).toFixed(2))
      bar.setAttribute('height', bh.toFixed(2))
      const pk = this.peaks[i]
      if (pk) {
        const py = mirror ? y + (h - this.peakLevels[i] * h) / 2 - 1.5 : y + h - this.peakLevels[i] * h - 1.5
        pk.setAttribute('x', bx.toFixed(2))
        pk.setAttribute('width', bw.toFixed(2))
        pk.setAttribute('y', py.toFixed(2))
        pk.setAttribute('height', '1.5')
        pk.setAttribute('opacity', this.peakLevels[i] > 0.01 ? '1' : '0')
      }
    })
    return moving
  }
}

// ---------- sliders (seek / volume) ----------

interface Slider {
  kind: 'seek' | 'volume'
  el: SVGGraphicsElement
  set(p: number): void
  pointToValue(e: PointerEvent): number
  dragging: boolean
}

function svgPoint(svg: SVGSVGElement, e: PointerEvent) {
  const pt = svg.createSVGPoint()
  pt.x = e.clientX
  pt.y = e.clientY
  return pt.matrixTransform(svg.getScreenCTM()!.inverse())
}

function makeSlider(svg: SVGSVGElement, el: SVGGraphicsElement, kind: 'seek' | 'volume'): Slider | null {
  const clamp = (v: number) => Math.min(1, Math.max(0, v))
  if (el.dataset.zaShape === 'ring' && el instanceof SVGCircleElement) {
    el.setAttribute('pathLength', '100')
    const cx = el.cx.baseVal.value
    const cy = el.cy.baseVal.value
    return {
      kind,
      el,
      dragging: false,
      set(p) {
        el.setAttribute('stroke-dasharray', `${(clamp(p) * 100).toFixed(2)} 100`)
      },
      pointToValue(e) {
        // In the circle's own (rotated) coordinates the dash starts at angle 0.
        const local = svgPoint(svg, e).matrixTransform(el.getCTM()!.inverse())
        let a = Math.atan2(local.y - cy, local.x - cx)
        if (a < 0) a += Math.PI * 2
        return clamp(a / (Math.PI * 2))
      },
    }
  }
  const track = el.querySelector<SVGGraphicsElement>('[data-za-part="track"]')
  if (!track) return null
  const fill = el.querySelector<SVGRectElement>('[data-za-part="fill"]')
  const thumb = el.querySelector<SVGGraphicsElement>('[data-za-part="thumb"]')
  const tb = track.getBBox()
  const vertical = el.dataset.zaOrient === 'vertical'
  const thb = thumb?.getBBox()
  return {
    kind,
    el,
    dragging: false,
    set(p) {
      p = clamp(p)
      if (fill) {
        if (vertical) {
          fill.setAttribute('y', String(tb.y + tb.height * (1 - p)))
          fill.setAttribute('height', String(tb.height * p))
        } else fill.setAttribute('width', String(Math.max(0, tb.width * p)))
      }
      if (thumb && thb) {
        const travel = vertical ? tb.height - thb.height : tb.width - thb.width
        const offset = vertical
          ? tb.y + travel * (1 - p) - thb.y
          : tb.x + travel * p - thb.x
        thumb.setAttribute('transform', vertical ? `translate(0 ${offset})` : `translate(${offset} 0)`)
      }
    },
    pointToValue(e) {
      const pt = svgPoint(svg, e)
      return vertical ? clamp(1 - (pt.y - tb.y) / tb.height) : clamp((pt.x - tb.x) / tb.width)
    },
  }
}

// ---------- the player ----------

let uidCounter = 0

export class FreeformPlayer {
  readonly root: HTMLDivElement
  private readonly svg: SVGSVGElement
  private state: SpotifyState | null = null
  private readonly texts: { el: SVGElement; key: string }[] = []
  private readonly sliders: Slider[] = []
  private readonly vis: VisLayer[] = []
  private readonly toggles: { el: Element; key: 'shuffle' | 'repeat' }[] = []
  private readonly arts: SVGImageElement[] = []
  private marqueeOffset = 0
  private ticker: number
  private raf = 0
  private visMoving = false
  private readonly maskId: string
  private maskReady = false

  constructor(
    container: HTMLElement,
    svgText: string,
    private host: FreeformHost,
    position: { x: number; y: number } | null,
  ) {
    this.svg = sanitizeSvg(svgText)
    this.maskId = `ff-${uidCounter}-${Date.now()}`
    void this.buildMask(new XMLSerializer().serializeToString(this.svg))
    this.svg.classList.add('za-skin')
    this.root = document.createElement('div')
    this.root.className = 'za-root'
    this.root.append(this.svg)
    container.append(this.root)

    const w = this.svg.width.baseVal.value || 300
    const h = this.svg.height.baseVal.value || 200
    // The window is sized to the skin; the skin sits at a fixed offset in it.
    this.moveTo(position?.x ?? 0, position?.y ?? 0)

    const uid = String(uidCounter++)
    for (const el of this.svg.querySelectorAll<SVGGraphicsElement>('[data-za]')) {
      const key = el.dataset.za!
      if (BUTTONS.has(key)) {
        el.classList.add('za-button')
        if (key === 'shuffle' || key === 'repeat') this.toggles.push({ el, key })
      } else if (key === 'vis') this.vis.push(new VisLayer(el, this.svg, host.analyser, `${uid}-${this.vis.length}`))
      else if (key === 'seek' || key === 'volume') {
        const s = makeSlider(this.svg, el, key)
        if (s) {
          el.classList.add('za-slider')
          this.sliders.push(s)
        }
      } else if (key === 'art' && el instanceof SVGImageElement) this.arts.push(el)
      else this.texts.push({ el, key })
    }

    this.svg.addEventListener('pointerdown', this.onPointerDown)
    this.svg.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      window.widget.showContextMenu()
    })
    // Marquee and clock tick; cheap at 5Hz.
    this.ticker = window.setInterval(() => {
      this.marqueeOffset++
      this.renderText()
    }, 200)
    document.addEventListener('visibilitychange', this.kickVis)
  }

  /** Where the player is, for main's click-through hit testing. */
  hitRegion(): HitRegion {
    // Rendered box, so it reflects the player's zoom.
    const r = this.svg.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, maskId: this.maskReady ? this.maskId : undefined }
  }

  /**
   * Renders the skin once and keeps solid pixels as its clickable shape.
   * The threshold skips soft drop shadows and glows.
   */
  private async buildMask(svgText: string) {
    const w = Math.ceil(this.svg.width.baseVal.value || 300)
    const h = Math.ceil(this.svg.height.baseVal.value || 200)
    const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
    try {
      const img = new Image()
      img.src = url
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0, w, h)
      const px = ctx.getImageData(0, 0, w, h).data
      const data = new Uint8Array(w * h)
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4 + 3] > 96 ? 1 : 0
      window.widget.setHitMask({ id: this.maskId, w, h, data })
      this.maskReady = true
      this.host.moved()
    } catch (err) {
      // Fall back to the bounding box.
      console.warn('[freeform] hit mask failed:', err)
    } finally {
      URL.revokeObjectURL(url)
    }
  }

  dispose() {
    clearInterval(this.ticker)
    cancelAnimationFrame(this.raf)
    document.removeEventListener('visibilitychange', this.kickVis)
    this.root.remove()
  }

  setState(s: SpotifyState) {
    this.state = s
    const cls = this.svg.classList
    const live = s.availability === 'ok'
    cls.toggle('za-playing', live && s.state === 'playing')
    cls.toggle('za-paused', live && s.state === 'paused')
    cls.toggle('za-stopped', !live || s.state === 'stopped')
    cls.toggle('za-shuffle', s.shuffling)
    cls.toggle('za-repeat', s.repeating)
    cls.toggle('za-offline', !live)
    for (const t of this.toggles) t.el.classList.toggle('za-on', t.key === 'shuffle' ? s.shuffling : s.repeating)
    for (const art of this.arts) {
      const url = s.track?.artworkUrl
      if (url && art.getAttribute('href') !== url) art.setAttribute('href', url)
    }
    for (const sl of this.sliders) {
      if (sl.dragging) continue
      if (sl.kind === 'volume') sl.set(s.volume / 100)
    }
    this.renderText()
    this.kickVis()
  }

  private position() {
    const s = this.state
    if (!s || s.availability !== 'ok') return 0
    const pos = s.state === 'playing' ? s.positionSec + (Date.now() - s.sampledAt) / 1000 : s.positionSec
    const dur = (s.track?.durationMs ?? 0) / 1000
    return dur > 0 ? Math.min(pos, dur) : pos
  }

  private textFor(key: string): string {
    const s = this.state
    if (!s) return ''
    const t = s.track
    const dur = (t?.durationMs ?? 0) / 1000
    if (s.availability === 'not-running') {
      if (key === 'title' || key === 'track' || key === 'status') return 'Spotify is not running'
    } else if (s.availability === 'not-authorized') {
      if (key === 'title' || key === 'track' || key === 'status') return 'Allow control in Setup Assistant'
    }
    switch (key) {
      case 'title':
        return t?.name ?? ''
      case 'artist':
        return t?.artist ?? ''
      case 'album':
        return t?.album ?? ''
      case 'track':
        return t ? (t.artist ? `${t.artist} - ${t.name}` : t.name) : 'Spotify'
      case 'time':
        return fmt(this.position())
      case 'remaining':
        return '-' + fmt(dur - this.position())
      case 'duration':
        return fmt(dur)
      case 'status':
        return s.state === 'playing' ? 'Playing' : s.state === 'paused' ? 'Paused' : 'Stopped'
      case 'kbps':
        return '320'
      case 'volume-text':
        return `Vol ${Math.round(s.volume)}`
    }
    return ''
  }

  private renderText() {
    for (const { el, key } of this.texts) {
      let str = this.textFor(key)
      if (el.dataset.zaUpper !== undefined) str = str.toUpperCase()
      const chars = Number(el.dataset.zaChars ?? 0)
      if (chars && str.length > chars) {
        const loop = `${str}   ***   `
        const o = this.marqueeOffset % loop.length
        str = (loop + loop).slice(o, o + chars)
      }
      if (el.dataset.zaFont === '7seg') {
        if (el.dataset.zaLast !== str) {
          el.dataset.zaLast = str
          drawSevenSeg(el as SVGGElement, str)
        }
      } else if (el.textContent !== str) el.textContent = str
    }
    const dur = (this.state?.track?.durationMs ?? 0) / 1000
    for (const sl of this.sliders) {
      if (sl.kind === 'seek' && !sl.dragging) sl.set(dur > 0 ? this.position() / dur : 0)
    }
  }

  // Animate the visualizer while playing (and while bars fall after a pause).
  private readonly kickVis = () => {
    if (!this.vis.length || this.raf) return
    const loop = () => {
      const active = this.state?.state === 'playing' && this.state.availability === 'ok' && !document.hidden
      let moving = false
      for (const v of this.vis) moving = v.frame(active) || moving
      this.visMoving = moving
      this.raf = active || moving ? requestAnimationFrame(loop) : 0
    }
    this.raf = requestAnimationFrame(loop)
  }

  private moveTo(x: number, y: number) {
    this.root.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    this.root.dataset.x = String(Math.round(x))
    this.root.dataset.y = String(Math.round(y))
    this.host.moved?.()
  }

  private readonly onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    const target = e.target as Element
    const control = target.closest<SVGGraphicsElement>('[data-za]')
    const key = control?.dataset.za

    if (control && key && BUTTONS.has(key)) {
      control.classList.add('za-pressed')
      const up = (ev: PointerEvent) => {
        control.classList.remove('za-pressed')
        window.removeEventListener('pointerup', up)
        if (control.contains(ev.target as Node)) this.press(key)
      }
      window.addEventListener('pointerup', up)
      return
    }

    const slider = this.sliders.find((s) => s.el === control || s.el.contains(target))
    if (slider) {
      slider.dragging = true
      slider.el.classList.add('za-pressed')
      let value = slider.pointToValue(e)
      slider.set(value)
      if (slider.kind === 'volume') void window.spotify.setVolume(Math.round(value * 100))
      const move = (ev: PointerEvent) => {
        value = slider.pointToValue(ev)
        slider.set(value)
        if (slider.kind === 'volume') void window.spotify.setVolume(Math.round(value * 100))
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        slider.el.classList.remove('za-pressed')
        if (slider.kind === 'seek') {
          const dur = (this.state?.track?.durationMs ?? 0) / 1000
          if (dur > 0) void window.spotify.seek(value * dur)
        }
        // Let the confirmed state arrive before tracking it again.
        setTimeout(() => (slider.dragging = false), 400)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      return
    }

    // Anything else painted: drag the player window.
    this.host.dragStart()
    window.addEventListener('pointerup', () => this.host.dragEnd(), { once: true })
  }

  private press(key: string) {
    const s = this.state
    switch (key) {
      case 'play':
        return void window.spotify.play()
      case 'pause':
        return void window.spotify.pause()
      case 'playpause':
        return void window.spotify.playpause()
      case 'stop':
        return void window.spotify.pause().then(() => window.spotify.seek(0))
      case 'next':
        return void window.spotify.next()
      case 'prev':
        return void window.spotify.prev()
      case 'shuffle':
        return void window.spotify.setShuffle(!s?.shuffling)
      case 'repeat':
        return void window.spotify.setRepeat(!s?.repeating)
      case 'vol-up':
        return void window.spotify.setVolume(Math.min(100, (s?.volume ?? 50) + 10))
      case 'vol-down':
        return void window.spotify.setVolume(Math.max(0, (s?.volume ?? 50) - 10))
      case 'close':
      case 'minimize':
        return this.host.close()
      case 'skins':
        return this.host.openSkins()
    }
  }
}
