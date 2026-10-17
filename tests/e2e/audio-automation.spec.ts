/**
 * Audio automation: per-clip mute (timeline button, M, inspector), volume envelope points on
 * the clip's volume line (one undo step per gesture), and an export where the muted clip is
 * silent and the envelope is applied.
 */
import { expect, test, type Page } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject } from '../../src/shared/factory'
import type { Clip, Project } from '../../src/shared/model'
import { audioPlan } from '../../src/shared/render-plan'
import { addClip, mainTrack, splitClip } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT, stubDialogs, type AppHandle } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')
/** Export path for tests that don't export. */
const UNUSED = join(ROOT, 'test-results', 'unused.mp4')
mkdirSync(SHOTS, { recursive: true })

const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

const coastline = (trackId: string) =>
  baseClip({ kind: 'video', name: 'coastline.mp4', trackId, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true })

async function open(p: Project, exportPath: string): Promise<AppHandle> {
  const h = await launch()
  const dir = join(h.dataDir, 'Projects')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
  await stubDialogs(h.app, FIXTURES, exportPath)
  await h.page.reload()
  await h.page.getByText(p.name).first().click()
  await h.page.waitForTimeout(1500)
  return h
}

async function close(h: AppHandle): Promise<void> {
  const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
  if (errs.length) console.log(errs.join('\n'))
  await h.app.close()
}

const project = (page: Page): Promise<Project> => page.evaluate(() => (window as any).__trailer.store.getState().project)
const clipOf = async (page: Page, id: string): Promise<Clip> => (await project(page)).clips.find((c) => c.id === id)!
const pastLen = (page: Page): Promise<number> => page.evaluate(() => (window as any).__trailer.store.getState().past.length)
const lastLabel = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).__trailer.store.getState().past.at(-1)?.label ?? '')
/** Ids of the clips the shared mixer plays. */
const heard = async (page: Page) => audioPlan(await project(page)).map((s) => s.clipId)

/** Mean and max level (dBFS) of the exported audio over [from, from + dur). */
function levels(file: string, from: number, dur: number): { mean: number; max: number } {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', '-ss', String(from), '-t', String(dur), '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'])
  const err = r.stderr.toString()
  const num = (k: string) => {
    const m = new RegExp(`${k}:\\s*(-?[\\d.]+|-inf) dB`).exec(err)
    if (!m) throw new Error(`no ${k} in ffmpeg output:\n${err.slice(-1500)}`)
    return m[1] === '-inf' ? -Infinity : Number(m[1])
  }
  return { mean: num('mean_volume'), max: num('max_volume') }
}

test('audio: mute a clip from the timeline, M and the inspector', async () => {
  const p = newProject('Mute test', settings, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, coastline(main), main, 0)
  const audioTrack = p.tracks.find((t) => t.kind === 'audio')!
  const music = baseClip({ kind: 'audio', name: 'ambient-music.mp3', trackId: audioTrack.id, source: join(FIXTURES, 'ambient-music.mp3'), duration: 10 * S, sourceDuration: 60 * S, hasAudio: true })
  addClip(p, music, audioTrack.id, 0)
  const video = p.clips.find((c) => c.kind === 'video')!
  video.volume = 0.7

  const h = await open(p, UNUSED)
  const page = h.page
  try {
    const before = await pastLen(page)
    expect(await heard(page)).toEqual([video.id, music.id])

    // Speaker button on the clip.
    const button = page.locator(`[data-clip="${video.id}"] [data-testid="clip-mute"]`)
    await page.locator(`[data-clip="${video.id}"]`).hover()
    await expect(button).toHaveAttribute('aria-pressed', 'false')
    await button.click()
    await expect.poll(async () => (await clipOf(page, video.id)).muted).toBe(true)
    expect((await clipOf(page, video.id)).volume).toBe(0.7) // volume kept for un-muting
    expect(await pastLen(page)).toBe(before + 1)
    expect(await lastLabel(page)).toBe('Mute coastline.mp4')
    expect(await heard(page)).toEqual([music.id])
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await page.screenshot({ path: join(SHOTS, 'audio-01-muted-clip.png') })

    // M toggles the selected clip.
    const cb = (await page.locator(`[data-clip="${video.id}"]`).boundingBox())!
    await page.mouse.click(cb.x + cb.width / 3, cb.y + 12)
    await expect.poll(() => page.evaluate(() => (window as any).__trailer.store.getState().selection)).toEqual([video.id])
    await page.keyboard.press('m')
    await expect.poll(async () => (await clipOf(page, video.id)).muted).toBeFalsy()
    expect((await clipOf(page, video.id)).volume).toBe(0.7)
    expect(await pastLen(page)).toBe(before + 2)
    expect(await heard(page)).toEqual([video.id, music.id])

    // Inspector switch.
    const sw = page.getByRole('switch', { name: 'Mute clip audio' })
    await expect(sw).toHaveAttribute('aria-checked', 'false')
    await sw.click()
    await expect.poll(async () => (await clipOf(page, video.id)).muted).toBe(true)
    await expect(sw).toHaveAttribute('aria-checked', 'true')
    expect(await pastLen(page)).toBe(before + 3)
    await page.screenshot({ path: join(SHOTS, 'audio-02-inspector-mute.png') })

    // Undo restores the sound.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await clipOf(page, video.id)).muted).toBeFalsy()
    expect(await heard(page)).toEqual([video.id, music.id])

    // Project inspector: duck the audio track under the video's sound (render-plan only, clips untouched).
    await page.keyboard.press('Escape')
    const duck = page.getByRole('switch', { name: `Duck ${audioTrack.name} under clip audio` })
    await duck.click()
    await expect.poll(async () => (await project(page)).tracks.find((t) => t.id === audioTrack.id)?.duck?.enabled).toBe(true)
    const seg = audioPlan(await project(page)).find((s) => s.clipId === music.id)!
    expect(seg.duckDb).toBe(12)
    expect(seg.duck).toHaveLength(1)
    expect((await clipOf(page, music.id)).volumeKeys).toBeUndefined()
    await page.screenshot({ path: join(SHOTS, 'audio-05-ducking.png') })
  } finally {
    await close(h)
  }
})

test('audio: add, drag and delete volume envelope points', async () => {
  const p = newProject('Envelope test', settings, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, coastline(main), main, 0)
  const audioTrack = p.tracks.find((t) => t.kind === 'audio')!
  const music = baseClip({ kind: 'audio', name: 'ambient-music.mp3', trackId: audioTrack.id, source: join(FIXTURES, 'ambient-music.mp3'), duration: 10 * S, sourceDuration: 60 * S, hasAudio: true })
  addClip(p, music, audioTrack.id, 0)

  const h = await open(p, UNUSED)
  const page = h.page
  try {
    const line = page.locator(`[data-clip="${music.id}"] [data-testid="volume-line"]`)
    const keys = page.locator(`[data-clip="${music.id}"] [data-testid="volume-key"]`)
    const clipBox = (await page.locator(`[data-clip="${music.id}"]`).boundingBox())!
    const lb = (await line.boundingBox())!
    const y = lb.y + lb.height / 2
    const xAt = (frac: number) => clipBox.x + clipBox.width * frac
    const before = await pastLen(page)

    // Alt-click adds a point on the line (no level change), one undo step.
    await page.keyboard.down('Alt')
    await page.mouse.click(xAt(0.25), y)
    await page.keyboard.up('Alt')
    await expect(keys).toHaveCount(1)
    let c = await clipOf(page, music.id)
    expect(c.volumeKeys).toHaveLength(1)
    expect(Math.abs(c.volumeKeys![0].t - 2.5 * S)).toBeLessThan(0.1 * S)
    expect(c.volumeKeys![0].gain).toBeCloseTo(1, 6)
    expect(c.start).toBe(0)
    expect(await pastLen(page)).toBe(before + 1)
    expect(await lastLabel(page)).toBe('Add volume point ambient-music.mp3')

    // Ctrl-click adds a second one.
    await page.keyboard.down('Control')
    await page.mouse.click(xAt(0.75), y)
    await page.keyboard.up('Control')
    await expect(keys).toHaveCount(2)
    expect(await pastLen(page)).toBe(before + 2)

    // Drag the first point down and right: live draft, one undo step on release.
    const k = (await keys.first().boundingBox())!
    const kx = k.x + k.width / 2
    const ky = k.y + k.height / 2
    await page.mouse.move(kx, ky)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(kx + i * 2, ky + i)
      await page.waitForTimeout(16)
    }
    await expect(page.getByTestId('volume-tip')).toBeVisible()
    await page.waitForTimeout(50)
    const draft = await page.evaluate((id) => (window as any).__trailer.store.getState().draft?.clips.find((x: any) => x.id === id), music.id)
    expect(draft.volumeKeys[0].gain).toBeLessThan(1)
    expect(await pastLen(page)).toBe(before + 2) // nothing committed mid-drag
    await page.screenshot({ path: join(SHOTS, 'audio-03-envelope-drag.png') })
    await page.mouse.up()
    c = await clipOf(page, music.id)
    expect(c.volumeKeys).toHaveLength(2)
    expect(c.volumeKeys![0].gain).toBeLessThan(0.85)
    expect(c.volumeKeys![0].gain).toBeGreaterThan(0.3)
    // 24 px to the right, at the clip's scale (10 s across its width).
    expect(c.volumeKeys![0].t).toBeGreaterThan(2.5 * S + (12 / clipBox.width) * 10 * S)
    expect(c.volumeKeys![1].gain).toBeCloseTo(1, 6)
    expect(c.start).toBe(0)
    expect(await pastLen(page)).toBe(before + 3)
    expect(await lastLabel(page)).toBe('Move volume point ambient-music.mp3')
    expect(await page.evaluate(() => (window as any).__trailer.store.getState().draft)).toBeNull()

    // The line is now a polyline through the points; the moved point sits below the line's old level.
    const pts = (await line.getAttribute('points'))!.trim().split(/\s+/)
    expect(pts.length).toBeGreaterThan(4)
    const k2 = (await keys.first().boundingBox())!
    expect(k2.y + k2.height / 2).toBeGreaterThan(y + 8)

    // The mixer hears it: the gain at the dragged point is the point's gain.
    const seg = audioPlan(await project(page)).find((s) => s.clipId === music.id)!
    expect(seg.keyTimes).toEqual(c.volumeKeys!.map((x) => x.t))

    // Alt-drag on the line adds and drags in one gesture: one undo step.
    await page.keyboard.down('Alt')
    await page.mouse.move(xAt(0.9), y)
    await page.mouse.down()
    for (let i = 1; i <= 8; i++) {
      await page.mouse.move(xAt(0.9), y - i * 2)
      await page.waitForTimeout(16)
    }
    await page.mouse.up()
    await page.keyboard.up('Alt')
    await expect(keys).toHaveCount(3)
    c = await clipOf(page, music.id)
    expect(c.volumeKeys![2].gain).toBeGreaterThan(1.1)
    expect(c.volumeKeys!.map((x) => x.t)).toEqual([...c.volumeKeys!.map((x) => x.t)].sort((a, b) => a - b))
    expect(await pastLen(page)).toBe(before + 4)
    await page.screenshot({ path: join(SHOTS, 'audio-04-envelope.png') })

    // Double-click deletes a point; undo brings it back.
    const kd = (await keys.nth(1).boundingBox())!
    await page.mouse.dblclick(kd.x + kd.width / 2, kd.y + kd.height / 2)
    await expect(keys).toHaveCount(2)
    c = await clipOf(page, music.id)
    expect(c.volumeKeys).toHaveLength(2)
    expect(c.volume).toBe(1) // the line's double-click (reset volume) didn't fire
    expect(await pastLen(page)).toBe(before + 5)
    expect(await lastLabel(page)).toBe('Delete volume point ambient-music.mp3')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await clipOf(page, music.id)).volumeKeys?.length).toBe(3)
  } finally {
    await close(h)
  }
})

test('audio: export silences the muted clip and applies the envelope', async () => {
  // Main: coastline (330 Hz tone) split at 6 s. The second half ramps from 0 dB at 7 s to -20 dB at 8 s.
  const p = newProject('Mute export', settings, FIXTURES)
  const main = mainTrack(p).id
  const a = coastline(main)
  addClip(p, a, main, 0)
  const bId = splitClip(p, a.id, 6 * S)!
  const b = p.clips.find((c) => c.id === bId)!
  b.volumeKeys = [{ t: 1 * S, gain: 1 }, { t: 2 * S, gain: 0.1 }]

  const exportPath = join(ROOT, 'test-results', `audio-mute-${Date.now()}.mp4`)
  const h = await open(p, exportPath)
  const page = h.page
  try {
    // Mute the first half from the timeline.
    await page.locator(`[data-clip="${a.id}"]`).hover()
    await page.locator(`[data-clip="${a.id}"] [data-testid="clip-mute"]`).click()
    await expect.poll(async () => (await clipOf(page, a.id)).muted).toBe(true)
    expect(await heard(page)).toEqual([bId])

    await page.keyboard.press('Control+e')
    await expect(page.getByText('NVIDIA NVENC')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Browse' }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 120_000 })
    await page.getByRole('button', { name: 'Done' }).click()

    const muted = levels(exportPath, 0.5, 5)
    const loud = levels(exportPath, 6.1, 0.8)
    const dipped = levels(exportPath, 8.5, 3)
    console.log({ muted, loud, dipped })
    expect(muted.max).toBeLessThan(-80) // digital silence
    expect(loud.mean).toBeGreaterThan(-35)
    expect(loud.mean - dipped.mean).toBeGreaterThan(17)
    expect(loud.mean - dipped.mean).toBeLessThan(23)
  } finally {
    await close(h)
  }
})
