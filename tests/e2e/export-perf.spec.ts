/**
 * Export throughput benchmarks on realistic trailers (cross-fades, a title, music).
 * Budget from the plan: >= 5x real-time for 1080p30 output from 1080p sources.
 * 4K60 sources are decode-bound (two decoded frames per output frame) and reported separately.
 */
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject, TEXT_PRESETS } from '../../src/shared/factory'
import type { Project } from '../../src/shared/model'
import { addClip, mainTrack, projectDuration, setTransition } from '../../src/shared/timeline'
import { FIXTURES, launch, stubDialogs } from './harness'

const S = 1_000_000
type Src = [name: string, seconds: number, w: number, h: number, audio: boolean]

function buildProject(name: string, sources: Src[]): Project {
  const p = newProject(name, { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
  const main = mainTrack(p).id
  const clips = sources.map(([file, dur, w, h, audio]) =>
    baseClip({ kind: 'video', name: file, trackId: main, source: join(FIXTURES, file), duration: dur * S, sourceDuration: dur * S, mediaWidth: w, mediaHeight: h, hasAudio: audio }))
  for (const c of clips) addClip(p, c, main, 1e10)
  for (let i = 0; i + 1 < clips.length; i++) setTransition(p, clips[i].id, clips[i + 1].id, S)
  const text = p.tracks.find((t) => t.kind === 'text')!
  addClip(p, baseClip({ kind: 'text', name: 'Title', trackId: text.id, text: structuredClone(TEXT_PRESETS[0].text), duration: 6 * S }), text.id, 2 * S)
  const audio = p.tracks.find((t) => t.kind === 'audio')!
  addClip(p, baseClip({ kind: 'audio', name: 'ambient-music.mp3', trackId: audio.id, source: join(FIXTURES, 'ambient-music.mp3'), duration: projectDuration(p), sourceDuration: 60 * S, hasAudio: true }), audio.id, 0)
  return p
}

async function bench(p: Project): Promise<number> {
  const h = await launch()
  try {
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    const out = join(h.dataDir, 'bench.mp4')
    await stubDialogs(h.app, FIXTURES, out)
    await h.page.reload()
    await h.page.getByText(p.name).first().click()
    await h.page.waitForTimeout(1500)
    await h.page.keyboard.press('Control+e')
    await h.page.getByRole('button', { name: 'Browse' }).click()
    const t0 = Date.now()
    await h.page.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(h.page.getByText('Export complete')).toBeVisible({ timeout: 120_000 })
    const secs = (Date.now() - t0) / 1000
    const dur = projectDuration(p) / S
    console.log(h.logs.filter((l) => l.startsWith('[log] [export]')).join('\n'))
    console.log(`${p.name}: ${dur.toFixed(1)}s exported in ${secs.toFixed(1)}s = ${(dur / secs).toFixed(1)}x real-time (${((dur * 30) / secs).toFixed(0)} fps)`)
    const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString())
    expect(Math.abs(Number(probe.format.duration) - dur)).toBeLessThan(0.2)
    return dur / secs
  } finally {
    await h.app.close()
  }
}

test('export throughput: 1080p sources', async () => {
  const speed = await bench(buildProject('Bench 1080p', [
    ['coastline.mp4', 12, 1920, 1080, true],
    ['mountains.mp4', 8, 1920, 1080, true],
    ['hevc-bars.mp4', 6, 1920, 1080, false],
    ['coastline.mp4', 12, 1920, 1080, true],
  ]))
  expect(speed).toBeGreaterThanOrEqual(5)
})

test('export throughput: mixed with 4K60', async () => {
  await bench(buildProject('Bench 4K mix', [
    ['coastline.mp4', 12, 1920, 1080, true],
    ['forest.mp4', 14, 3840, 2160, false],
    ['mountains.mp4', 8, 1920, 1080, true],
  ]))
})
