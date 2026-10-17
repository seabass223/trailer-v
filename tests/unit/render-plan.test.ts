import { describe, expect, it } from 'vitest'
import { baseClip, newProject } from '@shared/factory'
import type { Project } from '@shared/model'
import { compileSegments, mix, SAMPLE_RATE, type PcmSource } from '@shared/mixer'
import { audioPlan, framePlan } from '@shared/render-plan'
import { addClip, mainTrack, setTransition } from '@shared/timeline'

const S = 1_000_000

function project(): Project {
  return newProject('t', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, null)
}

function twoClipsWithXfade() {
  const p = project()
  const main = mainTrack(p).id
  const a = baseClip({ kind: 'video', name: 'a', trackId: main, source: 'a', duration: 4 * S, sourceDuration: 4 * S, hasAudio: true })
  const b = baseClip({ kind: 'video', name: 'b', trackId: main, source: 'b', duration: 4 * S, sourceDuration: 4 * S, hasAudio: true })
  addClip(p, a, main, 0)
  addClip(p, b, main, 10 * S)
  setTransition(p, a.id, b.id, 2 * S)
  return { p, a, b }
}

describe('framePlan', () => {
  it('cross-fades centred on the cut, freezing edge frames when out of handles', () => {
    const { p, a, b } = twoClipsWithXfade()
    const before = framePlan(p, 2.5 * S)
    expect(before.base).toHaveLength(1)
    const mid = framePlan(p, 4 * S)
    expect(mid.base.map((l) => l.clip.id)).toEqual([a.id, b.id])
    expect(mid.base[1].opacity).toBeCloseTo(0.5)
    // Outgoing clip has no source past 4s: frozen just inside the end.
    const late = framePlan(p, 4.9 * S)
    expect(late.base[0].sourceTime).toBeLessThan(4 * S)
    // Incoming clip before its start shows its first frame.
    expect(framePlan(p, 3.2 * S).base[1].sourceTime).toBe(0)
  })

  it('dips to colour on main-track fades and fades overlays to transparent', () => {
    const p = project()
    const main = mainTrack(p).id
    const a = baseClip({ kind: 'video', name: 'a', trackId: main, source: 'a', duration: 4 * S, sourceDuration: 4 * S })
    a.fadeIn = { duration: 1 * S, color: '#ffffff' }
    addClip(p, a, main, 0)
    const text = p.tracks.find((t) => t.kind === 'text')!
    const t = baseClip({ kind: 'text', name: 't', trackId: text.id, duration: 2 * S })
    t.fadeOut = { duration: 1 * S, color: '#000000' }
    addClip(p, t, text.id, 0)
    const plan = framePlan(p, 0.25 * S)
    expect(plan.dip).toEqual({ color: '#ffffff', alpha: 0.75 })
    expect(framePlan(p, 1.5 * S).overlays[0].opacity).toBeCloseTo(0.5)
  })

  it('skips hidden tracks and orders overlays above the main track', () => {
    const p = project()
    const image = p.tracks.find((t) => t.kind === 'image')!
    const text = p.tracks.find((t) => t.kind === 'text')!
    addClip(p, baseClip({ kind: 'image', name: 'i', trackId: image.id, duration: S }), image.id, 0)
    addClip(p, baseClip({ kind: 'text', name: 't', trackId: text.id, duration: S }), text.id, 0)
    expect(framePlan(p, 0.5 * S).overlays.map((l) => l.clip.kind)).toEqual(['image', 'text'])
    image.hidden = true
    expect(framePlan(p, 0.5 * S).overlays.map((l) => l.clip.kind)).toEqual(['text'])
  })
})

describe('mixer', () => {
  const dc = (frames: number): PcmSource => {
    const data = new Int16Array(frames * 2).fill(16384) // 0.5
    return { data, frames }
  }

  it('applies gain and equal-power cross-fade (constant power at the midpoint)', () => {
    const { p } = twoClipsWithXfade()
    p.clips[0].volume = 1
    const segs = compileSegments(audioPlan(p))
    // Sources longer than the clips so both sides have audio handles across the cut.
    const sources = new Map([['a', dc(10 * SAMPLE_RATE)], ['b', dc(10 * SAMPLE_RATE)]])
    const L = new Float32Array(128)
    const R = new Float32Array(128)
    // Well before the transition: only clip a at 0.5.
    mix(L, R, 1 * SAMPLE_RATE, 128, segs, sources)
    expect(L[0]).toBeCloseTo(0.5, 3)
    // Midpoint of the cross-fade: 0.5*(cos45 + sin45) ~= 0.707
    mix(L, R, 4 * SAMPLE_RATE, 1, segs, sources)
    expect(L[0]).toBeCloseTo(0.5 * Math.SQRT2, 2)
  })

  it('outputs silence past the source end', () => {
    const p = project()
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    addClip(p, baseClip({ kind: 'audio', name: 'm', trackId: audio.id, source: 'm', duration: S, sourceDuration: S }), audio.id, 0)
    const segs = compileSegments(audioPlan(p))
    const sources = new Map([['m', dc(SAMPLE_RATE / 2)]])
    const L = new Float32Array(16)
    const R = new Float32Array(16)
    mix(L, R, SAMPLE_RATE * 0.75, 16, segs, sources)
    expect(Math.max(...L)).toBe(0)
  })
})
