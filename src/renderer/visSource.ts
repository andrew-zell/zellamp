/**
 * Feeds the AnalyserNode that Webamp's own visualizer draws from.
 *
 * v1 source: system-audio loopback via getDisplayMedia (captures ALL system
 * audio, not just Spotify). If capture is unavailable we run a synthetic
 * signal tied to play state so the vis never looks dead.
 *
 * v2 (native Core Audio process tap) should only need to replace
 * `startCapture()`: anything that ends up connected to `this.input` works.
 */

export type VisMode = 'starting' | 'live' | 'fallback'

// Loopback capture is post-Spotify-volume; normalize it back up.
const TARGET_PEAK = 0.8
const MAX_AGC = 4
const MIN_AGC = 0.5
const SILENCE = 0.0005
// If capture yields nothing but digital silence for this much play time, the
// permission is probably missing (macOS hands back a silent/ended track).
const DEAD_CAPTURE_MS = 8000

const BANDS = [60, 150, 400, 1000, 2500, 6000, 12000]

export class VisSource {
  readonly ctx = new AudioContext()
  readonly analyser: AnalyserNode
  /** Everything that should drive the vis connects here. */
  private readonly input: GainNode

  mode: VisMode = 'starting'
  onModeChange: (mode: VisMode, reason?: string) => void = () => {}

  private playing = false
  private spotifyVolume = 100
  private agc = 1
  private peakHold = 0
  private captureProven = false
  private silentPlayMs = 0
  private meterTimer: number | null = null
  private readonly meterBuf: Float32Array<ArrayBuffer>

  private fakeGains: GainNode[] = []
  private fakeTimer: number | null = null

  constructor() {
    this.analyser = this.ctx.createAnalyser()
    this.analyser.fftSize = 2048
    this.analyser.smoothingTimeConstant = 0.8
    this.input = this.ctx.createGain()
    this.input.connect(this.analyser)
    // Keep the graph pulled by the destination, but silent: we must never
    // play captured system audio back out (feedback loop).
    const sink = this.ctx.createGain()
    sink.gain.value = 0
    this.analyser.connect(sink).connect(this.ctx.destination)
    this.meterBuf = new Float32Array(this.analyser.fftSize)
    void this.ctx.suspend()
  }

  async startCapture() {
    this.captureProven = false
    this.silentPlayMs = 0
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
      // We only want the audio; drop the screen video right away.
      stream.getVideoTracks().forEach((t) => t.stop())
      const track = stream.getAudioTracks()[0]
      if (!track || track.readyState === 'ended') {
        throw new Error('No audio track. System Audio Recording permission may be denied.')
      }
      track.addEventListener('ended', () => this.useFallback('Audio capture ended.'))
      this.ctx.createMediaStreamSource(new MediaStream([track])).connect(this.input)
      // A retry from the Setup Assistant can succeed after a fallback.
      this.stopFake()
      this.setMode('live')
    } catch (err) {
      this.useFallback(err instanceof Error ? err.message : String(err))
    }
    this.updateRunning()
  }

  setPlaying(playing: boolean) {
    if (playing === this.playing) return
    this.playing = playing
    this.updateRunning()
  }

  setSpotifyVolume(volume: number) {
    this.spotifyVolume = volume
  }

  /** Pause all audio processing while nothing would be drawn. */
  private updateRunning() {
    const active = this.playing && !document.hidden
    if (active) {
      void this.ctx.resume()
      if (this.mode === 'fallback') this.startFake()
      else if (this.meterTimer == null) this.meterTimer = window.setInterval(() => this.meter(), 100)
    } else {
      void this.ctx.suspend()
      this.stopFake()
      if (this.meterTimer != null) {
        clearInterval(this.meterTimer)
        this.meterTimer = null
      }
    }
  }

  readonly onVisibilityChange = () => this.updateRunning()

  /** Auto-gain: compensate Spotify volume instantly, then track loudness slowly. */
  private meter() {
    if (this.mode !== 'live') return
    this.analyser.getFloatTimeDomainData(this.meterBuf)
    let peak = 0
    for (let i = 0; i < this.meterBuf.length; i++) {
      const v = Math.abs(this.meterBuf[i])
      if (v > peak) peak = v
    }
    const gainNow = this.input.gain.value || 1
    const raw = peak / gainNow

    if (raw > 0) this.captureProven = true
    if (!this.captureProven) {
      this.silentPlayMs += 100
      if (this.silentPlayMs >= DEAD_CAPTURE_MS) {
        this.useFallback('Capture is silent. Grant Screen & System Audio Recording, then restart.')
      }
      return
    }

    const volumeComp = 100 / Math.min(100, Math.max(10, this.spotifyVolume))
    // Don't adapt on silence, so silence stays silent.
    if (raw > SILENCE) {
      const level = raw * volumeComp
      this.peakHold = Math.max(level, this.peakHold * 0.997)
      this.agc = Math.min(MAX_AGC, Math.max(MIN_AGC, TARGET_PEAK / this.peakHold))
    }
    this.input.gain.setTargetAtTime(volumeComp * this.agc, this.ctx.currentTime, 0.1)
  }

  private useFallback(reason: string) {
    if (this.mode === 'fallback') {
      this.onModeChange('fallback', reason)
      return
    }
    console.warn('[vis] falling back to synthetic visualizer:', reason)
    this.setMode('fallback', reason)
    this.buildFake()
    this.updateRunning()
  }

  private setMode(mode: VisMode, reason?: string) {
    this.mode = mode
    this.onModeChange(mode, reason)
  }

  // ---- Synthetic fallback: band-passed noise with wandering levels ----

  private buildFake() {
    if (this.fakeGains.length) return
    const len = this.ctx.sampleRate * 2
    const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate)
    const data = buffer.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    const noise = this.ctx.createBufferSource()
    noise.buffer = buffer
    noise.loop = true
    for (const freq of BANDS) {
      const filter = this.ctx.createBiquadFilter()
      filter.type = 'bandpass'
      filter.frequency.value = freq
      filter.Q.value = 2
      const gain = this.ctx.createGain()
      gain.gain.value = 0
      noise.connect(filter).connect(gain).connect(this.analyser)
      this.fakeGains.push(gain)
    }
    noise.start()
  }

  private startFake() {
    if (this.fakeTimer != null) return
    let beat = 0
    this.fakeTimer = window.setInterval(() => {
      beat = (beat + 1) % 4
      const t = this.ctx.currentTime
      this.fakeGains.forEach((g, i) => {
        // Low bands pulse on a beat, highs shimmer randomly.
        const pulse = i < 2 && beat === 0 ? 1.5 : 1
        const level = (0.2 + Math.random() * 0.8) * pulse * (1.2 - i * 0.1)
        g.gain.setTargetAtTime(level, t, 0.05)
      })
    }, 130)
  }

  private stopFake() {
    if (this.fakeTimer != null) {
      clearInterval(this.fakeTimer)
      this.fakeTimer = null
    }
    const t = this.ctx.currentTime
    this.fakeGains.forEach((g) => g.gain.setTargetAtTime(0, t, 0.05))
  }
}
