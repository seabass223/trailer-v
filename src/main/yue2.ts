import { Client, StreamableHTTPClientTransport, type CallToolResult, type Tool } from '@modelcontextprotocol/client'
import { app, ipcMain, shell, type WebContents } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { GenEvent, GenView } from '@shared/ipc'
import type { MediaFile } from '@shared/model'

/**
 * Invoker for YuE2 Studio song generation over MCP (MCP Micro-UI Jobs 0.1.0).
 *
 * The renderer hosts YuE2's View for the form and live progress, but the main process owns the job:
 * it tracks every job with long-polls and delivers the primary artifact into the media folder
 * exactly once, so closing the dialog never loses (or cancels) a song.
 */

const PROFILE = 'dev.micro-ui/jobs'
const APP_MIME = 'text/html;profile=mcp-app'
const ENDPOINT = `http://127.0.0.1:${process.env.YUE2_PORT ?? 7862}/mcp`
const OUT_DIR = 'AI Audio'

interface JobMeta { role: 'start' | 'status' | 'result' | 'cancel'; statusTool?: string; resultTool?: string; cancelTool?: string }
interface Handle { jobId: string; statusTool: string; resultTool: string; cancelTool: string; pollIntervalMs?: number }
interface Artifact { uri: string; name: string; mimeType: string; size: number; sha256: string; role: string; durationMs?: number }
interface ViewSession { folder: string; html: string; label: string; sender: WebContents }
interface Job { handle: Handle; viewId: string; folder: string; label: string; sender: WebContents }

let client: Client | null = null
let connecting: Promise<Client> | null = null
let tools: Tool[] = []
const views = new Map<string, ViewSession>()
const jobs = new Map<string, Job>()
const tracked = new Set<string>()
const delivered = new Set<string>()

const jobMeta = (t: Tool | undefined) => t?._meta?.[PROFILE] as JobMeta | undefined
const startTool = () => tools.find((t) => jobMeta(t)?.role === 'start')

async function connect(): Promise<Client> {
  if (client) return client
  connecting ??= (async () => {
    const c = new Client({ name: 'trailer-v', title: 'Trailer-V', version: app.getVersion() }, {
      // We render the View, so declare MCP Apps (enables the form path) and the jobs profile.
      capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [APP_MIME] }, [PROFILE]: { version: '0.1.0' } } } as never,
      versionNegotiation: { mode: 'auto' },
    })
    c.onclose = () => {
      if (client === c) client = null
    }
    try {
      await c.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT)))
    } catch (e) {
      throw new Error(`YuE2 Studio isn't running. Open it from the Start menu, then try again. (${(e as Error).message})`)
    }
    tools = (await c.listTools()).tools
    if (!startTool()) throw new Error('YuE2 Studio has no song generator tool')
    client = c
    return c
  })().finally(() => (connecting = null))
  return connecting
}

/** One reconnect retry: handles don't survive a backend restart, but a dropped session does. */
async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  try {
    return await fn(await connect())
  } catch (e) {
    if (client && !/YuE2 Studio isn't running/.test((e as Error).message)) throw e
    client = null
    return fn(await connect())
  }
}

const listeners = new Set<(e: GenEvent) => void>()

/** In-process subscribers (the MCP server) see every job event the editor sees. */
export function onGenerateEvent(cb: (e: GenEvent) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function emit(job: { sender: WebContents }, e: GenEvent): void {
  if (!job.sender.isDestroyed()) job.sender.send('generate:event', e)
  for (const l of listeners) l(e)
}

function sc<T>(r: CallToolResult): T {
  return (r.structuredContent ?? {}) as T
}

function errorOf(r: CallToolResult): { code?: string; message: string } {
  const err = sc<{ error?: { code?: string; message?: string } }>(r).error
  const text = r.content?.find((b) => b.type === 'text') as { text?: string } | undefined
  return { code: err?.code, message: err?.message ?? text?.text ?? 'Unknown error' }
}

function adopt(viewId: string, h: Handle): void {
  const v = views.get(viewId)
  if (v) begin({ handle: h, viewId, folder: v.folder, label: v.label, sender: v.sender })
}

function begin(job: Job): void {
  if (!job.handle?.jobId || jobs.has(job.handle.jobId)) return
  jobs.set(job.handle.jobId, job)
  emit(job, { type: 'started', jobId: job.handle.jobId, viewId: job.viewId, label: job.label })
  void track(job)
}

/** View id used for jobs started without a View (MCP). */
export const NO_VIEW = 'mcp'

/**
 * Start a song without the dialog (MCP): same tracking and delivery into `folder`/AI Audio as a
 * View-started job, and the editor shows its progress toast. Returns the job id.
 */
export async function startSong(args: Record<string, unknown>, folder: string, label: string, sender: WebContents): Promise<string> {
  const start = (await connect(), startTool()!)
  const r = await withClient((c) => c.callTool({ name: start.name, arguments: args }))
  if (r.isError) throw new Error(errorOf(r).message)
  const handle = sc<Handle>(r)
  if (!handle.jobId) throw new Error('YuE2 Studio returned no job')
  begin({ handle, viewId: NO_VIEW, folder, label, sender })
  return handle.jobId
}

export async function cancelSong(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (job) await withClient((c) => c.callTool({ name: job.handle.cancelTool, arguments: { jobId } }))
}

/** Spec 6.7 step 4: follow the job ourselves; never rely on the View. */
async function track(job: Job): Promise<void> {
  const { jobId, statusTool } = job.handle
  if (tracked.has(jobId)) return
  tracked.add(jobId)
  let failures = 0
  for (;;) {
    try {
      const r = await withClient((c) =>
        c.callTool({ name: statusTool, arguments: { jobId, waitMs: 25_000 } }, {
          timeout: 45_000,
          onprogress: (p) => emit(job, { type: 'status', jobId, progress: p.progress, message: p.message ?? '', phase: '' }),
        }),
      )
      if (r.isError) {
        const err = errorOf(r)
        return emit(job, { type: 'ended', jobId, state: 'failed', message: err.code === 'not_found' ? 'YuE2 Studio restarted; the song is in its library' : err.message })
      }
      failures = 0
      const s = sc<{ state: string; phase: string; progress: number | null; message: string; error?: { message: string } }>(r)
      emit(job, { type: 'status', jobId, progress: s.progress, message: s.message, phase: s.phase })
      if (s.state === 'completed') return void (await deliver(jobId))
      if (s.state === 'failed' || s.state === 'cancelled') {
        return emit(job, { type: 'ended', jobId, state: s.state, message: s.error?.message ?? s.message })
      }
    } catch (e) {
      if (++failures >= 5) return emit(job, { type: 'ended', jobId, state: 'failed', message: (e as Error).message })
      await new Promise((r) => setTimeout(r, 1000 * failures))
    }
  }
}

/** Spec 6.7 step 5: result → resources/read → verify size + sha256 → write once per jobId. */
async function deliver(jobId: string): Promise<void> {
  const job = jobs.get(jobId)
  if (!job || delivered.has(jobId)) return
  delivered.add(jobId)
  try {
    const r = await withClient((c) => c.callTool({ name: job.handle.resultTool, arguments: { jobId } }))
    if (r.isError) throw new Error(errorOf(r).message)
    const artifacts = sc<{ artifacts: Artifact[] }>(r).artifacts ?? []
    const primary = artifacts.find((a) => a.role === 'primary') ?? artifacts[0]
    if (!primary) throw new Error('The song has no audio')
    const bytes = await fetchVerified(primary)
    const file = await saveInto(job.folder, job.label, primary, bytes)
    emit(job, { type: 'delivered', jobId, viewId: job.viewId, label: job.label, file, artifacts: [primary.uri] })
  } catch (e) {
    delivered.delete(jobId) // the View's `completed` or a later poll may retry
    emit(job, { type: 'ended', jobId, state: 'failed', message: `Couldn't save the song: ${(e as Error).message}` })
  }
}

async function fetchVerified(a: Artifact): Promise<Buffer> {
  for (let attempt = 0; ; attempt++) {
    const res = await withClient((c) => c.readResource({ uri: a.uri }))
    const item = res.contents[0] as { blob?: string; text?: string }
    const bytes = item.blob != null ? Buffer.from(item.blob, 'base64') : Buffer.from(item.text ?? '', 'utf8')
    const hex = createHash('sha256').update(bytes).digest('hex')
    if (bytes.length === a.size && hex === a.sha256) return bytes
    if (attempt >= 1) throw new Error(`verification failed for ${a.uri}`)
  }
}

/** Filename from the user's style prompt, falling back to the server's (path-stripped) name. */
async function saveInto(folder: string, label: string, a: Artifact, bytes: Buffer): Promise<MediaFile> {
  const serverName = basename(a.name.replace(/\\/g, '/'))
  const ext = (extname(serverName).slice(1) || 'mp3').toLowerCase()
  const stem = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48)
    .replace(/[ .,]+$/, '') || basename(serverName, extname(serverName))
  const dir = join(folder, OUT_DIR)
  await mkdir(dir, { recursive: true })
  let name = `${stem}.${ext}`
  for (let i = 2; await exists(join(dir, name)); i++) name = `${stem} (${i}).${ext}`
  const path = join(dir, name)
  await writeFile(path, bytes, { flag: 'wx' })
  return { path, name, rel: join(OUT_DIR, name), ext, kind: 'audio', size: bytes.length, mtime: Date.now() }
}

async function exists(p: string): Promise<boolean> {
  return stat(p).then(() => true, () => false)
}

/** HTML for mcpview://view/<viewId>; served with its own CSP so the parent's never applies. */
export function viewHtml(viewId: string): string | undefined {
  return views.get(viewId)?.html
}

export function registerGenerateIpc(): void {
  ipcMain.handle('generate:openView', async (e, folder: string): Promise<GenView> => {
    const start = (await connect(), startTool()!)
    const uri = (start._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri
    if (!uri) throw new Error('YuE2 Studio has no UI for song generation')
    const item = (await withClient((c) => c.readResource({ uri }))).contents[0] as { text?: string; mimeType?: string }
    if (!item.text) throw new Error('YuE2 Studio returned an empty View')
    const viewId = randomUUID()
    views.set(viewId, { folder, html: item.text, label: 'Generated song', sender: e.sender })
    return { viewId, url: `mcpview://view/${viewId}`, startTool: start.name }
  })

  ipcMain.on('generate:closeView', (_e, viewId: string) => {
    // Never cancels: jobs keep running and still get delivered (spec 6.7 step 7).
    views.delete(viewId)
  })

  ipcMain.handle('generate:callTool', async (_e, viewId: string, name: string, args: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)
    const vis = ((t?._meta?.ui as { visibility?: string[] } | undefined)?.visibility ?? ['model', 'app'])
    if (!t || !vis.includes('app')) throw new Error(`${name} is not available to apps`)
    const role = jobMeta(t)?.role
    const v = views.get(viewId)
    if (role === 'start' && v && typeof args?.style === 'string' && args.style.trim()) v.label = args.style.trim()
    const r = await withClient((c) => c.callTool({ name, arguments: args }, role === 'status' ? { timeout: 45_000 } : undefined))
    // The View's own start call (form submit): adopt now rather than wait for `started`.
    const h = sc<Handle>(r)
    if (role === 'start' && !r.isError && h.jobId) adopt(viewId, h)
    return r
  })

  ipcMain.handle('generate:readResource', (_e, uri: string) => withClient((c) => c.readResource({ uri })))
  ipcMain.on('generate:adopt', (_e, viewId: string, h: Handle) => adopt(viewId, h))
  ipcMain.on('generate:deliverNow', (_e, jobId: string) => void deliver(jobId))
  ipcMain.handle('generate:cancel', (_e, jobId: string) => cancelSong(jobId))
  ipcMain.handle('generate:openLink', (_e, url: string) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
  })
}
