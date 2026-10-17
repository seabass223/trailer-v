/**
 * UI-thread facade for the preview engine: owns the preview canvas, the engine worker, the
 * AudioContext/mixer worklet and the shared clock. React code talks to this, never to the
 * GPU or decoders directly. The playhead is driven by one rAF loop reading the shared clock.
 */
import type { Micros, Project } from '@shared/model'
import { compileSegments } from '@shared/mixer'
import { audioPlan } from '@shared/render-plan'
import { projectDuration } from '@shared/timeline'
import { frameToUs, frameIndex } from '@shared/time'
import workletUrl from './audio/worklet.ts?worker&url'
import { CLOCK, clockTimeUs, createClock, createStats, isPlaying, usToFrames } from './clock'
import { pcmFor, releasePcm, setPreviewBusyProbe } from './media-client'
import type { EngineInbound, EngineOutbound, PreviewQuality } from './protocol'

type TickListener = (time: Micros, playing: boolean) => void

class EngineClient {
  readonly clock = createClock()
  readonly stats = createStats()
  readonly canvas: HTMLCanvasElement
  private worker: Worker
  private ctx: AudioContext
  private mixer: AudioWorkletNode | null = null
  private mixerReady: Promise<void>
  private project: Project | null = null
  private listeners = new Set<TickListener>()
  private lastTick = { time: -1, playing: false }
  private loadedSources = new Set<string>()
  private posterWaiters = new Map<number, (b: ArrayBuffer | null) => void>()
  private nextPoster = 1
  adapter = ''
  error: string | null = null
  onError: ((message: string) => void) | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.className = 'block h-full w-full'
    const offscreen = this.canvas.transferControlToOffscreen()
    this.worker = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'engine' })
    this.worker.onmessage = (e: MessageEvent<EngineOutbound>) => this.onWorker(e.data)
    this.send({ type: 'init', canvas: offscreen, clock: this.clock, stats: this.stats }, [offscreen])

    this.ctx = new AudioContext({ sampleRate: 48_000, latencyHint: 'interactive' })
    this.mixerReady = this.ctx.audioWorklet.addModule(workletUrl).then(() => {
      this.mixer = new AudioWorkletNode(this.ctx, 'trailer-mixer', { numberOfInputs: 0, outputChannelCount: [2] })
      this.mixer.connect(this.ctx.destination)
      this.mixer.port.onmessage = (e) => {
        if (e.data?.type === 'ended') this.emit(true)
      }
      this.mixer.port.postMessage({ type: 'init', clock: this.clock })
      if (this.project) this.syncAudio(this.project)
    })
    requestAnimationFrame(this.loop)
    setPreviewBusyProbe(() => this.playing || performance.now() - this.lastSeekAt < 800, this.clock)
  }

  private lastSeekAt = 0

  private send(m: EngineInbound, transfer: Transferable[] = []): void {
    this.worker.postMessage(m, transfer)
  }

  private onWorker(m: EngineOutbound): void {
    if (m.type === 'ready') this.adapter = m.adapter
    else if (m.type === 'error') {
      this.error = m.message
      this.onError?.(m.message)
    } else if (m.type === 'log') {
      console.log(`[engine] ${m.message}`)
    } else if (m.type === 'prerolled') {
      this.prerollWaiters.get(m.id)?.()
      this.prerollWaiters.delete(m.id)
    } else if (m.type === 'poster') {
      this.posterWaiters.get(m.id)?.(m.jpeg)
      this.posterWaiters.delete(m.id)
    }
  }

  private loop = () => {
    requestAnimationFrame(this.loop)
    this.emit(false)
  }

  private emit(force: boolean): void {
    const time = this.time()
    const playing = this.playing
    if (!force && time === this.lastTick.time && playing === this.lastTick.playing) return
    this.lastTick = { time, playing }
    for (const l of this.listeners) l(time, playing)
  }

  /** Subscribe to playhead updates (called at display rate while it moves). */
  subscribe(l: TickListener): () => void {
    this.listeners.add(l)
    l(this.time(), this.playing)
    return () => this.listeners.delete(l)
  }

  time(): Micros {
    return clockTimeUs(this.clock)
  }

  /** Playing, or about to (prerolling). */
  get playing(): boolean {
    return isPlaying(this.clock) || this.pendingPlay > 0
  }

  get duration(): Micros {
    return this.project ? projectDuration(this.project) : 0
  }

  setProject(p: Project): void {
    this.project = p
    this.send({ type: 'project', project: p })
    Atomics.store(this.clock, CLOCK.END, usToFrames(projectDuration(p)))
    if (this.time() > projectDuration(p)) this.seek(projectDuration(p))
    this.syncAudio(p)
  }

  private syncAudio(p: Project): void {
    const segs = audioPlan(p)
    this.mixer?.port.postMessage({ type: 'segments', segments: compileSegments(segs) })
    const needed = new Set(segs.map((s) => s.source))
    for (const path of needed) {
      if (this.loadedSources.has(path)) continue
      this.loadedSources.add(path)
      pcmFor(path)
        .then(async (pcm) => {
          await this.mixerReady
          this.mixer?.port.postMessage({ type: 'source', path, data: pcm.data, frames: pcm.frames })
        })
        .catch(() => this.loadedSources.delete(path))
    }
    for (const path of [...this.loadedSources]) {
      if (needed.has(path)) continue
      this.loadedSources.delete(path)
      this.mixer?.port.postMessage({ type: 'drop-source', path })
    }
    releasePcm(needed)
  }

  private pendingPlay = 0
  private prerollWaiters = new Map<number, () => void>()

  private preroll(): Promise<void> {
    const id = Date.now() + Math.random()
    return new Promise((resolve) => {
      this.prerollWaiters.set(id, resolve)
      this.send({ type: 'preroll', id })
      setTimeout(() => this.prerollWaiters.delete(id) && resolve(), 500)
    })
  }

  async play(): Promise<void> {
    if (!this.project || this.playing || this.pendingPlay) return
    const end = projectDuration(this.project)
    if (end <= 0) return
    if (this.time() >= end - 1000) this.seek(0)
    // The UI flips to "playing" immediately; the clock starts once decoders have a few frames
    // buffered (the GPU may be ramping up from idle), so playback never stutters at the start.
    const ticket = ++this.pendingPlay
    this.emit(true)
    await Promise.all([this.ctx.state !== 'running' ? this.ctx.resume() : null, this.preroll()])
    if (this.pendingPlay !== ticket) return
    this.pendingPlay = 0
    const latency = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)
    Atomics.store(this.clock, CLOCK.LATENCY, Math.round(latency * 48_000))
    // Audio starts exactly here; the picture holds until that sound is audible.
    Atomics.store(this.clock, CLOCK.PLAY_START, Atomics.load(this.clock, CLOCK.POSITION))
    Atomics.add(this.clock, CLOCK.SEEK_GEN, 1)
    Atomics.store(this.clock, CLOCK.PLAYING, 1)
    this.send({ type: 'play' })
    this.emit(true)
  }

  pause(): void {
    if (this.pendingPlay) {
      this.pendingPlay = 0
      this.emit(true)
      return
    }
    if (!isPlaying(this.clock)) return
    const heard = this.time()
    Atomics.store(this.clock, CLOCK.PLAYING, 0)
    this.seek(this.snap(heard))
    this.send({ type: 'pause' })
  }

  toggle(): void {
    if (this.playing) this.pause()
    else void this.play()
  }

  private snap(t: Micros): Micros {
    const fps = this.project?.settings.fps ?? 30
    return frameToUs(frameIndex(t, fps), fps)
  }

  seek(t: Micros): void {
    const clamped = Math.max(0, Math.min(t, this.duration))
    const frames = usToFrames(clamped)
    this.lastSeekAt = performance.now()
    Atomics.store(this.clock, CLOCK.PLAY_START, frames)
    Atomics.store(this.clock, CLOCK.POSITION, frames)
    Atomics.add(this.clock, CLOCK.SEEK_GEN, 1)
    this.send({ type: 'seek', time: clamped })
    this.emit(true)
  }

  step(frames: number): void {
    const fps = this.project?.settings.fps ?? 30
    if (this.playing) this.pause()
    this.seek(frameToUs(frameIndex(this.time(), fps) + frames, fps))
  }

  resize(width: number, height: number): void {
    const dpr = window.devicePixelRatio || 1
    this.send({ type: 'resize', width: Math.round(width * dpr), height: Math.round(height * dpr) })
  }

  setQuality(quality: PreviewQuality): void {
    this.send({ type: 'quality', quality })
  }

  /** Debug helper: logs decoder state to the console as `[engine] ...`. */
  describe(): void {
    this.send({ type: 'describe' })
  }

  /** Verbose engine logging (seeks, drops) — enabled while the perf HUD is shown. */
  setDebug(on: boolean): void {
    this.send({ type: 'debug', on })
  }

  hideClip(clipId: string | null): void {
    this.send({ type: 'hide-clip', clipId })
  }

  poster(time: Micros): Promise<ArrayBuffer | null> {
    const id = this.nextPoster++
    return new Promise((resolve) => {
      this.posterWaiters.set(id, resolve)
      this.send({ type: 'poster', time, id })
      setTimeout(() => {
        if (this.posterWaiters.delete(id)) resolve(null)
      }, 5000)
    })
  }
}

let instance: EngineClient | null = null

export function engine(): EngineClient {
  instance ??= new EngineClient()
  return instance
}

export type { EngineClient }
