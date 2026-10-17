import { describe, expect, it } from 'vitest'
import { baseClip, newProject } from '@shared/factory'
import type { Project } from '@shared/model'
import { compileSegments, mix, SAMPLE_RATE, type PcmSource } from '@shared/mixer'
import { audioPlan, framePlan, videoChangesBetween } from '@shared/render-plan'
import { addClip, insertTrack, mainTrack, setTransition } from '@shared/timeline'

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

describe('stacked video tracks', () => {
  const vid = (trackId: string, name: string, seconds: number) =>
    baseClip({ kind: 'video', name, trackId, source: name, duration: seconds * S, sourceDuration: seconds * S, hasAudio: true })

  /** Main: a [0,10). V2: b [2,5). V3: c [4,6). */
  function stacked() {
    const p = project()
    const main = mainTrack(p).id
    const v2 = insertTrack(p, 'video')
    const v3 = insertTrack(p, 'video')
    const a = vid(main, 'a', 10)
    const b = vid(v2.id, 'b', 3)
    const c = vid(v3.id, 'c', 2)
    addClip(p, a, main, 0)
    addClip(p, b, v2.id, 2 * S)
    addClip(p, c, v3.id, 4 * S)
    return { p, a, b, c, v2, v3 }
  }
  const shown = (p: Project, sec: number) => framePlan(p, sec * S).base.map((l) => l.clip.name)

  it('shows only the topmost video track with a clip at that time', () => {
    const { p } = stacked()
    expect(shown(p, 1)).toEqual(['a'])
    expect(shown(p, 3)).toEqual(['b'])
    expect(shown(p, 4.5)).toEqual(['c'])
    expect(shown(p, 5.5)).toEqual(['c'])
    expect(shown(p, 7)).toEqual(['a'])
    // The covered clip comes back mid-clip at the right source time.
    expect(framePlan(p, 7 * S).base[0].sourceTime).toBe(7 * S)
  })

  it('covers lower tracks even when the top clip is scaled down', () => {
    const { p, b } = stacked()
    b.transform = { fit: 'contain', x: 0.2, y: 0, scale: 0.4 }
    expect(shown(p, 3)).toEqual(['b'])
  })

  it('skips hidden video tracks', () => {
    const { p, v2, v3 } = stacked()
    v3.hidden = true
    expect(shown(p, 4.5)).toEqual(['b'])
    v2.hidden = true
    expect(shown(p, 4.5)).toEqual(['a'])
  })

  it('keeps overlays above whichever video is shown', () => {
    const { p } = stacked()
    const text = p.tracks.find((t) => t.kind === 'text')!
    addClip(p, baseClip({ kind: 'text', name: 't', trackId: text.id, duration: 10 * S }), text.id, 0)
    const plan = framePlan(p, 3 * S)
    expect(plan.base.map((l) => l.clip.name)).toEqual(['b'])
    expect(plan.overlays.map((l) => l.clip.name)).toEqual(['t'])
  })

  it('cross-fades within an upper video track like the main one', () => {
    const { p, b, v2, v3 } = stacked()
    const d = vid(v2.id, 'd', 2)
    addClip(p, d, v2.id, 5 * S)
    setTransition(p, b.id, d.id, 1 * S)
    v3.hidden = true
    const mid = framePlan(p, 5 * S)
    expect(mid.base.map((l) => l.clip.name)).toEqual(['b', 'd'])
    expect(mid.base[1].opacity).toBeCloseTo(0.5)
    expect(mid.dip).toBeNull()
  })

  /** Effective share of each drawn layer, from the chain of mixes the compositor applies. */
  const shares = (plan: ReturnType<typeof framePlan>) => {
    let out: Record<string, number> = {}
    for (const l of plan.base) {
      out = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v * (1 - l.opacity)]))
      out[l.clip.name] = (out[l.clip.name] ?? 0) + l.opacity
    }
    const k = 1 - (plan.dip?.alpha ?? 0)
    return Object.fromEntries(Object.entries(out).map(([n, v]) => [n, Math.round(v * k * 1000) / 1000]))
  }

  it('dissolves a fading upper clip into the video below instead of dipping to colour', () => {
    const { p, b, v3 } = stacked()
    v3.hidden = true
    b.fadeIn = { duration: 1 * S, color: '#ff0000' }
    b.fadeOut = { duration: 1 * S, color: '#ff0000' }
    // Fade-in: from the main video into b.
    let plan = framePlan(p, 2.25 * S)
    expect(plan.dip).toBeNull()
    expect(plan.base.map((l) => l.clip.name)).toEqual(['a', 'b'])
    expect(shares(plan)).toEqual({ a: 0.75, b: 0.25 })
    expect(plan.base[0].sourceTime).toBe(2.25 * S) // the main clip carries on underneath
    // Fully shown in between: the main clip is covered again.
    plan = framePlan(p, 3 * S)
    expect(plan.base.map((l) => l.clip.name)).toEqual(['b'])
    expect(plan.standby).toEqual([])
    // Fade-out: back to the main video.
    expect(shares(framePlan(p, 4.5 * S))).toEqual({ a: 0.5, b: 0.5 })
  })

  it('keeps the video below decoded from the first instant of a fade-out', () => {
    const { p, b, v3 } = stacked()
    v3.hidden = true
    b.fadeOut = { duration: 1 * S, color: '#000000' }
    const plan = framePlan(p, 4 * S)
    expect(plan.base.map((l) => l.clip.name)).toEqual(['b'])
    expect(plan.standby.map((l) => l.clip.name)).toEqual(['a'])
    expect(videoChangesBetween(p, 3 * S, 4.5 * S)).toEqual([4 * S])
  })

  it('dips to the fade colour where nothing is below', () => {
    const { p, v2 } = stacked()
    const e = vid(v2.id, 'e', 2)
    addClip(p, e, v2.id, 12 * S) // the main track ends at 10 s
    e.fadeOut = { duration: 1 * S, color: '#ff0000' }
    const plan = framePlan(p, 13.5 * S)
    expect(plan.base.map((l) => l.clip.name)).toEqual(['e'])
    expect(plan.dip).toEqual({ color: '#ff0000', alpha: 0.5 })
  })

  it('dissolves past hidden tracks, and stacks fades on several tracks', () => {
    const { p, b, c, v2 } = stacked()
    c.fadeIn = { duration: 1 * S, color: '#000000' } // c: [4,6), fading in over [4,5)
    // b is on a hidden track: c dissolves straight into the main video.
    v2.hidden = true
    expect(shares(framePlan(p, 4.5 * S))).toEqual({ a: 0.5, c: 0.5 })
    // Both upper clips fading at once: c into b, and b into a.
    v2.hidden = false
    b.fadeOut = { duration: 1 * S, color: '#000000' } // b: [2,5), fading out over [4,5)
    expect(shares(framePlan(p, 4.5 * S))).toEqual({ a: 0.25, b: 0.25, c: 0.5 })
    // Nothing below the main clip: its own fade still dips to colour.
    const a = p.clips.find((x) => x.name === 'a')!
    a.fadeIn = { duration: 2 * S, color: '#ffffff' }
    expect(framePlan(p, 0.5 * S).dip).toEqual({ color: '#ffffff', alpha: 0.75 })
  })

  it('reports where the shown video can change, for decoder pre-roll', () => {
    const { p, b, v3 } = stacked()
    expect(videoChangesBetween(p, 0, 10 * S)).toEqual([2 * S, 4 * S, 5 * S, 6 * S])
    expect(videoChangesBetween(p, 4 * S, 5.5 * S)).toEqual([5 * S])
    v3.hidden = true
    expect(videoChangesBetween(p, 0, 10 * S)).toEqual([2 * S, 5 * S])
    b.fadeIn = { duration: 0.5 * S, color: '#000000' }
    b.fadeOut = { duration: 1 * S, color: '#000000' }
    expect(videoChangesBetween(p, 0, 10 * S)).toEqual([2 * S, 2.5 * S, 4 * S, 5 * S])
  })

  it('keeps covered clips audible', () => {
    const { p } = stacked()
    expect(audioPlan(p).map((s) => s.clipId).length).toBe(3)
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
