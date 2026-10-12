// Runs inside an offscreen Electron page (see build-themes.cjs).
// Restyles the base Winamp sprite sheets into a theme, then encodes BMPs.

;(() => {
  // ---------- color helpers ----------
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))

  /** 256-entry LUT from stops [[pos, '#rrggbb'], ...]. */
  function rampLut(stops) {
    const lut = new Uint8ClampedArray(256 * 3)
    const parsed = stops.map(([p, c]) => [p, hex(c)])
    for (let i = 0; i < 256; i++) {
      const t = i / 255
      let k = 0
      while (k < parsed.length - 2 && t > parsed[k + 1][0]) k++
      const [p0, c0] = parsed[k]
      const [p1, c1] = parsed[k + 1]
      const f = Math.min(1, Math.max(0, (t - p0) / (p1 - p0 || 1)))
      for (let j = 0; j < 3; j++) lut[i * 3 + j] = c0[j] + (c1[j] - c0[j]) * f
    }
    return lut
  }

  function hsv(r, g, b) {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const d = max - min
    let h = 0
    if (d) {
      if (max === r) h = ((g - b) / d) % 6
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h *= 60
      if (h < 0) h += 360
    }
    return [h, max ? d / max : 0, max / 255]
  }

  // Base skin palette → semantic class. Chrome is grey / blue-grey; the
  // accents are the LCD greens, the gold thumbs, and the red/orange bars.
  function classify(r, g, b) {
    const [h, s, v] = hsv(r, g, b)
    if (s < 0.28 || v < 0.12) return 'chrome'
    if (h >= 190 && h <= 290) return 'chrome'
    if (h >= 75 && h < 190) return 'lcd'
    if (h >= 38 && h < 75) return 'gold'
    return 'red'
  }

  // ---------- textures (luminance offsets for chrome) ----------
  function rng(seed) {
    let s = seed >>> 0
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296
  }

  function makeTexture(kind, w, h, seed) {
    const tex = new Float32Array(w * h)
    const rand = rng(seed)
    for (let y = 0; y < h; y++) {
      let acc = 0
      const rowJitter = rand() - 0.5
      for (let x = 0; x < w; x++) {
        let v = 0
        switch (kind) {
          case 'scanlines':
            v = y % 2 ? -0.07 : 0.015
            break
          case 'brushed':
            acc = acc * 0.85 + (rand() - 0.5) * 0.15
            v = rowJitter * 0.05 + acc * 0.18
            break
          case 'wood': {
            const t = y * 0.9 + 4 * Math.sin(x * 0.035 + y * 0.11) + 2 * Math.sin(x * 0.13)
            v = Math.sin(t) * 0.055 + (rand() - 0.5) * 0.025
            break
          }
          case 'frost':
            v = (rand() - 0.5) * 0.04 + 0.035 * Math.sin((x + y) * 0.045)
            break
          case 'pinstripe':
            v = x % 3 === 0 ? 0.05 : -0.01
            break
        }
        tex[y * w + x] = v
      }
    }
    return tex
  }

  // Sheets that are window backgrounds get the texture; buttons and fonts don't.
  const TEXTURED = new Set(['MAIN', 'EQMAIN', 'PLEDIT', 'TITLEBAR', 'GEN'])

  // ---------- pixel font for title bars ----------
  const GLYPHS = {
    A: [' #### ', '##  ##', '##  ##', '######', '##  ##', '##  ##', '##  ##'],
    E: ['######', '##    ', '##    ', '##### ', '##    ', '##    ', '######'],
    I: ['####', ' ## ', ' ## ', ' ## ', ' ## ', ' ## ', '####'],
    L: ['##    ', '##    ', '##    ', '##    ', '##    ', '##    ', '######'],
    M: ['##   ##', '### ###', '#######', '## # ##', '##   ##', '##   ##', '##   ##'],
    P: ['##### ', '##  ##', '##  ##', '##### ', '##    ', '##    ', '##    '],
    Q: [' #### ', '##  ##', '##  ##', '##  ##', '## ###', '##  ##', ' ### #'],
    R: ['##### ', '##  ##', '##  ##', '##### ', '## ## ', '##  ##', '##  ##'],
    S: [' #####', '##    ', '##    ', ' #### ', '    ##', '    ##', '##### '],
    T: ['######', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  ', '  ##  '],
    U: ['##  ##', '##  ##', '##  ##', '##  ##', '##  ##', '##  ##', ' #### '],
    Y: ['##  ##', '##  ##', ' #### ', '  ##  ', '  ##  ', '  ##  ', '  ##  '],
    Z: ['######', '    ##', '   ## ', '  ##  ', ' ##   ', '##    ', '######'],
    ' ': ['   ', '   ', '   ', '   ', '   ', '   ', '   '],
  }

  // Narrower letters for the shade-mode bar, where the text slot is ~44px.
  const NARROW = {
    ...GLYPHS,
    A: [' ### ', '## ##', '## ##', '#####', '## ##', '## ##', '## ##'],
    E: ['#####', '##   ', '##   ', '#### ', '##   ', '##   ', '#####'],
    L: ['##   ', '##   ', '##   ', '##   ', '##   ', '##   ', '#####'],
    P: ['#### ', '## ##', '## ##', '#### ', '##   ', '##   ', '##   '],
    Z: ['#####', '   ##', '  ## ', ' ##  ', '##   ', '##   ', '#####'],
  }

  function textWidth(text, glyphs = GLYPHS) {
    return [...text].reduce((w, ch) => w + glyphs[ch][0].length + 1, -1)
  }

  function drawText(ctx, text, x, y, color, shadow, glyphs = GLYPHS) {
    const passes = shadow ? [[1, 1, shadow], [0, 0, color]] : [[0, 0, color]]
    for (const [dx, dy, c] of passes) {
      ctx.fillStyle = c
      let cx = x + dx
      for (const ch of text) {
        const g = glyphs[ch]
        g.forEach((row, ry) => {
          for (let rx = 0; rx < row.length; rx++) if (row[rx] === '#') ctx.fillRect(cx + rx, y + dy + ry, 1, 1)
        })
        cx += g[0].length + 1
      }
    }
  }

  /**
   * Replaces a title strip's text. Title bars are horizontally uniform apart
   * from the text, so copying one ridge column across erases the old text and
   * keeps the ridges matching the tiles around it.
   */
  function retitle(ctx, x, y, w, h, sampleX, text, colors, { glyphs = GLYPHS, pad = 4 } = {}) {
    const col = ctx.getImageData(sampleX, y, 1, h)
    for (let cx = x; cx < x + w; cx++) ctx.putImageData(col, cx, y)

    // The bar's body color: the most common color in the ridge column.
    const px = col.data
    const counts = new Map()
    for (let r = 1; r < h - 1; r++) {
      const key = `${px[r * 4]},${px[r * 4 + 1]},${px[r * 4 + 2]}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    const body = [...counts].sort((a, b) => b[1] - a[1])[0][0].split(',')
    const tw = textWidth(text, glyphs)
    const tx = Math.round(x + (w - tw) / 2)
    const ty = y + 3
    ctx.fillStyle = `rgb(${body.join(',')})`
    ctx.fillRect(tx - pad, ty - 1, tw + pad * 2, 9)
    drawText(ctx, text, tx, ty, colors.text, colors.shadow, glyphs)
  }

  // gen.bmp's letter rows are found by scanning for the background color at
  // x=0, so (re)stamp the separators with a color no letter uses.
  function stampGenSeparators(canvas) {
    if (!canvas || !window.__genLetterWidths) return
    const g = canvas.getContext('2d')
    g.fillStyle = '#ff00ff'
    for (const y of [88, 96]) {
      let x = 0
      g.fillRect(x, y, 1, 7)
      for (const w of Object.values(window.__genLetterWidths)) {
        x += w + 1
        g.fillRect(x, y, 1, 7)
      }
    }
  }

  // ---------- theme application ----------
  function applyTheme(sheets, theme) {
    const luts = {
      chrome: rampLut(theme.ramps.chrome),
      lcd: rampLut(theme.ramps.lcd),
      gold: rampLut(theme.ramps.gold),
      red: rampLut(theme.ramps.red),
    }
    const out = {}
    for (const [name, src] of Object.entries(sheets)) {
      // Light themes brighten chrome a lot; button sheets can opt out so
      // their icons keep contrast against the button face.
      const { lo = 0, hi = 1, gamma = 1 } = theme.sheetLevels?.[name] ?? theme.levels ?? {}
      const w = src.width
      const h = src.height
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      const img = src.getContext('2d').getImageData(0, 0, w, h)
      const d = img.data
      const tex = theme.texture && TEXTURED.has(name) ? makeTexture(theme.texture, w, h, name.length * 31) : null
      for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        const r = d[i]
        const g = d[i + 1]
        const b = d[i + 2]
        const cls = classify(r, g, b)
        let L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        if (cls === 'chrome') {
          L = Math.pow(Math.min(1, Math.max(0, (L - lo) / (hi - lo))), gamma)
          // Leave near-black display panels flat; texture only the body.
          if (tex && L > 0.08) L = Math.min(1, Math.max(0.09, L + tex[p]))
        } else {
          // Accents: use brightness, so dim greens and reds still read.
          L = Math.max(L, hsv(r, g, b)[2] * 0.92)
        }
        const lut = luts[cls]
        const k = Math.round(L * 255) * 3
        d[i] = lut[k]
        d[i + 1] = lut[k + 1]
        d[i + 2] = lut[k + 2]
      }
      ctx.putImageData(img, 0, 0)
      out[name] = canvas
    }

    stampGenSeparators(out.GEN)

    // Branded title bars.
    const { active, inactive } = theme.title
    const t = out.TITLEBAR.getContext('2d')
    retitle(t, 27 + 16, 0, 228, 14, 27 + 20, 'ZELLAMP', active)
    retitle(t, 27 + 16, 15, 228, 14, 27 + 20, 'ZELLAMP', inactive)
    // Shade-mode bars (active y=29, inactive y=42): only the text slot between
    // the logo and the "=" divider; the rest holds the mini display and buttons.
    const shade = { glyphs: NARROW, pad: 1 }
    retitle(t, 27 + 17, 29, 45, 14, 27 + 17, 'ZELLAMP', active, shade)
    retitle(t, 27 + 17, 42, 45, 14, 27 + 17, 'ZELLAMP', inactive, shade)
    const eq = out.EQMAIN.getContext('2d')
    retitle(eq, 3, 134, 238, 14, 8, 'ZELLAMP EQUALIZER', active)
    retitle(eq, 3, 149, 238, 14, 8, 'ZELLAMP EQUALIZER', inactive)
    const pl = out.PLEDIT.getContext('2d')
    retitle(pl, 26, 0, 100, 20, 27, 'PLAYLIST', active)
    retitle(pl, 26, 21, 100, 20, 27, 'PLAYLIST', inactive)
    return out
  }

  // ---------- encoders ----------
  /** 24-bit bottom-up BMP, base64. */
  function toBmp(canvas) {
    const w = canvas.width
    const h = canvas.height
    const px = canvas.getContext('2d').getImageData(0, 0, w, h).data
    const rowSize = Math.ceil((w * 3) / 4) * 4
    const size = 54 + rowSize * h
    const buf = new Uint8Array(size)
    const dv = new DataView(buf.buffer)
    buf[0] = 0x42
    buf[1] = 0x4d
    dv.setUint32(2, size, true)
    dv.setUint32(10, 54, true)
    dv.setUint32(14, 40, true)
    dv.setInt32(18, w, true)
    dv.setInt32(22, h, true)
    dv.setUint16(26, 1, true)
    dv.setUint16(28, 24, true)
    dv.setUint32(34, rowSize * h, true)
    for (let y = 0; y < h; y++) {
      const row = 54 + (h - 1 - y) * rowSize
      for (let x = 0; x < w; x++) {
        const s = (y * w + x) * 4
        buf[row + x * 3] = px[s + 2]
        buf[row + x * 3 + 1] = px[s + 1]
        buf[row + x * 3 + 2] = px[s]
      }
    }
    let bin = ''
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000))
    return btoa(bin)
  }

  function visColorTxt(vis) {
    const lines = [vis.bg, vis.dots, ...vis.bars, ...vis.osc, vis.peak]
    if (lines.length !== 24) throw new Error(`viscolor needs 24 colors, got ${lines.length}`)
    return lines.map((c, i) => `${hex(c).join(',')} // color ${i}`).join('\r\n') + '\r\n'
  }

  function plEditTxt(pl) {
    return [
      '[Text]',
      `Normal=${pl.normal}`,
      `Current=${pl.current}`,
      `NormalBG=${pl.normalbg}`,
      `SelectedBG=${pl.selectedbg}`,
      `Font=${pl.font ?? 'Arial'}`,
      '',
    ].join('\r\n')
  }

  // Winamp file names for each sheet.
  const FILES = {
    MAIN: 'main.bmp',
    CBUTTONS: 'cbuttons.bmp',
    TITLEBAR: 'titlebar.bmp',
    POSBAR: 'posbar.bmp',
    VOLUME: 'volume.bmp',
    BALANCE: 'balance.bmp',
    SHUFREP: 'shufrep.bmp',
    PLAYPAUS: 'playpaus.bmp',
    MONOSTER: 'monoster.bmp',
    NUMBERS: 'numbers.bmp',
    NUMS_EX: 'nums_ex.bmp',
    TEXT: 'text.bmp',
    EQMAIN: 'eqmain.bmp',
    EQ_EX: 'eq_ex.bmp',
    PLEDIT: 'pledit.bmp',
    GEN: 'gen.bmp',
  }

  /** The untouched base skin as a .wsz ("Winamp Classic"). */
  window.buildClassic = (sheets, colors, playlistStyle) => {
    const files = {}
    stampGenSeparators(sheets.GEN)
    for (const [sheet, file] of Object.entries(FILES)) files[file] = { base64: toBmp(sheets[sheet]) }
    const rgbToHex = (c) => '#' + c.match(/\d+/g).map((v) => (+v).toString(16).padStart(2, '0')).join('')
    const vis = colors.map(rgbToHex)
    files['viscolor.txt'] = {
      text: visColorTxt({ bg: vis[0], dots: vis[1], bars: vis.slice(2, 18), osc: vis.slice(18, 23), peak: vis[23] }),
    }
    files['pledit.txt'] = { text: plEditTxt(playlistStyle) }
    return files
  }

  /** Builds every file of a .wsz: { name: { base64 } | { text } }. */
  window.buildTheme = (sheets, theme) => {
    const styled = applyTheme(sheets, theme)
    const files = {}
    for (const [sheet, file] of Object.entries(FILES)) files[file] = { base64: toBmp(styled[sheet]) }
    files['viscolor.txt'] = { text: visColorTxt(theme.vis) }
    files['pledit.txt'] = { text: plEditTxt(theme.playlist) }
    files['readme.txt'] = { text: `${theme.name} for Zellamp\r\n${theme.description}\r\n` }
    return files
  }
})()
