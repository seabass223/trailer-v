/**
 * AudioWorklet: real-time mixer and master clock. Mixes the shared 48 kHz PCM sources with
 * the same `mix()` export uses, and advances the shared clock while playing.
 */
import { mix, type CompiledSegment, type PcmSource } from '@shared/mixer'
import { CLOCK } from '../clock'

declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor {
  readonly port: MessagePort
}

export type WorkletInbound =
  | { type: 'init'; clock: Int32Array }
  | { type: 'segments'; segments: CompiledSegment[] }
  | { type: 'source'; path: string; data: Int16Array; frames: number }
  | { type: 'drop-source'; path: string }

class MixerProcessor extends AudioWorkletProcessor {
  private clock: Int32Array | null = null
  private segments: CompiledSegment[] = []
  private sources = new Map<string, PcmSource>()
  private scratchL = new Float32Array(128)
  private scratchR = new Float32Array(128)

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent<WorkletInbound>) => {
      const m = e.data
      if (m.type === 'init') this.clock = m.clock
      else if (m.type === 'segments') this.segments = m.segments
      else if (m.type === 'source') this.sources.set(m.path, { data: m.data, frames: m.frames })
      else if (m.type === 'drop-source') this.sources.delete(m.path)
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    const L = out[0]
    const R = out[1] ?? out[0]
    const c = this.clock
    if (!c || Atomics.load(c, CLOCK.PLAYING) !== 1) {
      L.fill(0)
      if (R !== L) R.fill(0)
      return true
    }
    const gen = Atomics.load(c, CLOCK.SEEK_GEN)
    const pos = Atomics.load(c, CLOCK.POSITION)
    const n = L.length
    if (this.scratchL.length < n) {
      this.scratchL = new Float32Array(n)
      this.scratchR = new Float32Array(n)
    }
    mix(this.scratchL, this.scratchR, pos, n, this.segments, this.sources)
    L.set(this.scratchL.subarray(0, n))
    if (R !== L) R.set(this.scratchR.subarray(0, n))
    // A seek from the UI thread wins over our advance.
    if (Atomics.load(c, CLOCK.SEEK_GEN) === gen) {
      const next = pos + n
      const end = Atomics.load(c, CLOCK.END)
      if (end > 0 && next >= end) {
        Atomics.store(c, CLOCK.POSITION, end)
        Atomics.store(c, CLOCK.PLAYING, 0)
        this.port.postMessage({ type: 'ended' })
      } else {
        Atomics.store(c, CLOCK.POSITION, next)
      }
    }
    return true
  }
}

void sampleRate
registerProcessor('trailer-mixer', MixerProcessor)
