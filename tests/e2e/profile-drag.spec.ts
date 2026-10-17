/** Diagnostic: CPU profile of the first 300 ms of a trim drag (prints top self-time functions). */
import { test } from '@playwright/test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { baseClip, newProject } from '../../src/shared/factory'
import { addClip, mainTrack } from '../../src/shared/timeline'
import { FIXTURES, launch } from './harness'

const S = 1_000_000

test('profile drag start', async () => {
  test.skip(!process.env.PROFILE, 'diagnostic: run with PROFILE=1')
  const h = await launch()
  try {
    const p = newProject('Prof', { aspect: '16:9', tier: '1080p', width: 1920, height: 1080, fps: 30, background: '#000000', historyDepth: 200 }, FIXTURES)
    const main = mainTrack(p).id
    addClip(p, baseClip({ kind: 'video', name: 'coastline.mp4', trackId: main, source: join(FIXTURES, 'coastline.mp4'), duration: 12 * S, sourceDuration: 12 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true }), main, 0)
    addClip(p, baseClip({ kind: 'video', name: 'mountains.mp4', trackId: main, source: join(FIXTURES, 'mountains.mp4'), duration: 8 * S, sourceDuration: 8 * S, mediaWidth: 1920, mediaHeight: 1080, hasAudio: true }), main, 1e9)
    const dir = join(h.dataDir, 'Projects')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${p.id}.tvproj`), JSON.stringify(p))
    await h.page.reload()
    const page = h.page
    await page.getByText('Prof').first().click()
    await page.waitForTimeout(4000)
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Profiler.enable')
    await cdp.send('Profiler.setSamplingInterval', { interval: 100 })
    const clip = (await page.locator('[data-clip]').first().boundingBox())!
    const y = clip.y + clip.height / 2
    const x0 = clip.x + clip.width - 3
    if (process.env.WARM_DRAG) {
      // A first drag to see whether the hitch is a one-time (shader compile) cost.
      await page.mouse.move(x0, y)
      await page.mouse.down()
      for (let i = 1; i <= 10; i++) {
        await page.mouse.move(x0 - i * 3, y)
        await page.waitForTimeout(8)
      }
      await page.mouse.up()
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(500)
    }
    if (process.env.NO_INSPECTOR) await page.evaluate(() => (window as any).__trailer.store.setState({ inspectorOpen: false }))
    await page.waitForTimeout(300)
    await page.mouse.move(x0, y)
    const events: any[] = []
    cdp.on('Tracing.dataCollected', (d: any) => events.push(...d.value))
    const done = new Promise<void>((r) => cdp.once('Tracing.tracingComplete', () => r()))
    await cdp.send('Tracing.start', { categories: 'devtools.timeline,disabled-by-default-devtools.timeline', transferMode: 'ReportEvents' })
    await cdp.send('Profiler.start')
    await page.mouse.down()
    for (let i = 1; i <= 20; i++) {
      await page.mouse.move(x0 - i * 3, y)
      await page.waitForTimeout(8)
    }
    const { profile } = await cdp.send('Profiler.stop')
    await cdp.send('Tracing.end')
    await done
    await page.mouse.up()
    const dur = new Map<string, { total: number; max: number; n: number }>()
    for (const e of events) {
      if (e.ph !== 'X' || !e.dur) continue
      const d = dur.get(e.name) ?? { total: 0, max: 0, n: 0 }
      d.total += e.dur / 1000
      d.max = Math.max(d.max, e.dur / 1000)
      d.n++
      dur.set(e.name, d)
    }
    const gpu = events.filter((e) => e.name === 'GPUTask' && e.ph === 'X').sort((a, b) => b.dur - a.dur)[0]
    if (gpu) {
      const threadNames = new Map(events.filter((e) => e.name === 'thread_name').map((e) => [`${e.pid}:${e.tid}`, e.args.name]))
      console.log(`LONGEST GPUTask ${(gpu.dur / 1000).toFixed(1)} ms on ${threadNames.get(`${gpu.pid}:${gpu.tid}`)}; preceding 60 ms:`)
      const before = events
        .filter((e) => e.ts >= gpu.ts - 60_000 && e.ts <= gpu.ts + 2_000 && (e.dur ?? 0) > 300 && e.name !== 'RunTask' && e.name !== 'GPUTask')
        .sort((a, b) => a.ts - b.ts)
        .slice(0, 40)
      for (const e of before) {
        const where = threadNames.get(`${e.pid}:${e.tid}`) ?? `${e.pid}:${e.tid}`
        const detail = e.args?.data ? JSON.stringify(e.args.data).slice(0, 140) : ''
        console.log(`  ${((e.ts - gpu.ts) / 1000).toFixed(1).padStart(6)} ms +${((e.dur ?? 0) / 1000).toFixed(1)} ${where} ${e.name} ${detail}`)
      }
    }
    console.log('TRACE (total / max / count):')
    console.log([...dur.entries()].sort((a, b) => b[1].max - a[1].max).slice(0, 16)
      .map(([k, v]) => `${v.total.toFixed(1).padStart(7)} ms  max ${v.max.toFixed(1).padStart(6)}  x${v.n}  ${k}`).join('\n'))
    const byId = new Map(profile.nodes.map((n: any) => [n.id, n]))
    const self = new Map<string, number>()
    const dt = profile.timeDeltas
    profile.samples.forEach((id: number, i: number) => {
      const n: any = byId.get(id)
      const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`
      self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000)
    })
    const top = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)')).sort((a, b) => b[1] - a[1]).slice(0, 18)
    console.log(top.map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`).join('\n'))
    const idle = [...self.entries()].filter(([k]) => k.startsWith('(idle)') || k.startsWith('(program)'))
    console.log(idle.map(([k, v]) => `${v.toFixed(1).padStart(7)} ms  ${k}`).join('\n'))
  } finally {
    await h.app.close()
  }
})
