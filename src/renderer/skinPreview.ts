/**
 * Renders a Winamp main-window preview straight from a .wsz: unzip, decode
 * the BMP sprite sheets, and composite the sprites at their Winamp positions.
 * Sheets a skin doesn't include fall back to the classic skin, as in Winamp.
 */

const NEEDED = [
  'main.bmp',
  'titlebar.bmp',
  'cbuttons.bmp',
  'posbar.bmp',
  'volume.bmp',
  'balance.bmp',
  'shufrep.bmp',
  'monoster.bmp',
  'playpaus.bmp',
  'numbers.bmp',
  'nums_ex.bmp',
  'text.bmp',
  'viscolor.txt',
] as const

export type SkinFiles = Map<string, Uint8Array<ArrayBuffer>>

/** Minimal zip reader: central directory + stored/deflated entries. */
export async function unzip(zip: Uint8Array<ArrayBuffer>, wanted: readonly string[]): Promise<SkinFiles> {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  let eocd = zip.length - 22
  while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd--
  if (eocd < 0) throw new Error('not a zip')
  const count = dv.getUint16(eocd + 10, true)
  let p = dv.getUint32(eocd + 16, true)
  const out: SkinFiles = new Map()
  const decoder = new TextDecoder('latin1')
  for (let i = 0; i < count; i++) {
    const method = dv.getUint16(p + 10, true)
    const compSize = dv.getUint32(p + 20, true)
    const nameLen = dv.getUint16(p + 28, true)
    const extraLen = dv.getUint16(p + 30, true)
    const commentLen = dv.getUint16(p + 32, true)
    const localOffset = dv.getUint32(p + 42, true)
    // Skins are often zipped inside a folder; match on the base name.
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen)).split('/').pop()!.toLowerCase()
    p += 46 + nameLen + extraLen + commentLen
    if (!wanted.includes(name) || out.has(name)) continue
    const start = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true)
    const raw = zip.slice(start, start + compSize)
    if (method === 0) out.set(name, raw)
    else if (method === 8) {
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
      out.set(name, new Uint8Array(await new Response(stream).arrayBuffer()))
    }
  }
  return out
}

interface Sheets {
  images: Map<string, ImageBitmap>
  vis: string[] | null
}

async function decode(files: SkinFiles): Promise<Sheets> {
  const images = new Map<string, ImageBitmap>()
  await Promise.all(
    [...files]
      .filter(([name]) => name.endsWith('.bmp'))
      .map(async ([name, bytes]) => {
        try {
          images.set(name, await createImageBitmap(new Blob([bytes], { type: 'image/bmp' })))
        } catch {
          // Unreadable sheet: the classic fallback covers it.
        }
      }),
  )
  const txt = files.get('viscolor.txt')
  let vis: string[] | null = null
  if (txt) {
    const colors = new TextDecoder('latin1')
      .decode(txt)
      .split(/\r?\n/)
      .map((l) => l.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/))
      .filter(Boolean)
      .map((m) => `rgb(${m![1]},${m![2]},${m![3]})`)
    if (colors.length >= 24) vis = colors
  }
  return { images, vis }
}

let classic: Promise<Sheets> | null = null

export async function loadSheets(wsz: Uint8Array<ArrayBuffer>, fallback?: () => Promise<Uint8Array<ArrayBuffer> | null>) {
  const sheets = await decode(await unzip(wsz, NEEDED))
  if (fallback && NEEDED.some((n) => n.endsWith('.bmp') && n !== 'nums_ex.bmp' && !sheets.images.has(n))) {
    classic ??= fallback().then((d) => (d ? unzip(d, NEEDED).then(decode) : { images: new Map(), vis: null }))
    const base = await classic
    for (const [k, v] of base.images) if (!sheets.images.has(k)) sheets.images.set(k, v)
    sheets.vis ??= base.vis
  }
  return sheets
}

// text.bmp glyph positions (row, column), 5x6 each.
function glyph(ch: string): [number, number] {
  const c = ch.toUpperCase()
  if (c >= 'A' && c <= 'Z') return [0, c.charCodeAt(0) - 65]
  if (c >= '0' && c <= '9') return [1, c.charCodeAt(0) - 48]
  if (c === '-') return [1, 15]
  if (c === '.') return [1, 11]
  return [0, 30] // space
}

// A frozen spectrum so every preview shows the same "moment".
const BARS = [9, 13, 15, 14, 11, 12, 10, 8, 9, 7, 8, 6, 7, 5, 6, 4, 3, 3, 2]

/** Draws the main window (275×116) into `canvas`. */
export function renderMainWindow(canvas: HTMLCanvasElement, sheets: Sheets, marquee: string) {
  canvas.width = 275
  canvas.height = 116
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const img = (n: string) => sheets.images.get(n)
  const blit = (n: string, sx: number, sy: number, w: number, h: number, dx: number, dy: number) => {
    const im = img(n)
    if (im) ctx.drawImage(im, sx, sy, w, h, dx, dy, w, h)
  }

  blit('main.bmp', 0, 0, 275, 116, 0, 0)
  blit('titlebar.bmp', 27, 0, 275, 14, 0, 0)

  // Visualizer: 19 bars, colored per row from viscolor (index 2 = top).
  if (sheets.vis) {
    BARS.forEach((h, i) => {
      for (let r = 0; r < h; r++) {
        const row = 15 - r
        ctx.fillStyle = sheets.vis![2 + row]
        ctx.fillRect(24 + i * 4, 43 + row, 3, 1)
      }
      ctx.fillStyle = sheets.vis![23]
      ctx.fillRect(24 + i * 4, 43 + 15 - h - 1, 3, 1)
    })
  }

  blit('playpaus.bmp', 0, 0, 9, 9, 26, 28)
  // Time 02:47
  const digits = img('nums_ex.bmp') ? 'nums_ex.bmp' : 'numbers.bmp'
  ;[0, 2, 4, 7].forEach((d, i) => blit(digits, d * 9, 0, 9, 13, [48, 60, 78, 90][i], 26))

  // Marquee, kbps, khz in the skin's own font.
  const text = (s: string, x: number, y: number, maxChars: number) =>
    [...s.slice(0, maxChars)].forEach((ch, i) => {
      const [row, col] = glyph(ch)
      blit('text.bmp', col * 5, row * 6, 5, 6, x + i * 5, y)
    })
  text(marquee.padEnd(31, ' '), 111, 27, 31)
  text('320', 111, 43, 3)
  text('44', 156, 43, 2)

  blit('monoster.bmp', 0, 0, 29, 12, 212, 41)
  blit('monoster.bmp', 29, 12, 27, 12, 239, 41)
  blit('volume.bmp', 0, 20 * 15, 68, 13, 107, 57)
  blit('volume.bmp', 15, 422, 14, 11, 107 + 39, 58)
  blit('balance.bmp', 9, 0, 38, 13, 177, 57)
  blit('balance.bmp', 15, 422, 14, 11, 177 + 12, 58)
  blit('shufrep.bmp', 0, 73, 23, 12, 219, 58)
  blit('shufrep.bmp', 23, 61, 23, 12, 242, 58)
  blit('posbar.bmp', 0, 0, 248, 10, 16, 72)
  blit('posbar.bmp', 248, 0, 29, 10, 16 + 78, 72)
  blit('cbuttons.bmp', 0, 0, 114, 18, 16, 88)
  blit('cbuttons.bmp', 114, 0, 22, 16, 136, 89)
  blit('shufrep.bmp', 28, 0, 47, 15, 164, 89)
  blit('shufrep.bmp', 0, 0, 28, 15, 210, 89)
}
