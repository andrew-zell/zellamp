// Pulls Webamp's embedded base skin (per-sprite PNGs + sprite sheet coordinates)
// out of its bundle so the theme generator can rebuild real Winamp sprite sheets.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'node_modules/webamp/built/webamp.lazy-bundle.js'), 'utf8')

// Grab `<decl> name = {...}` / `[...]` by bracket matching from its declaration.
// `prelude` is evaluated first (for objects that reference earlier consts).
function grab(decl, prelude = '') {
  const start = src.indexOf(decl)
  if (start < 0) throw new Error(`not found: ${decl}`)
  const open = src.indexOf(decl.endsWith('[') ? '[' : '{', start + decl.length - 1)
  const close = { '{': '}', '[': ']' }[src[open]]
  let depth = 0
  let inStr = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (c === '\\') i++
      else if (c === inStr) inStr = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') inStr = c
    else if (c === src[open]) depth++
    else if (c === close && --depth === 0) {
      return vm.runInNewContext(`${prelude}\n;(${src.slice(open, i + 1)})`, { UTF8_ELLIPSIS: '\u2026' })
    }
  }
  throw new Error(`unterminated: ${decl}`)
}

// The base skin's sprites live in a compiled stylesheet, keyed by CSS selector.
const cssStart = src.indexOf('"', src.indexOf('var css_248z = '))
let cssEnd = cssStart + 1
while (src[cssEnd] !== '"') cssEnd += src[cssEnd] === '\\' ? 2 : 1
const css = JSON.parse(src.slice(cssStart, cssEnd + 1))
const urlBySelector = {}
for (const m of css.matchAll(/([^{}]+)\{background-image: url\((data:image\/png;base64,[^)]+)\)\}/g)) {
  for (const sel of m[1].split(',')) urlBySelector[sel.trim().replace(/^#webamp /, '')] = m[2]
}
const imageSelectors = grab('const imageSelectors = {')

const sprites = grab(
  'const sprites = {',
  src.slice(src.indexOf('const FONT_LOOKUP = {'), src.indexOf('const sprites = {')),
)
const images = {}
const missing = []
for (const sprite of Object.values(sprites).flat()) {
  const selectors = sprite.name.startsWith('CHARACTER_')
    ? [`.character-${sprite.name.slice('CHARACTER_'.length)}`]
    : (imageSelectors[sprite.name] ?? [])
  const url = selectors.map((sel) => urlBySelector[sel]).find(Boolean)
  if (url) images[sprite.name] = url
  else missing.push(sprite.name)
}

// Generic-window (gen.bmp) title font. Webamp keeps these outside the
// sprite table; the theme builder writes them back into gen.bmp rows 88/96.
const genLetters = {}
for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
  const lower = ch.toLowerCase()
  genLetters[ch] = {
    selected: urlBySelector[`.gen-window.selected .gen-text-${lower}`],
    normal: urlBySelector[`.gen-text-${lower}`],
  }
  if (!genLetters[ch].selected || !genLetters[ch].normal) missing.push(`GEN_TEXT_${ch}`)
}

const out = {
  images,
  genLetters,
  missing,
  colors: grab('var colors = ['),
  playlistStyle: grab('var playlistStyle = {'),
  sprites,
}
const dest = join(root, 'scripts/.cache/base-skin.json')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, JSON.stringify(out))
console.log(
  Object.keys(images).length, 'images,', missing.length, 'missing:', missing.join(' '), '\n',
  Object.entries(out.sprites).map(([k, v]) => `${k}(${v.length})`).join(' '),
)
