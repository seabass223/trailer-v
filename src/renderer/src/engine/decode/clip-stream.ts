/**
 * One hardware decoder per visible clip. Keeps a small window of decoded VideoFrames around
 * the requested source time:
 *  - playback: decodes ahead (lookahead frames), frames are released as soon as they're stale;
 *  - scrubbing: "latest target wins" — re-seeks only when the target leaves what's buffered
 *    or lands in a GOP the decoder hasn't been fed yet, otherwise decodes forward;
 *  - pre-roll (background): decodes up to where a clip is about to show, yielding to the
 *    streams on screen so it never costs them a frame.
 * Hardware decoders stall when apps hold too many frames, so the window is kept small.
 */
import { isDisposable } from './disposable'
import type { VideoSource } from './sources'

/**
 * Decodes a background stream may submit per `want()` (once per rendered frame). A burst of
 * them backs up the GPU process and stalls the frames on screen (measured: ~200 ms with the
 * hardware decoder under load), so pre-roll is paced instead.
 */
const BACKGROUND_DECODES_PER_WANT = 2

export class ClipStream {
  readonly clipId: string
  readonly src: VideoSource
  private decoder: VideoDecoder | null = null
  private frames: VideoFrame[] = []
  /** Last shown frame, kept across a seek until the first new frame decodes (no black flash). */
  private held: VideoFrame | null = null
  private gen = 0
  private target = 0
  private lookahead = 2
  private runStart = -1
  private decodedUpTo = -1
  private fedUpTo = -1
  /** Every packet of the current run is fed (the source ends: nothing more can come). */
  private fedAll = false
  /** Pre-rolling a picture that isn't on screen yet. */
  private background = false
  /** Decodes left before the next `want()` (background only). */
  private budget = 0
  private evaluating = false
  private wake: (() => void) | null = null
  lastUsed = performance.now()
  /** Set while a stream on screen is filling its lookahead: a background stream stops feeding. */
  hold = false
  error: string | null = null
  /** Called whenever a new frame is decoded (the engine re-renders paused frames). */
  onFrame: (() => void) | null = null
  onLog: ((m: string) => void) | null = null

  constructor(clipId: string, src: VideoSource) {
    this.clipId = clipId
    this.src = src
  }

  get framesHeld(): number {
    return this.frames.length
  }

  seeks = 0
  skipped = 0

  describe(): string {
    const ts = this.frames.map((f) => Math.round(f.timestamp / 1000)).join(',')
    return `${this.clipId.slice(0, 4)} target=${Math.round(this.target / 1000)}ms frames=[${ts}] decodedUpTo=${Math.round(this.decodedUpTo / 1000)} fedUpTo=${Math.round(this.fedUpTo / 1000)} q=${this.decoder?.decodeQueueSize ?? '-'} seeks=${this.seeks} skipped=${this.skipped} la=${this.lookahead}${this.background ? ' bg' : ''}${this.hold ? ' hold' : ''}${this.error ? ' err=' + this.error : ''}`
  }

  private makeDecoder(): VideoDecoder {
    const d = new VideoDecoder({
      output: (frame) => this.onOutput(frame),
      error: (e) => {
        this.error = e.message
      },
    })
    d.addEventListener('dequeue', () => this.signal())
    return d
  }

  private signal(): void {
    const w = this.wake
    this.wake = null
    w?.()
  }

  private onOutput(frame: VideoFrame): void {
    if (this.held) {
      this.held.close()
      this.held = null
    }
    this.decodedUpTo = Math.max(this.decodedUpTo, frame.timestamp)
    this.frames.push(frame)
    if (this.frames.length > 1 && this.frames[this.frames.length - 2].timestamp > frame.timestamp) {
      this.frames.sort((a, b) => a.timestamp - b.timestamp)
    }
    this.prune()
    this.onFrame?.()
  }

  /** Keep the latest frame at/before the target plus the frames after it. */
  private prune(): void {
    const tol = 500
    while (this.frames.length >= 2 && this.frames[1].timestamp <= this.target + tol) {
      this.frames.shift()!.close()
    }
  }

  /** Decoded frames available after source time `t` (playback buffer depth). */
  ahead(t: number): number {
    let n = 0
    for (const f of this.frames) if (f.timestamp > t + 500) n++
    return n
  }

  private futureFrames(): number {
    let n = 0
    for (const f of this.frames) if (f.timestamp > this.target + 500) n++
    return n
  }

  /** Frames covering the same time span as `n` frames at 30 fps (60 fps sources get double). */
  scaled(n: number): number {
    if (n <= 1) return n
    const frames = Math.round(n * Math.max(1, 33_333 / this.src.frameDuration))
    // Hardware decoders have a fixed pool of output surfaces; holding too many stalls them.
    return Math.min(frames, 6)
  }

  /** Still filling its lookahead for `t` (pre-roll for other clips waits until it's full). */
  filling(t: number): boolean {
    return !this.error && !this.fedAll && this.ahead(t) < this.lookahead - 1
  }

  /**
   * Ask for source time `t` (µs). Non-blocking. `lookahead` is in 30 fps-equivalent frames.
   * `background`: pre-roll for a picture not on screen yet.
   */
  want(t: number, lookahead: number, background = false): void {
    this.target = t
    this.lookahead = this.scaled(lookahead)
    this.background = background
    this.budget = BACKGROUND_DECODES_PER_WANT
    this.lastUsed = performance.now()
    this.prune()
    if (!this.evaluating) void this.evaluate()
    this.signal()
  }

  /** Best frame for `t`: latest at/before it, or the first one if it's just ahead. */
  frameAt(t: number): VideoFrame | null {
    let best: VideoFrame | null = null
    for (const f of this.frames) {
      if (f.timestamp <= t + 500) best = f
      else break
    }
    if (best) return best
    const first = this.frames[0]
    if (first && first.timestamp - t < this.src.frameDuration * 2) return first
    return this.held
  }

  /** True when the frame on screen for `t` is the exact one (not a stale placeholder). */
  isExact(t: number): boolean {
    const f = this.frameAt(t)
    if (!f || f === this.held) return false
    if (f.timestamp > t + 500) return false
    const next = this.frames[this.frames.indexOf(f) + 1]
    return !!next || this.decodedUpTo >= t || f.timestamp + this.src.frameDuration > t
  }

  private async evaluate(): Promise<void> {
    this.evaluating = true
    try {
      for (;;) {
        const t = this.target
        const tol = this.src.frameDuration
        const first = this.frames[0]
        let reason = ''
        if (this.runStart < 0) reason = 'initial'
        else if (this.decoder?.state !== 'configured') reason = `decoder ${this.decoder?.state}`
        else if (first && t < first.timestamp - tol) reason = `backwards (first=${first.timestamp})`
        else if (!first && t < this.runStart - tol) reason = `before run (${this.runStart})`
        else if (t > this.decodedUpTo + 2 * tol) {
          // Ahead of the decoder: jump only if t is in a GOP we haven't fed yet.
          const key = await this.src.sink.getKeyPacket(t / 1e6, { verifyKeyPackets: true })
          const keyUs = key ? key.microsecondTimestamp : 0
          // runStart covers a seek whose first packet hasn't been fed yet (avoids seek storms).
          if (keyUs > Math.max(this.fedUpTo, this.runStart) + 1) reason = `ahead (key=${keyUs} fed=${this.fedUpTo})`
        }
        if (reason) {
          this.onLog?.(`seek ${this.clipId.slice(0, 4)} -> ${Math.round(t / 1000)}ms: ${reason}`)
          this.seek(t)
        }
        if (this.target === t) break
      }
    } catch (e) {
      this.error = String(e)
    } finally {
      this.evaluating = false
    }
  }

  private seek(t: number): void {
    this.seeks++
    const g = ++this.gen
    // Keep showing the current picture until the new position's first frame arrives.
    const shown = this.frameAt(this.target)
    for (const f of this.frames) if (f !== shown) f.close()
    if (shown && shown !== this.held) {
      this.held?.close()
      this.held = shown
    }
    this.frames = []
    this.decodedUpTo = -1
    this.fedUpTo = -1
    this.fedAll = false
    this.runStart = t
    if (!this.decoder || this.decoder.state === 'closed') this.decoder = this.makeDecoder()
    else this.decoder.reset()
    this.decoder.configure({ ...this.src.config, optimizeForLatency: true })
    this.signal()
    void this.feed(g, t)
  }

  private paused(): boolean {
    const d = this.decoder!
    if (this.background) {
      // Pre-roll shares the hardware decoder with the pictures on screen: it only uses what
      // they leave idle, a few frames at a time.
      if (this.hold || this.budget <= 0 || d.decodeQueueSize > 2) return true
    } else {
      // Catching up to a target (seek into a long GOP): keep the hardware queue deep for
      // throughput. Otherwise stay shallow so the decoder reacts quickly to new targets.
      const behind = this.target > this.decodedUpTo + 2 * this.src.frameDuration
      if (d.decodeQueueSize > (behind ? 16 : 3)) return true
    }
    return this.futureFrames() >= this.lookahead || this.frames.length >= this.lookahead + 2
  }

  private async feed(g: number, t: number): Promise<void> {
    const sink = this.src.sink
    try {
      const start =
        (await sink.getKeyPacket(t / 1e6, { verifyKeyPackets: true })) ?? (await sink.getFirstKeyPacket())
      if (!start || g !== this.gen) return
      this.runStart = start.microsecondTimestamp
      for await (const packet of sink.packets(start)) {
        if (g !== this.gen) return
        while (g === this.gen && this.paused()) {
          await new Promise<void>((r) => (this.wake = r))
        }
        if (g !== this.gen || this.decoder?.state !== 'configured') return
        this.fedUpTo = Math.max(this.fedUpTo, packet.microsecondTimestamp)
        // Seeking deep into a long GOP while paused, or pre-rolling a clip that shows there:
        // frames nothing references and that land before the target never reach the screen,
        // so don't decode them. Never for a picture on screen during playback: gaps make
        // hardware decoders hold output longer (measured: stutter at 4K60).
        if (
          (this.lookahead <= 1 || this.background) &&
          packet.type === 'delta' &&
          packet.microsecondTimestamp < this.target - this.src.frameDuration &&
          this.target > this.decodedUpTo + 10 * this.src.frameDuration &&
          isDisposable(packet.data, this.src.nal, this.src.nalLength)
        ) {
          this.skipped++
          continue
        }
        this.decoder.decode(packet.toEncodedVideoChunk())
        this.budget--
      }
      if (g === this.gen && this.decoder?.state === 'configured') {
        this.fedAll = true
        await this.decoder.flush()
      }
    } catch (e) {
      if (g === this.gen && !(e instanceof DOMException && e.name === 'AbortError')) this.error = String(e)
    }
  }

  close(): void {
    this.gen++
    this.signal()
    for (const f of this.frames) f.close()
    this.frames = []
    this.held?.close()
    this.held = null
    if (this.decoder && this.decoder.state !== 'closed') this.decoder.close()
    this.decoder = null
  }
}
