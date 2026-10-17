import { describe, expect, it } from 'vitest'
import { resample } from '@shared/resample'

function sine(freq: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds))
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate)
  return out
}

describe('resample', () => {
  it('44.1k -> 48k preserves a 1 kHz tone accurately', () => {
    const out = resample(sine(1000, 44100, 1), 44100, 48000)
    expect(out.length).toBe(48000)
    const ref = sine(1000, 48000, 1)
    let err = 0
    for (let i = 1000; i < 47000; i++) err = Math.max(err, Math.abs(out[i] - ref[i]))
    expect(err).toBeLessThan(0.01)
  })

  it('96k -> 48k removes content above the new Nyquist', () => {
    const out = resample(sine(30000, 96000, 0.5), 96000, 48000)
    let peak = 0
    for (let i = 500; i < out.length - 500; i++) peak = Math.max(peak, Math.abs(out[i]))
    expect(peak).toBeLessThan(0.05)
  })
})
