/**
 * Pure timeline operations. They mutate the given project (an Immer draft in the app,
 * a plain object in tests). The main video track is magnetic: its clips are always
 * contiguous from 0. Other tracks are free placement with no overlaps.
 */
import type { AspectId, Clip, FitMode, Micros, Project, TierId, Track, Transition } from './model'
import { uid } from './factory'
import { resolutionFor } from './presets'
import { frameDuration } from './time'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

export const minClipDuration = (fps: number): Micros => frameDuration(fps)

export function mainTrack(p: Project): Track {
  const t = p.tracks.find((t) => t.kind === 'video')
  if (!t) throw new Error('Project has no video track')
  return t
}

export const isMain = (p: Project, trackId: string): boolean => mainTrack(p).id === trackId

export function trackClips(p: Project, trackId: string, exclude?: ReadonlySet<string>): Clip[] {
  return p.clips
    .filter((c) => c.trackId === trackId && !exclude?.has(c.id))
    .sort((a, b) => a.start - b.start)
}

export const clipEnd = (c: Clip): Micros => c.start + c.duration

export function projectDuration(p: Project): Micros {
  let end = 0
  for (const c of p.clips) end = Math.max(end, clipEnd(c))
  return end
}

export function findClip(p: Project, id: string): Clip | undefined {
  return p.clips.find((c) => c.id === id)
}

/** Longest the clip may become given its source (null = unlimited). */
export function maxDurationFor(c: Pick<Clip, 'sourceDuration' | 'inPoint'>): Micros {
  return c.sourceDuration == null ? Number.POSITIVE_INFINITY : c.sourceDuration - c.inPoint
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Lay main-track clips out back to back from 0, keeping their order. */
export function layoutMain(p: Project): void {
  const main = mainTrack(p)
  let t = 0
  for (const c of trackClips(p, main.id)) {
    c.start = t
    t += c.duration
  }
}

/** Drop transitions whose clips no longer touch; clamp durations and fades to what fits. */
export function pruneTransitions(p: Project): void {
  const byId = new Map(p.clips.map((c) => [c.id, c]))
  p.transitions = p.transitions.filter((t) => {
    const a = byId.get(t.fromClipId)
    const b = byId.get(t.toClipId)
    return !!a && !!b && a.trackId === b.trackId && Math.abs(clipEnd(a) - b.start) < 2 && t.duration > 0
  })
  // Each side of a clip's transitions may use at most half the clip.
  for (const t of p.transitions) {
    const a = byId.get(t.fromClipId)!
    const b = byId.get(t.toClipId)!
    t.duration = Math.min(t.duration, a.duration, b.duration)
  }
  for (const c of p.clips) {
    const total = c.fadeIn.duration + c.fadeOut.duration
    if (total > c.duration) {
      const k = c.duration / total
      c.fadeIn.duration = Math.floor(c.fadeIn.duration * k)
      c.fadeOut.duration = Math.floor(c.fadeOut.duration * k)
    }
  }
}

export function normalize(p: Project): void {
  layoutMain(p)
  pruneTransitions(p)
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Insertion index on the main track for a drop at `time` (nearest clip boundary). */
export function mainInsertIndex(p: Project, time: Micros, exclude?: ReadonlySet<string>): number {
  const clips = trackClips(p, mainTrack(p).id, exclude)
  let t = 0
  for (let i = 0; i < clips.length; i++) {
    const mid = t + clips[i].duration / 2
    if (time < mid) return i
    t += clips[i].duration
  }
  return clips.length
}

/** Start time of insertion boundary `index` on the main track. */
export function mainBoundaryTime(p: Project, index: number, exclude?: ReadonlySet<string>): Micros {
  const clips = trackClips(p, mainTrack(p).id, exclude)
  let t = 0
  for (let i = 0; i < Math.min(index, clips.length); i++) t += clips[i].duration
  return t
}

/** Place `clip` as the `index`-th clip of the main track (it is removed from wherever it was). */
export function insertMainAt(p: Project, clip: Clip, index: number): void {
  const main = mainTrack(p)
  const others = trackClips(p, main.id, new Set([clip.id]))
  const idx = Math.max(0, Math.min(index, others.length))
  // Give everything a temporary order key, then lay out.
  others.forEach((c, i) => (c.start = (i < idx ? i : i + 1) * 2))
  clip.trackId = main.id
  clip.start = idx * 2
  if (!p.clips.includes(clip)) p.clips.push(clip)
  normalize(p)
}

/**
 * Nearest start >= 0 where a clip of `duration` fits on a free track without overlapping,
 * preferring `desired`.
 */
export function nearestFreeStart(
  p: Project,
  trackId: string,
  desired: Micros,
  duration: Micros,
  exclude?: ReadonlySet<string>,
): Micros {
  const clips = trackClips(p, trackId, exclude)
  desired = Math.max(0, desired)
  const fits = (s: Micros) => clips.every((c) => s + duration <= c.start || s >= clipEnd(c))
  if (fits(desired)) return desired
  let best = Number.POSITIVE_INFINITY
  let bestDist = Number.POSITIVE_INFINITY
  let gapStart = 0
  const consider = (s: Micros) => {
    const d = Math.abs(s - desired)
    if (d < bestDist) {
      bestDist = d
      best = s
    }
  }
  for (const c of clips) {
    const gapEnd = c.start
    if (gapEnd - gapStart >= duration) consider(Math.min(Math.max(desired, gapStart), gapEnd - duration))
    gapStart = Math.max(gapStart, clipEnd(c))
  }
  consider(Math.max(desired, gapStart))
  return best
}

export function addClip(p: Project, clip: Clip, trackId: string, at: Micros): void {
  clip.trackId = trackId
  if (isMain(p, trackId)) {
    insertMainAt(p, clip, mainInsertIndex(p, at))
  } else {
    clip.start = nearestFreeStart(p, trackId, at, clip.duration)
    p.clips.push(clip)
    normalize(p)
  }
}

/** Move a clip to another (compatible) track and/or time. */
export function moveClip(p: Project, id: string, trackId: string, at: Micros): void {
  const c = findClip(p, id)
  if (!c) return
  // Transitions are tied to neighbours; moving breaks them.
  p.transitions = p.transitions.filter((t) => t.fromClipId !== id && t.toClipId !== id)
  if (isMain(p, trackId)) {
    const exclude = new Set([id])
    insertMainAt(p, c, mainInsertIndex(p, at, exclude))
  } else {
    c.trackId = trackId
    c.start = nearestFreeStart(p, trackId, at, c.duration, new Set([id]))
    normalize(p)
  }
}

// ---------------------------------------------------------------------------
// Trim / split / delete
// ---------------------------------------------------------------------------

export interface TrimResult {
  start: Micros
  duration: Micros
  inPoint: Micros
}

/**
 * Clamped result of dragging a clip edge by `delta` (positive = rightwards).
 * Respects source length, minimum duration, and free-track neighbours.
 */
export function trimPreview(p: Project, id: string, edge: 'start' | 'end', delta: Micros): TrimResult | null {
  const c = findClip(p, id)
  if (!c) return null
  const minDur = minClipDuration(p.settings.fps)
  const main = isMain(p, c.trackId)
  const siblings = trackClips(p, c.trackId, new Set([id]))
  const limited = c.sourceDuration != null

  if (edge === 'end') {
    let duration = c.duration + delta
    duration = Math.min(duration, maxDurationFor(c))
    if (!main) {
      const next = siblings.find((s) => s.start >= clipEnd(c) - 1)
      if (next) duration = Math.min(duration, next.start - c.start)
    }
    duration = Math.max(minDur, duration)
    return { start: c.start, duration, inPoint: c.inPoint }
  }

  // Start edge: moving right shrinks, moving left extends (needs source handle).
  let d = delta
  if (limited) d = Math.max(d, -c.inPoint)
  if (!main) {
    const prev = [...siblings].reverse().find((s) => clipEnd(s) <= c.start + 1)
    d = Math.max(d, (prev ? clipEnd(prev) : 0) - c.start)
  }
  d = Math.min(d, c.duration - minDur)
  return {
    start: main ? c.start : c.start + d,
    duration: c.duration - d,
    inPoint: limited ? c.inPoint + d : c.inPoint,
  }
}

export function trimClip(p: Project, id: string, edge: 'start' | 'end', delta: Micros): void {
  const r = trimPreview(p, id, edge, delta)
  const c = findClip(p, id)
  if (!r || !c) return
  Object.assign(c, r)
  normalize(p)
}

/** Split at `at`; returns the id of the new right-hand clip. */
export function splitClip(p: Project, id: string, at: Micros): string | null {
  const c = findClip(p, id)
  if (!c) return null
  const minDur = minClipDuration(p.settings.fps)
  if (at < c.start + minDur || at > clipEnd(c) - minDur) return null
  const left = at - c.start
  const right: Clip = clone(c)
  right.id = uid()
  right.start = at
  right.duration = c.duration - left
  right.inPoint = c.sourceDuration != null ? c.inPoint + left : c.inPoint
  right.fadeIn = { ...right.fadeIn, duration: 0 }
  c.duration = left
  c.fadeOut = { ...c.fadeOut, duration: 0 }
  p.clips.push(right)
  for (const t of p.transitions) if (t.fromClipId === id) t.fromClipId = right.id
  normalize(p)
  return right.id
}

/** Split every clip under `at` (when nothing is selected) or just the selected ones. */
export function splitAt(p: Project, at: Micros, ids?: readonly string[]): string[] {
  const targets = (ids?.length ? p.clips.filter((c) => ids.includes(c.id)) : p.clips).filter(
    (c) => at > c.start && at < clipEnd(c),
  )
  const created: string[] = []
  for (const c of targets) {
    const n = splitClip(p, c.id, at)
    if (n) created.push(n)
  }
  return created
}

export function deleteClips(p: Project, ids: readonly string[]): void {
  const set = new Set(ids)
  p.clips = p.clips.filter((c) => !set.has(c.id))
  p.transitions = p.transitions.filter((t) => !set.has(t.fromClipId) && !set.has(t.toClipId))
  normalize(p)
}

export function duplicateClip(p: Project, id: string): string | null {
  const c = findClip(p, id)
  if (!c) return null
  const copy: Clip = clone(c)
  copy.id = uid()
  if (isMain(p, c.trackId)) {
    const idx = trackClips(p, c.trackId).findIndex((x) => x.id === id)
    p.clips.push(copy)
    insertMainAt(p, copy, idx + 1)
  } else {
    copy.start = nearestFreeStart(p, c.trackId, clipEnd(c), c.duration)
    p.clips.push(copy)
  }
  return copy.id
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

export function transitionBetween(p: Project, fromId: string, toId: string): Transition | undefined {
  return p.transitions.find((t) => t.fromClipId === fromId && t.toClipId === toId)
}

/** Neighbouring (touching) clip pairs on a track. */
export function adjacentPairs(p: Project, trackId: string): [Clip, Clip][] {
  const clips = trackClips(p, trackId)
  const pairs: [Clip, Clip][] = []
  for (let i = 0; i + 1 < clips.length; i++) {
    if (Math.abs(clipEnd(clips[i]) - clips[i + 1].start) < 2) pairs.push([clips[i], clips[i + 1]])
  }
  return pairs
}

export function setTransition(p: Project, fromId: string, toId: string, duration: Micros | null): void {
  const existing = transitionBetween(p, fromId, toId)
  if (duration == null || duration <= 0) {
    p.transitions = p.transitions.filter((t) => t !== existing)
    return
  }
  if (existing) existing.duration = duration
  else p.transitions.push({ id: uid(), fromClipId: fromId, toClipId: toId, duration })
  pruneTransitions(p)
}

// ---------------------------------------------------------------------------
// Project-level
// ---------------------------------------------------------------------------

/** Change aspect/tier. Visual media is re-fitted to the new frame (the UI warns first). */
export function applyFormat(p: Project, aspect: AspectId, tier: TierId, fit: FitMode | null): void {
  const res = resolutionFor(aspect, tier)
  const aspectChanged = aspect !== p.settings.aspect
  p.settings.aspect = aspect
  p.settings.tier = res.tier
  p.settings.width = res.width
  p.settings.height = res.height
  if (aspectChanged && fit) {
    for (const c of p.clips) {
      if (c.kind === 'video' || c.kind === 'image') c.transform = { fit, x: 0, y: 0, scale: 1 }
    }
  }
}
