import type { Availability, PlayerState, SpotifyCommand, SpotifyState, Track } from '../../shared/types'

/** One read of the player's state. */
export interface RawRead {
  availability: Availability
  state?: PlayerState
  positionSec?: number
  volume?: number
  shuffling?: boolean
  repeating?: boolean
  trackId?: string
  /** Only present when the track differs from the `knownTrackId` passed in. */
  track?: Track
  /** Epoch ms, best estimate of when the position was sampled. */
  sampledAt: number
}

/**
 * Where "what's playing" comes from and how to control it: the Spotify app
 * via AppleScript on macOS, the system media session on Windows, and later
 * possibly a browser extension or the Spotify Web API.
 */
export interface MediaSource {
  /** Shown when nothing is available, e.g. "Spotify is not running". */
  readonly idleText: string
  /**
   * Full read. `knownTrackId` lets a source skip expensive metadata when the
   * track hasn't changed.
   */
  read(knownTrackId: string | null): Promise<RawRead>
  run(cmd: SpotifyCommand): Promise<Availability>
  /**
   * Push channel for changes. `patch` carries whatever the event already
   * knows, applied instantly before the follow-up read. Returns unsubscribe.
   */
  watch(onEvent: (patch?: Partial<SpotifyState>) => void): () => void
}
