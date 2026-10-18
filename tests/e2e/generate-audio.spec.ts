/**
 * Generate audio: right-click the Audio tab → YuE2 Studio's MCP Apps View (form → progress),
 * the main process tracks the job and saves the verified MP3 into <media folder>/AI Audio.
 * Needs YuE2 Studio running on 127.0.0.1:7862; skipped otherwise.
 */
import { expect, test } from '@playwright/test'
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '../../src/shared/factory'
import { launch, ROOT } from './harness'

const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })
const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

test('generate audio: form in the YuE2 View, delivered into the media folder', async () => {
  const up = await fetch('http://127.0.0.1:7862/api/health').then((r) => r.ok, () => false)
  test.skip(!up, 'YuE2 Studio is not running')
  test.setTimeout(600_000)

  const media = mkdtempSync(join(tmpdir(), 'trailer-v-gen-'))
  const p = newProject('Gen test', settings, media)
  const h = await launch()
  const dir = join(h.dataDir, 'Projects')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
  await h.page.reload()
  await h.page.getByText(p.name).first().click()
  await h.page.waitForTimeout(1000)

  await h.page.getByRole('button', { name: 'Audio' }).click({ button: 'right' })
  await h.page.getByRole('menuitem', { name: /Generate audio/ }).click()
  await expect(h.page.getByRole('dialog', { name: 'Generate audio' })).toBeVisible()
  const view = h.page.frameLocator('iframe[title="YuE2 Studio"]')
  await expect(view.locator('textarea, input').first()).toBeVisible({ timeout: 30_000 })
  await h.page.screenshot({ path: join(SHOTS, 'generate-form.png') })

  await view.locator('#style').fill('warm lofi piano, mellow')
  await view.getByRole('switch', { name: 'Instrumental' }).click()
  await view.getByRole('slider').focus()
  await h.page.keyboard.press('Home') // shortest song (10 s)
  await view.getByRole('button', { name: /Generate/ }).click()
  await expect(view.getByText(/Generating|Waiting|Loading|Planning|queued/i).first()).toBeVisible({ timeout: 30_000 })
  await h.page.screenshot({ path: join(SHOTS, 'generate-progress.png') })

  // Closing the dialog must not cancel: the main process still delivers the song.
  await h.page.getByRole('button', { name: 'Close' }).click()
  await expect(h.page.getByRole('dialog', { name: 'Generate audio' })).toBeHidden()
  await expect(h.page.getByText('warm lofi piano, mellow').first()).toBeVisible() // progress toast

  await expect(h.page.getByText('Song ready')).toBeVisible({ timeout: 480_000 })
  const out = readdirSync(join(media, 'AI Audio'))
  expect(out).toEqual(['warm lofi piano, mellow.mp3'])
  // The library watcher picks it up on the Audio tab; "Add at playhead" puts it on the timeline.
  await expect(h.page.getByText('1 files')).toBeVisible({ timeout: 3_000 })
  await h.page.screenshot({ path: join(SHOTS, 'generate-done.png') })
  await h.page.getByRole('button', { name: 'Add at playhead' }).click()
  await expect.poll(() => h.page.evaluate(() => (window as any).__trailer.store.getState().project.clips.length)).toBe(1)
  const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
  expect(errs).toEqual([])
  await h.app.close()
})
