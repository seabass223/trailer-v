/**
 * Pure timeline operations. They mutate the given project (an Immer draft in the app,
 * a plain object in tests). The main video track is magnetic: its clips are always
 * contiguous from 0. Other tracks (extra video tracks included) are free placement with
 * no overlaps.
 */
import type { AspectId, Clip, FitMode, Micros, Project, TierId, Track, TrackKind, Transition } from './model'
import { newTrack, TRACK_LABELS, uid } from './factory'
import { resolutionFor } from './presets'
import { frameDuration } from './time'

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T

export const minClipDuration = (fps: number): Micros => frameDuration(fps)

/** The magnetic track: the bottom video row (extra video tracks are added above it). */
export function mainTrack(p: Project): Track {
  const t = p.tracks.findLast((t) => t.kind === 'video')
  if (!t) throw new Error('Project has no video track')
  return t
}

export const isMain = (p: Project, trackId: string): boolean => mainTrack(p).id === trackId

/**
 * Add an empty track. Video tracks go above the topmost video row (upper rows draw on top,
 * and the main track stays the bottom one); other kinds go after the last of their kind.
 */
export function insertTrack(p: Project, kind: TrackKind): Track {
  const names = new Set(p.tracks.map((t) => t.name))
  let n = p.tracks.filter((t) => t.kind === kind).length + 1
  while (names.has(`${TRACK_LABELS[kind]} ${n}`)) n++
  const t = newTrack(kind, `${TRACK_LABELS[kind]} ${n}`)
  const at = kind === 'video' ? p.tracks.findIndex((x) => x.kind === 'video') : p.tracks.findLastIndex((x) => x.kind === kind) + 1
  p.tracks.splice(Math.max(0, at), 0, t)
  return t
}

/**
 * Rows (final indexes) a track may move to. The main track has to stay the bottom video row,
 * so other video tracks stay above it and it stays below them; every other kind is free.
 */
export function trackMoveRange(p: Project, trackId: string): [number, number] | null {
  const idx = p.tracks.findIndex((t) => t.id === trackId)
  if (idx < 0) return null
  const last = p.tracks.length - 1
  const t = p.tracks[idx]
  if (t.kind !== 'video') return [0, last]
  const main = p.tracks.indexOf(mainTrack(p))
  if (idx !== main) return [0, main - 1]
  const above = p.tracks.findLastIndex((x, i) => i !== idx && x.kind === 'video')
  return [above + 1, last]
}

/** Move a track to final index `to` (clamped to its allowed range). Returns whether it moved. */
export function moveTrack(p: Project, trackId: string, to: number): boolean {
  const range = trackMoveRange(p, trackId)
  if (!range) return false
  const idx = p.tracks.findIndex((t) => t.id === trackId)
  const dest = Math.max(range[0], Math.min(range[1], to))
  if (dest === idx) return false
  const [t] = p.tracks.splice(idx, 1)
  p.tracks.splice(dest, 0, t)
  return true
}

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

/**
 * Give a clip a trimmed extent. Volume keys stay on the same source moment: a head trim
 * shifts them by the in-point change (keys outside the clip are kept for trimming back).
 */
export function applyTrim(c: Clip, r: TrimResult): void {
  const shift = r.inPoint - c.inPoint
  if (shift && c.volumeKeys?.length) c.volumeKeys = c.volumeKeys.map((k) => ({ t: k.t - shift, gain: k.gain }))
  Object.assign(c, r)
}

export function trimClip(p: Project, id: string, edge: 'start' | 'end', delta: Micros): void {
  const r = trimPreview(p, id, edge, delta)
  const c = findClip(p, id)
  if (!r || !c) return
  applyTrim(c, r)
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
  // Both halves keep the whole envelope (re-based on the right), so neither changes shape
  // and either can be trimmed back out over the other's keys.
  if (right.volumeKeys) right.volumeKeys = right.volumeKeys.map((k) => ({ t: k.t - left, gain: k.gain }))
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
// Gaps
// ---------------------------------------------------------------------------

const hasGap = (clips: Clip[]): boolean => clips.some((c, i) => i > 0 && c.start - clipEnd(clips[i - 1]) > 1)

/** Tracks of `kind` with dead space between clips (the magnetic main track never has any). */
export function tracksWithGaps(p: Project, kind: TrackKind = 'video'): Track[] {
  return p.tracks.filter((t) => t.kind === kind && hasGap(trackClips(p, t.id)))
}

/**
 * Butt clips together. On each track of `kind` (or just `trackIds`), the first clip stays put
 * and every later clip moves left to start where the previous one ends. Clips that already
 * touch move as a unit, so their transitions stay intact. Returns how many gaps were closed.
 */
export function closeGaps(p: Project, kind: TrackKind = 'video', trackIds?: readonly string[]): number {
  let closed = 0
  for (const t of p.tracks) {
    if (t.kind !== kind || (trackIds && !trackIds.includes(t.id))) continue
    const clips = trackClips(p, t.id)
    let prevEnd = clips.length ? clipEnd(clips[0]) : 0 // original layout, to count real gaps
    for (let i = 1; i < clips.length; i++) {
      if (clips[i].start - prevEnd > 1) closed++
      prevEnd = clipEnd(clips[i])
      const end = clipEnd(clips[i - 1])
      if (clips[i].start !== end) clips[i].start = end
    }
  }
  if (closed) normalize(p)
  return closed
}

export interface SeamPlan {
  /** New start per clip id (only clips that will actually move). */
  moves: Map<string, Micros>
  /** Video clips that take part (non-main), in seam order. */
  clips: Clip[]
  tracks: number
  /** Selected main-track clips: magnetic, so they stay where they are. */
  skippedMain: number
  /** Clips that had to go past an unselected clip in their way. */
  detoured: number
}

/** First start >= `from` where `duration` fits between the (disjoint) `taken` intervals. */
function firstFreeFrom(taken: [Micros, Micros][], from: Micros, duration: Micros): Micros {
  let s = from
  for (const [a, b] of [...taken].sort((x, y) => x[0] - y[0])) {
    if (b <= s) continue
    if (a >= s + duration) break
    s = b
  }
  return s
}

/**
 * Plan a seam for any selection. Selected video clips (non-main) are laid end to end in
 * vertical track order (top row first; within a track, by time), each staying on its own
 * track, from where the earliest of them starts. Unselected clips never move: a selected clip
 * that would land on one goes to the first free spot after it instead. A single selected clip
 * closes the gap before it on its track. Pure: nothing is changed.
 */
export function seamPlan(p: Project, ids: readonly string[]): SeamPlan {
  const set = new Set(ids)
  const main = mainTrack(p)
  const row = new Map(p.tracks.map((t, i) => [t.id, i]))
  const video = p.clips.filter((c) => set.has(c.id) && p.tracks[row.get(c.trackId)!]?.kind === 'video')
  const clips = video.filter((c) => c.trackId !== main.id).sort((a, b) => row.get(a.trackId)! - row.get(b.trackId)! || a.start - b.start)
  const plan: SeamPlan = { moves: new Map(), clips, tracks: new Set(clips.map((c) => c.trackId)).size, skippedMain: video.length - clips.length, detoured: 0 }
  if (!clips.length) return plan
  // What each track already holds that won't move: its unselected clips.
  const taken = new Map<string, [Micros, Micros][]>()
  for (const c of clips) {
    if (!taken.has(c.trackId)) {
      taken.set(c.trackId, p.clips.filter((o) => o.trackId === c.trackId && !set.has(o.id)).map((o) => [o.start, clipEnd(o)]))
    }
  }
  let cursor = Math.min(...clips.map((c) => c.start))
  if (clips.length === 1) {
    // Up against the clip before it; space before a track's first clip stays, as in closeGaps.
    const before = taken.get(clips[0].trackId)!.map(([, e]) => e).filter((e) => e <= clips[0].start)
    if (before.length) cursor = Math.max(...before)
  }
  for (const c of clips) {
    const track = taken.get(c.trackId)!
    const s = firstFreeFrom(track, cursor, c.duration)
    if (s !== cursor) plan.detoured++
    track.push([s, s + c.duration])
    if (s !== c.start) plan.moves.set(c.id, s)
    cursor = s + c.duration
  }
  return plan
}

/** Apply a seam plan (see seamPlan). Returns the number of clips moved. */
export function seamAcrossTracks(p: Project, ids: readonly string[]): number {
  const plan = seamPlan(p, ids)
  if (!plan.moves.size) return 0
  for (const c of p.clips) {
    const to = plan.moves.get(c.id)
    if (to != null) c.start = to
  }
  normalize(p)
  return plan.moves.size
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
