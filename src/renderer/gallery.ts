import type { ThemeInfo, ThemeList } from '../shared/types'
import { kitThemeId, loadKit, type SkinKit } from './skinKit'
import { loadSheets, renderMainWindow } from './skinPreview'
import { button, div, label, mountWindow, panel, paragraph, row, text } from './waui'
import './gallery.css'

/**
 * Zellamp's skin browser. Like Winamp 2's, clicking a skin applies it right
 * away; the window itself is drawn in whatever skin is active.
 */

const SKIN_FILE = /\.(wsz|zip)$/i
const INFO_CHARS = 54

type Bytes = Uint8Array<ArrayBuffer>
const read = (id: string) => window.themes.read(id) as Promise<Bytes | null>
const classic = () => read('classic')

let list: ThemeList = { themes: [], active: 'classic' }
let kit: SkinKit | null = null
let kitFor = ''
let message = ''
let messageTimer: number | undefined

// Preview image URL per theme: classic skins are composited from their
// bitmaps; freeform skins are their own SVG (shown as an <img>, inert).
const previews = new Map<string, Promise<string | null>>()
function preview(theme: ThemeInfo) {
  let p = previews.get(theme.id)
  if (!p) {
    p = read(theme.id).then(async (data) => {
      if (!data) return null
      try {
        if (theme.kind === 'freeform') return URL.createObjectURL(new Blob([data], { type: 'image/svg+xml' }))
        const canvas = document.createElement('canvas')
        renderMainWindow(canvas, await loadSheets(data, classic), theme.name)
        return canvas.toDataURL()
      } catch {
        return null
      }
    })
    previews.set(theme.id, p)
  }
  return p
}

function sourceLabel(t: ThemeInfo) {
  if (t.source === 'builtin') return 'Built-in / Nullsoft base skin'
  if (t.source === 'zellamp') return t.kind === 'freeform' ? 'Built-in / Zellamp freeform' : 'Built-in / Zellamp original'
  return `Installed / ${t.description}`
}

function flash(msg: string) {
  message = msg
  clearTimeout(messageTimer)
  messageTimer = window.setTimeout(() => {
    message = ''
    render()
  }, 5000)
  render()
}

async function ensureKit() {
  const id = kitThemeId(list.themes, list.active)
  if (kit && kitFor === id) return
  kit = await loadKit(await read(id), classic)
  kitFor = id
  if (import.meta.env.DEV) (window as unknown as { __kit: SkinKit }).__kit = kit
}

function render() {
  if (!kit) return
  const k = kit
  const c = k.colors
  const active = list.themes.find((t) => t.id === list.active) ?? list.themes[0]
  const content = mountWindow(k, 'Zellamp Skin Browser', () => window.close())

  // ---- left: the list ----
  const items = list.themes.map((t) => {
    const isActive = t.id === list.active
    const item = div(
      `wa-item${isActive ? ' selected' : ''}`,
      text(k, `${isActive ? '* ' : '  '}${t.name}`, isActive ? c.current : c.normal),
    )
    item.addEventListener('click', () => void window.themes.apply(t.id))
    return item
  })
  const listBox = panel('wa-list skin-list', ...items)
  listBox.tabIndex = 0
  listBox.setAttribute('role', 'listbox')
  listBox.setAttribute('aria-label', 'Skins')
  listBox.addEventListener('keydown', (e) => {
    const i = list.themes.findIndex((t) => t.id === list.active)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const next = list.themes[Math.min(list.themes.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]
      if (next) void window.themes.apply(next.id)
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && active?.source === 'installed') {
      void window.themes.remove(active.id)
    }
  })
  const left = div(
    'col col-left',
    label(k, `Skins (${list.themes.length})`),
    listBox,
    row(
      'buttons',
      button(k, 'Install...', () => void window.themes.installDialog()),
      button(k, 'Folder', () => window.themes.reveal()),
    ),
  )

  // ---- right: preview + info ----
  const shot = div('preview-shot')
  if (active) {
    void preview(active).then((url) => {
      if (!url) return
      const img = document.createElement('img')
      img.src = url
      img.alt = `${active.name} preview`
      img.className = active.kind === 'freeform' ? 'preview-freeform' : 'preview-classic'
      shot.replaceChildren(img)
    })
  }
  const info = active
    ? panel(
        'info',
        text(k, active.name, c.current),
        div('gap'),
        paragraph(
          k,
          active.source !== 'installed'
            ? active.description
            : active.kind === 'freeform'
              ? 'A Zellamp freeform skin you installed.'
              : 'A classic Winamp 2 skin you installed.',
          INFO_CHARS,
          c.normal,
        ),
        div('spacer'),
        text(k, sourceLabel(active).slice(0, INFO_CHARS), c.normal),
        message ? text(k, message.slice(0, INFO_CHARS), c.current) : div(),
      )
    : panel('info')
  const right = div(
    'col col-right',
    label(k, 'Preview'),
    panel('preview', shot),
    label(k, 'Info'),
    info,
    row(
      'buttons buttons-right',
      button(k, 'Remove', () => active && void window.themes.remove(active.id), {
        disabled: active?.source !== 'installed',
      }),
    ),
  )

  const drop = panel('drop', text(k, 'Drop .wsz skins to install', c.current))
  drop.hidden = depth === 0
  drop.id = 'drop'
  content.append(div('layout', left, right), drop)
  listBox.querySelector('.selected')?.scrollIntoView({ block: 'nearest' })
  listBox.focus()
}

// ---- drag and drop install ----
let depth = 0
const dropEl = () => document.getElementById('drop')
window.addEventListener('dragenter', (e) => {
  e.preventDefault()
  if (++depth === 1) dropEl()?.removeAttribute('hidden')
})
window.addEventListener('dragleave', () => {
  if (--depth === 0) dropEl()?.setAttribute('hidden', '')
})
window.addEventListener('dragover', (e) => e.preventDefault())
window.addEventListener('drop', async (e) => {
  e.preventDefault()
  depth = 0
  dropEl()?.setAttribute('hidden', '')
  for (const file of Array.from(e.dataTransfer?.files ?? [])) {
    if (!SKIN_FILE.test(file.name)) {
      flash(`Not a skin: ${file.name}`)
      continue
    }
    previews.delete(`user:${file.name}`)
    const { error } = await window.themes.install(file.name, new Uint8Array(await file.arrayBuffer()))
    if (error) flash(error)
  }
})

async function update(next: ThemeList) {
  list = next
  await ensureKit()
  render()
}

window.themes.onChanged((next) => void update(next))
void window.themes.list().then(update)
