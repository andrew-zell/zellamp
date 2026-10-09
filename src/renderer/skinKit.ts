import { unzip } from './skinPreview'

/**
 * Everything Zellamp's own windows (gallery, setup) need to draw themselves
 * in the active skin: gen.bmp window chrome and title font, the text.bmp
 * pixel font, playlist colors, and bevel colors sampled from the chrome.
 */

/** Which classic skin dresses Zellamp's own windows for the active theme. */
export function kitThemeId(themes: { id: string; kind: string; panel?: string }[], active: string) {
  const info = themes.find((t) => t.id === active)
  return info?.kind === 'freeform' ? (info.panel ?? 'classic') : active
}

export interface SkinKit {
  /** gen.bmp sprites as data URLs, keyed by Webamp's sprite names. */
  gen: Record<string, string>
  /** text.bmp glyph coverage masks (5×6), keyed by character. */
  glyphs: Map<string, Float32Array>
  colors: {
    /** Playlist (list) colors from pledit.txt. */
    normal: string
    current: string
    normalbg: string
    selectedbg: string
    /** Chrome colors sampled from gen.bmp. */
    face: string
    light: string
    dark: string
    /** Title text color (focused / unfocused), sampled from gen.bmp's font. */
    text: string
    textInactive: string
    accent: string
    /** Skin color with the best contrast on `face` (labels, buttons). */
    onFace: string
  }
}

const GEN_SPRITES: [string, number, number, number, number][] = [
  ['GEN_TOP_LEFT_SELECTED', 0, 0, 25, 20],
  ['GEN_TOP_LEFT_END_SELECTED', 26, 0, 25, 20],
  ['GEN_TOP_CENTER_FILL_SELECTED', 52, 0, 25, 20],
  ['GEN_TOP_RIGHT_END_SELECTED', 78, 0, 25, 20],
  ['GEN_TOP_LEFT_RIGHT_FILL_SELECTED', 104, 0, 25, 20],
  ['GEN_TOP_RIGHT_SELECTED', 130, 0, 25, 20],
  ['GEN_TOP_LEFT', 0, 21, 25, 20],
  ['GEN_TOP_LEFT_END', 26, 21, 25, 20],
  ['GEN_TOP_CENTER_FILL', 52, 21, 25, 20],
  ['GEN_TOP_RIGHT_END', 78, 21, 25, 20],
  ['GEN_TOP_LEFT_RIGHT_FILL', 104, 21, 25, 20],
  ['GEN_TOP_RIGHT', 130, 21, 25, 20],
  ['GEN_BOTTOM_LEFT', 0, 42, 125, 14],
  ['GEN_BOTTOM_RIGHT', 0, 57, 125, 14],
  ['GEN_BOTTOM_FILL', 127, 72, 25, 14],
  ['GEN_MIDDLE_LEFT', 127, 42, 11, 29],
  ['GEN_MIDDLE_LEFT_BOTTOM', 158, 42, 11, 24],
  ['GEN_MIDDLE_RIGHT', 139, 42, 8, 29],
  ['GEN_MIDDLE_RIGHT_BOTTOM', 170, 42, 8, 24],
  ['GEN_CLOSE_SELECTED', 148, 42, 9, 9],
]

// text.bmp layout: [row, column] of each 5×6 glyph (same table Winamp uses).
const FONT: Record<string, [number, number]> = {}
'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').forEach((c, i) => (FONT[c] = [0, i]))
'0123456789'.split('').forEach((c, i) => (FONT[c] = [1, i]))
Object.assign(FONT, {
  '"': [0, 26], '@': [0, 27], ' ': [0, 30],
  '…': [1, 10], '.': [1, 11], ':': [1, 12], '(': [1, 13], ')': [1, 14], '-': [1, 15], "'": [1, 16],
  '!': [1, 17], _: [1, 18], '+': [1, 19], '\\': [1, 20], '/': [1, 21], '[': [1, 22], ']': [1, 23],
  '^': [1, 24], '&': [1, 25], '%': [1, 26], ',': [1, 27], '=': [1, 28], $: [1, 29], '#': [1, 30],
  '?': [2, 3], '*': [2, 4], '<': [1, 22], '>': [1, 23], '{': [1, 22], '}': [1, 23],
})

const GEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

type Rgb = [number, number, number]
const hex = ([r, g, b]: Rgb) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
const lum = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b

async function bitmap(bytes: Uint8Array<ArrayBuffer> | undefined) {
  if (!bytes) return null
  try {
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/bmp' }))
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    ctx.drawImage(bmp, 0, 0)
    return ctx
  } catch {
    return null
  }
}

function crop(src: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')!.putImageData(src.getImageData(x, y, w, h), 0, 0)
  return c
}

function pixels(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): Rgb[] {
  const d = ctx.getImageData(x, y, w, h).data
  const out: Rgb[] = []
  for (let i = 0; i < d.length; i += 4) out.push([d[i], d[i + 1], d[i + 2]])
  return out
}

const mode = (px: Rgb[]) => {
  const counts = new Map<string, [Rgb, number]>()
  for (const p of px) {
    const k = p.join()
    const e = counts.get(k)
    counts.set(k, [p, (e?.[1] ?? 0) + 1])
  }
  return [...counts.values()].sort((a, b) => b[1] - a[1])[0][0]
}
const parseHex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb
/** WCAG contrast ratio. */
function contrast(a: Rgb, b: Rgb) {
  const rel = (c: Rgb) => {
    const [r, g, bl] = c.map((v) => {
      const s = v / 255
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl
  }
  const [x, y] = [rel(a), rel(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}
const brightest = (px: Rgb[]) => px.reduce((a, b) => (lum(b) > lum(a) ? b : a))
const darkest = (px: Rgb[]) => px.reduce((a, b) => (lum(b) < lum(a) ? b : a))

/** Same algorithm Webamp uses to find gen.bmp's variable-width letters. */
function genLetters(gen: CanvasRenderingContext2D, y: number) {
  const width = gen.canvas.width
  const at = (x: number) => gen.getImageData(x, y, 1, 1).data.join()
  const bg = at(0)
  const out = new Map<string, HTMLCanvasElement>()
  let x = 1
  for (const letter of GEN_LETTERS) {
    let end = x
    while (end < width && at(end) !== bg) end++
    if (end > x) out.set(letter, crop(gen, x, y, end - x, 7))
    x = end + 1
  }
  return out
}

function parsePledit(bytes: Uint8Array<ArrayBuffer> | undefined) {
  const out: Record<string, string> = {}
  if (!bytes) return out
  for (const line of new TextDecoder('latin1').decode(bytes).split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+)\s*=\s*(#?[0-9a-f]{6})/i)
    if (m) out[m[1].toLowerCase()] = m[2].startsWith('#') ? m[2] : `#${m[2]}`
  }
  return out
}

const FILES = ['gen.bmp', 'text.bmp', 'pledit.txt']

export async function loadKit(
  wsz: Uint8Array<ArrayBuffer> | null,
  classic: () => Promise<Uint8Array<ArrayBuffer> | null>,
): Promise<SkinKit> {
  const files = wsz ? await unzip(wsz, FILES).catch(() => new Map()) : new Map()
  // Skins without gen.bmp / text.bmp borrow them from the classic skin.
  if (FILES.some((f) => !files.has(f))) {
    const base = await classic()
    if (base) for (const [k, v] of await unzip(base, FILES)) if (!files.has(k)) files.set(k, v)
  }
  const gen = await bitmap(files.get('gen.bmp'))
  const text = await bitmap(files.get('text.bmp'))
  if (!gen || !text) throw new Error('skin is missing gen.bmp / text.bmp')

  const sprites: Record<string, string> = {}
  for (const [name, x, y, w, h] of GEN_SPRITES) sprites[name] = crop(gen, x, y, w, h).toDataURL()

  // Glyph coverage: distance from the font's background color.
  const bgPx = pixels(text, 150, 0, 1, 1)[0]
  const glyphs = new Map<string, Float32Array>()
  let maxDist = 1
  const raw = new Map<string, number[]>()
  for (const [ch, [row, col]] of Object.entries(FONT)) {
    const px = pixels(text, col * 5, row * 6, 5, 6)
    const dist = px.map((p) => Math.abs(lum(p) - lum(bgPx)) + Math.abs(p[1] - bgPx[1]) * 0.25)
    maxDist = Math.max(maxDist, ...dist)
    raw.set(ch, dist)
  }
  for (const [ch, dist] of raw) glyphs.set(ch, Float32Array.from(dist, (d) => Math.min(1, (d / maxDist) * 1.6)))

  const pl = parsePledit(files.get('pledit.txt'))
  const letters = { selected: genLetters(gen, 88) }
  const letterPixels = (set: Map<string, HTMLCanvasElement>) =>
    [...set.values()].flatMap((c) => pixels(c.getContext('2d', { willReadFrequently: true })!, 0, 0, c.width, c.height))
  const letterPx = letterPixels(letters.selected)
  const edge = pixels(gen, 127, 42, 11, 29)
  const face = mode(pixels(gen, 127, 72, 25, 14))
  const textColor = letterPx.length ? brightest(letterPx) : ([255, 255, 255] as Rgb)
  const listBg = pl.normalbg ? parseHex(pl.normalbg) : ([0, 0, 0] as Rgb)
  const onFace = [textColor, darkest(edge), listBg].reduce((a, b) => (contrast(b, face) > contrast(a, face) ? b : a))
  return {
    gen: sprites,
    glyphs,
    colors: {
      normal: pl.normal ?? '#00ff00',
      current: pl.current ?? '#ffffff',
      normalbg: pl.normalbg ?? '#000000',
      selectedbg: pl.selectedbg ?? '#0000c6',
      face: hex(face),
      light: hex(brightest(edge)),
      dark: hex(darkest(edge)),
      text: hex(textColor),
      // Unfocused: dimmed toward the chrome but still readable.
      textInactive: hex(textColor.map((v, i) => Math.round(v * 0.6 + face[i] * 0.4)) as Rgb),
      onFace: hex(onFace),
      accent: hex(brightest(pixels(gen, 104, 0, 25, 20))),
    },
  }
}

/** Renders a string in the skin's pixel font. Unknown characters become spaces. */
export function pixelText(kit: SkinKit, str: string, color: string): HTMLCanvasElement {
  const chars = [...str.toUpperCase()]
  const c = document.createElement('canvas')
  c.width = Math.max(1, chars.length * 5)
  c.height = 6
  const ctx = c.getContext('2d')!
  const img = ctx.createImageData(c.width, 6)
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16))
  chars.forEach((ch, i) => {
    const mask = kit.glyphs.get(ch) ?? kit.glyphs.get(' ')!
    for (let y = 0; y < 6; y++)
      for (let x = 0; x < 5; x++) {
        const a = mask[y * 5 + x]
        if (a <= 0.05) continue
        const o = (y * c.width + i * 5 + x) * 4
        img.data[o] = r
        img.data[o + 1] = g
        img.data[o + 2] = b
        img.data[o + 3] = Math.round(a * 255)
      }
  })
  ctx.putImageData(img, 0, 0)
  c.className = 'px-text'
  return c
}

/** Greedy word wrap to `width` characters. */
export function wrap(str: string, width: number): string[] {
  const lines: string[] = []
  for (const para of str.split('\n')) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      if (!line) line = word
      else if (line.length + 1 + word.length <= width) line += ' ' + word
      else {
        lines.push(line)
        line = word
      }
    }
    lines.push(line)
  }
  return lines
}

// Title bar lettering. A fixed, hard-edged bold pixel font (same style as
// the ZELLAMP title on the built-in skins' main windows; see
// scripts/themes/engine.js). Skins' own gen.bmp fonts are tiny anti-aliased
// bitmaps that smear when zoomed and can't be cleaned up reliably, so only
// the colors come from the skin.
const TITLE_FONT: Record<string, string[]> = {
  A: [' #### ', '##  ##', '##  ##', '######', '##  ##', '##  ##', '##  ##'],
  B: ['##### ', '##  ##', '##  ##', '##### ', '##  ##', '##  ##', '##### '],
  C: [' #####', '##    ', '##    ', '##    ', '##    ', '##    ', ' #####'],
  D: ['##### ', '##  ##', '##  ##', '##  ##', '##  ##', '##  ##', '##### '],
  E: ['######', '##    ', '##    ', '##### ', '##    ', '##    ', '######'],
  F: ['######', '##    ', '##    ', '##### ', '##    ', '##    ', '##    '],
  G: [' #####', '##    ', '##    ', '## ###', '##  ##', '##  ##', ' #####'],
  H: ['##  ##', '##  ##', '##  ##', '######', '##  ##', '##  ##', '##  ##'],
  I: ['####', ' ## ', ' ## ', ' ## ', ' ## ', ' ## ', '####'],
  J: ['    ##', '    ##', '    ##', '    ##', '##  ##', '##  ##', ' #### '],
  K: ['##  ##', '##  ##', '## ## ', '####  ', '## ## ', '##  ##', '##  ##'],
  L: ['##    ', '##    ', '##    ', '##    ', '##    ', '##    ', '######'],
  M: ['##   ##', '### ###', '#######', '## # ##', '##   ##', '##   ##', '##   ##'],
  N: ['##  ##', '### ##', '######', '## ###', '##  ##', '##  ##', '##  ##'],
  O: [' #### ', '##  ##', '##  ##', '##  ##', '##  ##', '##  ##', ' #### '],
  P: ['##### ', '##  ##', '##  ##', '##### ', '##    ', '##    ', '##    '],
  Q: [' #### ', '##  ##', '##  ##', '##  ##', '## ###', '##  ##', ' ### #'],
  R: ['##### ', '##  ##', '##  ##', '##### ', '## ## ', '##  ##', '##  ##'],
  S: [' #####', '##    ', '##    ', ' #### ', '    ##', '    ##', '##### '],
  T: ['######', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  '],
  U: ['##  ##', '##  ##', '##  ##', '##  ##', '##  ##', '##  ##', ' #### '],
  V: ['##  ##', '##  ##', '##  ##', '##  ##', '##  ##', ' #### ', '  ##  '],
  W: ['##   ##', '##   ##', '##   ##', '## # ##', '#######', '### ###', '##   ##'],
  X: ['##  ##', '##  ##', ' #### ', '  ##  ', ' #### ', '##  ##', '##  ##'],
  Y: ['##  ##', '##  ##', ' #### ', '  ##  ', '  ##  ', '  ##  ', '  ##  '],
  Z: ['######', '    ##', '   ## ', '  ##  ', ' ##   ', '##    ', '######'],
  ' ': ['   ', '   ', '   ', '   ', '   ', '   ', '   '],
}

/** Window title in the bold pixel font, in the skin's title colors. */
export function genTitle(kit: SkinKit, title: string, focused: boolean): HTMLCanvasElement {
  const glyphs = [...title.toUpperCase()].map((ch) => TITLE_FONT[ch] ?? TITLE_FONT[' '])
  const c = document.createElement('canvas')
  // +1 for the drop shadow.
  c.width = Math.max(1, glyphs.reduce((w, g) => w + g[0].length + 1, -1)) + 1
  c.height = 8
  const ctx = c.getContext('2d')!
  const draw = (dx: number, dy: number, color: string) => {
    ctx.fillStyle = color
    let x = dx
    for (const g of glyphs) {
      g.forEach((row, y) => {
        for (let i = 0; i < row.length; i++) if (row[i] === '#') ctx.fillRect(x + i, y + dy, 1, 1)
      })
      x += g[0].length + 1
    }
  }
  // Shadow keeps it legible on light title bars, as Winamp titles often did.
  draw(1, 1, kit.colors.dark)
  draw(0, 0, focused ? kit.colors.text : kit.colors.textInactive)
  c.className = 'px-text'
  return c
}
