/**
 * The in-app MCP server, driven by a real MCP client over Streamable HTTP: create a project,
 * build a timeline (media, text, cross-fade, layered track), check frames rendered by the export
 * compositor, undo, and export an MP4 through NVENC that ffprobe agrees with.
 */
import { Client, StreamableHTTPClientTransport, type CallToolResult } from '@modelcontextprotocol/client'
import { expect, test } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from '@playwright/test'
import { FIXTURES, ROOT } from './harness'

const PORT = 7873
const SHOTS = join(ROOT, 'test-results', 'shots')
mkdirSync(SHOTS, { recursive: true })

type Json = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any

test('mcp: build a timeline, render frames and export through the MCP server', async () => {
  test.setTimeout(240_000)
  const dataDir = mkdtempSync(join(tmpdir(), 'trailer-v-mcp-'))
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, TRAILER_DATA_DIR: dataDir, TRAILER_MCP_PORT: String(PORT), ELECTRON_RENDERER_URL: '' },
  })
  const logs: string[] = []
  app.process().stdout?.on('data', (d: Buffer) => logs.push(d.toString().trim()))
  const page = await app.firstWindow()
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))

  const client = new Client({ name: 'e2e', version: '0.0.1' }, { versionNegotiation: { mode: 'auto' } } as never)
  await expect.poll(async () => {
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`)))
      return true
    } catch {
      return false
    }
  }, { timeout: 20_000 }).toBe(true)

  const call = async (name: string, args: Json = {}): Promise<CallToolResult> => {
    const r = (await client.callTool({ name, arguments: args }, { timeout: 120_000 })) as CallToolResult
    if (r.isError) throw new Error(`${name}: ${(r.content[0] as { text: string }).text}`)
    return r
  }
  const data = async (name: string, args: Json = {}): Promise<Json> => (await call(name, args)).structuredContent as Json
  const image = async (name: string, args: Json, file: string) => {
    const r = await call(name, args)
    const img = r.content.find((c) => c.type === 'image') as { data: string; mimeType: string }
    expect(img.mimeType).toBe('image/jpeg')
    const bytes = Buffer.from(img.data, 'base64')
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
    writeFileSync(join(SHOTS, file), bytes)
    return bytes
  }

  try {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    for (const n of ['create_project', 'add_media_clip', 'add_text_clip', 'render_frame', 'export_video', 'generate_music', 'job_status']) expect(names).toContain(n)
    expect(tools.length).toBeGreaterThanOrEqual(35)

    const status = await data('get_status')
    expect(status.screen).toBe('home')
    expect(status.encoders.h264_nvenc).toBe(true)

    const p = await data('create_project', { name: 'MCP test', aspect: '16:9', tier: '1080p', fps: 30, mediaFolder: FIXTURES })
    expect(p.settings).toMatchObject({ width: 1920, height: 1080, fps: 30 })
    await expect(page.getByText('MCP test').first()).toBeVisible()

    const media = await data('list_media', { kind: 'video' })
    expect(media.files.map((f: Json) => f.rel)).toContain('coastline.mp4')
    const probe = await data('probe_media', { path: 'coastline.mp4' })
    expect(probe).toMatchObject({ width: 1920, height: 1080, hasAudio: true })
    expect(probe.duration).toBeCloseTo(12, 1)

    // Two trimmed main-track clips with a cross-fade.
    const a = (await data('add_media_clip', { path: 'coastline.mp4', inPoint: 2, duration: 4 })).clip
    const b = (await data('add_media_clip', { path: 'mountains.mp4', duration: 3, fadeOut: { duration: 0.5 } })).clip
    expect(a).toMatchObject({ start: 0, duration: 4, inPoint: 2 })
    expect(b.start).toBe(4)
    const x = await data('set_transition', { from: a.id, duration: 1 })
    expect(x.transition.duration).toBe(1)

    // A styled title and a second text layer overlapping it on a new track.
    const title = (await data('add_text_clip', {
      paragraphs: [{ runs: [{ text: 'TRAILER', weight: 900, letterSpacing: 0.12 }, { text: '-V', color: '#ff6b35', weight: 900 }] }],
      style: { font: 'Segoe UI', size: 140 }, start: 0.5, duration: 3, fadeIn: { duration: 0.3 },
    })).clip
    expect(title.text.plain).toBe('TRAILER-V')
    expect(title.text.style).toMatchObject({ size: 140, weight: 900 })
    const sub = await data('add_text_clip', { text: 'Built for RTX', preset: 'subtitle', start: 1, duration: 2, track: 'new' })
    expect(sub.clip.start).toBe(1)
    expect(sub.clip.track).not.toBe(title.track)

    // Edits are undoable steps in the editor's own history.
    await data('update_clip', { id: title.id, style: { color: '#ffd166' }, transform: { y: -0.1 } })
    expect((await data('get_history')).past.at(-1)).toBe('Edit TRAILER-V')
    await data('undo')
    const tl = await data('get_project')
    const t2 = tl.clips.find((c: Json) => c.id === title.id)
    expect(t2.transform.y).toBe(0)
    expect(tl.duration).toBeCloseTo(7, 2) // cross-fades are centred on the cut: clips stay back to back
    expect(tl.transitions).toHaveLength(1)

    await image('render_frame', { time: 1.5, width: 960 }, 'mcp-01-frame.jpg')
    await image('render_storyboard', { count: 8, tileWidth: 320 }, 'mcp-02-storyboard.jpg')
    await image('screenshot_window', { width: 1280 }, 'mcp-03-window.jpg')

    // Export through NVENC and check the file.
    const out = join(dataDir, 'mcp-export.mp4')
    let job = await data('export_video', { outputPath: out, waitSeconds: 50 })
    for (let i = 0; job.state === 'running' && i < 10; i++) job = await data('job_status', { jobId: job.jobId, waitSeconds: 30 })
    expect(job.state, JSON.stringify(job)).toBe('completed')
    expect(job.result.path).toBe(out)
    const probeOut = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out]).toString())
    const v = probeOut.streams.find((s: Json) => s.codec_type === 'video')
    expect(v).toMatchObject({ codec_name: 'h264', width: 1920, height: 1080 })
    expect(probeOut.streams.some((s: Json) => s.codec_type === 'audio')).toBe(true)
    expect(Math.abs(Number(probeOut.format.duration) - tl.duration)).toBeLessThan(0.2)

    // Refuses to clobber, and errors come back as tool errors.
    const again = (await client.callTool({ name: 'export_video', arguments: { outputPath: out } })) as CallToolResult
    expect(again.isError).toBe(true)
    const bad = (await client.callTool({ name: 'add_media_clip', arguments: { path: 'nope.mp4' } })) as CallToolResult
    expect(bad.isError).toBe(true)

    await data('close_project')
    expect((await data('get_status')).screen).toBe('home')
    expect(logs.filter((l) => /pageerror/.test(l))).toEqual([])
  } finally {
    await client.close().catch(() => {})
    await app.close()
  }
})
