import type { Transform } from './model'

export type Rect = [left: number, top: number, right: number, bottom: number]

/** Where media of natural size mw×mh lands in a W×H frame for a transform. */
export function mediaRect(W: number, H: number, mw: number, mh: number, t: Transform): Rect {
  if (!mw || !mh) return [0, 0, W, H]
  const fit = t.fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh)
  const w = mw * fit * t.scale
  const h = mh * fit * t.scale
  const cx = W / 2 + t.x * W
  const cy = H / 2 + t.y * H
  return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2]
}
