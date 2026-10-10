// Draws Zellamp's pixel-art icons and writes them scaled with hard pixels:
//   resources/icon.png     1024×1024 app icon (macOS build, About window)
//   resources/icon.icns    macOS app icon, 16–1024 px (needs macOS iconutil)
//   resources/icon.ico     Windows app icon, 16–256 px
//   src/main/trayIcon.ts   menu bar (template) and Windows tray icons
// Usage: node scripts/icon/build-icon.mjs
//
// The app icon is drawn on a 64×64 grid; its body fills 52×52 cells (832 of
// 1024 px), matching Apple's app icon grid. Below 64 px a separate 16×16
// drawing is used, scaled by whole numbers, so small sizes stay crisp.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

const N = 64
const C = {
  outline: '#020d05',
  bezelDark: '#0a3d17',
  bezel: '#13702b',
  bezelLight: '#2fb84a',
  bezelHi: '#7cf27a',
  screen: '#03140a',
  screenEdge: '#000000',
  grid: '#0a2f16',
  barLow: '#3cae1e',
  barMid: '#5fd41f',
  barHigh: '#a6f22a',
  barTop: '#d9ff4a',
  peak: '#f2ffb0',
  zFace: '#e4ff3c',
  zLight: '#fbffc2',
  zShadow: '#2c5a00',
  led: '#7cff4a',
  ledOff: '#0f4a1d',
  key: '#1d8f36',
  keyHi: '#6fe86a',
  keyLo: '#06280e',
}

const px = Array.from({ length: N * N }, () => null)
const set = (x, y, c) => {
  if (x >= 0 && y >= 0 && x < N && y < N) px[y * N + x] = c
}
const rect = (x0, y0, x1, y1, c) => {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c)
}

/** Stepped rounded corner: is (x, y) inside a rounded rect? */
function inRound(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false
  const cx = x < x0 + r ? x0 + r : x > x1 - r ? x1 - r : x
  const cy = y < y0 + r ? y0 + r : y > y1 - r ? y1 - r : y
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + r * 0.6
}

// ---- body (rounded, Apple grid: cells 6..57) ----
const B = { x0: 6, y0: 6, x1: 57, y1: 57, r: 9 }
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (!inRound(x, y, B.x0, B.y0, B.x1, B.y1, B.r)) continue
    const inner = inRound(x, y, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
    if (!inner) set(x, y, C.outline)
    else {
      // Light from the top left: highlight band top/left, shade bottom/right.
      const nearTop = !inRound(x, y - 2, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
      const nearLeft = !inRound(x - 2, y, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
      const nearBottom = !inRound(x, y + 2, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
      const nearRight = !inRound(x + 2, y, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
      const edgeTop = !inRound(x, y - 1, B.x0 + 1, B.y0 + 1, B.x1 - 1, B.y1 - 1, B.r - 1)
      if (edgeTop) set(x, y, C.bezelHi)
      else if (nearTop || nearLeft) set(x, y, C.bezelLight)
      else if (nearBottom || nearRight) set(x, y, C.bezelDark)
      else set(x, y, C.bezel)
    }
  }
}

// ---- screen ----
const S = { x0: 11, y0: 11, x1: 52, y1: 43 }
rect(S.x0 - 1, S.y0 - 1, S.x1 + 1, S.y1 + 1, C.bezelDark) // recess
rect(S.x0 - 1, S.y1 + 1, S.x1 + 1, S.y1 + 1, C.bezelHi) // recess lip catches light
rect(S.x1 + 1, S.y0 - 1, S.x1 + 1, S.y1 + 1, C.bezelLight)
rect(S.x0, S.y0, S.x1, S.y1, C.screenEdge)
rect(S.x0 + 1, S.y0 + 1, S.x1 - 1, S.y1 - 1, C.screen)
// Faint grid.
for (let x = S.x0 + 6; x < S.x1; x += 7) rect(x, S.y0 + 1, x, S.y1 - 1, C.grid)
for (let y = S.y0 + 5; y < S.y1; y += 7) rect(S.x0 + 1, y, S.x1 - 1, y, C.grid)

// ---- equalizer: dot-matrix bars (3×2 dots, 1px gaps) ----
const heights = [3, 4, 5, 7, 9, 6, 8, 5, 7]
// Columns under the Z stay short (row 4 max) so they clear its plate.
const peaks = [4, 0, 0, 8, 9, 8, 9, 7, 9]
const ROWS = 9
const barX = (i) => S.x0 + 3 + i * 4
const dotY = (row) => S.y1 - 2 - row * 3 // row 0 at the bottom
const rowColor = (row) => (row < 3 ? C.barLow : row < 5 ? C.barMid : row < 7 ? C.barHigh : C.barTop)
heights.forEach((h, i) => {
  for (let row = 0; row < h; row++) rect(barX(i), dotY(row) - 1, barX(i) + 2, dotY(row), rowColor(row))
  // A highlight on each bar's top dot.
  rect(barX(i), dotY(h - 1) - 1, barX(i) + 2, dotY(h - 1) - 1, C.peak)
  // Floating peak marker.
  const p = Math.min(ROWS - 1, peaks[i])
  if (p > h) rect(barX(i), dotY(p) - 1, barX(i) + 2, dotY(p), C.peak)
})

// ---- Z (block letter, top-left of the screen, drop shadow) ----
const Z = [
  '###########',
  '###########',
  '       ####',
  '      #### ',
  '     ####  ',
  '    ####   ',
  '   ####    ',
  '  ####     ',
  ' ####      ',
  '###########',
  '###########',
]
const zx = S.x0 + 3
const zy = S.y0 + 2
// Clear a dark plate so the letter reads over the grid and bars.
rect(zx - 1, zy - 1, zx + Z[0].length, zy + Z.length + 1, C.screen)
Z.forEach((line, y) =>
  [...line].forEach((ch, x) => {
    if (ch === '#') set(zx + x + 1, zy + y + 1, C.zShadow)
  }),
)
Z.forEach((line, y) =>
  [...line].forEach((ch, x) => {
    if (ch !== '#') return
    const top = y === 0 || line[x] !== Z[y - 1]?.[x]
    set(zx + x, zy + y, top ? C.zLight : C.zFace)
  }),
)

// ---- control strip under the screen ----
const cy = 48
rect(13, cy, 15, cy + 2, C.led) // power LED
set(13, cy, C.peak)
rect(18, cy, 20, cy + 2, C.ledOff)
// Two keys on the right.
for (const kx of [34, 44]) {
  rect(kx, cy - 1, kx + 7, cy + 3, C.keyLo)
  rect(kx, cy - 1, kx + 6, cy + 2, C.key)
  rect(kx, cy - 1, kx + 6, cy - 1, C.keyHi)
  rect(kx, cy - 1, kx, cy + 2, C.keyHi)
}
// Speaker grille slots.
for (let x = 24; x <= 30; x += 2) rect(x, cy, x, cy + 2, C.bezelDark)

// ---- small icon (16×16, for 16–48 px) ----
const SMALL_PALETTE = {
  o: C.outline, h: C.bezelHi, l: C.bezelLight, b: C.bezel, d: C.bezelDark, s: C.screen,
  Z: C.zLight, z: C.zFace, 1: C.barLow, 2: C.barMid, 3: C.barHigh, 4: C.barTop, L: C.led, k: C.keyHi,
}
const SMALL = [
  '.oooooooooooooo.',
  'ohhhhhhhhhhhhhho',
  'olssssssssssssdo',
  'olsZZZZZssssssdo',
  'olsssszsssssssdo',
  'olssszsssss4ssdo',
  'olsszssssss3s4do',
  'olszzzzzs4s3s3do',
  'olsssssss2s2s2do',
  'olsssssss1s1s1do',
  'olssssssssssssdo',
  'olbbbbbbbbbbbbdo',
  'olbLbbbbbkkbkkdo',
  'olbbbbbbbbbbbbdo',
  'oddddddddddddddo',
  '.oooooooooooooo.',
]

// ---- menu bar template (black + alpha; macOS tints it) ----
const TEMPLATE = [
  '................',
  '................',
  '.##############.',
  '################',
  '##.....#########',
  '#####.##########',
  '####.######.####',
  '###.#######.#.##',
  '##.....##.#.#.##',
  '#########.#.#.##',
  '#########.#.#.##',
  '################',
  '.##############.',
  '......####......',
  '....########....',
  '................',
]

const fromArt = (rows, palette) => {
  const n = rows.length
  if (rows.some((r) => r.length !== n)) throw new Error('icon art rows must be square')
  return { n, px: rows.flatMap((r) => [...r].map((ch) => palette[ch] ?? null)) }
}
const big = { n: N, px }
const small = fromArt(SMALL, SMALL_PALETTE)
const template = fromArt(TEMPLATE, { '#': '#000000' })

// ---- PNG writer ----
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
function crc32(buf) {
  let c = ~0
  for (const b of buf) {
    c ^= b
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1
  }
  return ~c >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
/** Encode `art` scaled by a whole number, centered with `pad` clear pixels. */
function png(art, scale, pad = 0) {
  const size = art.n * scale + pad * 2
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const ax = Math.floor((x - pad) / scale)
      const ay = Math.floor((y - pad) / scale)
      const inside = x >= pad && y >= pad && ax < art.n && ay < art.n
      const c = inside ? art.px[ay * art.n + ax] : null
      if (!c) continue
      const o = y * (size * 4 + 1) + 1 + x * 4
      const [r, g, b] = hexRgb(c)
      raw[o] = r
      raw[o + 1] = g
      raw[o + 2] = b
      raw[o + 3] = 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** .ico with PNG-compressed entries (Windows Vista and later). */
function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = header.length
  images.forEach(({ size, data }, i) => {
    const e = 6 + i * 16
    header[e] = size >= 256 ? 0 : size
    header[e + 1] = size >= 256 ? 0 : size
    header.writeUInt16LE(1, e + 4)
    header.writeUInt16LE(32, e + 6)
    header.writeUInt32LE(data.length, e + 8)
    header.writeUInt32LE(offset, e + 12)
    offset += data.length
  })
  return Buffer.concat([header, ...images.map((i) => i.data)])
}

const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`
const root = join(import.meta.dirname, '../..')

writeFileSync(join(root, 'resources/icon.png'), png(big, 16))
// Each size is a whole-number scale of one of the drawings.
const winSizes = [
  [16, small, 1, 0],
  [20, small, 1, 2],
  [24, small, 1, 4],
  [32, small, 2, 0],
  [40, small, 2, 4],
  [48, small, 3, 0],
  [64, big, 1, 0],
  [128, big, 2, 0],
  [256, big, 4, 0],
]
writeFileSync(
  join(root, 'resources/icon.ico'),
  ico(winSizes.map(([size, art, scale, pad]) => ({ size, data: png(art, scale, pad) }))),
)
writeFileSync(
  join(root, 'src/main/trayIcon.ts'),
  `// Generated by scripts/icon/build-icon.mjs. Do not edit.
// macOS menu bar: template icon (black + alpha), 16pt @1x and @2x.
export const TRAY_ICON_1X = '${dataUrl(png(template, 1))}'
export const TRAY_ICON_2X = '${dataUrl(png(template, 2))}'
// Windows tray: full color, 16px @1x and @2x.
export const TRAY_ICON_COLOR_1X = '${dataUrl(png(small, 1))}'
export const TRAY_ICON_COLOR_2X = '${dataUrl(png(small, 2))}'
`,
)

// macOS .icns: hand-drawn small sizes too (a resized 1024 would blur them).
if (process.platform === 'darwin') {
  const set = join(mkdtempSync(join(tmpdir(), 'zellamp-icon-')), 'icon.iconset')
  execFileSync('mkdir', [set])
  const macSizes = [
    ['16x16', small, 1],
    ['16x16@2x', small, 2],
    ['32x32', small, 2],
    ['32x32@2x', small, 4],
    ['128x128', big, 2],
    ['128x128@2x', big, 4],
    ['256x256', big, 4],
    ['256x256@2x', big, 8],
    ['512x512', big, 8],
    ['512x512@2x', big, 16],
  ]
  for (const [name, art, scale] of macSizes) writeFileSync(join(set, `icon_${name}.png`), png(art, scale))
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'resources/icon.icns')])
  rmSync(join(set, '..'), { recursive: true })
}
console.log('wrote resources/icon.png, icon.icns, icon.ico, src/main/trayIcon.ts')
