/** Inline text editing on the preview, and the timeline volume line (state asserts + shots). */
import { expect, test, type Page } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject, TEXT_PRESETS } from '../../src/shared/factory'
import type { Project } from '../../src/shared/model'
import { addClip, mainTrack } from '../../src/shared/timeline'
import { FIXTURES, launch, ROOT, stubDialogs, type AppHandle } from './harness'

const S = 1_000_000
const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

const settings = { aspect: '16:9' as const, tier: '1080p' as const, width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }

function withVideo(name: string): Project {
  const p = newProject(name, settings, FIXTURES)
  const main = mainTrack(p).id
  addClip(p, baseClip({ kind: 'video', name: 'coastline.mp4', trackId: main, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true }), main, 0)
  return p
}

async function open(p: Project): Promise<AppHandle> {
  const h = await launch()
  const dir = join(h.dataDir, 'Projects')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
  await stubDialogs(h.app, FIXTURES, join(h.dataDir, 'x.mp4'))
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

const clipOf = (page: Page, id: string) =>
  page.evaluate((cid) => (window as any).__trailer.store.getState().project.clips.find((c: any) => c.id === cid), id)
const plain = (doc: any): string => (doc.content ?? []).map((p: any) => (p.content ?? []).map((n: any) => n.text ?? '').join('')).join('\n')
const pastLen = (page: Page): Promise<number> => page.evaluate(() => (window as any).__trailer.store.getState().past.length)

test('text: edit inline on the preview', async () => {
  const p = withVideo('Inline text test')
  const textTrack = p.tracks.find((t) => t.kind === 'text')!
  const title = baseClip({ kind: 'text', name: 'Title', trackId: textTrack.id, text: structuredClone(TEXT_PRESETS[0].text), duration: 6 * S })
  addClip(p, title, textTrack.id, 0)
  const knock = baseClip({ kind: 'text', name: 'Knockout', trackId: textTrack.id, text: structuredClone(TEXT_PRESETS[3].text), duration: 4 * S })
  addClip(p, knock, textTrack.id, 7 * S)

  const h = await open(p)
  const page = h.page
  try {
    const seek = async (s: number) => {
      await page.evaluate((v) => (window as any).__trailer.engine().seek(v * 1e6), s)
      await page.waitForTimeout(700)
    }
    await seek(2)
    await page.evaluate((id) => (window as any).__trailer.store.setState({ selection: [id] }), title.id)
    const box = page.getByTestId('transform-box')
    await expect(box).toBeVisible()
    const b = (await box.boundingBox())!
    const before = await pastLen(page)

    // Double-click opens the editor exactly over the rendered box, focused.
    await page.mouse.dblclick(b.x + b.width / 2, b.y + b.height / 2)
    const ed = page.getByTestId('inline-text-editor')
    await expect(ed).toBeVisible()
    await expect(ed.locator('.ProseMirror')).toBeFocused()
    const e = (await ed.boundingBox())!
    expect(Math.abs(e.x - b.x)).toBeLessThan(2)
    expect(Math.abs(e.width - b.width)).toBeLessThan(2)
    expect(Math.abs(e.y + e.height / 2 - (b.y + b.height / 2))).toBeLessThan(2)
    expect(Math.abs(e.height - b.height)).toBeLessThan(4)
    expect(await page.evaluate(() => document.fullscreenElement)).toBeNull()

    // Typing commits live (coalesced into one undo step); Escape ends editing.
    await page.keyboard.press('Control+a')
    await page.keyboard.type('Hello inline')
    await expect.poll(async () => plain((await clipOf(page, title.id)).text.doc)).toBe('Hello inline')
    await page.screenshot({ path: join(SHOTS, 'inline-01-editing.png') })
    await page.keyboard.press('Escape')
    await expect(ed).toBeHidden()
    await expect(box).toBeVisible()
    const doc = (await clipOf(page, title.id)).text.doc
    expect(JSON.stringify(doc)).toContain('120px') // styling survives a full replace
    expect(await pastLen(page)).toBe(before + 1)
    expect(await page.evaluate(() => (window as any).__trailer.store.getState().selection)).toEqual([title.id])
    await page.screenshot({ path: join(SHOTS, 'inline-02-committed.png') })

    // Clicking outside (here: the preview canvas) also ends editing. Edits within 1.5 s of
    // each other share an undo step, so leave a gap to keep this session separate.
    await page.waitForTimeout(1600)
    const b2 = (await box.boundingBox())!
    await page.mouse.dblclick(b2.x + b2.width / 2, b2.y + b2.height / 2)
    await expect(ed).toBeVisible()
    await page.keyboard.press('End')
    await page.keyboard.type(' again')
    const frame = (await page.locator('#preview-root canvas').boundingBox())!
    await page.mouse.click(frame.x + 12, frame.y + 12)
    await expect(ed).toBeHidden()
    expect(plain((await clipOf(page, title.id)).text.doc)).toBe('Hello inline again')

    // One undo per editing session.
    await page.keyboard.press('Control+z')
    await expect.poll(async () => plain((await clipOf(page, title.id)).text.doc)).toBe('Hello inline')
    await page.keyboard.press('Control+z')
    await expect.poll(async () => plain((await clipOf(page, title.id)).text.doc)).toBe('A Brighter Tomorrow')

    // Knockout edits as plain letters: no plate behind the editor.
    await seek(8)
    await page.evaluate((id) => (window as any).__trailer.store.setState({ selection: [id] }), knock.id)
    const kb = (await box.boundingBox())!
    const pastKnock = await pastLen(page)
    await page.mouse.dblclick(kb.x + kb.width / 2, kb.y + kb.height / 2)
    await expect(ed).toBeVisible()
    const plate = await ed.evaluate((el) => getComputedStyle(el.firstElementChild as HTMLElement).backgroundColor)
    expect(plate).toBe('rgba(0, 0, 0, 0)')
    await expect(ed).toContainText('COMING SOON')
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, 'inline-03-knockout.png') })
    await page.keyboard.press('Escape')
    await expect(ed).toBeHidden()
    expect(await pastLen(page)).toBe(pastKnock)
  } finally {
    await close(h)
  }
})

test('audio: drag the volume line', async () => {
  const p = withVideo('Volume line test')
  const audioTrack = p.tracks.find((t) => t.kind === 'audio')!
  const music = baseClip({ kind: 'audio', name: 'ambient-music.mp3', trackId: audioTrack.id, source: join(FIXTURES, 'ambient-music.mp3'), duration: 10 * S, sourceDuration: 60 * S, hasAudio: true })
  addClip(p, music, audioTrack.id, 0)
  const video = p.clips.find((c) => c.kind === 'video')!

  const h = await open(p)
  const page = h.page
  try {
    const line = (id: string) => page.locator(`[data-clip="${id}"] [data-testid="volume-line"]`)
    await expect(line(music.id)).toHaveCount(1)
    await expect(line(video.id)).toHaveCount(1)
    const before = await pastLen(page)
    const start = (await clipOf(page, music.id)).start

    // Drag up: live dB tooltip, one undo step on release, clip doesn't move.
    const b = (await line(music.id).boundingBox())!
    const x = b.x + b.width / 2
    const y = b.y + b.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 10; i++) {
      await page.mouse.move(x + i, y - i)
      await page.waitForTimeout(16)
    }
    const tip = page.getByTestId('volume-tip')
    await expect(tip).toBeVisible()
    await expect(tip).toContainText(/^\+\d+\.\d dB\d+%$/)
    await page.screenshot({ path: join(SHOTS, 'volume-01-drag.png') })
    expect(await pastLen(page)).toBe(before) // nothing committed mid-drag
    await page.mouse.up()
    await expect(tip).toHaveCount(0)
    const up = await clipOf(page, music.id)
    expect(up.volume).toBeGreaterThan(1.2)
    expect(up.volume).toBeLessThanOrEqual(2)
    expect(up.start).toBe(start)
    expect(await pastLen(page)).toBe(before + 1)

    // The line follows the new level.
    const b2 = (await line(music.id).boundingBox())!
    expect(b2.y).toBeLessThan(b.y - 5)

    // Video with audio: drag all the way down to silence.
    const v = (await line(video.id).boundingBox())!
    await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2)
    await page.mouse.down()
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(v.x + v.width / 2, v.y + v.height / 2 + i * 8)
      await page.waitForTimeout(16)
    }
    await expect(page.getByTestId('volume-tip')).toContainText('−∞ dB0%')
    await page.mouse.up()
    expect((await clipOf(page, video.id)).volume).toBe(0)
    expect(await pastLen(page)).toBe(before + 2)

    // Double-click resets to 100%; undo brings the dragged level back.
    const b3 = (await line(music.id).boundingBox())!
    await page.mouse.dblclick(b3.x + b3.width / 2, b3.y + b3.height / 2)
    await expect.poll(async () => (await clipOf(page, music.id)).volume).toBe(1)
    await page.keyboard.press('Control+z')
    await expect.poll(async () => (await clipOf(page, music.id)).volume).toBe(up.volume)
  } finally {
    await close(h)
  }
})
