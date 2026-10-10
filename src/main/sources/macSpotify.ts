import { systemPreferences } from 'electron'
import { execFile } from 'node:child_process'
import type { Availability, PlayerState, SpotifyCommand, SpotifyState } from '../../shared/types'
import type { MediaSource, RawRead } from './types'

/**
 * Thin wrapper around Spotify's AppleScript dictionary. Everything that talks
 * to Spotify goes through here so a Web API backend could be swapped in later.
 *
 * Scripts are static; dynamic values only ever travel as argv, never as
 * interpolated script source.
 */

// ASCII unit separator: never shows up in track metadata.
const READ_SCRIPT = `
on run argv
	set knownId to ""
	if (count of argv) > 0 then set knownId to item 1 of argv
	if application "Spotify" is not running then return "NOT_RUNNING"
	tell application "Spotify"
		set d to character id 31
		-- One Apple Event for all player-level properties.
		set p to properties
		-- Position (and the track) are "missing value" when nothing is loaded.
		set pos to player position of p
		if pos is missing value then set pos to 0
		set vol to sound volume of p
		if vol is missing value then set vol to 100
		set out to "OK" & d & (player state of p as text) & d & ((pos * 1000) as integer) & d & vol & d & (shuffling of p) & d & (repeating of p)
		try
			set tid to id of current track
			set out to out & d & tid
			-- Track properties can't be fetched as a record, so only pay for
			-- the per-field events when the track actually changed.
			if tid is not knownId then
				set t to current track
				set out to out & d & (name of t) & d & (artist of t) & d & (album of t) & d & (duration of t) & d & (artwork url of t)
			end if
		end try
		return out
	end tell
end run
`

const COMMAND_SCRIPT = `
on run argv
	if application "Spotify" is not running then return "NOT_RUNNING"
	set cmd to item 1 of argv
	tell application "Spotify"
		if cmd is "playpause" then
			playpause
		else if cmd is "play" then
			play
		else if cmd is "pause" then
			pause
		else if cmd is "next" then
			next track
		else if cmd is "prev" then
			previous track
		else if cmd is "seek" then
			set player position to ((item 2 of argv) as integer) / 1000
		else if cmd is "volume" then
			set sound volume to ((item 2 of argv) as integer)
		else if cmd is "shuffle" then
			set shuffling to ((item 2 of argv) is "true")
		else if cmd is "repeat" then
			set repeating to ((item 2 of argv) is "true")
		end if
	end tell
	return "OK"
end run
`

// Rough time from spawn until the first Apple Event lands (process start).
const SPAWN_LATENCY_MS = 50

function osascript(script: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script, ...args], { timeout: 4000 }, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stderr: String(stderr) }))
        return
      }
      resolve(String(stdout).replace(/\n$/, ''))
    })
  })
}

function classifyError(err: unknown): Availability {
  const text = String((err as { stderr?: string })?.stderr ?? err)
  // -1743: user denied (or hasn't granted) Automation permission.
  if (text.includes('-1743')) return 'not-authorized'
  // -600: application isn't running (quit between our check and the tell).
  if (text.includes('-600')) return 'not-running'
  return 'error'
}

const NOTIFICATION = 'com.spotify.client.PlaybackStateChanged'

/** macOS: the Spotify desktop app via AppleScript + distributed notifications. */
export class MacSpotifySource implements MediaSource {
  readonly idleText = 'Spotify is not running'
  private lastErrorLog = 0

  watch(onEvent: (patch?: Partial<SpotifyState>) => void) {
    const id = systemPreferences.subscribeNotification(NOTIFICATION, (_event, userInfo) => {
      const info = userInfo as Record<string, unknown>
      if (process.env.WR_DEBUG_PORT) console.log('[spotify] notification', JSON.stringify(info))
      onEvent(parseNotification(info))
    })
    return () => systemPreferences.unsubscribeNotification(id)
  }

  async read(knownTrackId: string | null): Promise<RawRead> {
    const startedAt = Date.now()
    const sampledAt = startedAt + SPAWN_LATENCY_MS
    let out: string
    try {
      out = await osascript(READ_SCRIPT, knownTrackId ? [knownTrackId] : [])
    } catch (err) {
      const availability = classifyError(err)
      this.logError('read', err, availability)
      return { availability, sampledAt }
    }
    if (out === 'NOT_RUNNING') return { availability: 'not-running', sampledAt }

    const f = out.split('\u001f')
    if (f[0] !== 'OK' || f.length < 6) return { availability: 'error', sampledAt }
    const result: RawRead = {
      availability: 'ok',
      state: normalizeState(f[1]),
      positionSec: Number(f[2]) / 1000,
      volume: Number(f[3]),
      shuffling: f[4] === 'true',
      repeating: f[5] === 'true',
      trackId: f[6] || undefined,
      sampledAt,
    }
    if (f.length >= 12) {
      result.track = {
        id: f[6],
        name: f[7],
        artist: f[8],
        album: f[9],
        durationMs: Number(f[10]) || 0,
        artworkUrl: f[11],
      }
    }
    return result
  }

  async run(cmd: SpotifyCommand): Promise<Availability> {
    const args = commandArgs(cmd)
    try {
      const out = await osascript(COMMAND_SCRIPT, args)
      return out === 'NOT_RUNNING' ? 'not-running' : 'ok'
    } catch (err) {
      const availability = classifyError(err)
      this.logError(`command ${cmd.type}`, err, availability)
      return availability
    }
  }

  /** Avoid spamming the console every poll tick while Spotify is unreachable. */
  private logError(what: string, err: unknown, availability: Availability) {
    const now = Date.now()
    if (now - this.lastErrorLog < 30_000) return
    this.lastErrorLog = now
    const detail = (err as { stderr?: string })?.stderr?.trim() || String(err)
    console.warn(`[spotify] ${what} failed (${availability}): ${detail}`)
  }
}

/** Spotify's notification carries state and track; apply it before the read. */
function parseNotification(info: Record<string, unknown>): Partial<SpotifyState> {
  const patch: Partial<SpotifyState> = { availability: 'ok' }
  const playerState = String(info['Player State'] ?? '').toLowerCase()
  if (playerState === 'playing' || playerState === 'paused' || playerState === 'stopped') patch.state = playerState
  if (typeof info['Playback Position'] === 'number') {
    patch.positionSec = info['Playback Position'] as number
    patch.sampledAt = Date.now()
  }
  const trackId = info['Track ID'] as string | undefined
  if (trackId) {
    patch.track = {
      id: trackId,
      name: String(info['Name'] ?? ''),
      artist: String(info['Artist'] ?? ''),
      album: String(info['Album'] ?? ''),
      durationMs: Number(info['Duration'] ?? 0),
      // Not in the notification; the follow-up read fills it in.
      artworkUrl: '',
    }
  }
  return patch
}

function normalizeState(s: string): PlayerState {
  if (s === 'playing' || s === 'paused') return s
  return 'stopped'
}

function commandArgs(cmd: SpotifyCommand): string[] {
  switch (cmd.type) {
    case 'seek':
      return ['seek', String(Math.max(0, Math.round(cmd.seconds * 1000)))]
    case 'setVolume':
      return ['volume', String(Math.min(100, Math.max(0, Math.round(cmd.volume))))]
    case 'setShuffle':
      return ['shuffle', String(cmd.value)]
    case 'setRepeat':
      return ['repeat', String(cmd.value)]
    default:
      return [cmd.type]
  }
}
