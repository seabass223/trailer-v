/** Font weight and letter spacing from the text inspector (state asserts + shots). */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject, TEXT_PRESETS } from '../../src/shared/factory'
import { addClip, mainTrack } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT, stubDialogs } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

const docOf = async (page: Page, id: string) =>
  JSON.stringify(await page.evaluate((cid) => (window as any).__trailer.store.getState().project.clips.find((c: any) => c.id === cid).text.doc, id))
const pastLen = (page: Page): Promise<number> => page.evaluate(() => (window as any).__trailer.store.getState().past.length)

test('text: font weight and letter spacing', async () => {
  const p = newProject('Text style test', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, baseClip({ kind: 'video', name: 'coastline.mp4', trackId: main, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true }), main, 0)
  const textTrack = p.tracks.find((t) => t.kind === 'text')!
  const title = baseClip({ kind: 'text', name: 'Title', trackId: textTrack.id, text: structuredClone(TEXT_PRESETS[0].text), duration: 6 * S })
  addClip(p, title, textTrack.id, 0)

  const h = await launch()
  const page = h.page
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await stubDialogs(h.app, FIXTURES, join(h.dataDir, 'x.mp4'))
    await page.reload()
    await page.getByText(p.name).first().click()
    await page.waitForTimeout(1500)
    await page.evaluate(() => (window as any).__trailer.engine().seek(2e6))
    await page.evaluate((id) => (window as any).__trailer.store.setState({ selection: [id] }), title.id)
    const box = page.getByTestId('transform-box')
    await expect(box).toBeVisible()

    // Weight menu lists the font's real faces (Segoe UI ships Light…Black) and starts at Bold.
    const weight = page.getByRole('combobox', { name: 'Font weight' })
    await expect(weight).toContainText('Bold')
    await weight.click()
    for (const name of ['Light', 'Semilight', 'Regular', 'Semibold', 'Bold', 'Black']) {
      await expect(page.getByRole('option', { name: new RegExp(`^${name}\\s*\\d+$`) })).toBeVisible()
    }
    const before = await pastLen(page)
    await page.getByRole('option', { name: /^Light\s*300$/ }).click()
    await expect.poll(() => docOf(page, title.id)).toContain('"fontWeight":"300"')
    expect(await docOf(page, title.id)).not.toContain('"bold"')
    expect(await pastLen(page)).toBe(before + 1)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'text-style-01-light.png') })

    // The inline editor renders the same weight.
    const b = (await box.boundingBox())!
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
    const span = page.getByTestId('inline-text-editor').locator('span[style*="font-weight"]').first()
    await expect(span).toHaveCSS('font-weight', '300')
    await page.keyboard.press('Escape')

    // Bold toggles between Bold and Regular through the weight; undo goes back to Light. (Text
    // edits within 1.5 s share an undo step, so leave a gap.)
    await page.waitForTimeout(1600)
    await page.getByRole('button', { name: 'Bold' }).click()
    await expect(weight).toContainText('Bold')
    await expect.poll(() => docOf(page, title.id)).toContain('"bold"')
    expect(await docOf(page, title.id)).not.toContain('"fontWeight":"')
    // Leave the inspector's editor so Ctrl+Z is the editor-wide undo, not TipTap's own.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.keyboard.press('Control+z')
    await expect.poll(() => docOf(page, title.id)).toContain('"fontWeight":"300"')

    // Letter spacing: keyboard on the slider keeps focus there, coalesces into one undo step,
    // and wide tracking re-wraps the rendered text (the box grows a line).
    const h0 = (await box.boundingBox())!.height
    const spacing = page.getByText('Letter spacing').locator('..').getByRole('slider')
    await spacing.focus()
    const beforeSpacing = await pastLen(page)
    for (let i = 0; i < 4; i++) await page.keyboard.press('PageUp')
    await expect(spacing).toBeFocused()
    await expect.poll(() => docOf(page, title.id)).toContain('"letterSpacing":"0.4em"')
    expect(await pastLen(page)).toBe(beforeSpacing + 1)
    await expect.poll(async () => (await box.boundingBox())!.height).toBeGreaterThan(h0 * 1.4)
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, 'text-style-02-spacing.png') })

    // Typing a font size keeps focus in the field and doesn't touch the text.
    const size = page.getByRole('spinbutton', { name: 'Font size' })
    await size.click()
    await size.press('Control+a')
    await size.pressSequentially('84', { delay: 120 })
    await expect(size).toBeFocused()
    await expect.poll(() => docOf(page, title.id)).toContain('"fontSize":"84px"')
    expect(await docOf(page, title.id)).toContain('A Brighter Tomorrow')
  } finally {
    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    if (errs.length) console.log(errs.join('\n'))
    await h.app.close()
  }
})
