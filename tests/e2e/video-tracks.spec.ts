/**
 * Several video tracks: add/remove/undo from the timeline UI, library drop and moves between
 * video tracks, marquee and hide. Only the topmost video is drawn, decoded and exported, and
 * its fades dissolve into the video below.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject } from '../../src/shared/factory'
import type { Project } from '../../src/shared/model'
import { framePlan } from '../../src/shared/render-plan'
import { addClip, insertTrack, mainTrack } from '../../src/shared/timeline'
import { drag, FIXTURES, launch, ROOT, stubDialogs, type AppHandle } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

const coastline = (trackId: string) =>
  baseClip({ kind: 'video', name: 'coastline.mp4', trackId, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true })

function withVideo(name: string): Project {
  const p = newProject(name, settings, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, coastline(main), main, 0)
  return p
}

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
const pastLen = (page: Page): Promise<number> => page.evaluate(() => (window as any).__trailer.store.getState().past.length)
const trackNames = async (page: Page) => (await project(page)).tracks.map((t) => t.name)
const clipsOn = async (page: Page, trackId: string) =>
  (await project(page)).clips.filter((c) => c.trackId === trackId).sort((a, b) => a.start - b.start).map((c) => [c.name, c.start])
/** Names of the video-track layers the shared render plan draws at `sec`. */
const shown = async (page: Page, sec: number) => framePlan(await project(page), sec * S).base.map((l) => l.clip.name)

async function rowY(page: Page, trackId: string): Promise<number> {
  const b = (await page.locator(`[data-track="${trackId}"]`).boundingBox())!
  return b.y + b.height / 2
}

/** Viewport x for a timeline time (seconds). */
async function timeX(page: Page, seconds: number): Promise<number> {
  return page.evaluate((sec) => {
    const sc = document.querySelector('section.bg-timeline .overflow-auto') as HTMLElement
    const r = sc.getBoundingClientRect()
    const pps = (window as any).__trailer.store.getState().pxPerSec
    return r.left + 168 + sec * pps - sc.scrollLeft
  }, seconds)
}

async function cardCenter(page: Page, name: string) {
  const box = (await page.getByText(name, { exact: true }).first().boundingBox())!
  return { x: box.x + box.width / 2, y: box.y - 40 }
}

/** Seek and wait until the preview shows the exact frame. */
async function seekExact(page: Page, sec: number): Promise<void> {
  await page.evaluate((s) => (window as any).__trailer.engine().seek(s * 1e6), sec)
  await settle(page)
}

async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(300)
  await expect.poll(() => page.evaluate(() => (window as any).__trailer.engine().stats[6]), { timeout: 10_000 }).toBe(1)
  await page.waitForTimeout(150)
}

/** Brightest channel in an 8x8 patch at the frame's top-left corner, read off the preview. */
async function previewCorner(page: Page): Promise<number> {
  const png = await page.locator('#preview-root canvas').screenshot()
  return page.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const c = new OffscreenCanvas(img.width, img.height)
    const g = c.getContext('2d')!
    g.drawImage(img, 0, 0)
    const d = g.getImageData(3, 3, 8, 8).data
    let max = 0
    for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2])
    return max
  }, png.toString('base64'))
}

/** Same patch, from the exported file. */
function exportCorner(file: string, sec: number): number {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1', '-vf', 'crop=8:8:6:6', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  expect(raw.length).toBe(8 * 8 * 3)
  return Math.max(...raw)
}

test('video tracks: add, drop, move between, marquee, hide, remove, undo', async () => {
  const p = withVideo('Video tracks UI')
  const mainId = mainTrack(p).id
  const h = await open(p, join(ROOT, 'test-results', 'unused.mp4'))
  const page = h.page
  try {
    // Add a video track from the "+ Track" menu: it goes above the main track.
    const before = await pastLen(page)
    await page.getByRole('button', { name: 'Track', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Video track' }).click()
    await expect.poll(() => trackNames(page)).toEqual(['Video 2', 'Video', 'Text', 'Image', 'Audio'])
    expect(await pastLen(page)).toBe(before + 1)
    const v2 = (await project(page)).tracks[0].id
    expect(mainTrack(await project(page)).id).toBe(mainId)
    await expect(page.getByLabel('Main track', { exact: true })).toBeVisible()

    // Undo / redo the add.
    await page.keyboard.press('Control+z')
    await expect.poll(() => trackNames(page)).toEqual(['Video', 'Text', 'Image', 'Audio'])
    await expect(page.getByLabel('Main track', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Control+y')
    await expect.poll(() => trackNames(page)).toEqual(['Video 2', 'Video', 'Text', 'Image', 'Audio'])
    expect((await project(page)).tracks[0].id).toBe(v2)

    // Library drop onto the new track: free placement over the main clip, no ripple.
    await drag(page, await cardCenter(page, 'mountains.mp4'), { x: await timeX(page, 3), y: await rowY(page, v2) })
    await expect.poll(async () => (await clipsOn(page, v2)).length).toBe(1)
    const [[, dropAt]] = await clipsOn(page, v2)
    expect(Math.abs((dropAt as number) - 3 * S)).toBeLessThan(250_000)
    expect(await clipsOn(page, mainId)).toEqual([['coastline.mp4', 0]])
    const broll = (await project(page)).clips.find((c) => c.trackId === v2)!

    // The upper video covers the main one where they overlap.
    expect(await shown(page, 1)).toEqual(['coastline.mp4'])
    expect(await shown(page, 5)).toEqual(['mountains.mp4'])
    await seekExact(page, 5)
    await page.screenshot({ path: join(SHOTS, 'tracks-01-two-video-tracks.png') })

    // Drag the clip down onto the main track: inserted magnetically after coastline. Grab it
    // above its middle, where the volume line sits.
    const cb = (await page.locator(`[data-clip="${broll.id}"]`).boundingBox())!
    await drag(page, { x: cb.x + cb.width / 2, y: cb.y + 14 }, { x: cb.x + cb.width / 2, y: await rowY(page, mainId) })
    await expect.poll(() => clipsOn(page, mainId)).toEqual([['coastline.mp4', 0], ['mountains.mp4', 12 * S]])
    expect(await clipsOn(page, v2)).toEqual([])
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await clipsOn(page, v2)).map((c) => c[0])).toEqual(['mountains.mp4'])
    expect(await clipsOn(page, mainId)).toEqual([['coastline.mp4', 0]])

    // Marquee across both video rows selects a clip on each.
    await drag(page, { x: await timeX(page, 1), y: (await rowY(page, v2)) - 20 }, { x: await timeX(page, 5), y: await rowY(page, mainId) })
    const sel: string[] = await page.evaluate(() => (window as any).__trailer.store.getState().selection)
    expect(new Set(sel)).toEqual(new Set([broll.id, (await project(page)).clips.find((c) => c.trackId === mainId)!.id]))

    // Hiding the upper track reveals the main one; undo shows it again.
    await page.locator(`[data-track="${v2}"]`).getByRole('button', { name: 'Toggle visibility' }).click()
    await expect.poll(() => shown(page, 5)).toEqual(['coastline.mp4'])
    await page.keyboard.press('Control+z')
    await expect.poll(() => shown(page, 5)).toEqual(['mountains.mp4'])

    // The main track can't be removed; a non-empty track can't either.
    await page.locator(`[data-track="${mainId}"]`).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Main track (magnetic)' })).toBeVisible()
    await expect(page.getByRole('menuitem', { name: 'Remove track' })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await page.locator(`[data-track="${v2}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove track' }).click()
    await expect(page.getByText('Only empty tracks can be removed')).toBeVisible()
    expect(await trackNames(page)).toHaveLength(5)

    // Empty it, remove it, and bring it back with undo.
    await page.evaluate((id) => (window as any).__trailer.store.setState({ selection: [id] }), broll.id)
    await page.keyboard.press('Delete')
    await expect.poll(async () => (await clipsOn(page, v2)).length).toBe(0)
    await page.locator(`[data-track="${v2}"]`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Remove track' }).click()
    await expect.poll(() => trackNames(page)).toEqual(['Video', 'Text', 'Image', 'Audio'])
    await page.keyboard.press('Control+z')
    await expect.poll(() => trackNames(page)).toEqual(['Video 2', 'Video', 'Text', 'Image', 'Audio'])
    expect((await project(page)).tracks[0].id).toBe(v2)
  } finally {
    await close(h)
  }
})

test('video tracks: only the top video is drawn, decoded and exported; its fades dissolve', async () => {
  // Main: coastline [0,12). Video 2: mountains [3,8) at half size, so a lower video drawn
  // underneath would show in the frame corners; only the background may show there. It fades
  // in and out over 1 s (to black, were nothing below), dissolving with coastline instead.
  const p = withVideo('Video tracks render')
  const v2 = insertTrack(p, 'video')
  const broll = baseClip({
    kind: 'video', name: 'mountains.mp4', trackId: v2.id, source: join(FIXTURES, 'mountains.mp4'), duration: 5 * S, sourceDuration: 8 * S,
    mediaWidth: 1920, mediaHeight: 1080, hasAudio: true, transform: { fit: 'contain', x: 0, y: 0, scale: 0.5 },
    fadeIn: { duration: 1 * S, color: '#000000' }, fadeOut: { duration: 1 * S, color: '#000000' },
  })
  addClip(p, broll, v2.id, 3 * S)
  expect(framePlan(p, 5 * S).base.map((l) => l.clip.id)).toEqual([broll.id])
  expect(framePlan(p, 7.5 * S).base.map((l) => l.clip.name)).toEqual(['coastline.mp4', 'mountains.mp4'])

  const exportPath = join(ROOT, 'test-results', `video-tracks-${Date.now()}.mp4`)
  const app = await open(p, exportPath)
  const page = app.page
  try {
    // Preview: corner is background while the half-size upper clip is shown.
    await seekExact(page, 1)
    expect(await previewCorner(page)).toBeGreaterThan(25)
    await seekExact(page, 5)
    expect(await previewCorner(page)).toBeLessThan(14)
    await page.screenshot({ path: join(SHOTS, 'tracks-02-top-only.png') })

    // The covered main clip's decoder is released: one decoder for one visible video.
    await expect.poll(() => page.evaluate(() => (window as any).__trailer.engine().stats[3]), { timeout: 8_000 }).toBe(1)

    // Hide the upper track: the main video shows again. Undo covers it again.
    const toggleV2 = page.locator(`[data-track="${v2.id}"]`).getByRole('button', { name: 'Toggle visibility' })
    await toggleV2.click()
    await settle(page)
    expect(await previewCorner(page)).toBeGreaterThan(25)
    await page.keyboard.press('Control+z')
    await settle(page)
    expect(await previewCorner(page)).toBeLessThan(14)

    // Halfway through the fade-out the corner is half coastline, half background: a dissolve
    // into the main video, not a dip to black.
    await seekExact(page, 7.5)
    const mid = await previewCorner(page)
    await page.screenshot({ path: join(SHOTS, 'tracks-03-dissolve.png') })
    await toggleV2.click()
    await settle(page)
    const full = await previewCorner(page)
    await page.keyboard.press('Control+z')
    console.log({ mid, full })
    expect(full).toBeGreaterThan(25)
    expect(mid / full).toBeGreaterThan(0.35)
    expect(mid / full).toBeLessThan(0.65)

    // Playback across the cover and the mid-clip reveal (deep in coastline's 250-frame GOP)
    // drops no frames: revealed clips are pre-rolled like clips that start soon.
    await seekExact(page, 2)
    const dropped0 = await page.evaluate(() => (window as any).__trailer.engine().stats[1])
    await page.mouse.click(1000, 300)
    await page.keyboard.press('Space')
    await page.waitForTimeout(7500)
    await page.keyboard.press('Space')
    await page.waitForTimeout(400)
    expect(await page.evaluate(() => (window as any).__trailer.engine().stats[1]) - dropped0).toBe(0)

    // Export renders the same thing.
    await page.keyboard.press('Control+e')
    await expect(page.getByText('NVIDIA NVENC')).toBeVisible({ timeout: 15_000 })
    await page.getByRole('button', { name: 'Browse' }).click()
    await page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(page.getByText('Export complete')).toBeVisible({ timeout: 120_000 })
    expect(exportCorner(exportPath, 1)).toBeGreaterThan(25)
    expect(exportCorner(exportPath, 5)).toBeLessThan(14)
    const exportMid = exportCorner(exportPath, 7.5)
    console.log({ exportMid })
    expect(exportMid).toBeGreaterThan(14) // a dip would be black
    expect(exportMid).toBeGreaterThan(0.35 * mid)
    expect(exportMid).toBeLessThan(1.65 * mid)
    expect(exportCorner(exportPath, 10)).toBeGreaterThan(25)
    await page.getByRole('button', { name: 'Done' }).click()
  } finally {
    await close(app)
  }
})
