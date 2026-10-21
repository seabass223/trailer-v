/**
 * Library drops from Explorer: files dropped on a tab (or the panel under it) are copied into the
 * media folder with a Windows shell copy, only when they belong on that tab; right-clicking any
 * tab opens the media folder in Explorer.
 *
 * Disk-backed File objects come from a real <input type=file> (Playwright's setInputFiles), so
 * the drop path is the one an Explorer drag takes: webUtils.getPathForFile → shell copy → watcher.
 */
import { expect, test, type Page } from '@playwright/test'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newProject } from '../../src/shared/factory'
import { FIXTURES, launch, ROOT } from './harness'

const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })
const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

/** Dispatch an Explorer-style file drag (enter, over, optionally drop) on `target` with these disk files. */
async function dragFiles(page: Page, target: string, paths: string[], drop = true): Promise<void> {
  const input = page.locator('#e2e-files')
  await input.setInputFiles(paths)
  await page.evaluate(([sel, doDrop]) => {
    const el = document.querySelector(sel as string)!
    const dt = new DataTransfer()
    for (const f of Array.from((document.getElementById('e2e-files') as HTMLInputElement).files!)) dt.items.add(f)
    const fire = (type: string) => el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }))
    fire('dragenter')
    fire('dragover')
    if (doDrop) fire('drop')
  }, [target, drop] as const)
}

const tabSel = (id: string) => `[data-testid="library-tab-${id}"]`
const BODY = '[data-testid="library-body"]'

test('library: drop files from Explorer onto tabs, open the folder in Explorer', async () => {
  const media = mkdtempSync(join(tmpdir(), 'trailer-v-import-'))
  const p = newProject('Import test', settings, media)
  const h = await launch()
  const page = h.page
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await page.reload()
    await page.getByText(p.name).first().click()
    await expect(page.getByText('0 files')).toBeVisible()
    await page.evaluate(() => {
      const i = document.createElement('input')
      i.type = 'file'
      i.multiple = true
      i.id = 'e2e-files'
      i.style.display = 'none'
      document.body.appendChild(i)
    })
    const badge = join(FIXTURES, 'badge.png')
    const music = join(FIXTURES, 'ambient-music.mp3')
    const text = join(FIXTURES, 'title.txt')
    const tabOf = () => page.evaluate(() => (window as any).__trailer.store.getState().libraryTab)

    // Image tab: only the image is copied; the mp3 is reported, not copied.
    await dragFiles(page, tabSel('image'), [badge, music])
    await expect.poll(tabOf).toBe('image')
    await expect.poll(() => readdirSync(media).sort()).toEqual(['badge.png'])
    expect(statSync(join(media, 'badge.png')).size).toBe(statSync(badge).size)
    await expect(page.getByText('Copied badge.png')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText(/this tab takes images/)).toBeVisible()
    // The watcher lists it and the new card is selected.
    await expect(page.getByText('badge.png', { exact: true })).toBeVisible({ timeout: 5000 })
    await page.screenshot({ path: join(SHOTS, 'import-01-image-tab.png') })

    // While dragging an mp3 over the Image tab's panel, the overlay refuses it.
    await dragFiles(page, BODY, [music], false)
    await expect(page.getByTestId('library-drop')).toContainText('This tab takes images')
    await page.screenshot({ path: join(SHOTS, 'import-02-refused.png') })
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="library-body"]')!
      el.dispatchEvent(new DragEvent('dragleave', { dataTransfer: new DataTransfer(), bubbles: true }))
    })

    // Audio tab takes the mp3; the panel under the Text tab takes a txt.
    await dragFiles(page, tabSel('audio'), [music])
    await expect.poll(tabOf).toBe('audio')
    await expect.poll(() => existsSync(join(media, 'ambient-music.mp3'))).toBe(true)
    await page.getByRole('button', { name: 'Text' }).first().click()
    await dragFiles(page, BODY, [text])
    await expect.poll(() => existsSync(join(media, 'title.txt'))).toBe(true)
    await expect(page.getByText('3 files')).toBeVisible({ timeout: 5000 })

    // A file already in the media folder is not copied onto itself.
    await page.getByRole('button', { name: 'Image' }).first().click()
    await dragFiles(page, tabSel('image'), [join(media, 'badge.png')])
    await expect(page.getByText(/already in the media folder/)).toBeVisible()
    expect(readdirSync(media).sort()).toEqual(['ambient-music.mp3', 'badge.png', 'title.txt'])

    // The library must not depend on the folder watcher alone (a deaf watcher left a dropped file
    // unlisted). The watcher skips "~" files, so these only show up through the editor's rescans.
    const files = () => page.evaluate(() => (window as any).__trailer.store.getState().files.map((f: any) => f.name).sort())
    const src = mkdtempSync(join(tmpdir(), 'trailer-v-import-src-'))
    copyFileSync(music, join(src, '~dropped.mp3'))
    await dragFiles(page, tabSel('audio'), [join(src, '~dropped.mp3')])
    await expect.poll(files).toContain('~dropped.mp3') // rescanned right after the copy
    copyFileSync(music, join(media, '~from-explorer.mp3'))
    await page.waitForTimeout(1600)
    expect(await files()).not.toContain('~from-explorer.mp3')
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect.poll(files).toContain('~from-explorer.mp3') // rescanned on focus
    copyFileSync(music, join(media, '~refreshed.mp3'))
    await page.getByRole('button', { name: 'Audio' }).first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Refresh' }).click()
    await expect.poll(files).toContain('~refreshed.mp3') // Refresh in the tab menu

    // Right-click any tab → Open in Explorer opens the media folder.
    await h.app.evaluate(({ shell }) => {
      ;(globalThis as any).__opened = []
      shell.openPath = async (path: string) => {
        ;(globalThis as any).__opened.push(path)
        return ''
      }
    })
    for (const name of ['Media', 'Text']) {
      await page.getByRole('button', { name }).first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: 'Open in Explorer' }).click()
    }
    await page.getByRole('button', { name: 'Audio' }).first().click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: /Generate audio/ })).toBeVisible()
    await page.screenshot({ path: join(SHOTS, 'import-03-tab-menu.png') })
    await page.getByRole('menuitem', { name: 'Open in Explorer' }).click()
    expect(await h.app.evaluate(() => (globalThis as any).__opened)).toEqual([media, media, media])

    const errs = h.logs.filter((l) => /\[(error|pageerror)\]/.test(l))
    expect(errs).toEqual([])
  } finally {
    await h.app.close()
  }
})
