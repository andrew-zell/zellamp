#!/usr/bin/env node
// Drive a running dev build over the Chrome DevTools Protocol.
// Start the app with a debug port first: ./scripts/dev.sh (port 9333).
//
//   node scripts/debug/cdp.mjs pages                       list open pages
//   node scripts/debug/cdp.mjs eval '<js>'                 evaluate (awaits promises)
//   node scripts/debug/cdp.mjs shot out.png [--clear]      screenshot (--clear: transparent background)
//   node scripts/debug/cdp.mjs reload                      reload the page
//   node scripts/debug/cdp.mjs rclick <x> <y>              right-click at page coordinates
//   node scripts/debug/cdp.mjs click <x> <y>               left-click at page coordinates
//   node scripts/debug/cdp.mjs hover <x> <y>               move the mouse
//
// --page <name> picks the window by URL (index.html = the player, default;
// gallery.html, setup.html, about.html). --port <n> overrides 9333.
//
// In the player page (dev builds only): window.__webamp (Webamp instance),
// window.__skins (SkinSwitcher), window.__vis (VisSource). Gallery: __kit.
import { writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  if (i < 0) return fallback
  const [, value] = args.splice(i, 2)
  return value
}
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  if (i >= 0) args.splice(i, 1)
  return i >= 0
}
const port = opt('port', process.env.WR_DEBUG_PORT ?? '9333')
const pageName = opt('page', 'index.html')
const clear = flag('clear')
const [mode, ...rest] = args

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
if (mode === 'pages') {
  for (const t of targets.filter((t) => t.type === 'page')) console.log(t.url)
  process.exit(0)
}
const page = targets.find((t) => t.type === 'page' && t.url.includes(pageName))
if (!page) {
  console.error(`no page matching "${pageName}" (try: pages)`)
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let id = 0
const pending = new Map()
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  pending.get(d.id)?.(d)
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id
    pending.set(i, resolve)
    ws.send(JSON.stringify({ id: i, method, params }))
  })
const mouse = async (type, x, y, button = 'none') =>
  send('Input.dispatchMouseEvent', { type, x: Number(x), y: Number(y), button, clickCount: 1 })

switch (mode) {
  case 'eval': {
    const res = await send('Runtime.evaluate', { expression: rest[0], awaitPromise: true, returnByValue: true })
    console.log(JSON.stringify(res.result?.result?.value ?? res.result, null, 2))
    break
  }
  case 'shot': {
    if (clear) await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
    const res = await send('Page.captureScreenshot', { format: 'png' })
    if (clear) await send('Emulation.setDefaultBackgroundColorOverride', {})
    writeFileSync(rest[0], Buffer.from(res.result.data, 'base64'))
    console.log('saved', rest[0])
    break
  }
  case 'reload':
    await send('Page.reload', { ignoreCache: true })
    break
  case 'rclick':
  case 'click': {
    const button = mode === 'rclick' ? 'right' : 'left'
    await mouse('mouseMoved', rest[0], rest[1])
    await mouse('mousePressed', rest[0], rest[1], button)
    await mouse('mouseReleased', rest[0], rest[1], button)
    break
  }
  case 'hover':
    await mouse('mouseMoved', rest[0], rest[1])
    break
  default:
    console.error('usage: cdp.mjs pages | eval <js> | shot <out.png> [--clear] | reload | click|rclick|hover <x> <y>')
    process.exit(1)
}
ws.close()
