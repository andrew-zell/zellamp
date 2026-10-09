// Renders the DMG window background in Winamp style, using the classic
// skin's own LCD font. Writes resources/dmg/background.tiff (1x + 2x).
//
//   npm run dmg-background
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '../..')
const out = path.join(root, 'resources/dmg')

// Must match package.json build.dmg.contents.
const W = 540
const H = 380
const APP = [150, 250]
const APPS = [390, 250]

const page = `
async function draw(base, scale) {
  const c = document.createElement('canvas')
  c.width = ${W} * scale
  c.height = ${H} * scale
  const ctx = c.getContext('2d')
  ctx.imageSmoothingEnabled = false
  ctx.scale(scale, scale)
  const img = async (url) => { const i = new Image(); i.src = url; await i.decode(); return i }
  const px = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }

  // Chrome body with the vis-grid dot texture.
  px(0, 0, ${W}, ${H}, '#262639')
  for (let y = 1; y < ${H}; y += 3) for (let x = 1; x < ${W}; x += 3) px(x, y, 1, 1, '#2e2e45')

  const bevel = (x, y, w, h, fill, inset) => {
    const hi = '#7a7a98', lo = '#0c0c14'
    px(x, y, w, 1, inset ? lo : hi); px(x, y, 1, h, inset ? lo : hi)
    px(x, y + h - 1, w, 1, inset ? hi : lo); px(x + w - 1, y, 1, h, inset ? hi : lo)
    px(x + 1, y + 1, w - 2, h - 2, fill)
  }

  // LCD text using text.bmp glyphs (green on black). Webamp keys letter
  // glyphs by their lowercase char code.
  const glyph = (ch) => {
    const code = ch.charCodeAt(0)
    return base.images['CHARACTER_' + code] || base.images['CHARACTER_32']
  }
  const text = async (str, x, y, size) => {
    for (const [i, ch] of [...str.toLowerCase()].entries()) {
      ctx.drawImage(await img(glyph(ch)), x + i * 5 * size, y, 5 * size, 6 * size)
    }
  }

  bevel(24, 20, ${W} - 48, 112, '#000000', true)
  await text('ZELLAMP', 44, 36, 4)
  await text('Drag Zellamp into Applications.', 44, 76, 2)
  await text('Then open it: setup walks you', 44, 92, 2)
  await text('through Spotify permissions.', 44, 108, 2)

  // Icon wells: mid-grey so Finder's labels read in light and dark mode.
  for (const [cx, cy] of [${JSON.stringify(APP)}, ${JSON.stringify(APPS)}]) {
    bevel(cx - 66, cy - 66, 132, 150, '#8b90a6', false)
  }

  // Chunky pixel arrow in vis-bar greens.
  const greens = ['#18a818', '#28c828', '#38e038', '#7cf07c']
  const ax = ${APP[0]} + 82, bx = ${APPS[0]} - 82, ay = ${APP[1]}
  for (let x = ax; x < bx - 16; x += 4) px(x, ay - 4, 3, 8, greens[Math.min(3, Math.floor(((x - ax) / (bx - ax)) * 4))])
  for (let i = 0; i < 5; i++) px(bx - 18 + i * 4, ay - 16 + i * 4, 3, 32 - i * 8, greens[3])

  bevel(38, 344, 31 * 5 + 12, 12, '#000000', true)
  await text('Zellamp for the Spotify Mac app', 44, 347, 1)
  return c.toDataURL()
}
`

app.whenReady().then(async () => {
  try {
    const base = fs.readFileSync(path.join(root, 'scripts/.cache/base-skin.json'), 'utf8')
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
    await win.loadURL('about:blank')
    await win.webContents.executeJavaScript(page + ';0')
    fs.mkdirSync(out, { recursive: true })
    for (const scale of [1, 2]) {
      const url = await win.webContents.executeJavaScript(`draw(${base}, ${scale})`)
      fs.writeFileSync(path.join(out, scale === 1 ? 'background.png' : 'background@2x.png'), Buffer.from(url.split(',')[1], 'base64'))
    }
    // Finder picks the right resolution from a multi-image TIFF.
    execFileSync('tiffutil', ['-cathidpicheck', path.join(out, 'background.png'), path.join(out, 'background@2x.png'), '-out', path.join(out, 'background.tiff')])
    console.log('wrote resources/dmg/background.tiff')
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.exit()
})
