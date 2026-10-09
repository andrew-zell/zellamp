import type { SetupAction, SetupStatus } from '../shared/types'
import { kitThemeId, loadKit, type SkinKit } from './skinKit'
import { button, div, label, mountWindow, panel, paragraph, row, text } from './waui'
import './gallery.css'
import './setup.css'

/**
 * First-run Setup Assistant. Walks through the two macOS permissions with
 * live status (pushed from main as the user grants them in System Settings).
 */

const CHARS = 58
type Bytes = Uint8Array<ArrayBuffer>
const read = (id: string) => window.themes.read(id) as Promise<Bytes | null>

type Mark = 'ok' | 'todo' | 'optional' | null

interface Step {
  title: string
  mark: (s: SetupStatus) => Mark
  body: (s: SetupStatus) => string
  status?: (s: SetupStatus) => string
  actions: (s: SetupStatus) => [string, SetupAction][]
}

const STEPS: Step[] = [
  {
    title: 'Welcome',
    mark: () => null,
    body: () =>
      'Zellamp is a remote and visualizer for the Spotify app. Spotify does the playing. Zellamp gives it a classic skin.\n\n' +
      'Setup takes about a minute. macOS needs you to approve two things: letting Zellamp control Spotify, and (optionally) letting it hear your audio for the visualizer.',
    actions: () => [],
  },
  {
    title: 'Spotify',
    mark: (s) => (s.spotify === 'running' ? 'ok' : 'todo'),
    body: () => 'Zellamp controls the Spotify desktop app, so it needs to be installed and running. A Premium account is not required for control.',
    status: (s) =>
      s.spotify === 'running'
        ? 'Spotify is running.'
        : s.spotify === 'not-running'
          ? 'Spotify is installed but not running.'
          : "Spotify isn't installed.",
    actions: (s) =>
      s.spotify === 'running' ? [] : s.spotify === 'not-running' ? [['Open Spotify', 'open-spotify']] : [['Get Spotify', 'get-spotify']],
  },
  {
    title: 'Control',
    mark: (s) => (s.control === 'granted' ? 'ok' : 'todo'),
    body: (s) =>
      s.control === 'denied'
        ? 'macOS is blocking Zellamp from controlling Spotify. Open Automation settings, find Zellamp, and switch Spotify on.'
        : 'Play, pause, skip, seek and volume are sent to Spotify with Apple Events. macOS will ask "Zellamp wants access to control Spotify". Click OK.',
    status: (s) =>
      s.control === 'granted'
        ? 'Zellamp can control Spotify.'
        : s.control === 'denied'
          ? 'Access denied.'
          : s.spotify === 'running'
            ? 'Not yet allowed.'
            : 'Open Spotify first (previous step).',
    actions: (s) =>
      s.control === 'granted'
        ? []
        : s.control === 'denied'
          ? [['Open Settings', 'open-automation-settings']]
          : [['Allow Control', 'request-control']],
  },
  {
    title: 'Visualizer',
    mark: (s) => (s.visualizer === 'live' ? 'ok' : 'optional'),
    body: (s) => {
      const intro =
        "For a real spectrum, Zellamp listens to your Mac's audio output. macOS lists this under Screen & System Audio Recording. Zellamp only keeps the audio. The screen image is discarded immediately.\n\n"
      if (s.visualizer === 'live') return intro + 'All set.'
      if (s.screenAccess === 'granted')
        return intro + 'macOS has granted access. Click Relaunch so Zellamp can start listening.'
      if (s.screenAccess === 'denied')
        return (
          intro +
          'macOS says this copy of Zellamp is not allowed. If Zellamp already looks switched on in Settings, that entry belongs to an older build: select it, click the minus button, then come back and click Enable.'
        )
      return intro + 'Click Enable and allow the macOS prompt, then Relaunch. Skip this and the visualizer plays a simulated animation.'
    },
    status: (s) =>
      s.visualizer === 'live'
        ? 'Live: the visualizer hears your audio.'
        : s.screenAccess === 'granted'
          ? 'Access granted. Relaunch to finish.'
          : s.screenAccess === 'denied'
            ? 'macOS: not allowed for this copy of Zellamp.'
            : s.visualizer === 'starting'
              ? 'Checking...'
              : 'Not enabled. Using the simulated visualizer.',
    actions: (s) =>
      s.visualizer === 'live'
        ? []
        : [
            ['Enable', 'request-visualizer'],
            ['Settings', 'open-screen-settings'],
            ['Relaunch', 'relaunch'],
          ],
  },
  {
    title: 'Done',
    mark: () => null,
    body: () =>
      "You're set. Press Cmd+T any time for the skin browser, and drop any classic Winamp .wsz skin onto it to install it.\n\n" +
      'This assistant stays in the Widget menu if you need it again.',
    actions: () => [['Skin Browser', 'open-skins']],
  },
]

let status: SetupStatus = { spotify: 'running', control: 'unknown', visualizer: 'starting', screenAccess: 'unknown' }
let current = 0
let kit: SkinKit | null = null

function markText(mark: Mark) {
  return mark === 'ok' ? '[OK]' : mark === 'todo' ? '[!!]' : mark === 'optional' ? '[--]' : ''
}

async function act(action: SetupAction) {
  status = await window.setup.action(action)
  render()
}

function render() {
  if (!kit) return
  const k = kit
  const c = k.colors
  const content = mountWindow(k, 'Zellamp Setup', () => window.close())
  const step = STEPS[current]

  const items = STEPS.map((s, i) => {
    const mark = markText(s.mark(status))
    const name = `${i + 1} ${s.title}`
    const line = name.padEnd(22 - mark.length, ' ') + mark
    const item = div(`wa-item${i === current ? ' selected' : ''}`, text(k, line, i === current ? c.current : c.normal))
    item.addEventListener('click', () => {
      current = i
      render()
    })
    return item
  })
  const left = div('col col-left', label(k, 'Setup'), panel('wa-list skin-list', ...items))

  const stepMark = step.mark(status)
  const info = panel(
    'info',
    text(k, step.title, c.current),
    div('gap'),
    paragraph(k, step.body(status), CHARS, c.normal),
    div('spacer'),
    step.status
      ? text(k, `${markText(stepMark) || '>'} ${step.status(status)}`.slice(0, CHARS), stepMark === 'ok' ? c.current : c.normal)
      : div(),
  )

  const last = current === STEPS.length - 1
  const nav = row(
    'buttons setup-nav',
    ...step.actions(status).map(([name, action]) => button(k, name, () => void act(action))),
    div('spacer'),
    button(k, 'Back', () => {
      current--
      render()
    }, { disabled: current === 0 }),
    last
      ? button(k, 'Finish', () => void act('finish'))
      : button(k, 'Next', () => {
          current++
          render()
        }),
  )

  const right = div('col col-right', label(k, `Step ${current + 1} of ${STEPS.length}`), info, nav)
  content.append(div('layout', left, right))
}

window.themes.onChanged(async ({ themes, active }) => {
  kit = await loadKit(await read(kitThemeId(themes, active)), () => read('classic'))
  render()
})

window.setup.onChanged((next) => {
  status = next
  render()
})

void (async () => {
  const { themes, active } = await window.themes.list()
  kit = await loadKit(await read(kitThemeId(themes, active)), () => read('classic'))
  status = await window.setup.status()
  render()
})()
