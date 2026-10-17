/**
 * End-to-end: the real built app, real GPU decode/encode. Covers project CRUD, library drag,
 * magnetic timeline, split/trim/undo/redo, transitions, fades, text, aspect change warning,
 * playback without dropped frames, and an NVENC export verified with ffprobe.
 */
import { expect, test, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { drag, FIXTURES, launch, ROOT, stubDialogs, type AppHandle } from './harness'

const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

type Snapshot = {
  clips: { id: string; name: string; trackKind: string; start: number; duration: number; inPoint: number; fadeIn: number; fadeOut: number }[]
  transitions: number
  past: number
  future: number
  width: number
  height: number
  aspect: string
}

async function state(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const s = (window as any).__trailer.store.getState()
    const p = s.project
    const kind = (id: string) => p.tracks.find((t: any) => t.id === id)?.kind
    return {
      clips: p.clips
        .map((c: any) => ({ id: c.id, name: c.name, trackKind: kind(c.trackId), start: c.start, duration: c.duration, inPoint: c.inPoint, fadeIn: c.fadeIn.duration, fadeOut: c.fadeOut.duration }))
        .sort((a: any, b: any) => a.trackKind.localeCompare(b.trackKind) || a.start - b.start),
      transitions: p.transitions.length,
      past: s.past.length,
      future: s.future.length,
      width: p.settings.width,
      height: p.settings.height,
      aspect: p.settings.aspect,
    }
  })
}

const main = (s: Snapshot) => s.clips.filter((c) => c.trackKind === 'video')

async function cardCenter(page: Page, name: string) {
  const box = (await page.getByText(name, { exact: true }).first().boundingBox())!
  return { x: box.x + box.width / 2, y: box.y - 40 }
}

async function rowY(page: Page, name: string) {
  const box = (await page.locator('div.sticky', { hasText: new RegExp(`^${name}$`) }).first().boundingBox())!
  return box.y + box.height / 2
}

/** Viewport x for a timeline time (seconds). */
async function timeX(page: Page, seconds: number) {
  return page.evaluate((sec) => {
    const sc = document.querySelector('section.bg-timeline .overflow-auto') as HTMLElement
    const r = sc.getBoundingClientRect()
    const pps = (window as any).__trailer.store.getState().pxPerSec
    return r.left + 168 + sec * pps - sc.scrollLeft
  }, seconds)
}

async function seek(page: Page, seconds: number) {
  await page.evaluate((s) => (window as any).__trailer.engine().seek(s * 1e6), seconds)
  await page.waitForTimeout(600)
}

async function hud(page: Page): Promise<string> {
  return (await page.getByTestId('perf-hud').textContent()) ?? ''
}

test.describe.configure({ mode: 'serial' })

let h: AppHandle
const out = () => join(h.dataDir, 'export.mp4')

test.beforeAll(async () => {
  h = await launch()
  await stubDialogs(h.app, FIXTURES, join(h.dataDir, 'export.mp4'))
})

test.afterAll(async () => {
  const errors = h.logs.filter((l) => /\[(error|pageerror|main|main:err)\]|\[export\]/.test(l))
  if (errors.length) console.log('Renderer errors:\n' + errors.join('\n'))
  await h.app.close()
})

test('create a project with a media folder', async () => {
  const { page } = h
  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByPlaceholder('My trailer').fill('E2E trailer')
  await page.getByText('Choose a Windows folder').click()
  await page.getByRole('button', { name: 'Create project' }).click()
  await expect(page.getByText('coastline.mp4').first()).toBeVisible()
  await expect(page.getByText('9 files')).toBeVisible()
})

test('drag media into a magnetic main track and free overlay tracks', async () => {
  const { page } = h
  await page.waitForTimeout(800)
  const videoY = await rowY(page, 'Video')
  await drag(page, await cardCenter(page, 'coastline.mp4'), { x: await timeX(page, 1), y: videoY })
  await expect.poll(async () => main(await state(page)).length).toBe(1)
  // Dropped far to the right, still lands right after (magnetic).
  await drag(page, await cardCenter(page, 'mountains.mp4'), { x: await timeX(page, 20), y: videoY })
  await expect.poll(async () => main(await state(page)).length).toBe(2)
  let s = await state(page)
  expect(main(s).map((c) => [c.name, c.start])).toEqual([['coastline.mp4', 0], ['mountains.mp4', 12_000_000]])

  await drag(page, await cardCenter(page, 'ambient-music.mp3'), { x: await timeX(page, 0.2), y: await rowY(page, 'Audio') })
  await page.getByRole('button', { name: 'Text' }).first().click()
  await drag(page, await cardCenter(page, 'Title'), { x: await timeX(page, 1), y: await rowY(page, 'Text') })
  await page.getByRole('button', { name: 'Media' }).first().click()
  await drag(page, await cardCenter(page, 'badge.png'), { x: await timeX(page, 14), y: await rowY(page, 'Image') })
  await expect.poll(async () => (await state(page)).clips.length).toBe(5)
  s = await state(page)
  const text = s.clips.find((c) => c.trackKind === 'text')!
  expect(text.start).toBeGreaterThan(800_000)
  expect(text.start).toBeLessThan(1_300_000)
  await page.waitForTimeout(1500)
  await page.screenshot({ path: join(SHOTS, 'e2e-01-timeline.png') })
})

test('split, undo and redo', async () => {
  const { page } = h
  await page.mouse.click(await timeX(page, 10), await rowY(page, 'Text')) // empty area: deselects + seeks
  await expect.poll(() => page.evaluate(() => Math.round((window as any).__trailer.engine().time() / 1e6))).toBe(10)
  await seek(page, 4)
  const before = await state(page)
  await page.keyboard.press('s')
  let s = await state(page)
  // Every clip under the playhead (coastline, text, music) is split.
  expect(s.clips.length).toBe(before.clips.length + 3)
  expect(main(s).map((c) => c.start)).toEqual([0, 4_000_000, 12_000_000])
  expect(main(s)[1].inPoint).toBe(4_000_000)
  await page.keyboard.press('Control+z')
  s = await state(page)
  expect(s.clips.length).toBe(before.clips.length)
  await page.keyboard.press('Control+y')
  expect((await state(page)).clips.length).toBe(before.clips.length + 3)
  await page.keyboard.press('Control+z')
  expect((await state(page)).future).toBe(1)
})

test('trim the end of a clip with the mouse; the magnetic track ripples', async () => {
  const { page } = h
  const s0 = await state(page)
  const coast = main(s0)[0]
  const clipEl = page.locator(`[data-clip="${coast.id}"]`)
  const box = (await clipEl.boundingBox())!
  // Drag the right edge 2 s to the left.
  const pps = await page.evaluate(() => (window as any).__trailer.store.getState().pxPerSec)
  await drag(page, { x: box.x + box.width - 3, y: box.y + box.height / 2 }, { x: box.x + box.width - 3 - 2 * pps, y: box.y + box.height / 2 })
  const s = await state(page)
  const trimmed = main(s)[0]
  expect(Math.abs(trimmed.duration - 10_000_000)).toBeLessThan(150_000)
  expect(main(s)[1].start).toBe(trimmed.duration)
})

test('cross-fade via the junction, fades via inspector', async () => {
  const { page } = h
  const s0 = await state(page)
  const [a] = main(s0)
  const cutX = await timeX(page, (a.start + a.duration) / 1e6)
  const y = await rowY(page, 'Video')
  await page.mouse.move(cutX, y)
  await page.getByRole('button', { name: 'Add transition' }).first().click({ force: true })
  await page.getByRole('radio', { name: 'Cross-fade' }).click()
  await page.keyboard.press('Escape')
  expect((await state(page)).transitions).toBe(1)
  // Fade the last main clip out to black from the store-level action (UI sliders covered by unit tests).
  await page.evaluate(() => {
    const t = (window as any).__trailer
    const p = t.store.getState().project
    const v = p.clips.filter((c: any) => c.trackId === p.tracks[0].id).sort((x: any, y: any) => x.start - y.start)
    t.store.setState({ selection: [v[v.length - 1].id] })
  })
  await expect(page.getByText('Fade out')).toBeVisible()
  const slider = page.locator('span[role="slider"]').nth(2)
  await slider.focus()
  for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight')
  expect(main(await state(page)).at(-1)!.fadeOut).toBeGreaterThan(0)
  const midCut = (a.start + a.duration) / 1e6
  await seek(page, midCut)
  await page.screenshot({ path: join(SHOTS, 'e2e-02-crossfade.png') })
  await seek(page, 2.5)
  await page.screenshot({ path: join(SHOTS, 'e2e-03-title.png') })
})

test('aspect ratio change warns, resizes, and is undoable', async () => {
  const { page } = h
  await page.getByRole('button', { name: '16:9' }).click()
  await page.getByRole('menuitem', { name: /9:16/ }).click()
  await expect(page.getByText(/Change aspect ratio to 9:16/)).toBeVisible()
  await page.getByRole('button', { name: 'Resize media' }).click()
  let s = await state(page)
  expect([s.aspect, s.width, s.height]).toEqual(['9:16', 1080, 1920])
  await page.waitForTimeout(800)
  await page.screenshot({ path: join(SHOTS, 'e2e-04-shorts.png') })
  await page.keyboard.press('Control+z')
  s = await state(page)
  expect([s.aspect, s.width, s.height]).toEqual(['16:9', 1920, 1080])
})

test('plays through cuts and a cross-fade without dropping frames', async () => {
  const { page } = h
  await page.keyboard.press('Control+Shift+P')
  await seek(page, 7)
  await page.mouse.click(1000, 300)
  const dropped0 = Number(/dropped\s+(\d+)/.exec(await hud(page))?.[1] ?? 0)
  await page.keyboard.press('Space')
  await page.waitForTimeout(9000)
  await page.keyboard.press('Space')
  await page.waitForTimeout(600)
  const text = await hud(page)
  console.log(text)
  const dropped = Number(/dropped\s+(\d+)/.exec(text)?.[1] ?? 0) - dropped0
  expect(dropped).toBe(0)
  await page.keyboard.press('Control+Shift+P')
})

test('exports with NVENC and the file matches the dialog settings', async () => {
  const { page } = h
  await page.keyboard.press('Control+e')
  await expect(page.getByText('NVIDIA NVENC')).toBeVisible({ timeout: 15000 })
  await expect(page.getByText('1920×1080')).toBeVisible()
  await page.getByRole('button', { name: 'Browse' }).click()
  await page.screenshot({ path: join(SHOTS, 'e2e-05a-export-dialog.png') })
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await expect(page.getByText('Export complete')).toBeVisible({ timeout: 120_000 })
  await page.screenshot({ path: join(SHOTS, 'e2e-05-export.png') })
  expect(existsSync(out())).toBe(true)
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out()]).toString())
  const v = probe.streams.find((x: any) => x.codec_type === 'video')
  const a = probe.streams.find((x: any) => x.codec_type === 'audio')
  const s = await state(page)
  const expected = Math.max(...s.clips.map((c) => c.start + c.duration)) / 1e6
  console.log({ codec: v.codec_name, w: v.width, h: v.height, fps: v.r_frame_rate, vbit: v.bit_rate, abit: a.bit_rate, dur: probe.format.duration, expected })
  expect(v.codec_name).toBe('h264')
  expect([v.width, v.height]).toEqual([1920, 1080])
  expect(v.r_frame_rate).toBe('30/1')
  expect(a.codec_name).toBe('aac')
  expect(Number(a.sample_rate)).toBe(48000)
  expect(Math.abs(Number(probe.format.duration) - expected)).toBeLessThan(0.2)
  await page.getByRole('button', { name: 'Done' }).click()
})

test('back to projects shows the project card with its poster', async () => {
  const { page } = h
  await page.getByRole('button', { name: 'All projects' }).click()
  await expect(page.getByText('E2E trailer')).toBeVisible()
  await expect(page.locator('img[src^="media://"]').first()).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(500)
  await page.screenshot({ path: join(SHOTS, 'e2e-06-home.png') })
})
