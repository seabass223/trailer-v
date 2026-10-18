import { describe, expect, it } from 'vitest'
import { baseClip, newProject } from '@shared/factory'
import type { Clip, Project } from '@shared/model'
import { resolutionFor } from '@shared/presets'
import {
  addClip, applyFormat, closeGaps, deleteClips, duplicateClip, insertTrack, isMain, mainTrack, moveClip, moveTrack, projectDuration,
  seamAcrossTracks, seamPlan, setTransition, splitAt, splitClip, trackClips, trackMoveRange, tracksWithGaps, trimClip, trimPreview,
} from '@shared/timeline'

const S = 1_000_000

function project(): Project {
  const r = resolutionFor('16:9', '1080p')
  return newProject('t', { aspect: '16:9', tier: '1080p', width: r.width, height: r.height, fps: 30, background: '#000000', historyDepth: 200 }, null)
}

function video(p: Project, name: string, seconds: number): Clip {
  return baseClip({
    kind: 'video', name, trackId: mainTrack(p).id, source: `C:\\m\\${name}.mp4`,
    duration: seconds * S, sourceDuration: seconds * S, hasAudio: true, mediaWidth: 1920, mediaHeight: 1080,
  })
}

const track = (p: Project, kind: string) => p.tracks.find((t) => t.kind === kind)!
const names = (p: Project) => trackClips(p, mainTrack(p).id).map((c) => `${c.name}@${c.start / S}`)

describe('magnetic main track', () => {
  it('appends and inserts at the nearest boundary, pushing later clips', () => {
    const p = project()
    addClip(p, video(p, 'a', 4), mainTrack(p).id, 0)
    addClip(p, video(p, 'b', 2), mainTrack(p).id, 100 * S)
    expect(names(p)).toEqual(['a@0', 'b@4'])
    // Drop at 1s: nearer the start of 'a' than its middle -> inserted first.
    addClip(p, video(p, 'c', 3), mainTrack(p).id, 1 * S)
    expect(names(p)).toEqual(['c@0', 'a@3', 'b@7'])
  })

  it('closes the gap on delete and ripples trims', () => {
    const p = project()
    const a = video(p, 'a', 4)
    const b = video(p, 'b', 2)
    addClip(p, a, mainTrack(p).id, 0)
    addClip(p, b, mainTrack(p).id, 10 * S)
    trimClip(p, a.id, 'end', -1 * S)
    expect(names(p)).toEqual(['a@0', 'b@3'])
    trimClip(p, a.id, 'start', 1 * S)
    expect(a.inPoint).toBe(1 * S)
    expect(names(p)).toEqual(['a@0', 'b@2'])
    deleteClips(p, [a.id])
    expect(names(p)).toEqual(['b@0'])
  })

  it('reorders when a clip is moved', () => {
    const p = project()
    const a = video(p, 'a', 2)
    const b = video(p, 'b', 2)
    addClip(p, a, mainTrack(p).id, 0)
    addClip(p, b, mainTrack(p).id, 10 * S)
    moveClip(p, a.id, mainTrack(p).id, 3.5 * S)
    expect(names(p)).toEqual(['b@0', 'a@2'])
  })
})

describe('trim limits', () => {
  it('cannot extend beyond the source or below one frame', () => {
    const p = project()
    const a = video(p, 'a', 4)
    addClip(p, a, mainTrack(p).id, 0)
    expect(trimPreview(p, a.id, 'end', 10 * S)!.duration).toBe(4 * S)
    expect(trimPreview(p, a.id, 'start', -1 * S)!.inPoint).toBe(0)
    const shrunk = trimPreview(p, a.id, 'end', -100 * S)!
    expect(shrunk.duration).toBe(Math.round(S / 30))
  })

  it('stops at free-track neighbours', () => {
    const p = project()
    const t = track(p, 'image')
    const x = baseClip({ kind: 'image', name: 'x', trackId: t.id, duration: 2 * S })
    const y = baseClip({ kind: 'image', name: 'y', trackId: t.id, duration: 2 * S })
    addClip(p, x, t.id, 0)
    addClip(p, y, t.id, 5 * S)
    expect(trimPreview(p, x.id, 'end', 10 * S)!.duration).toBe(5 * S)
    expect(trimPreview(p, y.id, 'start', -10 * S)!.start).toBe(2 * S)
  })
})

describe('free tracks', () => {
  it('snaps a colliding drop into the nearest gap that fits', () => {
    const p = project()
    const t = track(p, 'text')
    addClip(p, baseClip({ kind: 'text', name: 'a', trackId: t.id, duration: 2 * S }), t.id, 0)
    addClip(p, baseClip({ kind: 'text', name: 'b', trackId: t.id, duration: 2 * S }), t.id, 6 * S)
    const c = baseClip({ kind: 'text', name: 'c', trackId: t.id, duration: 3 * S })
    addClip(p, c, t.id, 1 * S)
    expect(c.start).toBe(2 * S) // gap [2,6) fits 3s, closest to 1s
    const d = baseClip({ kind: 'text', name: 'd', trackId: t.id, duration: 5 * S })
    addClip(p, d, t.id, 1 * S)
    expect(d.start).toBe(8 * S) // nothing fits before -> after the last clip
  })
})

describe('split', () => {
  it('splits into two clips that continue the source', () => {
    const p = project()
    const a = video(p, 'a', 6)
    addClip(p, a, mainTrack(p).id, 0)
    a.fadeOut.duration = S
    const id = splitClip(p, a.id, 2 * S)!
    const b = p.clips.find((c) => c.id === id)!
    expect(a.duration).toBe(2 * S)
    expect(b.start).toBe(2 * S)
    expect(b.inPoint).toBe(2 * S)
    expect(b.duration).toBe(4 * S)
    expect(a.fadeOut.duration).toBe(0)
    expect(b.fadeOut.duration).toBe(S)
    expect(projectDuration(p)).toBe(6 * S)
  })

  it('splitAt with no selection cuts every clip under the playhead', () => {
    const p = project()
    addClip(p, video(p, 'a', 6), mainTrack(p).id, 0)
    const t = track(p, 'text')
    addClip(p, baseClip({ kind: 'text', name: 'x', trackId: t.id, duration: 4 * S }), t.id, 1 * S)
    expect(splitAt(p, 3 * S)).toHaveLength(2)
    expect(p.clips).toHaveLength(4)
  })
})

describe('transitions', () => {
  it('are clamped to the shorter clip and removed when clips stop touching', () => {
    const p = project()
    const a = video(p, 'a', 4)
    const b = video(p, 'b', 1)
    addClip(p, a, mainTrack(p).id, 0)
    addClip(p, b, mainTrack(p).id, 10 * S)
    setTransition(p, a.id, b.id, 3 * S)
    expect(p.transitions[0].duration).toBe(1 * S)
    deleteClips(p, [b.id])
    expect(p.transitions).toHaveLength(0)
  })

  it('moves to the right half when the outgoing clip is split', () => {
    const p = project()
    const a = video(p, 'a', 4)
    const b = video(p, 'b', 4)
    addClip(p, a, mainTrack(p).id, 0)
    addClip(p, b, mainTrack(p).id, 10 * S)
    setTransition(p, a.id, b.id, S)
    const right = splitClip(p, a.id, 1 * S)!
    expect(p.transitions[0].fromClipId).toBe(right)
  })
})

describe('extra video tracks', () => {
  it('stack above the main track, which stays the magnetic bottom video row', () => {
    const p = project()
    const main = mainTrack(p)
    const v2 = insertTrack(p, 'video')
    const v3 = insertTrack(p, 'video')
    expect(p.tracks.map((t) => t.name)).toEqual(['Video 3', 'Video 2', 'Video', 'Text', 'Image', 'Audio'])
    expect(mainTrack(p)).toBe(main)
    expect(isMain(p, v2.id) || isMain(p, v3.id)).toBe(false)
  })

  it('reorder freely, but the main track stays the bottom video row', () => {
    const p = project()
    const main = mainTrack(p)
    const v2 = insertTrack(p, 'video')
    const order = () => p.tracks.map((t) => t.name)
    // ['Video 2', 'Video', 'Text', 'Image', 'Audio']
    expect(moveTrack(p, p.tracks[4].id, 0)).toBe(true)
    expect(order()).toEqual(['Audio', 'Video 2', 'Video', 'Text', 'Image'])
    // An upper video track can't drop below the main one: it clamps to just above it.
    expect(moveTrack(p, v2.id, 4)).toBe(false)
    expect(trackMoveRange(p, v2.id)).toEqual([0, 1])
    // The main track can't rise above another video track, but can go to the bottom.
    expect(trackMoveRange(p, main.id)).toEqual([2, 4])
    expect(moveTrack(p, main.id, 0)).toBe(false)
    expect(moveTrack(p, main.id, 4)).toBe(true)
    expect(order()).toEqual(['Audio', 'Video 2', 'Text', 'Image', 'Video'])
    expect(mainTrack(p)).toBe(main)
    expect(moveTrack(p, 'nope', 0)).toBe(false)
  })

  it('names new tracks uniquely and places other kinds after their own kind', () => {
    const p = project()
    const v2 = insertTrack(p, 'video')
    insertTrack(p, 'video')
    p.tracks = p.tracks.filter((t) => t !== v2)
    expect(insertTrack(p, 'video').name).toBe('Video 4') // 'Video 3' is still taken
    const t2 = insertTrack(p, 'text')
    expect(p.tracks[p.tracks.indexOf(t2) - 1].name).toBe('Text')
  })

  it('are free placement: clips may overlap the main track and moves never ripple', () => {
    const p = project()
    const main = mainTrack(p).id
    const v2 = insertTrack(p, 'video').id
    const a = video(p, 'a', 4)
    const b = video(p, 'b', 4)
    addClip(p, a, main, 0)
    addClip(p, b, main, 10 * S)
    const r = video(p, 'r', 2)
    addClip(p, r, v2, 5 * S)
    expect(r.start).toBe(5 * S)
    expect(names(p)).toEqual(['a@0', 'b@4'])
    // A second clip colliding on the same upper track lands in the nearest gap.
    const r2 = video(p, 'r2', 2)
    addClip(p, r2, v2, 6 * S)
    expect(r2.start).toBe(7 * S)
    // Main -> upper track: the main track closes the gap, the clip keeps its time.
    moveClip(p, a.id, v2, 0)
    expect(a.trackId).toBe(v2)
    expect(a.start).toBe(0) // fits before r
    expect(names(p)).toEqual(['b@0'])
    // Upper -> main: inserted magnetically.
    moveClip(p, r.id, main, 5 * S)
    expect(names(p)).toEqual(['b@0', 'r@4'])
  })

  it('trim against their own neighbours and duplicate into free space', () => {
    const p = project()
    const v2 = insertTrack(p, 'video').id
    const a = video(p, 'a', 6)
    const b = video(p, 'b', 2)
    addClip(p, a, v2, 0)
    addClip(p, b, v2, 8 * S)
    expect(trimPreview(p, a.id, 'end', 0)!.duration).toBe(6 * S)
    trimClip(p, a.id, 'end', -2 * S)
    expect(a.duration).toBe(4 * S)
    expect(b.start).toBe(8 * S) // no ripple
    const id = duplicateClip(p, b.id)
    const copy = p.clips.find((c) => c.id === id)!
    expect(copy.trackId).toBe(v2)
    expect(copy.start).toBe(10 * S)
  })
})

describe('close gaps', () => {
  it('butts clips together after the first one and keeps transitions between touching clips', () => {
    const p = project()
    const v2 = insertTrack(p, 'video').id
    const a = video(p, 'a', 2)
    const b = video(p, 'b', 3)
    const c = video(p, 'c', 4)
    const d = video(p, 'd', 1)
    addClip(p, a, v2, 1 * S) // leading space before the first clip is kept
    addClip(p, b, v2, 5 * S)
    addClip(p, c, v2, 8 * S) // touches b
    addClip(p, d, v2, 20 * S)
    setTransition(p, b.id, c.id, S)
    expect(tracksWithGaps(p).map((t) => t.id)).toEqual([v2])

    expect(closeGaps(p)).toBe(2)
    expect(trackClips(p, v2).map((x) => [x.name, x.start / S])).toEqual([['a', 1], ['b', 3], ['c', 6], ['d', 10]])
    expect(p.transitions).toHaveLength(1)
    expect(p.transitions[0]).toMatchObject({ fromClipId: b.id, toClipId: c.id, duration: S })
    expect(tracksWithGaps(p)).toEqual([])
    expect(closeGaps(p)).toBe(0)
  })

  it('only touches video tracks (or the given track)', () => {
    const p = project()
    const v2 = insertTrack(p, 'video').id
    const v3 = insertTrack(p, 'video').id
    const text = track(p, 'text')
    for (const [t, at] of [[v2, 0], [v2, 10], [v3, 0], [v3, 10]] as const) addClip(p, video(p, `x${at}`, 2), t, at * S)
    const t1 = baseClip({ kind: 'text', name: 't', trackId: text.id, duration: S })
    const t2 = baseClip({ kind: 'text', name: 'u', trackId: text.id, duration: S })
    addClip(p, t1, text.id, 0)
    addClip(p, t2, text.id, 6 * S)

    expect(closeGaps(p, 'video', [v2])).toBe(1)
    expect(trackClips(p, v2).map((x) => x.start / S)).toEqual([0, 2])
    expect(trackClips(p, v3).map((x) => x.start / S)).toEqual([0, 10])
    expect(closeGaps(p)).toBe(1)
    expect(trackClips(p, v3).map((x) => x.start / S)).toEqual([0, 2])
    expect(t2.start).toBe(6 * S) // text track untouched
  })
})

describe('seam across tracks', () => {
  // insertTrack puts each new video track on top, so the last one inserted is the top row.
  function stack() {
    const p = project()
    const low = insertTrack(p, 'video').id
    const mid = insertTrack(p, 'video').id
    const top = insertTrack(p, 'video').id
    return { p, top, mid, low, main: mainTrack(p).id }
  }

  it('chains selected clips top row first, each on its own track, from the earliest start', () => {
    const { p, top, mid, low, main } = stack()
    const a = video(p, 'a', 2)
    const b = video(p, 'b', 3)
    const c = video(p, 'c', 1)
    const m = video(p, 'm', 4)
    addClip(p, a, top, 10 * S)
    addClip(p, b, mid, 1 * S)
    addClip(p, c, low, 5 * S)
    addClip(p, m, main, 0)
    const text = track(p, 'text')
    const t = baseClip({ kind: 'text', name: 't', trackId: text.id, duration: S })
    addClip(p, t, text.id, 20 * S)

    const plan = seamPlan(p, p.clips.map((x) => x.id)) // Ctrl+A
    expect(plan.clips.map((x) => x.name)).toEqual(['a', 'b', 'c'])
    expect([plan.tracks, plan.skippedMain, plan.detoured]).toEqual([3, 1, 0])

    expect(seamAcrossTracks(p, p.clips.map((x) => x.id))).toBe(3)
    expect([a, b, c].map((x) => [x.trackId, x.start / S])).toEqual([[top, 1], [mid, 3], [low, 6]])
    expect(m.start).toBe(0) // main track stays put
    expect(t.start).toBe(20 * S) // non-video untouched
    expect(seamPlan(p, [a.id, b.id, c.id]).moves.size).toBe(0) // already seamed
  })

  it('keeps cross-fades between selected clips on the same track', () => {
    const { p, top, mid } = stack()
    const a = video(p, 'a', 2)
    const b = video(p, 'b', 2)
    const c = video(p, 'c', 2)
    addClip(p, a, top, 0)
    addClip(p, b, top, 2 * S)
    setTransition(p, a.id, b.id, S)
    addClip(p, c, mid, 30 * S)
    seamAcrossTracks(p, [a.id, b.id, c.id])
    expect(c.start).toBe(4 * S)
    expect(p.transitions).toHaveLength(1)
  })

  it('goes past an unselected clip in the way instead of refusing, never moving it', () => {
    const { p, top, mid } = stack()
    const a = video(p, 'a', 4)
    const b = video(p, 'b', 2)
    const x = video(p, 'x', 2)
    addClip(p, a, top, 0)
    addClip(p, b, mid, 20 * S)
    addClip(p, x, mid, 5 * S) // b would land at 4-6, on top of x
    expect(seamPlan(p, [a.id, b.id]).detoured).toBe(1)
    expect(seamAcrossTracks(p, [a.id, b.id])).toBe(1)
    expect([a.start, x.start, b.start]).toEqual([0, 5 * S, 7 * S]) // up against x
  })

  it('works on any partial selection; unselected clips stay put', () => {
    const { p, top, mid } = stack()
    // Two "sections" on two tracks; only the second section is selected.
    const [a1, a2, b1, b2] = [video(p, 'a1', 2), video(p, 'a2', 2), video(p, 'b1', 2), video(p, 'b2', 2)]
    addClip(p, a1, top, 0)
    addClip(p, b1, mid, 3 * S)
    addClip(p, a2, top, 10 * S)
    addClip(p, b2, mid, 20 * S)
    expect(seamAcrossTracks(p, [a2.id, b2.id])).toBe(1)
    expect([a1, b1, a2, b2].map((c) => c.start / S)).toEqual([0, 3, 10, 12])
    // Selecting across the sections chains them all, still without touching anything else.
    const c = video(p, 'c', 1)
    addClip(p, c, mid, 30 * S)
    expect(seamAcrossTracks(p, [a1.id, b1.id, b2.id])).toBe(2)
    expect([a1, b1, b2, a2, c].map((x) => x.start / S)).toEqual([0, 2, 4, 10, 30])
  })

  it('closes the gap before a single selected clip on its own track', () => {
    const { p, mid } = stack()
    const [a, b, c] = [video(p, 'a', 2), video(p, 'b', 2), video(p, 'c', 2)]
    addClip(p, a, mid, 1 * S)
    addClip(p, b, mid, 5 * S)
    addClip(p, c, mid, 10 * S)
    expect(seamPlan(p, [a.id]).moves.size).toBe(0) // space before a track's first clip stays
    expect(seamAcrossTracks(p, [c.id])).toBe(1)
    expect([a, b, c].map((x) => x.start / S)).toEqual([1, 5, 7])
    expect(seamAcrossTracks(p, [b.id])).toBe(1)
    expect([a, b, c].map((x) => x.start / S)).toEqual([1, 3, 7])
    // A selected main-track clip alongside doesn't count: still a single upper-track clip.
    const m = video(p, 'm', 4)
    addClip(p, m, mainTrack(p).id, 0)
    expect(seamAcrossTracks(p, [c.id, m.id])).toBe(1)
    expect(c.start).toBe(5 * S)
  })
})

describe('format change', () => {
  it('re-fits visual media and updates resolution', () => {
    const p = project()
    const a = video(p, 'a', 4)
    addClip(p, a, mainTrack(p).id, 0)
    a.transform = { fit: 'cover', x: 0.2, y: 0.1, scale: 1.5 }
    applyFormat(p, '9:16', '1080p', 'contain')
    expect(p.settings.width).toBe(1080)
    expect(p.settings.height).toBe(1920)
    expect(a.transform).toEqual({ fit: 'contain', x: 0, y: 0, scale: 1 })
  })
})
