import { describe, expect, it } from 'vitest'
import { baseClip, newProject } from '@shared/factory'
import type { Clip, Project } from '@shared/model'
import { resolutionFor } from '@shared/presets'
import {
  addClip, applyFormat, deleteClips, mainTrack, moveClip, projectDuration, setTransition, splitAt, splitClip,
  trackClips, trimClip, trimPreview,
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
