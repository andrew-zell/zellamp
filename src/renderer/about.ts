import iconUrl from '../../resources/icon.png'
import { kitThemeId, loadKit, type SkinKit } from './skinKit'
import { button, div, label, mountWindow, panel, paragraph, row, text } from './waui'
import './gallery.css'
import './setup.css'
import './about.css'

/** About Zellamp: version, credits, license. Drawn with the active skin like the other panels. */

const CHARS = 58
type Bytes = Uint8Array<ArrayBuffer>
const read = (id: string) => window.themes.read(id) as Promise<Bytes | null>

let kit: SkinKit | null = null
let version = ''

function render() {
  if (!kit) return
  const k = kit
  const c = k.colors
  const content = mountWindow(k, 'About Zellamp', () => window.close())

  const icon = document.createElement('img')
  icon.src = iconUrl
  icon.alt = ''
  icon.draggable = false
  const left = div('col col-left', label(k, 'Zellamp'), panel('about-icon', icon))

  const info = panel(
    'info',
    text(k, `Zellamp ${version}`, c.current),
    div('gap'),
    paragraph(
      k,
      'A Winamp-skinned remote and visualizer for Spotify and other players. Your player does the playing. Zellamp gives it a classic skin.',
      CHARS,
      c.normal,
    ),
    div('gap'),
    paragraph(k, '(C) 2026 Andrew Zell. Released under the MIT License.', CHARS, c.normal),
    div('gap'),
    paragraph(
      k,
      'Built on Webamp by Jordan Eldredge (MIT). Skins are the work of their authors. Not affiliated with Winamp or Spotify.',
      CHARS,
      c.normal,
    ),
  )
  const nav = row(
    'buttons setup-nav',
    button(k, 'Website', () => window.about.open('website')),
    button(k, 'Licenses', () => window.about.open('licenses')),
    div('spacer'),
    button(k, 'OK', () => window.close()),
  )
  content.append(div('layout', left, div('col col-right', label(k, 'About'), info, nav)))
}

window.themes.onChanged(async ({ themes, active }) => {
  kit = await loadKit(await read(kitThemeId(themes, active)), () => read('classic'))
  render()
})

void (async () => {
  const [{ themes, active }, info] = await Promise.all([window.themes.list(), window.about.info()])
  version = info.version
  kit = await loadKit(await read(kitThemeId(themes, active)), () => read('classic'))
  render()
})()
