/** Clip mute, volume envelopes and ducking: render plan, shared mixer and timeline edits. */
import { describe, expect, it } from 'vitest'
import { dbToGain, DEFAULT_DUCK, envelopeAt, gainToDb, keyGainAt } from '@shared/envelope'
import { baseClip, newProject } from '@shared/factory'
import type { Clip, Project, VolumeKey } from '@shared/model'
import { compileSegments, gainAt, mix, SAMPLE_RATE, type PcmSource } from '@shared/mixer'
import { audioPlan } from '@shared/render-plan'
import { addClip, duplicateClip, findClip, insertTrack, mainTrack, splitClip, trimClip } from '@shared/timeline'

const S = 1_000_000
const fr = (us: number) => Math.round((us * SAMPLE_RATE) / S)

function project(): Project {
  return newProject('t', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, null)
}

const dc = (frames: number): PcmSource => ({ data: new Int16Array(frames * 2).fill(16384), frames }) // 0.5

const video = (trackId: string, source: string, duration: number, hasAudio = true) =>
  baseClip({ kind: 'video', name: source, trackId, source, duration, sourceDuration: 60 * S, hasAudio })
const music = (trackId: string, duration: number) =>
  baseClip({ kind: 'audio', name: 'music', trackId, source: 'music', duration, sourceDuration: 60 * S, hasAudio: true })

/** Mixed level of the left channel at timeline time `us`. */
function levelAt(p: Project, us: number, sources: Map<string, PcmSource>): number {
  const L = new Float32Array(1)
  const R = new Float32Array(1)
  mix(L, R, fr(us), 1, compileSegments(audioPlan(p)), sources)
  return L[0]
}

/** Gain the mixer applies to `clipId` at timeline time `us`. */
function segGain(p: Project, clipId: string, us: number): number {
  const plan = audioPlan(p)
  const i = plan.findIndex((s) => s.clipId === clipId)
  if (i < 0) return 0
  return gainAt(compileSegments(plan)[i], fr(us))
}

describe('clip mute', () => {
  it('drops a muted clip from the audio plan, keeping its volume for un-muting', () => {
    const p = project()
    const main = mainTrack(p).id
    const v = video(main, 'v', 4 * S)
    addClip(p, v, main, 0)
    v.volume = 0.6
    const sources = new Map([['v', dc(10 * SAMPLE_RATE)]])
    expect(levelAt(p, 1 * S, sources)).toBeCloseTo(0.3, 3)

    v.muted = true
    expect(audioPlan(p)).toEqual([])
    expect(levelAt(p, 1 * S, sources)).toBe(0)

    v.muted = false
    expect(levelAt(p, 1 * S, sources)).toBeCloseTo(0.3, 3)
  })

  it('mutes only that clip, not the rest of its track', () => {
    const p = project()
    const main = mainTrack(p).id
    const a = video(main, 'a', 2 * S)
    const b = video(main, 'b', 2 * S)
    addClip(p, a, main, 0)
    addClip(p, b, main, 2 * S)
    a.muted = true
    expect(audioPlan(p).map((s) => s.clipId)).toEqual([b.id])
  })
})

describe('volume envelope', () => {
  const keys = (pts: [number, number][]): VolumeKey[] => pts.map(([t, gain]) => ({ t, gain }))

  it('is 1 without points and holds before the first and after the last', () => {
    expect(keyGainAt(undefined, 5)).toBe(1)
    expect(keyGainAt([], 5)).toBe(1)
    const k = keys([[1 * S, 0.5], [3 * S, 0.25]])
    expect(keyGainAt(k, 0)).toBeCloseTo(0.5, 6)
    expect(keyGainAt(k, 9 * S)).toBeCloseTo(0.25, 6)
  })

  it('interpolates linearly in dB between points', () => {
    const k = keys([[0, 1], [2 * S, dbToGain(-12)]])
    expect(gainToDb(keyGainAt(k, 1 * S))).toBeCloseTo(-6, 6)
    expect(gainToDb(keyGainAt(k, 0.5 * S))).toBeCloseTo(-3, 6)
    // Not linear in gain: half way is -6 dB (0.5), not the average 0.63.
    expect(keyGainAt(k, 1 * S)).toBeCloseTo(0.501, 3)
  })

  it('ramps to true silence at a zero point', () => {
    const k = keys([[0, 1], [1 * S, 0]])
    expect(keyGainAt(k, 1 * S)).toBe(0)
    expect(keyGainAt(k, 2 * S)).toBe(0)
    expect(keyGainAt(k, 0.5 * S)).toBeGreaterThan(0)
    expect(envelopeAt([], [], 0)).toBe(1)
  })

  it('is applied by the mixer on top of the clip volume', () => {
    const p = project()
    const audio = p.tracks.find((t) => t.kind === 'audio')!.id
    const m = music(audio, 4 * S)
    addClip(p, m, audio, 1 * S)
    m.volume = 0.5
    m.volumeKeys = keys([[0, 1], [2 * S, dbToGain(-12)]])
    const sources = new Map([['music', dc(10 * SAMPLE_RATE)]])
    // Evaluation points are every 32 frames; pick times on them.
    const at = (sec: number) => (Math.round((sec * SAMPLE_RATE) / 32) * 32 * S) / SAMPLE_RATE
    expect(levelAt(p, at(1), sources)).toBeCloseTo(0.25, 3)
    expect(levelAt(p, at(2), sources)).toBeCloseTo(0.25 * dbToGain(-6), 3)
    expect(levelAt(p, at(4), sources)).toBeCloseTo(0.25 * dbToGain(-12), 3)
  })

  it('gives identical samples for preview quanta from any position and export blocks', () => {
    const p = project()
    const audio = p.tracks.find((t) => t.kind === 'audio')!.id
    const m = music(audio, 3 * S)
    addClip(p, m, audio, 0.0123 * S)
    m.volumeKeys = keys([[0.1 * S, 0], [0.4 * S, 1.8], [0.7 * S, 0.2]])
    m.fadeIn.duration = 0.05 * S
    const segs = compileSegments(audioPlan(p))
    const sources = new Map([['music', dc(10 * SAMPLE_RATE)]])
    const n = SAMPLE_RATE
    const exportL = new Float32Array(n)
    mix(exportL, new Float32Array(n), 0, n, segs, sources)
    // AudioWorklet: 128-frame quanta after a seek to an odd frame.
    const seek = 77
    const previewL = new Float32Array(n)
    const qL = new Float32Array(128)
    const qR = new Float32Array(128)
    for (let pos = seek; pos < n; pos += 128) {
      const k = Math.min(128, n - pos)
      mix(qL, qR, pos, k, segs, sources)
      previewL.set(qL.subarray(0, k), pos)
    }
    expect(Array.from(previewL.subarray(seek))).toEqual(Array.from(exportL.subarray(seek)))
  })
})

describe('volume points survive edits', () => {
  /** Envelope gain at absolute timeline time `t`, from whichever clip covers it. */
  const timelineGain = (clips: Clip[], t: number) => {
    const c = clips.find((x) => t >= x.start && t < x.start + x.duration)!
    return keyGainAt(c.volumeKeys, t - c.start)
  }

  function withEnvelope() {
    const p = project()
    const audio = p.tracks.find((t) => t.kind === 'audio')!.id
    const m = music(audio, 8 * S)
    addClip(p, m, audio, 2 * S)
    m.inPoint = 5 * S
    m.volumeKeys = [{ t: 1 * S, gain: 1 }, { t: 3 * S, gain: 0.1 }, { t: 6 * S, gain: 1.5 }]
    return { p, m }
  }

  it('split re-bases the points onto the right-hand clip; the envelope is unchanged', () => {
    const { p, m } = withEnvelope()
    const before = Array.from({ length: 40 }, (_, i) => timelineGain([m], 2 * S + i * 0.2 * S))
    const rightId = splitClip(p, m.id, 6 * S)!
    const right = findClip(p, rightId)!
    expect(right.volumeKeys!.map((k) => k.t)).toEqual([-3 * S, -1 * S, 2 * S])
    expect(m.volumeKeys!.map((k) => k.t)).toEqual([1 * S, 3 * S, 6 * S])
    const after = Array.from({ length: 40 }, (_, i) => timelineGain([m, right], 2 * S + i * 0.2 * S))
    after.forEach((g, i) => expect(g).toBeCloseTo(before[i], 9))
  })

  it('a head trim keeps points on the same source moment, and trimming back restores them', () => {
    const { p, m } = withEnvelope()
    const original = structuredClone(m.volumeKeys)
    const gainAtSource = (src: number) => keyGainAt(m.volumeKeys, src - m.inPoint)
    const probe = [6.5 * S, 8 * S, 9.5 * S].map(gainAtSource)
    trimClip(p, m.id, 'start', 2 * S)
    expect(m.inPoint).toBe(7 * S)
    expect(m.volumeKeys!.map((k) => k.t)).toEqual([-1 * S, 1 * S, 4 * S])
    ;[6.5 * S, 8 * S, 9.5 * S].map(gainAtSource).forEach((g, i) => expect(g).toBeCloseTo(probe[i], 9))
    trimClip(p, m.id, 'start', -2 * S)
    expect(m.volumeKeys).toEqual(original)
  })

  it('a tail trim leaves points alone; duplicate copies them', () => {
    const { p, m } = withEnvelope()
    const original = structuredClone(m.volumeKeys)
    trimClip(p, m.id, 'end', -4 * S)
    expect(m.volumeKeys).toEqual(original)
    const copy = findClip(p, duplicateClip(p, m.id)!)!
    expect(copy.volumeKeys).toEqual(original)
    expect(copy.volumeKeys).not.toBe(m.volumeKeys)
  })
})

describe('ducking', () => {
  /** Music under a soundless main video, with an interview clip (with sound) on an upper video track. */
  function scene(duck = { ...DEFAULT_DUCK, amount: 12, attack: 200, release: 400 }) {
    const p = project()
    const main = mainTrack(p).id
    addClip(p, video(main, 'broll', 10 * S, false), main, 0)
    const upper = insertTrack(p, 'video').id
    const talk = video(upper, 'talk', 2 * S)
    addClip(p, talk, upper, 2 * S)
    const audio = p.tracks.find((t) => t.kind === 'audio')!
    audio.duck = duck
    const m = music(audio.id, 10 * S)
    addClip(p, m, audio.id, 0)
    return { p, m, talk, audio }
  }

  it('dips the music by the amount while clip audio plays, ramping in dB over attack and release', () => {
    const { p, m, talk } = scene()
    expect(segGain(p, m.id, 1 * S)).toBeCloseTo(1, 6)
    expect(segGain(p, m.id, 1.8 * S)).toBeCloseTo(1, 6)
    expect(gainToDb(segGain(p, m.id, 1.9 * S))).toBeCloseTo(-6, 3)
    expect(gainToDb(segGain(p, m.id, 2 * S))).toBeCloseTo(-12, 3)
    expect(gainToDb(segGain(p, m.id, 3.5 * S))).toBeCloseTo(-12, 3)
    expect(gainToDb(segGain(p, m.id, 4.2 * S))).toBeCloseTo(-6, 3)
    expect(segGain(p, m.id, 4.4 * S)).toBeCloseTo(1, 6)
    expect(segGain(p, m.id, 6 * S)).toBeCloseTo(1, 6)
    // The clip being ducked under is untouched.
    expect(segGain(p, talk.id, 3 * S)).toBeCloseTo(1, 6)
    // And the mixer output follows.
    const sources = new Map([['music', dc(20 * SAMPLE_RATE)], ['talk', dc(20 * SAMPLE_RATE)]])
    expect(levelAt(p, 3 * S, sources)).toBeCloseTo(0.5 * dbToGain(-12) + 0.5, 3)
  })

  it('does not change the clip data', () => {
    const { p, m } = scene()
    const before = structuredClone(m)
    audioPlan(p)
    expect(m).toEqual(before)
  })

  it('ignores muted, hidden and soundless video clips', () => {
    const { p, m, talk } = scene()
    talk.muted = true
    expect(segGain(p, m.id, 3 * S)).toBeCloseTo(1, 6)
    talk.muted = false
    p.tracks.find((t) => t.id === talk.trackId)!.hidden = true
    expect(segGain(p, m.id, 3 * S)).toBeCloseTo(1, 6)
  })

  it('is off when disabled, and merges back-to-back clip audio into one dip', () => {
    const { p, m, talk, audio } = scene()
    audio.duck!.enabled = false
    expect(segGain(p, m.id, 3 * S)).toBeCloseTo(1, 6)
    audio.duck!.enabled = true
    const next = video(talk.trackId, 'talk2', 2 * S)
    addClip(p, next, talk.trackId, 4 * S)
    expect(gainToDb(segGain(p, m.id, 4 * S))).toBeCloseTo(-12, 3)
    expect(gainToDb(segGain(p, m.id, 5.9 * S))).toBeCloseTo(-12, 3)
  })

  it('takes the deeper of overlapping ramps between close clips', () => {
    const { p, m, talk } = scene()
    // Gap of 0.3 s: release (0.4 s) and attack (0.2 s) overlap, so the music never fully recovers.
    addClip(p, video(talk.trackId, 'talk2', 1 * S), talk.trackId, 4.3 * S)
    const mid = segGain(p, m.id, 4.15 * S)
    expect(mid).toBeLessThan(1)
    expect(mid).toBeGreaterThan(dbToGain(-12))
  })
})
