import type { Micros } from './model'

export const US = 1_000_000

export const secToUs = (s: number): Micros => Math.round(s * US)
export const usToSec = (us: Micros): number => us / US

export function frameIndex(us: Micros, fps: number): number {
  return Math.round((us * fps) / US)
}

export function frameToUs(index: number, fps: number): Micros {
  return Math.round((index * US) / fps)
}

export function snapToFrame(us: Micros, fps: number): Micros {
  return frameToUs(frameIndex(us, fps), fps)
}

export function frameDuration(fps: number): Micros {
  return Math.round(US / fps)
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0')

/** 00:08, or 1:02:08 past an hour. */
export function formatTime(us: Micros): string {
  const total = Math.max(0, Math.floor(us / US))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** 00:08:12 (mm:ss:ff). */
export function formatTimecode(us: Micros, fps: number): string {
  const frames = frameIndex(Math.max(0, us), fps)
  const fpsInt = Math.round(fps)
  const ff = frames % fpsInt
  return `${formatTime(frameToUs(frames - ff, fps))}:${pad(ff)}`
}

/** Compact duration for badges and tooltips: 12.4s, 1:05. */
export function formatDuration(us: Micros): string {
  const s = us / US
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`
  return formatTime(us)
}
