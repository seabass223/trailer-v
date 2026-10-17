/**
 * Band-limited resampler (Lanczos, a = 8, 512-phase table). Used once per audio source when
 * it's decoded, so the real-time mixer can read 48 kHz PCM with plain integer indexing.
 */
const A = 8
const PHASES = 512

const tableCache = new Map<number, { table: Float32Array; taps: number; scale: number }>()

function sinc(x: number): number {
  if (x === 0) return 1
  const px = Math.PI * x
  return Math.sin(px) / px
}

function kernel(ratio: number) {
  // Downsampling widens the kernel to low-pass below the new Nyquist.
  const scale = ratio > 1 ? 1 / ratio : 1
  const key = Math.round(scale * 1e6)
  let k = tableCache.get(key)
  if (!k) {
    const taps = Math.ceil((2 * A) / scale)
    const table = new Float32Array((PHASES + 1) * taps)
    const half = taps / 2
    for (let ph = 0; ph <= PHASES; ph++) {
      const frac = ph / PHASES
      let sum = 0
      for (let t = 0; t < taps; t++) {
        const x = (t - half + 1 - frac) * scale
        const v = Math.abs(x) < A ? sinc(x) * sinc(x / A) : 0
        table[ph * taps + t] = v
        sum += v
      }
      // Normalise so DC gain is exactly 1 at every phase.
      for (let t = 0; t < taps; t++) table[ph * taps + t] /= sum || 1
    }
    k = { table, taps, scale }
    tableCache.set(key, k)
  }
  return k
}

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input
  const ratio = fromRate / toRate
  const outLen = Math.floor((input.length * toRate) / fromRate)
  const out = new Float32Array(outLen)
  const { table, taps } = kernel(ratio)
  const half = taps / 2
  const n = input.length
  for (let j = 0; j < outLen; j++) {
    const pos = j * ratio
    const i0 = Math.floor(pos)
    const ph = Math.round((pos - i0) * PHASES)
    const base = ph * taps
    const first = i0 - half + 1
    let acc = 0
    if (first >= 0 && first + taps <= n) {
      for (let t = 0; t < taps; t++) acc += input[first + t] * table[base + t]
    } else {
      for (let t = 0; t < taps; t++) {
        const idx = first + t
        if (idx >= 0 && idx < n) acc += input[idx] * table[base + t]
      }
    }
    out[j] = acc
  }
  return out
}
