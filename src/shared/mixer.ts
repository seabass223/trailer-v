/**
 * Sample-accurate mixer shared by the AudioWorklet (preview) and export, so what you hear
 * is exactly what gets encoded. Sources are 48 kHz interleaved stereo Int16 PCM.
 */
import type { AudioSegment } from './render-plan'

export const SAMPLE_RATE = 48_000

export interface PcmSource {
  data: Int16Array
  frames: number
}

export interface CompiledSegment {
  source: string
  from: number
  to: number
  clipStart: number
  inPoint: number
  gain: number
  fadeInEnd: number
  fadeOutStart: number
  clipEnd: number
  xInFrom: number
  xInTo: number
  xOutFrom: number
  xOutTo: number
}

const f = (us: number) => Math.round((us * SAMPLE_RATE) / 1_000_000)

export function compileSegments(segs: AudioSegment[]): CompiledSegment[] {
  return segs.map((s) => ({
    source: s.source,
    from: f(s.from),
    to: f(s.to),
    clipStart: f(s.clipStart),
    inPoint: f(s.inPoint),
    gain: s.gain,
    fadeInEnd: f(s.fadeInEnd),
    fadeOutStart: f(s.fadeOutStart),
    clipEnd: f(s.clipEndTime),
    xInFrom: f(s.xInFrom),
    xInTo: f(s.xInTo),
    xOutFrom: f(s.xOutFrom),
    xOutTo: f(s.xOutTo),
  }))
}

const HALF_PI = Math.PI / 2
const I16 = 1 / 32768

function gainAt(s: CompiledSegment, t: number): number {
  let g = s.gain
  if (t < s.fadeInEnd && s.fadeInEnd > s.clipStart) g *= Math.max(0, (t - s.clipStart) / (s.fadeInEnd - s.clipStart))
  if (t > s.fadeOutStart && s.clipEnd > s.fadeOutStart) g *= Math.max(0, (s.clipEnd - t) / (s.clipEnd - s.fadeOutStart))
  if (s.xInTo > s.xInFrom && t < s.xInTo) g *= Math.sin(Math.max(0, (t - s.xInFrom) / (s.xInTo - s.xInFrom)) * HALF_PI)
  if (s.xOutTo > s.xOutFrom && t >= s.xOutFrom) g *= Math.cos(Math.min(1, (t - s.xOutFrom) / (s.xOutTo - s.xOutFrom)) * HALF_PI)
  return g
}

/**
 * Mix `frames` frames starting at timeline frame `start` into planar `left`/`right`
 * (which are zeroed first). Sources missing from `sources` are silently skipped.
 */
export function mix(
  left: Float32Array,
  right: Float32Array,
  start: number,
  frames: number,
  segs: readonly CompiledSegment[],
  sources: ReadonlyMap<string, PcmSource>,
): void {
  left.fill(0, 0, frames)
  right.fill(0, 0, frames)
  const end = start + frames
  for (const s of segs) {
    if (s.to <= start || s.from >= end) continue
    const src = sources.get(s.source)
    if (!src) continue
    const a = Math.max(start, s.from)
    const b = Math.min(end, s.to)
    const data = src.data
    const offset = s.inPoint - s.clipStart
    // Envelope is piecewise-smooth; evaluating it every 32 frames is inaudible and much cheaper.
    let g = gainAt(s, a)
    for (let t = a; t < b; t++) {
      if (((t - a) & 31) === 0) g = gainAt(s, t)
      const sf = t + offset
      if (sf < 0 || sf >= src.frames) continue
      const i = t - start
      left[i] += data[sf * 2] * I16 * g
      right[i] += data[sf * 2 + 1] * I16 * g
    }
  }
}
