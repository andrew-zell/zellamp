import type { SpotifyCommand, SpotifyState } from '../shared/types'
import type { MediaSource, RawRead } from './sources/types'

// Poll cadences.
const RESYNC_MS = 5000 // notifications are working: just correct drift
const FAST_POLL_MS = 500 // notifications missing: poll is the primary source
const NOT_RUNNING_MS = 2000 // cheap: no Apple Event is sent to Spotify
const POST_COMMAND_MS = 150 // confirm a command took effect

/**
 * Keeps an authoritative SpotifyState in main and pushes it to listeners.
 *
 * Primary signal is the source's change events (Spotify's distributed
 * notification on macOS, media-session events on Windows). Polling covers the
 * position (resync) and acts as fallback when events don't arrive.
 */
export class StateBridge {
  private state: SpotifyState = {
    availability: 'not-running',
    state: 'stopped',
    track: null,
    positionSec: 0,
    sampledAt: Date.now(),
    volume: 100,
    shuffling: false,
    repeating: false,
  }

  // Start in fast mode; drop to resync cadence once a notification proves they work.
  private notificationsWork = false
  private lastNotificationAt = 0
  private missedNotifications = 0

  private timer: NodeJS.Timeout | null = null
  private reading = false
  private rereadQueued = false
  private lastCommandAt = 0
  private unwatch: (() => void) | null = null
  private metadataCompleteFor: string | null = null
  private errorStreak = 0

  constructor(
    private source: MediaSource,
    private emit: (state: SpotifyState) => void,
  ) {
    this.state.idleText = source.idleText
  }

  get current(): SpotifyState {
    return this.state
  }

  get idleText() {
    return this.source.idleText
  }

  start() {
    this.unwatch = this.source.watch((patch) => this.onSourceEvent(patch))
    void this.refresh()
  }

  stop() {
    this.unwatch?.()
    if (this.timer) clearTimeout(this.timer)
  }

  async command(cmd: SpotifyCommand) {
    this.lastCommandAt = Date.now()
    this.applyOptimistic(cmd)
    const availability = await this.source.run(cmd)
    if (availability !== 'ok') this.patch({ availability })
    this.schedule(POST_COMMAND_MS)
  }

  /** Read now, coalescing with any read already in flight. */
  async refresh(): Promise<void> {
    if (this.reading) {
      this.rereadQueued = true
      return
    }
    this.reading = true
    const issuedAt = Date.now()
    try {
      // Only skip the metadata fetch if we already have the full metadata
      // (a notification-sourced track has no artwork URL yet).
      const id = this.state.track?.id ?? null
      const knownId = id !== null && id === this.metadataCompleteFor ? id : null
      const read = await this.source.read(knownId)
      // A command landed while this read was in flight; its result may predate
      // the command and would undo the optimistic update. Read again instead.
      if (this.lastCommandAt > issuedAt) {
        this.rereadQueued = true
      } else {
        this.applyRead(read)
      }
    } finally {
      this.reading = false
    }
    if (this.rereadQueued) {
      this.rereadQueued = false
      return this.refresh()
    }
    this.schedule(this.nextInterval())
  }

  private nextInterval() {
    if (this.state.availability === 'not-running') return NOT_RUNNING_MS
    if (this.state.availability !== 'ok') return NOT_RUNNING_MS
    return this.notificationsWork ? RESYNC_MS : FAST_POLL_MS
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), ms)
  }

  private applyRead(read: RawRead) {
    // A single failed read (e.g. Spotify mid-transition) shouldn't flash an
    // error state; only report it if it persists.
    if (read.availability === 'error' && ++this.errorStreak < 3) return
    if (read.availability !== 'error') this.errorStreak = 0
    if (read.availability !== 'ok') {
      this.patch({
        availability: read.availability,
        state: 'stopped',
        ...(read.availability === 'not-running' ? { track: null, positionSec: 0 } : {}),
      })
      return
    }

    const prev = this.state
    let track = prev.track
    if (read.track) {
      track = read.track
      this.metadataCompleteFor = read.track.id
    }
    else if (!read.trackId) track = null

    // Did something change that a notification should have told us about?
    const changed = (track?.id ?? null) !== (prev.track?.id ?? null) || read.state !== prev.state
    if (changed && prev.availability === 'ok' && this.notificationsWork) {
      const sinceNotification = Date.now() - this.lastNotificationAt
      if (sinceNotification > 1500 && ++this.missedNotifications >= 2) {
        console.warn('[bridge] notifications appear to be missing, falling back to fast polling')
        this.notificationsWork = false
      }
    }

    this.patch({
      availability: 'ok',
      state: read.state!,
      track,
      positionSec: read.positionSec!,
      sampledAt: read.sampledAt,
      volume: read.volume!,
      shuffling: read.shuffling!,
      repeating: read.repeating!,
    })
  }

  private onSourceEvent(patch?: Partial<SpotifyState>) {
    this.lastNotificationAt = Date.now()
    this.missedNotifications = 0
    if (!this.notificationsWork) {
      this.notificationsWork = true
      console.log('[bridge] receiving change events')
    }
    // Apply what the event carries right away so the UI reacts without
    // waiting on a read, then do a real read for the rest.
    if (patch) {
      const p = { ...patch }
      // Same track: keep the metadata we have (e.g. artwork).
      if (p.track && p.track.id === this.state.track?.id) delete p.track
      this.patch(p)
    }
    void this.refresh()
  }

  private applyOptimistic(cmd: SpotifyCommand) {
    const s = this.state
    const now = Date.now()
    const pos = livePosition(s, now)
    switch (cmd.type) {
      case 'playpause':
        this.patch({ state: s.state === 'playing' ? 'paused' : 'playing', positionSec: pos, sampledAt: now })
        break
      case 'play':
        this.patch({ state: 'playing', positionSec: pos, sampledAt: now })
        break
      case 'pause':
        this.patch({ state: 'paused', positionSec: pos, sampledAt: now })
        break
      case 'seek':
        this.patch({ positionSec: cmd.seconds, sampledAt: now })
        break
      case 'setVolume':
        this.patch({ volume: cmd.volume })
        break
      case 'setShuffle':
        this.patch({ shuffling: cmd.value })
        break
      case 'setRepeat':
        this.patch({ repeating: cmd.value })
        break
    }
  }

  private patch(p: Partial<SpotifyState>) {
    this.state = { ...this.state, ...p }
    this.emit(this.state)
  }
}

function livePosition(s: SpotifyState, now: number) {
  if (s.state !== 'playing') return s.positionSec
  return s.positionSec + (now - s.sampledAt) / 1000
}
