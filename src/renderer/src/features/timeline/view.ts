/** Shared timeline geometry + the live scroll element (for imperative interactions). */
import type { Micros, Project, TrackKind } from '@shared/model'
import { useEditor } from '@/state/store'

export const HEADER_W = 168
export const RULER_H = 34

export const ROW_H: Record<TrackKind, number> = { video: 68, text: 56, image: 56, audio: 60 }

export const MIN_PPS = 2
export const MAX_PPS = 1200

export const view = {
  scroller: null as HTMLDivElement | null,
  overlay: null as HTMLDivElement | null,
}

export const pps = () => useEditor.getState().pxPerSec

export const usToPx = (us: Micros, pxPerSec = pps()): number => (us / 1_000_000) * pxPerSec
export const pxToUs = (px: number, pxPerSec = pps()): Micros => Math.round((px / pxPerSec) * 1_000_000)

/** Timeline time under a viewport x coordinate. */
export function timeAtClientX(clientX: number): Micros {
  const el = view.scroller
  if (!el) return 0
  const r = el.getBoundingClientRect()
  return Math.max(0, pxToUs(clientX - r.left - HEADER_W + el.scrollLeft))
}

/** Track row under a viewport y coordinate. */
export function trackAtClientY(p: Project, clientY: number): { id: string; kind: TrackKind; top: number; height: number } | null {
  const el = view.scroller
  if (!el) return null
  const r = el.getBoundingClientRect()
  const y = clientY - r.top + el.scrollTop - RULER_H
  let top = 0
  for (const t of p.tracks) {
    const h = ROW_H[t.kind]
    if (y >= top && y < top + h) return { id: t.id, kind: t.kind, top: top + RULER_H, height: h }
    top += h
  }
  return null
}

export function rowTop(p: Project, trackId: string): number {
  let top = RULER_H
  for (const t of p.tracks) {
    if (t.id === trackId) return top
    top += ROW_H[t.kind]
  }
  return top
}

export function setZoom(next: number, anchorClientX?: number): void {
  const el = view.scroller
  const prev = pps()
  const z = Math.max(MIN_PPS, Math.min(MAX_PPS, next))
  if (z === prev) return
  let anchorTime = 0
  let anchorOffset = 0
  if (el) {
    const r = el.getBoundingClientRect()
    anchorOffset = (anchorClientX ?? r.left + HEADER_W + (el.clientWidth - HEADER_W) / 2) - r.left - HEADER_W
    anchorTime = (el.scrollLeft + anchorOffset) / prev
  }
  useEditor.setState({ pxPerSec: z })
  if (el) {
    requestAnimationFrame(() => {
      el.scrollLeft = Math.max(0, anchorTime * z - anchorOffset)
    })
  }
}

export function zoomToFit(durationUs: Micros): void {
  const el = view.scroller
  if (!el || durationUs <= 0) return
  const avail = el.clientWidth - HEADER_W - 40
  useEditor.setState({ pxPerSec: Math.max(MIN_PPS, Math.min(MAX_PPS, avail / (durationUs / 1_000_000))) })
  requestAnimationFrame(() => (el.scrollLeft = 0))
}

/** Scroll the timeline when dragging near its left/right edges. Returns a stop function. */
export function autoScroll(getX: () => number): () => void {
  let raf = 0
  const step = () => {
    const el = view.scroller
    if (el) {
      const r = el.getBoundingClientRect()
      const x = getX()
      const edge = 48
      if (x < r.left + HEADER_W + edge) el.scrollLeft -= Math.min(30, (r.left + HEADER_W + edge - x) / 2)
      else if (x > r.right - edge) el.scrollLeft += Math.min(30, (x - (r.right - edge)) / 2)
    }
    raf = requestAnimationFrame(step)
  }
  raf = requestAnimationFrame(step)
  return () => cancelAnimationFrame(raf)
}
