/**
 * Track headers: rename inline, drag rows to reorder (the main track stays the bottom video
 * row), menu Move up/down, and a resizable name column that persists across reloads.
 */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newProject } from '../../src/shared/factory'
import type { Project } from '../../src/shared/model'
import { insertTrack } from '../../src/shared/timeline'
import { drag, FIXTURES, launch, ROOT, stubDialogs, type AppHandle } from './harness'

const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

async function open(p: Project): Promise<AppHandle> {
  const h = await launch()
  const dir = join(h.dataDir, 'Projects')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
  await stubDialogs(h.app, FIXTURES, join(h.dataDir, 'out.mp4'))
  await h.page.reload()
  await h.page.getByText(p.name).first().click()
  await h.page.waitForTimeout(1000)
  return h
}

const project = (page: Page): Promise<Project> => page.evaluate(() => (window as any).__trailer.store.getState().project)
const names = async (page: Page) => (await project(page)).tracks.map((t) => t.name)
const center = async (page: Page, sel: string) => {
  const b = (await page.locator(sel).boundingBox())!
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
}

test('rename, reorder and resize track headers', async () => {
  const p = newProject('Headers', settings, FIXTURES)
  insertTrack(p, 'video')
  const id = (n: string) => p.tracks.find((t) => t.name === n)!.id
  const h = await open(p)
  const { page } = h
  try {
    expect(await names(page)).toEqual(['Video 2', 'Video', 'Text', 'Image', 'Audio'])

    // Rename by double-click.
    await page.locator(`[data-track="${id('Text')}"] span`).first().dblclick()
    await page.getByRole('textbox', { name: 'Track name' }).fill('Titles')
    await page.keyboard.press('Enter')
    expect(await names(page)).toContain('Titles')

    // Drag Audio to the top.
    const header = (n: string) => `[data-track="${id(n)}"]`
    const audio = await center(page, header('Audio'))
    const top = await center(page, header('Video 2'))
    await drag(page, { x: audio.x + 20, y: audio.y }, { x: audio.x + 20, y: top.y - 20 })
    expect(await names(page)).toEqual(['Audio', 'Video 2', 'Video', 'Titles', 'Image'])

    // Video 2 can't go below the main video track: it clamps to just above it (no change).
    const v2 = await center(page, header('Video 2'))
    const img = await center(page, header('Image'))
    await drag(page, { x: v2.x + 20, y: v2.y }, { x: v2.x + 20, y: img.y + 20 })
    expect(await names(page)).toEqual(['Audio', 'Video 2', 'Video', 'Titles', 'Image'])

    // Menu: move Image up.
    await page.locator(header('Image')).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Move up' }).click()
    expect(await names(page)).toEqual(['Audio', 'Video 2', 'Video', 'Image', 'Titles'])
    // Main track can't move above Video 2.
    await page.locator(header('Video')).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Move up' })).toBeDisabled()
    await page.keyboard.press('Escape')

    // Undo restores the previous order.
    await page.keyboard.press('Control+z')
    expect(await names(page)).toEqual(['Audio', 'Video 2', 'Video', 'Titles', 'Image'])

    // Resize the name column.
    const before = (await page.locator(header('Audio')).boundingBox())!.width
    // A track row's handle (in the ruler row the playhead head sits on the edge at 0s).
    const grip = page.locator(header('Audio')).getByRole('separator', { name: 'Resize track names' })
    const g = (await grip.boundingBox())!
    await drag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: g.x + g.width / 2 + 120, y: g.y + g.height / 2 })
    const after = (await page.locator(header('Audio')).boundingBox())!.width
    expect(after).toBeGreaterThan(before + 100)
    await page.screenshot({ path: join(SHOTS, 'track-headers.png') })

    // Persists across reload.
    await page.reload()
    await page.getByText('Headers').first().click()
    await page.waitForTimeout(800)
    expect((await page.locator(header('Audio')).boundingBox())!.width).toBeCloseTo(after, 0)
  } finally {
    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    if (errs.length) console.log(errs.join('\n'))
    await h.app.close()
  }
})
