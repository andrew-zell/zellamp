// Generates Zellamp's bundled themes as real Winamp 2 .wsz skins.
//
//   npm run themes
//
// Runs in Electron so we get a real canvas: base sprite sheets are rebuilt
// from Webamp's embedded skin, restyled per theme (engine.js), and zipped.
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const themes = require('./themes.cjs')

const root = path.join(__dirname, '../..')
const outDir = path.join(root, 'resources/themes')

/** Minimal deflate zip writer (enough for .wsz). */
function zip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name)
    const deflated = zlib.deflateRawSync(data, { level: 9 })
    const crc = zlib.crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(deflated.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(deflated.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBuf, deflated)
    centrals.push(central, nameBuf)
    offset += local.length + nameBuf.length + deflated.length
  }
  const centralBuf = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, end])
}

async function main() {
  const base = fs.readFileSync(path.join(root, 'scripts/.cache/base-skin.json'), 'utf8')
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } })
  await win.loadURL('about:blank')
  for (const file of ['sheets.js', 'engine.js']) {
    await win.webContents.executeJavaScript(fs.readFileSync(path.join(__dirname, file), 'utf8') + '\n;0')
  }
  await win.webContents.executeJavaScript(`assembleSheets(${base}).then((s) => { window.__sheets = s; return 0 })`)

  fs.mkdirSync(outDir, { recursive: true })
  const { colors, playlistStyle } = JSON.parse(base)
  const classic = {
    id: 'classic',
    name: 'Winamp Classic',
    description: 'The original Winamp 2.91 base skin, untouched.',
    build: `buildClassic(window.__sheets, ${JSON.stringify(colors)}, ${JSON.stringify(playlistStyle)})`,
  }
  const manifest = []
  for (const theme of [classic, ...themes]) {
    const files = await win.webContents.executeJavaScript(
      theme.build ?? `buildTheme(window.__sheets, ${JSON.stringify(theme)})`,
    )
    const entries = Object.entries(files).map(([name, f]) => ({
      name,
      data: f.base64 != null ? Buffer.from(f.base64, 'base64') : Buffer.from(f.text, 'latin1'),
    }))
    const file = `${theme.id}.wsz`
    const wsz = zip(entries)
    fs.writeFileSync(path.join(outDir, file), wsz)
    manifest.push({ id: theme.id, name: theme.name, description: theme.description, file })
    console.log(`${file}  ${(wsz.length / 1024).toFixed(0)} KB`)
  }
  fs.writeFileSync(path.join(outDir, 'themes.json'), JSON.stringify(manifest, null, 2) + '\n')
}

app.whenReady().then(async () => {
  try {
    await main()
  } catch (err) {
    console.error(err)
    process.exitCode = 1
  }
  app.exit()
})
