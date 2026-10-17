/** "Close gaps" butts video clips together, keeps cross-fades, and is one undo step. */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject } from '../../src/shared/factory'
import { addClip, insertTrack, mainTrack, setTransition } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')

test('close gaps between video clips', async () => {
  const p = newProject('Gaps', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  const main = mainTrack(p).id
  const v2 = insertTrack(p, 'video').id
  const v = (name: string, file: string, dur: number) =>
    baseClip({ kind: 'video', name, trackId: main, source: join(FIXTURES, file), duration: dur * S, sourceDuration: dur * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true })
  addClip(p, v('base', 'coastline.mp4', 12), main, 0)
  const a = v('a', 'mountains.mp4', 3)
  const b = v('b', 'mountains.mp4', 2)
  const c = v('c', 'coastline.mp4', 2)
  addClip(p, a, v2, 1 * S)
  addClip(p, b, v2, 6 * S)
  addClip(p, c, v2, 8 * S) // touches b
  setTransition(p, b.id, c.id, 1 * S)

  const h = await launch()
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await h.page.reload()
    const page = h.page
    await page.getByText('Gaps').first().click()
    await page.waitForTimeout(1200)
    const starts = () =>
      page.evaluate((track) => {
        const s = (window as any).__trailer.store.getState().project
        return {
          v2: s.clips.filter((x: any) => x.trackId === track).sort((x: any, y: any) => x.start - y.start).map((x: any) => [x.name, x.start / 1e6]),
          transitions: s.transitions.length,
        }
      }, v2)

    const button = page.getByRole('button', { name: 'Close gaps between video clips' })
    await expect(button).toBeEnabled()
    await page.screenshot({ path: join(SHOTS, 'gaps-01-before.png') })
    await button.click()
    expect(await starts()).toEqual({ v2: [['a', 1], ['b', 4], ['c', 6]], transitions: 1 })
    await expect(page.getByRole('button', { name: 'No gaps between video clips' })).toBeDisabled()
    await page.waitForTimeout(600)
    await page.screenshot({ path: join(SHOTS, 'gaps-02-after.png') })

    // One undo step restores the layout; G does it again.
    await page.mouse.click(1000, 300)
    await page.keyboard.press('Control+z')
    expect(await starts()).toEqual({ v2: [['a', 1], ['b', 6], ['c', 8]], transitions: 1 })
    await page.keyboard.press('g')
    expect(await starts()).toEqual({ v2: [['a', 1], ['b', 4], ['c', 6]], transitions: 1 })
  } finally {
    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    if (errs.length) console.log(errs.join('\n'))
    await h.app.close()
  }
})

test('Ctrl+A then seam: clips on 10 video tracks chain top to bottom, each on its own track', async () => {
  const p = newProject('Staircase', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  const main = mainTrack(p).id
  const v = (name: string, track: string, dur: number) =>
    baseClip({ kind: 'video', name, trackId: track, source: join(FIXTURES, 'mountains.mp4'), duration: dur * S, sourceDuration: 8 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true })
  addClip(p, v('main', main, 6), main, 0)
  // 10 upper tracks; insertTrack puts each new one on top, so build bottom-up.
  const tracks: string[] = []
  for (let i = 0; i < 10; i++) tracks.unshift(insertTrack(p, 'video').id)
  // Scatter one short clip per track (top track's clip deliberately late).
  const scatter = [9, 0.5, 14, 3, 20, 7, 1, 25, 12, 5]
  tracks.forEach((t, i) => addClip(p, v(`c${i}`, t, 1 + (i % 3) * 0.5), t, scatter[i] * S))

  const h = await launch()
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await h.page.reload()
    const page = h.page
    await page.getByText('Staircase').first().click()
    await page.waitForTimeout(1200)
    const layout = () =>
      page.evaluate((ids) => {
        const s = (window as any).__trailer.store.getState().project
        return ids.map((t: string) => {
          const c = s.clips.find((x: any) => x.trackId === t)
          return [c.name, Math.round(c.start / 1e3) / 1e3, Math.round((c.start + c.duration) / 1e3) / 1e3]
        })
      }, tracks)

    await page.mouse.click(1000, 300)
    await page.keyboard.press('Control+a')
    const button = page.getByRole('button', { name: 'Seam 10 selected clips, top track first' })
    await expect(button).toBeEnabled()
    await page.screenshot({ path: join(SHOTS, 'seam-01-before.png') })
    await button.click()

    const after = await layout()
    // Chained from the earliest selected start (0.5 s), in track order, end to start.
    expect(after[0][1]).toBe(0.5)
    for (let i = 1; i < after.length; i++) expect(after[i][1]).toBe(after[i - 1][2])
    expect(after.map((r) => r[0])).toEqual(tracks.map((_, i) => `c${i}`)) // still one per track
    const mainStart = await page.evaluate((m) => (window as any).__trailer.store.getState().project.clips.find((x: any) => x.trackId === m).start, main)
    expect(mainStart).toBe(0)
    await expect(page.getByRole('button', { name: 'Selected clips are already seamed' })).toBeDisabled()
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'seam-02-after.png') })

    // One undo restores everything; G seams again.
    await page.keyboard.press('Control+z')
    expect((await layout()).map((r) => r[1])).toEqual(scatter)
    await page.keyboard.press('g')
    expect(await layout()).toEqual(after)
  } finally {
    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    if (errs.length) console.log(errs.join('\n'))
    await h.app.close()
  }
})
