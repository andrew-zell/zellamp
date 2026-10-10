import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StateBridge } from '../src/main/stateBridge'
import type { MediaSource, RawRead } from '../src/main/sources/types'
import type { SpotifyState } from '../src/shared/types'

const TRACK = { id: 't1', name: 'Song', artist: 'Artist', album: 'Album', durationMs: 180_000, artworkUrl: 'art.jpg' }

function playing(over: Partial<RawRead> = {}): RawRead {
  return {
    availability: 'ok',
    state: 'playing',
    positionSec: 10,
    sampledAt: Date.now(),
    volume: 50,
    shuffling: false,
    repeating: false,
    trackId: 't1',
    track: TRACK,
    ...over,
  }
}

/** A source whose reads resolve when the test says so. */
function fakeSource() {
  const reads: ((r: RawRead) => void)[] = []
  let onEvent: ((patch?: Partial<SpotifyState>) => void) | null = null
  const source: MediaSource = {
    idleText: 'Nothing is playing',
    read: vi.fn(() => new Promise<RawRead>((resolve) => reads.push(resolve))),
    run: vi.fn(async () => 'ok' as const),
    watch: (cb) => {
      onEvent = cb
      return () => {}
    },
  }
  return {
    source,
    /** Resolve the oldest pending read. */
    resolveRead: async (r: RawRead) => {
      reads.shift()!(r)
      await vi.advanceTimersByTimeAsync(0)
    },
    pendingReads: () => reads.length,
    event: (patch?: Partial<SpotifyState>) => onEvent!(patch),
  }
}

describe('StateBridge', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies play/pause instantly and freezes the position at the press', async () => {
    const f = fakeSource()
    const bridge = new StateBridge(f.source, () => {})
    bridge.start()
    await f.resolveRead(playing())
    vi.advanceTimersByTime(2000)
    await bridge.command({ type: 'playpause' })
    expect(bridge.current.state).toBe('paused')
    expect(bridge.current.positionSec).toBeCloseTo(12, 1)
  })

  it('discards a read that started before a command, and reads again', async () => {
    const f = fakeSource()
    const bridge = new StateBridge(f.source, () => {})
    bridge.start()
    await f.resolveRead(playing())
    await vi.advanceTimersByTimeAsync(5000) // next poll: a read is now in flight
    expect(f.pendingReads()).toBe(1)
    await bridge.command({ type: 'pause' })
    // The stale read still says "playing"; it must not undo the pause.
    await f.resolveRead(playing())
    expect(bridge.current.state).toBe('paused')
    expect(f.pendingReads()).toBe(1) // the re-read
    await f.resolveRead(playing({ state: 'paused' }))
    expect(bridge.current.state).toBe('paused')
  })

  it('ignores a single failed read, reports a persistent failure', async () => {
    const f = fakeSource()
    const bridge = new StateBridge(f.source, () => {})
    bridge.start()
    await f.resolveRead(playing())
    for (let i = 0; i < 2; i++) {
      await vi.advanceTimersByTimeAsync(5000)
      await f.resolveRead({ availability: 'error', sampledAt: Date.now() })
      expect(bridge.current.availability).toBe('ok')
    }
    await vi.advanceTimersByTimeAsync(5000)
    await f.resolveRead({ availability: 'error', sampledAt: Date.now() })
    expect(bridge.current.availability).toBe('error')
  })

  it('clears the track when the player goes away', async () => {
    const f = fakeSource()
    const bridge = new StateBridge(f.source, () => {})
    bridge.start()
    await f.resolveRead(playing())
    await vi.advanceTimersByTimeAsync(5000)
    await f.resolveRead({ availability: 'not-running', sampledAt: Date.now() })
    expect(bridge.current.track).toBeNull()
    expect(bridge.current.idleText).toBe('Nothing is playing')
  })

  it('keeps known metadata (artwork) when an event repeats the same track', async () => {
    const f = fakeSource()
    const bridge = new StateBridge(f.source, () => {})
    bridge.start()
    await f.resolveRead(playing())
    f.event({ state: 'paused', track: { ...TRACK, artworkUrl: '' } })
    expect(bridge.current.state).toBe('paused')
    expect(bridge.current.track?.artworkUrl).toBe('art.jpg')
  })
})
