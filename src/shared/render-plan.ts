/**
 * What to draw / hear at a given timeline time. Shared by the preview engine and export,
 * so both produce identical output.
 */
import type { Clip, Micros, Project, Track, TrackKind } from './model'
import { clipEnd } from './timeline'

const KIND_RANK: Record<TrackKind, number> = { video: 0, image: 1, text: 2, audio: 3 }

export interface VisualLayer {
  clip: Clip
  /** Source time to show (video), clamped into the source so transitions freeze edge frames. */
  sourceTime: Micros
  opacity: number
}

export interface ColorOverlay {
  color: string
  alpha: number
}

export interface FramePlan {
  /**
   * Main-track layers (bottom). Each is composited over the background on its own, then
   * successive ones are mixed by their opacity: a true cross-dissolve even for letterboxed media.
   */
  base: VisualLayer[]
  dip: ColorOverlay | null
  overlays: VisualLayer[]
}

/** Visual tracks ordered bottom-to-top: by kind, and within a kind, upper rows on top. */
export function visualTracksBottomUp(p: Project): Track[] {
  return p.tracks
    .map((t, row) => ({ t, row }))
    .filter(({ t }) => t.kind !== 'audio')
    .sort((a, b) => KIND_RANK[a.t.kind] - KIND_RANK[b.t.kind] || b.row - a.row)
    .map(({ t }) => t)
}

export function sourceTimeAt(c: Clip, t: Micros): Micros {
  const s = c.inPoint + (t - c.start)
  if (c.sourceDuration == null) return Math.max(0, s)
  // Keep a little inside the end so a decodable frame always exists.
  return Math.min(Math.max(0, s), Math.max(0, c.sourceDuration - 1000))
}

function fadeFactor(c: Clip, t: Micros): number {
  let f = 1
  if (c.fadeIn.duration > 0 && t < c.start + c.fadeIn.duration) f = Math.min(f, (t - c.start) / c.fadeIn.duration)
  const end = clipEnd(c)
  if (c.fadeOut.duration > 0 && t > end - c.fadeOut.duration) f = Math.min(f, (end - t) / c.fadeOut.duration)
  return Math.max(0, Math.min(1, f))
}

/** Main-track clips with time windows extended by centred cross-fades. */
interface Span {
  clip: Clip
  from: Micros
  to: Micros
  /** Ramp-in window [inFrom, inTo) and ramp-out window [outFrom, outTo). */
  inFrom: Micros
  inTo: Micros
  outFrom: Micros
  outTo: Micros
}

export function trackSpans(p: Project, trackId: string): Span[] {
  const clips = p.clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start)
  const spans = new Map<string, Span>()
  for (const c of clips) {
    const end = clipEnd(c)
    spans.set(c.id, { clip: c, from: c.start, to: end, inFrom: c.start, inTo: c.start, outFrom: end, outTo: end })
  }
  for (const tr of p.transitions) {
    const a = spans.get(tr.fromClipId)
    const b = spans.get(tr.toClipId)
    if (!a || !b) continue
    const cut = b.clip.start
    const half = tr.duration / 2
    a.to = cut + half
    a.outFrom = cut - half
    a.outTo = cut + half
    b.from = cut - half
    b.inFrom = cut - half
    b.inTo = cut + half
  }
  return clips.map((c) => spans.get(c.id)!)
}

export function framePlan(p: Project, t: Micros): FramePlan {
  const plan: FramePlan = { base: [], dip: null, overlays: [] }
  for (const track of visualTracksBottomUp(p)) {
    if (track.hidden) continue
    const isMainTrack = track.kind === 'video'
    for (const s of trackSpans(p, track.id)) {
      if (t < s.from || t >= s.to) continue
      const c = s.clip
      // Incoming side of a cross-fade fades in over the outgoing clip.
      let opacity = 1
      if (s.inTo > s.inFrom && t < s.inTo) opacity = (t - s.inFrom) / (s.inTo - s.inFrom)
      const fade = fadeFactor(c, t)
      if (isMainTrack) {
        plan.base.push({ clip: c, sourceTime: sourceTimeAt(c, t), opacity })
        if (fade < 1) {
          const color = t < c.start + c.fadeIn.duration ? c.fadeIn.color : c.fadeOut.color
          const alpha = 1 - fade
          if (!plan.dip || alpha > plan.dip.alpha) plan.dip = { color, alpha }
        }
      } else {
        // Overlays have no opaque frame underneath, so the outgoing side fades out too.
        if (s.outTo > s.outFrom && t >= s.outFrom) opacity *= 1 - (t - s.outFrom) / (s.outTo - s.outFrom)
        plan.overlays.push({ clip: c, sourceTime: sourceTimeAt(c, t), opacity: opacity * fade })
      }
    }
  }
  return plan
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioSegment {
  clipId: string
  source: string
  /** Audible timeline window (includes cross-fade extensions). */
  from: Micros
  to: Micros
  clipStart: Micros
  inPoint: Micros
  gain: number
  fadeInEnd: Micros
  fadeOutStart: Micros
  clipEndTime: Micros
  /** Equal-power cross-fade windows (empty when equal). */
  xInFrom: Micros
  xInTo: Micros
  xOutFrom: Micros
  xOutTo: Micros
}

export function audioPlan(p: Project): AudioSegment[] {
  const segs: AudioSegment[] = []
  for (const track of p.tracks) {
    if (track.hidden) continue
    if (track.kind !== 'audio' && track.kind !== 'video') continue
    for (const s of trackSpans(p, track.id)) {
      const c = s.clip
      if (!c.source || (c.kind !== 'audio' && !(c.kind === 'video' && c.hasAudio)) || c.volume <= 0) continue
      const end = clipEnd(c)
      segs.push({
        clipId: c.id,
        source: c.source,
        from: s.from,
        to: s.to,
        clipStart: c.start,
        inPoint: c.inPoint,
        gain: c.volume,
        fadeInEnd: c.start + c.fadeIn.duration,
        fadeOutStart: end - c.fadeOut.duration,
        clipEndTime: end,
        xInFrom: s.inFrom,
        xInTo: s.inTo,
        xOutFrom: s.outFrom,
        xOutTo: s.outTo,
      })
    }
  }
  return segs
}
