// Zellamp's built-in themes. Each is a recipe applied to the base Winamp
// sprite sheets by engine.js; see that file for what each field drives.
//
// ramps.*  luminance → color gradients per pixel class
//          chrome: window body (stop 0 doubles as the LCD panel background)
//          lcd:    display text, digits, indicators
//          gold:   slider thumbs, highlights
//          red:    volume / EQ bar ends
// levels   remaps chrome luminance before the ramp (gamma < 1 brightens)
// sheetLevels  per-sprite-sheet overrides of `levels`
// texture  scanlines | brushed | wood | frost | pinstripe

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
const toHex = (c) => '#' + c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')

/** n evenly spaced samples along a multi-stop gradient. */
function gradient(stops, n) {
  const cs = stops.map(hex)
  return Array.from({ length: n }, (_, i) => {
    const t = (i / (n - 1)) * (cs.length - 1)
    const k = Math.min(cs.length - 2, Math.floor(t))
    const f = t - k
    return toHex(cs[k].map((v, j) => v + (cs[k + 1][j] - v) * f))
  })
}

/** Vis colors: 16 spectrum bars top→bottom, 5 scope colors bright→dim. */
function vis({ bg, dots, bars, osc, peak }) {
  return { bg, dots, bars: gradient(bars, 16), osc: gradient(osc, 5), peak }
}

module.exports = [
  {
    id: 'neon-arcade',
    name: 'Neon Arcade',
    description: 'Synthwave purple chrome, cyan LCD, hot-pink sliders, CRT scanlines.',
    ramps: {
      chrome: [[0, '#0b0220'], [0.22, '#1c0a3a'], [0.45, '#3d1670'], [0.72, '#8a35c9'], [1, '#f6b8ff']],
      lcd: [[0, '#0b0220'], [0.45, '#0e5f80'], [1, '#6ff7ff']],
      gold: [[0, '#2a0b3d'], [0.5, '#d4168a'], [1, '#ffb3ec']],
      red: [[0, '#2a0b3d'], [0.5, '#ff3d81'], [1, '#ffe08a']],
    },
    levels: { gamma: 0.9 },
    texture: 'scanlines',
    title: {
      active: { text: '#6ff7ff', shadow: '#2a0b3d' },
      inactive: { text: '#7d5aa8' },
    },
    vis: vis({
      bg: '#0b0220',
      dots: '#24104a',
      bars: ['#ffffff', '#6ff7ff', '#b45cff', '#ff3dc8', '#5b1a8f'],
      osc: ['#ffffff', '#6ff7ff', '#3aa6d0', '#2a6a9a', '#1c3a6a'],
      peak: '#ffffff',
    }),
    playlist: { normal: '#6FF7FF', current: '#FFFFFF', normalbg: '#0B0220', selectedbg: '#5B1A8F' },
  },
  {
    id: 'walnut-hifi',
    name: 'Walnut Hi-Fi',
    description: '1970s receiver: walnut grain, amber display, brushed-brass knobs.',
    ramps: {
      chrome: [[0, '#120904'], [0.25, '#3a2113'], [0.5, '#6b4124'], [0.78, '#a87240'], [1, '#f3d6a6']],
      lcd: [[0, '#120904'], [0.45, '#8a4600'], [1, '#ffbe4d']],
      gold: [[0, '#2a1a08'], [0.55, '#b08530'], [1, '#fff0b8']],
      red: [[0, '#2a0d05'], [0.55, '#c9500f'], [1, '#ffc078']],
    },
    levels: { gamma: 0.95 },
    texture: 'wood',
    title: {
      active: { text: '#ffe2a8', shadow: '#1a0e06' },
      inactive: { text: '#9a7650' },
    },
    vis: vis({
      bg: '#120904',
      dots: '#2e1a0c',
      bars: ['#fff1c4', '#ffbe4d', '#ff8a1f', '#c94a0a', '#6e2405'],
      osc: ['#fff1c4', '#ffbe4d', '#d98a2b', '#9c5a1a', '#5e330d'],
      peak: '#fff6dd',
    }),
    playlist: { normal: '#FFBE4D', current: '#FFF1D0', normalbg: '#120904', selectedbg: '#5A3A1E' },
  },
  {
    id: 'arctic-glass',
    name: 'Arctic Glass',
    description: 'Bright frosted glass with an ice-blue display. The light one.',
    ramps: {
      chrome: [[0, '#0a1828'], [0.18, '#3c5a76'], [0.42, '#93b5cf'], [0.7, '#d6e7f3'], [1, '#ffffff']],
      lcd: [[0, '#0a1828'], [0.45, '#1f7fbf'], [1, '#c9f2ff']],
      gold: [[0, '#203a55'], [0.5, '#4cbcff'], [1, '#f2fbff']],
      red: [[0, '#203a55'], [0.5, '#6f9cff'], [1, '#e6f0ff']],
    },
    levels: { gamma: 0.55 },
    sheetLevels: { CBUTTONS: { gamma: 1 }, SHUFREP: { gamma: 0.9 } },
    texture: 'frost',
    title: {
      active: { text: '#0a2a4a', shadow: '#ffffff' },
      inactive: { text: '#6f8aa3' },
    },
    vis: vis({
      bg: '#0a1828',
      dots: '#162c44',
      bars: ['#ffffff', '#c9f2ff', '#6fd0ff', '#2f8fe0', '#1a4c8f'],
      osc: ['#ffffff', '#c9f2ff', '#7fc4ef', '#4a8cc0', '#2a5a88'],
      peak: '#ffffff',
    }),
    playlist: { normal: '#C9F2FF', current: '#FFFFFF', normalbg: '#0A1828', selectedbg: '#1F5A8F' },
  },
  {
    id: 'phosphor',
    name: 'Phosphor',
    description: 'Monochrome green-screen terminal with heavy CRT scanlines.',
    ramps: {
      chrome: [[0, '#000400'], [0.3, '#03140a'], [0.55, '#0a3416'], [0.82, '#1d7a34'], [1, '#8dffa8']],
      lcd: [[0, '#000400'], [0.45, '#14a046'], [1, '#c6ffd4']],
      gold: [[0, '#021006'], [0.5, '#2ccf63'], [1, '#e2ffe9']],
      red: [[0, '#021006'], [0.5, '#5ff08a'], [1, '#e2ffe9']],
    },
    levels: { gamma: 1.1 },
    texture: 'scanlines',
    title: {
      active: { text: '#8dffa8', shadow: '#000400' },
      inactive: { text: '#2e7a42' },
    },
    vis: vis({
      bg: '#000400',
      dots: '#062010',
      bars: ['#e2ffe9', '#8dffa8', '#3fdc6c', '#1c9a42', '#0a4a1e'],
      osc: ['#e2ffe9', '#8dffa8', '#4fcf74', '#2a8a48', '#145226'],
      peak: '#f2fff5',
    }),
    playlist: { normal: '#5FF08A', current: '#E2FFE9', normalbg: '#000400', selectedbg: '#0A3416', font: 'Menlo' },
  },
  {
    id: 'bubblegum',
    name: 'Bubblegum',
    description: 'Y2K translucent-plastic candy: pastel pink shell, mint display.',
    ramps: {
      chrome: [[0, '#2b0e30'], [0.2, '#7a3a80'], [0.45, '#d98ccb'], [0.72, '#f8c9e8'], [1, '#ffffff']],
      lcd: [[0, '#2b0e30'], [0.45, '#22b38e'], [1, '#a6ffe6']],
      gold: [[0, '#5a1f5e'], [0.5, '#ff5fa8'], [1, '#ffe0f0']],
      red: [[0, '#5a1f5e'], [0.5, '#ff8a5c'], [1, '#fff2b8']],
    },
    levels: { gamma: 0.6 },
    sheetLevels: { CBUTTONS: { gamma: 1 }, SHUFREP: { gamma: 0.9 } },
    texture: 'pinstripe',
    title: {
      active: { text: '#ffffff', shadow: '#a0408f' },
      inactive: { text: '#c890b8' },
    },
    vis: vis({
      bg: '#2b0e30',
      dots: '#43184a',
      bars: ['#ffffff', '#a6ffe6', '#7fd8ff', '#ff8ad0', '#c03c96'],
      osc: ['#ffffff', '#a6ffe6', '#7fdcc4', '#55a894', '#36766a'],
      peak: '#fff2b8',
    }),
    playlist: { normal: '#A6FFE6', current: '#FFFFFF', normalbg: '#2B0E30', selectedbg: '#8A3A82' },
  },
  {
    id: 'graphite-pro',
    name: 'Graphite Pro',
    description: 'Brushed titanium and graphite with an ice-blue readout and orange accents.',
    ramps: {
      chrome: [[0, '#07080a'], [0.25, '#24272c'], [0.5, '#555b64'], [0.78, '#9aa2ad'], [1, '#f0f3f7']],
      lcd: [[0, '#07080a'], [0.45, '#2a7cc0'], [1, '#c4e8ff']],
      gold: [[0, '#2a1405'], [0.5, '#ff7a1a'], [1, '#ffd9b3']],
      red: [[0, '#2a1405'], [0.5, '#ff5a1f'], [1, '#ffc493']],
    },
    levels: { gamma: 0.8 },
    texture: 'brushed',
    title: {
      active: { text: '#f0f3f7', shadow: '#07080a' },
      inactive: { text: '#7a818b' },
    },
    vis: vis({
      bg: '#07080a',
      dots: '#181b20',
      bars: ['#ffd9b3', '#ff7a1a', '#c4e8ff', '#4a9ae0', '#1c4a7a'],
      osc: ['#ffffff', '#c4e8ff', '#7ab4e0', '#4a7aa8', '#2a4a6a'],
      peak: '#ff7a1a',
    }),
    playlist: { normal: '#C4E8FF', current: '#FFFFFF', normalbg: '#07080A', selectedbg: '#2A3A4F' },
  },
]
