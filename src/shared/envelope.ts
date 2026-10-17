/**
 * Volume envelopes. Between points gain moves linearly in dB, which sounds even (a linear-gain
 * ramp seems to drop late). Shared by the mixer, the timeline drawing and the editing code.
 */
import type { DuckSettings, VolumeKey } from './model'

/** Below this the envelope is silence: a ramp to 0 runs to here, then drops out. */
export const DB_FLOOR = -72

export const gainToDb = (g: number): number => (g > 0 ? Math.max(DB_FLOOR, 20 * Math.log10(g)) : DB_FLOOR)
export const dbToGain = (db: number): number => (db <= DB_FLOOR ? 0 : Math.pow(10, db / 20))

/**
 * Envelope gain at `t`, with points given as ascending times `ts` and levels `dbs`. Before the
 * first point and after the last it holds; with no points it is 1.
 */
export function envelopeAt(ts: ArrayLike<number>, dbs: ArrayLike<number>, t: number): number {
  const n = ts.length
  if (n === 0) return 1
  if (t <= ts[0]) return dbToGain(dbs[0])
  if (t >= ts[n - 1]) return dbToGain(dbs[n - 1])
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ts[mid] <= t) lo = mid
    else hi = mid
  }
  const k = (t - ts[lo]) / (ts[hi] - ts[lo])
  return dbToGain(dbs[lo] + (dbs[hi] - dbs[lo]) * k)
}

/** Envelope gain of a clip's keys at clip-relative time `t` (1 without keys). */
export function keyGainAt(keys: readonly VolumeKey[] | undefined, t: number): number {
  if (!keys?.length) return 1
  return envelopeAt(keys.map((k) => k.t), keys.map((k) => gainToDb(k.gain)), t)
}

export const DEFAULT_DUCK: DuckSettings = { enabled: true, amount: 12, attack: 250, release: 500 }

/**
 * A ducking window: the track is fully down over [downAt, upAt), ramping from `rampFrom`
 * and back up by `rampTo`.
 */
export interface DuckWindow {
  rampFrom: number
  downAt: number
  upAt: number
  rampTo: number
}

/** How far down (0..1 of the duck amount) a set of windows is at `t`; overlapping ramps take the deeper. */
export function duckDepth(ws: readonly DuckWindow[], t: number): number {
  let d = 0
  for (const w of ws) {
    if (t < w.rampFrom || t >= w.rampTo) continue
    let x: number
    if (t < w.downAt) x = (t - w.rampFrom) / (w.downAt - w.rampFrom)
    else if (t < w.upAt) x = 1
    else x = 1 - (t - w.upAt) / (w.rampTo - w.upAt)
    if (x > d) d = x
    if (d >= 1) break
  }
  return d
}
