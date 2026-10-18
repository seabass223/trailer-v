/** The "+ Track" button stays reachable however far the track list is scrolled. */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { newProject } from '../../src/shared/factory'
import { insertTrack } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT } from './harness'

const SHOTS = join(ROOT, 'test-results', 'shots')

test('+ Track stays pinned at the top of the track list while scrolling', async () => {
  const p = newProject('Many tracks', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  for (let i = 0; i < 14; i++) insertTrack(p, 'video')
  const h = await launch()
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await h.page.reload()
    const page = h.page
    await page.getByText('Many tracks').first().click()
    await page.waitForTimeout(1000)
    const button = page.getByRole('button', { name: 'Track', exact: true })
    const top0 = (await button.boundingBox())!.y

    // Scroll the track list to the bottom.
    await page.evaluate(() => {
      const sc = document.querySelector('[data-timeline-scroll]') ?? document.querySelector('section.bg-timeline .overflow-auto')
      sc!.scrollTop = sc!.scrollHeight
    })
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'track-button-scrolled.png') })
    const box = await button.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.abs(box!.y - top0)).toBeLessThan(2)
    await expect(button).toBeInViewport()
    // Not just positioned there: nothing (track headers, playhead) may paint over it.
    const onTop = () =>
      button.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return !!hit && el.contains(hit)
      })
    expect(await onTop()).toBe(true)

    // Scrolled sideways too: the playhead passes under the track-name column, not over it.
    await page.evaluate(() => {
      const t = (window as any).__trailer
      t.engine().seek(2e6)
      const sc = document.querySelector('section.bg-timeline .overflow-auto')!
      sc.scrollLeft = 600
    })
    await page.waitForTimeout(300)
    expect(await onTop()).toBe(true)
    await page.evaluate(() => (document.querySelector('section.bg-timeline .overflow-auto')!.scrollLeft = 0))

    // And it still works from there.
    const before = await page.evaluate(() => (window as any).__trailer.store.getState().project.tracks.length)
    await button.click()
    await page.getByRole('menuitem', { name: 'Text track' }).click()
    expect(await page.evaluate(() => (window as any).__trailer.store.getState().project.tracks.length)).toBe(before + 1)
  } finally {
    await h.app.close()
  }
})
