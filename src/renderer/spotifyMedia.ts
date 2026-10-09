import type { SpotifyState } from '../shared/types'
import type { VisSource } from './visSource'

type Listener = () => void

/**
 * Stands in for Webamp's <audio>-backed Media class (`__customMediaClass`).
 *
 * Webamp → Spotify: Webamp's media middleware calls play/pause/seek/volume on
 * us; we forward over IPC. Spotify → Webamp: we report interpolated time and
 * duration, and emit `timeupdate`. The analyser comes from VisSource.
 *
 * Webamp constructs this with no arguments, hence the static wiring.
 */
export class SpotifyMedia {
  static vis: VisSource
  static instance: SpotifyMedia | null = null

  /**
   * While true, calls from Webamp are echoes of remote state we're pushing
   * into the store and must not be sent back to Spotify. Starts true so
   * Webamp's startup defaults (e.g. volume 78) never reach Spotify.
   */
  syncing = true

  private listeners = new Map<string, Set<Listener>>()
  private remote: SpotifyState | null = null
  private ticker: number | null = null
  lastLocalVolumeAt = 0

  constructor() {
    SpotifyMedia.instance = this
  }

  // ---- Spotify → Webamp ----

  setRemote(state: SpotifyState) {
    this.remote = state
    const playing = state.availability === 'ok' && state.state === 'playing'
    if (playing && this.ticker == null) {
      // 4Hz is plenty for a seconds display and keeps idle CPU down.
      this.ticker = window.setInterval(() => this.emit('timeupdate'), 250)
    } else if (!playing && this.ticker != null) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    this.emit('timeupdate')
  }

  emit(event: string) {
    this.listeners.get(event)?.forEach((cb) => cb())
  }

  // ---- IMedia ----

  on(event: string, cb: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(cb)
  }

  timeElapsed(): number {
    const r = this.remote
    if (!r || r.availability !== 'ok') return 0
    let pos = r.positionSec
    if (r.state === 'playing') pos += (Date.now() - r.sampledAt) / 1000
    const dur = this.duration()
    return dur > 0 ? Math.min(pos, dur) : pos
  }

  duration(): number {
    return (this.remote?.track?.durationMs ?? 0) / 1000
  }

  play(): Promise<void> {
    if (!this.syncing) void window.spotify.play()
    return Promise.resolve()
  }

  pause() {
    if (!this.syncing) void window.spotify.pause()
  }

  /** Spotify has no stop; emulate Winamp's by pausing and rewinding. */
  stop() {
    if (this.syncing) return
    void window.spotify.pause().then(() => window.spotify.seek(0))
    this.patchRemote({ state: 'paused', positionSec: 0 })
  }

  seekToPercentComplete(percent: number) {
    if (this.syncing) return
    const seconds = (this.duration() * percent) / 100
    this.patchRemote({ positionSec: seconds })
    void window.spotify.seek(seconds)
  }

  /** Throttled: a slider drag fires per pixel, and each send is an osascript spawn. */
  setVolume(volume: number) {
    if (this.syncing) return
    this.lastLocalVolumeAt = Date.now()
    SpotifyMedia.vis.setSpotifyVolume(volume)
    this.pendingVolume = volume
    if (this.volumeTimer != null) return
    const flush = () => {
      if (this.pendingVolume == null) {
        this.volumeTimer = null
        return
      }
      void window.spotify.setVolume(this.pendingVolume)
      this.pendingVolume = null
      this.volumeTimer = window.setTimeout(flush, 120)
    }
    flush()
  }

  private pendingVolume: number | null = null
  private volumeTimer: number | null = null

  /** Webamp's playlist holds one placeholder track; nothing to load. */
  loadFromUrl(_url: string, _autoPlay: boolean): Promise<void> {
    return Promise.resolve()
  }

  getAnalyser(): AnalyserNode {
    return SpotifyMedia.vis.analyser
  }

  // Cosmetic in v1: Spotify's audio path has no balance/preamp/EQ hooks.
  setBalance(_balance: number) {}
  setPreamp(_value: number) {}
  setEqBand(_band: number, _value: number) {}
  disableEq() {}
  enableEq() {}

  dispose() {
    if (this.ticker != null) clearInterval(this.ticker)
    this.listeners.clear()
  }

  /** Optimistic local update so the seek bar doesn't snap back before Spotify confirms. */
  private patchRemote(p: Partial<SpotifyState>) {
    if (!this.remote) return
    this.remote = { ...this.remote, ...p, sampledAt: Date.now() }
    this.emit('timeupdate')
  }
}
