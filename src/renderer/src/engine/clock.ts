/**
 * Lock-free transport clock shared by the UI thread, the engine worker and the AudioWorklet.
 * The worklet advances the position while playing, so video follows the audio clock.
 */
import { SAMPLE_RATE } from '@shared/mixer'

export const CLOCK = {
  PLAYING: 0,
  /** Position in 48 kHz frames. */
  POSITION: 1,
  /** Incremented on every seek so readers can tell a jump from playback. */
  SEEK_GEN: 2,
  /** Timeline end in frames; playback stops here. */
  END: 3,
  /** Output latency in frames (what's being heard lags POSITION by this much). */
  LATENCY: 4,
  /** Where playback (re)started; the picture holds here until the audio reaches the speakers. */
  PLAY_START: 5,
  SIZE: 8,
} as const

export type ClockView = Int32Array

export const createClock = (): ClockView => new Int32Array(new SharedArrayBuffer(CLOCK.SIZE * 4))

export const usToFrames = (us: number): number => Math.round((us * SAMPLE_RATE) / 1_000_000)
export const framesToUs = (frames: number): number => Math.round((frames * 1_000_000) / SAMPLE_RATE)

export function clockTimeUs(c: ClockView): number {
  const pos = Atomics.load(c, CLOCK.POSITION)
  const playing = Atomics.load(c, CLOCK.PLAYING) === 1
  // While playing, show the frame matching what's audible right now.
  if (!playing) return framesToUs(pos)
  return framesToUs(Math.max(Atomics.load(c, CLOCK.PLAY_START), pos - Atomics.load(c, CLOCK.LATENCY)))
}

export const isPlaying = (c: ClockView): boolean => Atomics.load(c, CLOCK.PLAYING) === 1

/** Engine stats written by the engine worker, read by the perf HUD (Float64 for convenience). */
export const STATS = {
  FPS: 0,
  DROPPED: 1,
  RENDER_MS: 2,
  DECODERS: 3,
  FRAMES_HELD: 4,
  GPU_MS: 5,
  /** 1 when the last rendered frame had every layer's exact content. */
  COMPLETE: 6,
  SIZE: 8,
} as const

export const createStats = (): Float64Array => new Float64Array(new SharedArrayBuffer(STATS.SIZE * 8))
