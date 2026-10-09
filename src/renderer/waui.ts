import { PANEL_SIZE, panelScale } from '../shared/types'
import { genTitle, pixelText, wrap, type SkinKit } from './skinKit'
import './waui.css'

/**
 * Tiny Winamp-style UI kit for Zellamp's own windows. Everything is drawn
 * from the active skin (see skinKit.ts): gen.bmp chrome and title font,
 * text.bmp lettering, pledit colors for lists, bevels from the chrome.
 * Sizes are in skin pixels; main sets the window's zoom factor.
 */

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Node[]) => {
  const e = document.createElement(tag)
  if (className) e.className = className
  e.append(...children)
  return e
}

/** Builds the gen.bmp window frame filling the page; returns its content area. */
export function mountWindow(kit: SkinKit, title: string, onClose: () => void): HTMLElement {
  const c = kit.colors
  const root = document.documentElement.style
  root.setProperty('--face', c.face)
  root.setProperty('--light', c.light)
  root.setProperty('--dark', c.dark)
  root.setProperty('--text', c.text)
  root.setProperty('--accent', c.accent)
  root.setProperty('--list-fg', c.normal)
  root.setProperty('--list-current', c.current)
  root.setProperty('--list-bg', c.normalbg)
  root.setProperty('--list-selected', c.selectedbg)

  const part = (cls: string) => el('div', cls)
  const tl = part('g-tl')
  const fillL = part('g-fill g-fill-l')
  const leftEnd = part('g-end')
  const titleBox = part('g-title')
  const rightEnd = part('g-end')
  const fillR = part('g-fill g-fill-r')
  const tr = part('g-tr')
  const close = el('button', 'g-close')
  close.setAttribute('aria-label', 'Close')
  close.addEventListener('click', onClose)
  tr.append(close)
  const top = el('div', 'g-top', tl, fillL, leftEnd, titleBox, rightEnd, fillR, tr)

  const ml = el('div', 'g-ml', part('g-mlb'))
  const mr = el('div', 'g-mr', part('g-mrb'))
  const content = el('div', 'g-content')
  const middle = el('div', 'g-middle', ml, content, mr)
  const bottom = el('div', 'g-bottom', part('g-bl'), part('g-br'))
  const frame = el('div', 'g-window', top, middle, bottom)
  frame.style.width = `${PANEL_SIZE.width}px`
  frame.style.height = `${PANEL_SIZE.height}px`
  fitToDisplay()

  const bg = (node: HTMLElement, sprite: string) => (node.style.backgroundImage = `url(${kit.gen[sprite]})`)
  const paint = (focused: boolean) => {
    const s = focused ? '_SELECTED' : ''
    bg(tl, `GEN_TOP_LEFT${s}`)
    bg(fillL, `GEN_TOP_LEFT_RIGHT_FILL${s}`)
    bg(leftEnd, `GEN_TOP_LEFT_END${s}`)
    bg(titleBox, `GEN_TOP_CENTER_FILL${s}`)
    bg(rightEnd, `GEN_TOP_RIGHT_END${s}`)
    bg(fillR, `GEN_TOP_LEFT_RIGHT_FILL${s}`)
    bg(tr, `GEN_TOP_RIGHT${s}`)
    const titleCanvas = genTitle(kit, title, focused)
    titleBox.replaceChildren(titleCanvas)
    // Lay the title row out in whole skin pixels. Flex-shared fills can end
    // on a half pixel, which shifts the title off the pixel grid and smears
    // the letters once zoomed.
    const TITLE_PAD = 4 + 3
    const fixed = 25 * 4 + titleCanvas.width + TITLE_PAD
    const free = Math.max(0, PANEL_SIZE.width - fixed)
    fillL.style.flex = fillR.style.flex = 'none'
    fillL.style.width = `${Math.floor(free / 2)}px`
    fillR.style.width = `${free - Math.floor(free / 2)}px`
  }
  bg(ml, 'GEN_MIDDLE_LEFT')
  bg(ml.firstElementChild as HTMLElement, 'GEN_MIDDLE_LEFT_BOTTOM')
  bg(mr, 'GEN_MIDDLE_RIGHT')
  bg(mr.firstElementChild as HTMLElement, 'GEN_MIDDLE_RIGHT_BOTTOM')
  bg(bottom, 'GEN_BOTTOM_FILL')
  bg(bottom.children[0] as HTMLElement, 'GEN_BOTTOM_LEFT')
  bg(bottom.children[1] as HTMLElement, 'GEN_BOTTOM_RIGHT')
  close.style.setProperty('--close-pressed', `url(${kit.gen.GEN_CLOSE_SELECTED})`)

  paint(document.hasFocus())
  window.onfocus = () => paint(true)
  window.onblur = () => paint(false)

  document.body.replaceChildren(frame)
  return content
}

/**
 * Zoom to a whole number of device pixels per skin pixel for the display the
 * window is on, and ask main to size the window to match. Re-runs when the
 * window moves to a display with a different pixel density.
 */
let watchingDpr = false
function fitToDisplay() {
  const scale = panelScale(window.devicePixelRatio)
  // CSS zoom, not webContents zoom: Chromium shares zoom across same-origin
  // windows, which would also scale the widget.
  document.documentElement.style.zoom = String(scale)
  window.widget.fitPanel(scale)
  if (watchingDpr) return
  watchingDpr = true
  const watch = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    mq.addEventListener(
      'change',
      () => {
        watchingDpr = false
        fitToDisplay()
        watch()
      },
      { once: true },
    )
  }
  watch()
}

export function text(kit: SkinKit, str: string, color = kit.colors.text) {
  return pixelText(kit, str, color)
}

/** Multi-line pixel text, wrapped to `chars` columns. */
export function paragraph(kit: SkinKit, str: string, chars: number, color = kit.colors.text) {
  const box = el('div', 'px-para')
  for (const line of wrap(str, chars)) box.append(pixelText(kit, line || ' ', color))
  return box
}

export function label(kit: SkinKit, str: string) {
  return el('div', 'px-label', pixelText(kit, str, kit.colors.onFace))
}

/** Sunken panel (list / display area). */
export function panel(className = '', ...children: Node[]) {
  return el('div', `wa-panel ${className}`, ...children)
}

/** Raised bevel button with a pixel-font label. */
export function button(kit: SkinKit, str: string, onClick: () => void, opts: { disabled?: boolean } = {}) {
  const b = el('button', 'wa-button', pixelText(kit, str, kit.colors.onFace))
  b.type = 'button'
  b.disabled = Boolean(opts.disabled)
  b.addEventListener('click', onClick)
  return b
}

export function row(className = '', ...children: Node[]) {
  return el('div', `wa-row ${className}`, ...children)
}

export function div(className = '', ...children: Node[]) {
  return el('div', className, ...children)
}
