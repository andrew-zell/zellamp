// Runs inside an offscreen Electron page. Rebuilds Winamp sprite sheets
// from Webamp's per-sprite base skin images.
async function loadImage(url) {
  const img = new Image()
  img.src = url
  await img.decode()
  return img
}

// Standard gen.bmp size; its title font lives below the chrome sprites.
const GEN_SIZE = [194, 109]
// Letter rows: selected at y=88, normal at y=96, starting at x=1, each
// letter followed by a 1px separator column of the background color.
const GEN_LETTER_ROWS = { selected: 88, normal: 96 }

// Returns { SHEET: canvas } for every sheet in the sprite table.
async function assembleSheets(base) {
  const sheets = {}
  for (const [sheet, sprites] of Object.entries(base.sprites)) {
    let w = Math.max(...sprites.map((s) => s.x + s.width))
    let h = Math.max(...sprites.map((s) => s.y + s.height))
    if (sheet === 'GEN') [w, h] = GEN_SIZE
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, w, h)
    for (const s of sprites) {
      const url = base.images[s.name]
      if (!url) continue
      ctx.drawImage(await loadImage(url), s.x, s.y, s.width, s.height)
    }
    if (sheet === 'GEN') await drawGenLetters(ctx, base.genLetters)
    sheets[sheet] = canvas
  }
  return sheets
}
window.assembleSheets = assembleSheets

async function drawGenLetters(ctx, letters) {
  const widths = {}
  for (const [row, y] of Object.entries(GEN_LETTER_ROWS)) {
    let x = 1
    for (const [ch, urls] of Object.entries(letters)) {
      const img = await loadImage(urls[row])
      ctx.drawImage(img, x, y)
      widths[ch] = img.width
      x += img.width + 1
    }
  }
  window.__genLetterWidths = widths
}
