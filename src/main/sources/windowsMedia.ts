import { app } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Availability, SpotifyCommand, SpotifyState } from '../../shared/types'
import type { MediaSource, RawRead } from './types'

/** What resources/windows/media-helper.ps1 reports. */
interface HelperState {
  type: 'state'
  availability: 'ok' | 'not-running'
  app?: string
  state?: 'playing' | 'paused' | 'stopped'
  trackId?: string
  title?: string
  artist?: string
  album?: string
  positionSec?: number
  durationMs?: number
  sampledAt?: number
  shuffling?: boolean
  repeating?: boolean
  volume?: number
  artwork?: string
}

const COMMAND_TIMEOUT_MS = 4000

/**
 * Windows: the system media session (Spotify, browsers playing YouTube
 * Music, and any other app that publishes to Windows' media controls), via
 * a long-running PowerShell helper. Prefers Spotify when it has a session.
 */
export class WindowsMediaSource implements MediaSource {
  readonly idleText = 'Nothing is playing'
  private proc: ChildProcessWithoutNullStreams | null = null
  private latest: HelperState = { type: 'state', availability: 'not-running' }
  private artwork = new Map<string, string>()
  private listeners = new Set<() => void>()
  private acks = new Map<number, (ok: boolean) => void>()
  private nextId = 1
  private restarts = 0
  /**
   * Play/pause land asynchronously in the player. Until it reports the
   * expected state (or this expires), keep reporting that state so the UI
   * doesn't flip back to the stale one in between.
   */
  private expect: { state: 'playing' | 'paused'; until: number; at: number } | null = null
  private stopped = false

  constructor() {
    this.startHelper()
    app.on('before-quit', () => {
      this.stopped = true
      this.proc?.stdin.end()
    })
  }

  /** %APPDATA%\Zellamp\media-helper.log: helper errors and lifecycle, for debugging. */
  private log(line: string) {
    const file = join(app.getPath('userData'), 'media-helper.log')
    try {
      // Keep it small: start over past 512 KB.
      if ((statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 512 * 1024) writeFileSync(file, '')
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // Logging must never break playback control.
    }
    console.warn('[media-helper]', line)
  }

  private helperPath() {
    return app.isPackaged
      ? join(process.resourcesPath, 'windows', 'media-helper.ps1')
      : join(app.getAppPath(), 'resources', 'windows', 'media-helper.ps1')
  }

  private startHelper() {
    const proc = spawn(
      'powershell.exe',
      // -MTA: see the note at the top of media-helper.ps1.
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-MTA', '-ExecutionPolicy', 'Bypass', '-File', this.helperPath()],
      { windowsHide: true },
    )
    this.proc = proc
    this.log(`starting ${this.helperPath()}`)
    proc.on('error', (err) => this.log(`spawn failed: ${err.message}`))
    createInterface({ input: proc.stdout }).on('line', (line) => this.onLine(line))
    proc.stderr.on('data', (d) => this.log(`stderr: ${String(d).trim()}`))
    proc.on('exit', (code) => {
      this.proc = null
      for (const ack of this.acks.values()) ack(false)
      this.acks.clear()
      if (this.stopped) return
      // Restart with backoff; the helper shouldn't die, but PowerShell can.
      const delay = Math.min(30_000, 1000 * 2 ** this.restarts++)
      this.log(`exited (${code}); restarting in ${delay}ms`)
      setTimeout(() => this.startHelper(), delay)
    })
  }

  private onLine(line: string) {
    let msg: { type?: string; id?: number; ok?: boolean; message?: string }
    try {
      msg = JSON.parse(line)
    } catch {
      return
    }
    if (msg.type === 'state') {
      this.restarts = 0
      const s = msg as HelperState
      if (s.artwork !== undefined && s.trackId) this.artwork.set(s.trackId, s.artwork)
      this.latest = s
      for (const l of this.listeners) l()
    } else if (msg.type === 'ack' && typeof msg.id === 'number') {
      this.acks.get(msg.id)?.(Boolean(msg.ok))
      this.acks.delete(msg.id)
    } else if (msg.type === 'error') {
      this.log(`error: ${msg.message}`)
    } else if (msg.type === 'hello') {
      this.log(`ready: ${line}`)
    }
  }

  watch(onEvent: (patch?: Partial<SpotifyState>) => void) {
    // The helper only speaks when something changed; reads are local.
    const l = () => onEvent()
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  async read(knownTrackId: string | null): Promise<RawRead> {
    const s = this.latest
    if (!this.proc || s.availability !== 'ok') return { availability: 'not-running', sampledAt: Date.now() }
    const trackId = s.trackId || undefined
    let state = s.state ?? 'stopped'
    let positionSec = Math.max(0, s.positionSec ?? 0)
    let sampledAt = s.sampledAt ?? Date.now()
    if (this.expect) {
      if (state === this.expect.state || Date.now() > this.expect.until) this.expect = null
      else {
        // Hold the expected state; freeze/resume the position from the press.
        if (state === 'playing') positionSec += (this.expect.at - sampledAt) / 1000
        sampledAt = this.expect.at
        state = this.expect.state
      }
    }
    const read: RawRead = {
      availability: 'ok',
      state,
      positionSec,
      sampledAt,
      // -1: the app has no audio session yet; keep a neutral value.
      volume: s.volume != null && s.volume >= 0 ? s.volume : 100,
      shuffling: Boolean(s.shuffling),
      repeating: Boolean(s.repeating),
      trackId,
    }
    if (trackId && trackId !== knownTrackId) {
      read.track = {
        id: trackId,
        name: s.title ?? '',
        artist: s.artist ?? '',
        album: s.album ?? '',
        durationMs: Math.max(0, s.durationMs ?? 0),
        artworkUrl: this.artwork.get(trackId) ?? '',
      }
    }
    return read
  }

  run(cmd: SpotifyCommand): Promise<Availability> {
    if (!this.proc) return Promise.resolve('not-running')
    const current = this.latest.state
    if (cmd.type === 'play') this.expect = { state: 'playing', until: Date.now() + 1500, at: Date.now() }
    else if (cmd.type === 'pause') this.expect = { state: 'paused', until: Date.now() + 1500, at: Date.now() }
    else if (cmd.type === 'playpause') {
      const from = this.expect?.state ?? current
      this.expect = { state: from === 'playing' ? 'paused' : 'playing', until: Date.now() + 1500, at: Date.now() }
    }
    const id = this.nextId++
    const msg: { id: number; cmd: string; value?: number | boolean } = { id, cmd: cmd.type }
    switch (cmd.type) {
      case 'seek':
        msg.value = cmd.seconds
        break
      case 'setVolume':
        msg.cmd = 'volume'
        msg.value = cmd.volume
        break
      case 'setShuffle':
        msg.cmd = 'shuffle'
        msg.value = cmd.value
        break
      case 'setRepeat':
        msg.cmd = 'repeat'
        msg.value = cmd.value
        break
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.acks.delete(id)
        resolve('error')
      }, COMMAND_TIMEOUT_MS)
      this.acks.set(id, (ok) => {
        clearTimeout(timer)
        resolve(ok ? 'ok' : this.latest.availability === 'ok' ? 'ok' : 'not-running')
      })
      this.proc!.stdin.write(JSON.stringify(msg) + '\n')
    })
  }
}
