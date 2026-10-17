/** Rich text, system fonts, knockout, and fullscreen preview (visual checks + state asserts). */
import { expect, test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject, TEXT_PRESETS } from '../../src/shared/factory'
import { addClip, mainTrack } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT, stubDialogs } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')

test('text: knockout, fonts, rich styles, fullscreen', async () => {
  const p = newProject('Text test', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, baseClip({ kind: 'video', name: 'coastline.mp4', trackId: main, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true }), main, 0)
  const text = p.tracks.find((t) => t.kind === 'text')!
  const knock = baseClip({ kind: 'text', name: 'Knockout', trackId: text.id, text: structuredClone(TEXT_PRESETS[3].text), duration: 4 * S })
  addClip(p, knock, text.id, 0)
  const title = baseClip({ kind: 'text', name: 'Title', trackId: text.id, text: structuredClone(TEXT_PRESETS[2].text), duration: 4 * S, transform: { fit: 'contain', x: -0.2, y: 0.3, scale: 1 } })
  addClip(p, title, text.id, 5 * S)

  const h = await launch()
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await stubDialogs(h.app, FIXTURES, join(h.dataDir, 'x.mp4'))
    await h.page.reload()
    await h.page.getByText('Text test').first().click()
    await h.page.waitForTimeout(1500)
    const page = h.page
    const seek = async (s: number) => {
      await page.evaluate((v) => (window as any).__trailer.engine().seek(v * 1e6), s)
      await page.waitForTimeout(700)
    }

    // Knockout: video visible only through the letters.
    await seek(2)
    await page.waitForTimeout(1000) // first decode after opening the project
    await page.screenshot({ path: join(SHOTS, 'text-01-knockout.png') })

    // Lower third, then restyle it through the inspector: system font + colour + italic.
    await seek(6)
    await page.evaluate((id) => (window as any).__trailer.store.setState({ selection: [id] }), title.id)
    await expect(page.getByText('Knockout', { exact: true }).first()).toBeVisible()
    const fonts: string[] = await page.evaluate(() => (window as any).__trailer.store.getState().fonts)
    expect(fonts.length).toBeGreaterThan(20)
    const pick = ['Georgia', 'Cambria', 'Consolas', 'Times New Roman'].find((f) => fonts.includes(f))!
    await page.getByRole('button', { name: /Segoe UI/ }).first().click()
    await page.getByPlaceholder(/Search \d+ fonts/).fill(pick)
    await page.getByRole('button', { name: pick, exact: true }).click()
    await page.getByRole('button', { name: 'Italic' }).click()
    await page.waitForTimeout(800)
    const doc = await page.evaluate((id) => (window as any).__trailer.store.getState().project.clips.find((c: any) => c.id === id).text.doc, title.id)
    const marks = JSON.stringify(doc)
    expect(marks).toContain(pick)
    expect(marks).toContain('"italic"')
    await page.screenshot({ path: join(SHOTS, 'text-02-restyled.png') })

    // Undo restores the original font.
    await page.mouse.click(1000, 300)
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await page.waitForTimeout(300)
    const after = JSON.stringify(await page.evaluate((id) => (window as any).__trailer.store.getState().project.clips.find((c: any) => c.id === id).text.doc, title.id))
    expect(after).not.toContain(pick)

    // Fullscreen preview.
    await seek(2)
    await page.keyboard.press('f')
    await page.waitForTimeout(1200)
    await page.screenshot({ path: join(SHOTS, 'text-03-fullscreen.png') })
    expect(await page.evaluate(() => document.fullscreenElement?.id)).toBe('preview-root')
    await page.keyboard.press('Escape')
  } finally {
    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    if (errs.length) console.log(errs.join('\n'))
    await h.app.close()
  }
})
