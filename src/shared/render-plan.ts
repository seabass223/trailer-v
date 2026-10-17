/**
 * What to draw / hear at a given timeline time. Shared by the preview engine and export,
 * so both produce identical output.
 */
import type { Clip, Micros, Project, Track, TrackKind } from './model'
import { type DuckWindow, gainToDb } from './envelope'
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
   * Video-track layers (bottom), bottom to top. Each is composited over the background on its
   * own, then successive ones are mixed in by their opacity: a true dissolve even for
   * letterboxed media. The first is always opaque.
   */
  base: VisualLayer[]
  /** Video layers in a fade that contribute nothing at this instant: decode, don't draw. */
  standby: VisualLayer[]
  dip: ColorOverlay | null
  overlays: VisualLayer[]
}

/**
 * Visual tracks ordered bottom-to-top: by kind, and within a kind, upper rows on top.
 * Video tracks cover each other rather than blend, though: see `addVideo`.
 */
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

const activeSpans = (p: Project, trackId: string, t: Micros): Span[] =>
  trackSpans(p, trackId).filter((s) => t >= s.from && t < s.to)

const inFade = (c: Clip, t: Micros): boolean =>
  (c.fadeIn.duration > 0 && t < c.start + c.fadeIn.duration) || (c.fadeOut.duration > 0 && t >= clipEnd(c) - c.fadeOut.duration)

/** One video track's own picture at `t`: its clips (cross-dissolving) and how far it has faded. */
interface TrackPicture {
  layers: VisualLayer[]
  /** Each layer's share of the track's picture. */
  weights: number[]
  /** How far the track has faded away (0 = fully shown); `color` is what it fades to. */
  faded: number
  color: string
  /** Inside a fade window, even at its very first instant (`faded` still 0). */
  fading: boolean
}

function trackPicture(p: Project, trackId: string, t: Micros): TrackPicture | null {
  const spans = activeSpans(p, trackId, t)
  if (!spans.length) return null
  const pic: TrackPicture = { layers: [], weights: [], faded: 0, color: '#000000', fading: false }
  for (const s of spans) {
    const c = s.clip
    // Incoming side of a cross-fade fades in over the outgoing clip.
    const opacity = s.inTo > s.inFrom && t < s.inTo ? (t - s.inFrom) / (s.inTo - s.inFrom) : 1
    pic.layers.push({ clip: c, sourceTime: sourceTimeAt(c, t), opacity })
    pic.fading ||= inFade(c, t)
    const faded = 1 - fadeFactor(c, t)
    if (faded > pic.faded) {
      pic.faded = faded
      pic.color = t < c.start + c.fadeIn.duration ? c.fadeIn.color : c.fadeOut.color
    }
  }
  // Layer i is mixed in by its opacity, then covered by the share of every later one.
  pic.weights = pic.layers.map((l, i) =>
    pic.layers.slice(i + 1).reduce((w, above) => w * (1 - above.opacity), i === 0 ? 1 : l.opacity))
  return pic
}

/**
 * Only one video is visible at a time: the topmost visible video track with a clip at `t`
 * covers every video track below it, even where its clip is scaled down or letterboxed (the
 * background shows there). Covered clips are not drawn, so they are not decoded either.
 * While that clip fades, it dissolves into the next video track down that has a clip (which
 * may itself be fading); only with nothing below does it dip to its fade colour.
 */
function addVideo(p: Project, t: Micros, plan: FramePlan): void {
  const stack: TrackPicture[] = []
  for (const track of p.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    const pic = trackPicture(p, track.id, t)
    if (!pic) continue
    stack.push(pic)
    if (!pic.fading) break
  }
  // Each track keeps (1 - faded) of what reaches it and hands the rest further down.
  let rest = 1
  const shares = stack.map((pic) => {
    const share = pic.layers.map((l, i) => ({ l, w: rest * (1 - pic.faded) * pic.weights[i] }))
    rest *= pic.faded
    return share
  })
  if (stack.length && rest > 0) plan.dip = { color: stack[stack.length - 1].color, alpha: rest }
  // Bottom-up as a chain of mixes: each layer goes in at its share of everything so far.
  let sum = 0
  for (const { l, w } of shares.reverse().flat()) {
    if (w <= 0) {
      plan.standby.push(l)
      continue
    }
    sum += w
    plan.base.push({ ...l, opacity: plan.base.length ? w / sum : 1 })
  }
}

export function framePlan(p: Project, t: Micros): FramePlan {
  const plan: FramePlan = { base: [], standby: [], dip: null, overlays: [] }
  addVideo(p, t, plan)
  for (const track of visualTracksBottomUp(p)) {
    if (track.hidden || track.kind === 'video') continue
    for (const s of activeSpans(p, track.id, t)) {
      const c = s.clip
      let opacity = 1
      if (s.inTo > s.inFrom && t < s.inTo) opacity = (t - s.inFrom) / (s.inTo - s.inFrom)
      // Overlays have no opaque frame underneath, so the outgoing side fades out too.
      if (s.outTo > s.outFrom && t >= s.outFrom) opacity *= 1 - (t - s.outFrom) / (s.outTo - s.outFrom)
      plan.overlays.push({ clip: c, sourceTime: sourceTimeAt(c, t), opacity: opacity * fadeFactor(c, t) })
    }
  }
  return plan
}

/**
 * Times in (from, to) where the shown video can change, ascending: span and fade edges on
 * visible video tracks (an upper clip ending or starting to fade out reveals the one below).
 */
export function videoChangesBetween(p: Project, from: Micros, to: Micros): Micros[] {
  const out = new Set<Micros>()
  const add = (x: Micros) => x > from && x < to && out.add(x)
  for (const track of p.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const s of trackSpans(p, track.id)) {
      const c = s.clip
      add(s.from)
      add(s.to)
      if (c.fadeIn.duration > 0) add(c.start + c.fadeIn.duration)
      if (c.fadeOut.duration > 0) add(clipEnd(c) - c.fadeOut.duration)
    }
  }
  return [...out].sort((a, b) => a - b)
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
  /** Volume envelope on the timeline: ascending absolute times and their levels in dB. */
  keyTimes: Micros[]
  keyDbs: number[]
  /** Ducking under video-track sound: dB to dip by and where (empty when not ducked). */
  duckDb: number
  duck: DuckWindow[]
}

const hasSound = (c: Clip): boolean => !!c.source && (c.kind === 'audio' || (c.kind === 'video' && c.hasAudio))

/** Clips that make sound: on a shown audio/video track, not muted and not at zero volume. */
function audibleSpans(p: Project, track: Track): Span[] {
  if (track.hidden || (track.kind !== 'audio' && track.kind !== 'video')) return []
  return trackSpans(p, track.id).filter((s) => hasSound(s.clip) && !s.clip.muted && s.clip.volume > 0)
}

/**
 * Where audible video-track clips play, merged, as ducking windows: fully down while they
 * play (so speech is never masked), ramping down over `attack` before and up over `release` after.
 */
export function duckWindows(p: Project, attack: Micros, release: Micros): DuckWindow[] {
  const spans = p.tracks
    .filter((t) => t.kind === 'video')
    .flatMap((t) => audibleSpans(p, t))
    .map((s) => [s.from, s.to] as const)
    .sort((a, b) => a[0] - b[0])
  const merged: [Micros, Micros][] = []
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged.map(([a, b]) => ({ rampFrom: a - attack, downAt: a, upAt: b, rampTo: b + release }))
}

/** Covered video clips stay audible: only the picture is exclusive (B-roll over an interview). */
export function audioPlan(p: Project): AudioSegment[] {
  const segs: AudioSegment[] = []
  for (const track of p.tracks) {
    const duck = track.kind === 'audio' && track.duck?.enabled && track.duck.amount > 0 ? track.duck : null
    const windows = duck ? duckWindows(p, duck.attack * 1000, duck.release * 1000) : []
    for (const s of audibleSpans(p, track)) {
      const c = s.clip
      const end = clipEnd(c)
      const keys = c.volumeKeys ?? []
      segs.push({
        clipId: c.id,
        source: c.source!,
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
        keyTimes: keys.map((k) => c.start + k.t),
        keyDbs: keys.map((k) => gainToDb(k.gain)),
        duckDb: duck ? duck.amount : 0,
        duck: windows.filter((w) => w.rampTo > s.from && w.rampFrom < s.to),
      })
    }
  }
  return segs
}
