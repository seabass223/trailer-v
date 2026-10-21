/**
 * Trailer-V's MCP server: Streamable HTTP on 127.0.0.1 (default port 7863), served from the main
 * process for as long as the app runs. Edits are forwarded to the open editor (one undo step
 * each, autosaved, visible live); exports and song generation run as jobs.
 *
 * Point an MCP client at http://127.0.0.1:7863/mcp. TRAILER_MCP_PORT changes the port and
 * TRAILER_MCP=0 turns the server off.
 */
import { app, type BrowserWindow } from 'electron'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  createMcpHandler, hostHeaderValidationResponse, localhostAllowedHostnames, localhostAllowedOrigins, McpServer,
  originValidationResponse, type CallToolResult, type ServerContext,
} from '@modelcontextprotocol/server'
import * as z from 'zod'
import type { EditorStateView, FrameImage, ProjectView } from '@shared/automation'
import type { ExportEvent, ExportJob, GenEvent } from '@shared/ipc'
import type { MediaFile, MediaMeta, Project } from '@shared/model'
import { ASPECTS, AUDIO_BITRATES, DEFAULT_AUDIO_KBPS, FPS_OPTIONS, recommendedVideoMbps, resolutionFor, SUPPORTED_EXTENSIONS } from '@shared/presets'
import { TEXT_PRESETS } from '@shared/factory'
import { frameIndex } from '@shared/time'
import { projectDuration } from '@shared/timeline'
import { encoderCaps } from '../encoder'
import { cancelExport, exportRunning, startExport } from '../export-window'
import { listFonts } from '../fonts'
import { scanFolder } from '../library'
import { createProject, duplicateProject, listProjects, removeProject } from '../projects'
import { cancelSong, onGenerateEvent, startSong } from '../yue2'
import { callEditor, registerAutomationIpc, trackPage } from './bridge'
import { createJob, getJob, jobView, runningJob, updateJob, waitFor, type Job } from './jobs'

const DEFAULT_PORT = 7863

const INSTRUCTIONS = `Trailer-V is a GPU video editor for YouTube. These tools drive the running app: edits appear live in its editor, each is one undo step, and projects autosave.

Model
- Times are seconds. The project frame is settings.width x settings.height at settings.fps.
- Tracks are rows. The bottom video row is the MAIN track and is magnetic: its clips always run back to back from 0 (no gaps); adding there inserts at the nearest clip boundary. Every other track is free placement and never overlaps clips on the same row: add a track (or pass track "new") to layer clips at the same time.
- Draw order: video tracks (upper rows on top) < image tracks < text tracks (upper rows on top).
- transform: fit "contain"|"cover" scales media to the frame, then scale multiplies it; x/y move the layer centre by a fraction of frame width/height (0,0 = centred; y 0.3 = 30% of the height below centre).
- Text sizes and paddings are reference px: 1 unit = 1px on a 1080px short side. Text box width is a fraction of frame width. knockout cuts the letters out of the box (fullFrame: the whole frame) so the video shows through.
- Fades: fadeIn/fadeOut on a main/video-track clip dip to its colour (or dissolve into the video track below); on overlays they fade opacity. set_transition makes a centred cross-fade between two touching clips.

Workflow
1. get_status, then create_project or open_project.
2. list_media / probe_media, add_media_clip, add_text_clip; update/move/trim as needed.
3. Check the cut with render_storyboard and render_frame (the same compositor as export).
4. export_video writes an MP4 with NVENC; generate_music makes a soundtrack with YuE2 Studio. Both are jobs: poll job_status until state is completed.`

type Win = () => BrowserWindow | null

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

const textResult = (data: unknown): CallToolResult => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
})

const jsonResult = (data: Record<string, unknown>): CallToolResult => ({ ...textResult(data), structuredContent: data })

const imageResult = (bytes: ArrayBuffer | Buffer, mimeType: string, caption: string): CallToolResult => ({
  content: [
    { type: 'image', data: Buffer.from(bytes as ArrayBuffer).toString('base64'), mimeType },
    { type: 'text', text: caption },
  ],
})

/** Progress notifications for clients that sent a progressToken (throttled, monotonic). */
function progressReporter(ctx: ServerContext): (progress: number, message: string) => void {
  const token = ctx.mcpReq._meta?.progressToken
  if (token == null) return () => {}
  let last = 0
  let best = -1
  return (progress, message) => {
    const now = Date.now()
    if (progress <= best || now - last < 400) return
    last = now
    best = progress
    void ctx.mcpReq
      .notify({ method: 'notifications/progress', params: { progressToken: token, progress, total: 100, message } })
      .catch(() => {})
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const Color = z.string().regex(/^#([0-9a-f]{6}|[0-9a-f]{8})$/i, 'hex colour like #ff6b35').describe('Hex colour, #rrggbb')
const Seconds = z.number().min(0)
const TrackRef = z
  .string()
  .describe('Track id or name from get_project, "main" (magnetic video track), "new" (a fresh track of the clip\'s kind) or a kind: video|image|text|audio')
const TextStyle = z
  .object({
    font: z.string().optional().describe('Installed font family (see list_fonts)'),
    size: z.number().positive().max(2000).optional().describe('Reference px (1 = 1px on a 1080px short side)'),
    color: Color.optional(),
    weight: z.number().int().min(100).max(950).optional().describe('400 regular, 700 bold; any 100-900'),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    letterSpacing: z.number().min(-0.5).max(2).optional().describe('Tracking in em, e.g. 0.12'),
  })
  .describe('Text run style')
const Align = z.enum(['left', 'center', 'right'])
const Fade = z.object({ duration: Seconds, color: Color.optional() })
const Transform = z
  .object({
    fit: z.enum(['contain', 'cover']).optional(),
    x: z.number().min(-2).max(2).optional().describe('Centre offset, fraction of frame width'),
    y: z.number().min(-2).max(2).optional().describe('Centre offset, fraction of frame height'),
    scale: z.number().positive().max(20).optional(),
  })
  .describe('Placement on the frame')
const Box = z
  .object({
    width: z.number().positive().max(1).optional().describe('Box width, fraction of frame width'),
    padding: z.number().min(0).max(400).optional(),
    background: Color.optional(),
    opacity: z.number().min(0).max(1).optional().describe('Background opacity'),
    radius: z.number().min(0).max(400).optional(),
    fullFrame: z.boolean().optional().describe('Knockout plate covers the whole frame'),
  })
  .describe('Text box / plate')

const clipProps = {
  name: z.string().max(120).optional(),
  volume: z.number().min(0).max(4).optional().describe('Linear gain, 1 = 100%'),
  muted: z.boolean().optional(),
  fadeIn: Fade.optional(),
  fadeOut: Fade.optional(),
  transform: Transform.optional(),
  volumeKeys: z
    .array(z.object({ t: z.number().describe('Seconds from the clip start'), gain: z.number().min(0).max(4) }))
    .optional()
    .describe('Volume envelope points (interpolated in dB); [] clears'),
}

const textProps = {
  text: z.string().max(5000).optional().describe('Plain text; \\n starts a new line. Keeps the current style unless `style` is given'),
  paragraphs: z
    .array(z.object({ align: Align.optional(), runs: z.array(TextStyle.extend({ text: z.string() })).min(1) }))
    .optional()
    .describe('Rich text: lines of differently styled runs (replaces `text`)'),
  style: TextStyle.optional().describe('Applied to every run'),
  align: Align.optional(),
  box: Box.optional(),
  knockout: z.boolean().optional(),
  lineHeight: z.number().min(0.5).max(4).optional(),
}

const waitSeconds = z.number().min(0).max(55).optional()

// ---------------------------------------------------------------------------
// Media paths
// ---------------------------------------------------------------------------

async function mediaFile(path: string, folder: string | null): Promise<MediaFile> {
  if (!isAbsolute(path) && !folder) throw new Error(`"${path}" is relative but the project has no media folder; give an absolute path`)
  const abs = resolve(isAbsolute(path) ? path : join(folder!, path))
  const st = await stat(abs).catch(() => null)
  if (!st?.isFile()) throw new Error(`File not found: ${abs}`)
  const ext = extname(abs).slice(1).toLowerCase()
  const kind = SUPPORTED_EXTENSIONS[ext]
  if (!kind) throw new Error(`Unsupported file type .${ext} (supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(', ')})`)
  return {
    path: abs, name: basename(abs), rel: folder ? relative(folder, abs) : basename(abs), ext, kind, size: st.size, mtime: Math.round(st.mtimeMs),
  }
}

async function folderExists(folder: string): Promise<string> {
  const abs = resolve(folder)
  const st = await stat(abs).catch(() => null)
  if (!st?.isDirectory()) throw new Error(`Folder not found: ${abs}`)
  return abs
}

const mb = (bytes: number) => Math.round((bytes / 1e6) * 10) / 10

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

async function follow(job: Job, seconds: number | undefined, ctx: ServerContext): Promise<CallToolResult> {
  const report = progressReporter(ctx)
  await waitFor(job, (seconds ?? 45) * 1000, ctx.mcpReq.signal, (j) => report(Math.round((j.progress ?? 0) * 100), j.message))
  const view = jobView(job)
  if (job.state === 'running') view.hint = `Still running: call job_status with jobId ${job.id} to keep waiting.`
  return jsonResult(view)
}

function startExportJob(win: Win, project: Project, job: ExportJob): Job {
  const label = `Export ${project.name}`
  const mcpJob = createJob('export', label, () => cancelExport())
  const durationSec = projectDuration(project) / 1e6
  const toast = (params: Record<string, unknown>) => void callEditor(win(), 'toast', { id: mcpJob.id, ...params }).catch(() => {})
  let lastToast = 0
  const onEvent = (e: ExportEvent) => {
    if (e.type === 'progress') {
      const audio = e.phase === 'audio'
      updateJob(mcpJob, {
        progress: audio ? 0 : e.frame / Math.max(1, e.total),
        message: audio ? 'Mixing audio' : `Frame ${e.frame}/${e.total} at ${Math.round(e.fps)} fps`,
      })
      if (Date.now() - lastToast > 1000) {
        lastToast = Date.now()
        toast({ kind: 'loading', message: `${label} (MCP)`, description: mcpJob.message })
      }
    } else if (e.type === 'done') {
      updateJob(mcpJob, {
        state: 'completed', progress: 1, message: 'Done',
        result: {
          path: job.outputPath, sizeMB: mb(e.size), seconds: Math.round(e.seconds * 10) / 10, duration: Math.round(durationSec * 100) / 100,
          speed: `${(durationSec / Math.max(0.001, e.seconds)).toFixed(1)}x real-time`,
          video: `${job.width}x${job.height} ${job.fps} fps ${job.codec} NVENC ${job.videoKbps} kbps`,
        },
      })
      toast({ kind: 'success', message: 'Export complete (MCP)', description: job.outputPath })
    } else if (e.type === 'error') {
      updateJob(mcpJob, { state: 'failed', error: e.message, message: e.message })
      toast({ kind: 'error', message: 'Export failed (MCP)', description: e.message })
    } else if (e.type === 'cancelled') {
      updateJob(mcpJob, { state: 'cancelled', message: 'Cancelled' })
      toast({ dismiss: true })
    }
  }
  startExport(project, job, { anchor: win(), onEvent }).catch((err: Error) => {
    updateJob(mcpJob, { state: 'failed', error: err.message, message: err.message })
    toast({ dismiss: true })
  })
  return mcpJob
}

async function startMusicJob(win: Win, args: Record<string, unknown>, folder: string, label: string): Promise<Job> {
  const w = win()
  if (!w) throw new Error('The Trailer-V window is not open')
  let songId: string | null = null
  const early: GenEvent[] = []
  let mcpJob: Job | null = null
  const handle = (e: GenEvent) => {
    if (!mcpJob || e.jobId !== songId) return
    if (e.type === 'status') updateJob(mcpJob, { progress: e.progress, message: e.message || e.phase || 'Generating' })
    else if (e.type === 'delivered') {
      updateJob(mcpJob, { state: 'completed', progress: 1, message: 'Saved', result: { path: e.file.path, name: e.file.name, rel: e.file.rel, sizeMB: mb(e.file.size) } })
      off()
    } else if (e.type === 'ended') {
      updateJob(mcpJob, { state: e.state, message: e.message, error: e.state === 'failed' ? e.message : null })
      off()
    }
  }
  const off = onGenerateEvent((e) => (mcpJob ? handle(e) : early.push(e)))
  try {
    songId = await startSong(args, folder, label, w.webContents)
  } catch (e) {
    off()
    throw e
  }
  const id = songId
  mcpJob = createJob('music', label, () => cancelSong(id))
  for (const e of early) handle(e)
  return mcpJob
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function buildServer(win: Win): McpServer {
  const server = new McpServer({ name: 'trailer-v', title: 'Trailer-V', version: app.getVersion() }, { instructions: INSTRUCTIONS })
  const editor = <T>(method: string, params?: unknown, timeoutMs?: number) => callEditor<T>(win(), method, params, timeoutMs)
  const state = () => editor<EditorStateView>('state')
  const read = { readOnlyHint: true, openWorldHint: false } as const
  const edit = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const

  // --- App & projects -----------------------------------------------------

  server.registerTool('get_status', {
    title: 'App status',
    description: 'What Trailer-V is showing (home screen or an open project), playhead, GPU, NVENC encoders and whether YuE2 Studio (music generation) is reachable.',
    inputSchema: z.object({}),
    annotations: read,
  }, async () => {
    const [s, caps, yue2] = await Promise.all([
      state(),
      encoderCaps(),
      fetch(`http://127.0.0.1:${process.env.YUE2_PORT ?? 7862}/api/health`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false),
    ])
    return jsonResult({
      app: `Trailer-V ${app.getVersion()}`, ...s,
      encoders: { ffmpeg: caps.ffmpeg, h264_nvenc: caps.h264, hevc_nvenc: caps.hevc },
      musicGeneration: yue2 ? 'YuE2 Studio is running' : 'YuE2 Studio is not running (generate_music unavailable)',
    })
  })

  server.registerTool('list_projects', {
    title: 'List projects',
    description: 'Saved projects, most recently edited first.',
    inputSchema: z.object({}),
    annotations: read,
  }, async () => {
    const list = await listProjects()
    return jsonResult({
      projects: list.map((p) => ({ id: p.id, name: p.name, aspect: p.aspect, size: `${p.width}x${p.height}`, duration: Math.round(p.duration / 1e4) / 100, updated: new Date(p.updated).toISOString() })),
    })
  })

  server.registerTool('create_project', {
    title: 'Create project',
    description: `New project, opened in the editor. Aspects: ${ASPECTS.map((a) => `${a.id} (${a.label})`).join(', ')}; tiers 720p, 1080p, 1440p, 4K (16:9 1080p = 1920x1080).`,
    inputSchema: z.object({
      name: z.string().min(1).max(120),
      aspect: z.enum(ASPECTS.map((a) => a.id) as [string, ...string[]]).default('16:9'),
      tier: z.enum(['720p', '1080p', '1440p', '4K']).default('1080p'),
      fps: z.union(FPS_OPTIONS.map((f) => z.literal(f)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>]).default(30),
      background: Color.default('#000000'),
      mediaFolder: z.string().optional().describe('Folder the library shows and relative media paths resolve against'),
      open: z.boolean().default(true),
    }),
    annotations: edit,
  }, async (a) => {
    const res = resolutionFor(a.aspect as never, a.tier)
    const folder = a.mediaFolder ? await folderExists(a.mediaFolder) : null
    const p = await createProject({
      name: a.name,
      settings: { aspect: a.aspect as never, tier: res.tier, width: res.width, height: res.height, fps: a.fps, background: a.background, historyDepth: 200 },
      mediaFolder: folder,
    })
    if (!a.open) return jsonResult({ id: p.id, name: p.name, settings: p.settings, mediaFolder: p.mediaFolder })
    return jsonResult({ ...(await editor<ProjectView>('openProject', { id: p.id })) })
  })

  server.registerTool('open_project', {
    title: 'Open project',
    description: 'Open a saved project in the editor (the current one is saved first). Returns its timeline.',
    inputSchema: z.object({ id: z.string().describe('Project id from list_projects') }),
    annotations: edit,
  }, async ({ id }) => jsonResult({ ...(await editor<ProjectView>('openProject', { id })) }))

  server.registerTool('close_project', {
    title: 'Close project',
    description: 'Save the open project and return to the home screen.',
    inputSchema: z.object({}),
    annotations: edit,
  }, async () => jsonResult({ ...(await editor<EditorStateView>('closeProject')) }))

  server.registerTool('get_project', {
    title: 'Get timeline',
    description: 'The open project: settings, tracks (rows, top first), clips with times in seconds, text and styles, and transitions. raw returns the saved JSON document (times in microseconds).',
    inputSchema: z.object({ raw: z.boolean().default(false) }),
    annotations: read,
  }, async ({ raw }) => jsonResult({ ...(await editor<Record<string, unknown>>('getProject', { raw })) }))

  server.registerTool('update_project', {
    title: 'Update project settings',
    description: 'Rename, change aspect/resolution (visual media re-fits with `fit`), frame rate, background colour or media folder. One undo step.',
    inputSchema: z.object({
      name: z.string().min(1).max(120).optional(),
      aspect: z.enum(ASPECTS.map((a) => a.id) as [string, ...string[]]).optional(),
      tier: z.enum(['720p', '1080p', '1440p', '4K']).optional(),
      fit: z.enum(['contain', 'cover']).optional(),
      fps: z.number().int().optional().describe('24, 25, 30, 50 or 60'),
      background: Color.optional(),
      mediaFolder: z.string().nullable().optional(),
    }),
    annotations: edit,
  }, async (a) => {
    const mediaFolder = a.mediaFolder ? await folderExists(a.mediaFolder) : a.mediaFolder
    return jsonResult({ ...(await editor<ProjectView>('updateProject', { ...a, mediaFolder })) })
  })

  server.registerTool('duplicate_project', {
    title: 'Duplicate project',
    description: 'Copy a saved project (the copy is not opened).',
    inputSchema: z.object({ id: z.string() }),
    annotations: edit,
  }, async ({ id }) => {
    const s = await duplicateProject(id)
    return jsonResult({ id: s.id, name: s.name })
  })

  server.registerTool('delete_project', {
    title: 'Delete project',
    description: 'Move a saved project to the Recycle Bin (recoverable there). The open project cannot be deleted.',
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ id }) => {
    const s = await state()
    if (s.project?.id === id) throw new Error('That project is open; close_project first')
    await removeProject(id)
    return jsonResult({ deleted: id, note: 'Moved to the Recycle Bin' })
  })

  // --- Media --------------------------------------------------------------

  server.registerTool('list_media', {
    title: 'List media',
    description: 'Supported media (mp4/mov/m4v video, jpg/png images, mp3 audio, txt) in the project\'s media folder or another folder, recursively.',
    inputSchema: z.object({
      folder: z.string().optional().describe('Defaults to the open project\'s media folder'),
      kind: z.enum(['video', 'image', 'audio', 'text']).optional(),
    }),
    annotations: read,
  }, async ({ folder, kind }) => {
    const dir = folder ? await folderExists(folder) : (await state()).project?.mediaFolder
    if (!dir) throw new Error('No folder given and the open project has no media folder')
    const files = (await scanFolder(dir)).filter((f) => !kind || f.kind === kind)
    return jsonResult({
      folder: dir, count: files.length,
      files: files.slice(0, 500).map((f) => ({ path: f.path, rel: f.rel, kind: f.kind, sizeMB: mb(f.size) })),
    })
  })

  server.registerTool('probe_media', {
    title: 'Probe media',
    description: 'Duration, size, frame rate, codec and audio of a media file, as the editor decodes it. Relative paths resolve against the media folder.',
    inputSchema: z.object({ path: z.string() }),
    annotations: read,
  }, async ({ path }) => {
    const file = await mediaFile(path, (await state()).project?.mediaFolder ?? null)
    const meta = await editor<MediaMeta>('probe', { file })
    if (meta.error) throw new Error(meta.error)
    return jsonResult({
      path: file.path, kind: file.kind, sizeMB: mb(file.size),
      duration: meta.duration == null ? null : Math.round(meta.duration / 1000) / 1000,
      width: meta.width, height: meta.height, fps: meta.fps, codec: meta.codec, hasAudio: meta.hasAudio, hasVideo: meta.hasVideo,
    })
  })

  // --- Timeline edits -----------------------------------------------------

  server.registerTool('add_media_clip', {
    title: 'Add media clip',
    description: 'Put a video, image or audio file on the timeline. On the main track, `start` picks the nearest clip boundary (omit to append). On free tracks the clip goes at `start` (default 0) or the nearest free spot. inPoint/duration trim the source.',
    inputSchema: z.object({
      path: z.string().describe('Absolute, or relative to the media folder'),
      track: TrackRef.optional().describe('Default: main track for video, first image/audio track otherwise. ' + TrackRef.description),
      start: Seconds.optional(),
      inPoint: Seconds.optional().describe('Source time the clip starts from'),
      duration: z.number().positive().optional().describe('Default: rest of the source (images 5 s)'),
      ...clipProps,
    }),
    annotations: edit,
  }, async (a) => {
    const file = await mediaFile(a.path, (await state()).project?.mediaFolder ?? null)
    return jsonResult({ ...(await editor<Record<string, unknown>>('addMedia', { ...a, file })) })
  })

  server.registerTool('add_text_clip', {
    title: 'Add text clip',
    description: `Add a title/caption on a text track. Starts from a preset (${TEXT_PRESETS.map((p) => `${p.id}: ${p.name}`).join('; ')}) then applies your text, style, box and transform. Default duration 5 s, start 0.`,
    inputSchema: z.object({
      preset: z.enum(TEXT_PRESETS.map((p) => p.id) as [string, ...string[]]).optional(),
      track: TrackRef.optional(),
      start: Seconds.optional(),
      duration: z.number().positive().optional(),
      ...textProps,
      ...clipProps,
    }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('addText', a)) }))

  server.registerTool('update_clip', {
    title: 'Update clip',
    description: 'Change a clip\'s properties: name, volume/mute, fades, transform, volume envelope, slip (inPoint keeps place and length), and for text clips the text, styles, alignment, box, knockout and line height. Use move_clip / trim_clip for timing.',
    inputSchema: z.object({ id: z.string(), inPoint: Seconds.optional(), ...clipProps, ...textProps }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('updateClip', a)) }))

  server.registerTool('move_clip', {
    title: 'Move clip',
    description: 'Move a clip to a time and/or another compatible track. Main track: inserts at the nearest boundary. Moving breaks the clip\'s transitions.',
    inputSchema: z.object({ id: z.string(), start: Seconds, track: TrackRef.optional() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('moveClip', a)) }))

  server.registerTool('trim_clip', {
    title: 'Trim clip',
    description: 'Drag a clip edge: `to` an absolute timeline time, or `by` seconds (+ = rightwards). Limited by the source length and free-track neighbours.',
    inputSchema: z.object({ id: z.string(), edge: z.enum(['start', 'end']), to: Seconds.optional(), by: z.number().optional() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('trimClip', a)) }))

  server.registerTool('split_clips', {
    title: 'Split clips',
    description: 'Split every clip under `at` (or just `ids`). Returns the new right-hand clips.',
    inputSchema: z.object({ at: Seconds, ids: z.array(z.string()).optional() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('splitClip', a)) }))

  server.registerTool('delete_clips', {
    title: 'Delete clips',
    description: 'Remove clips from the timeline (one undo step; the media files are untouched). Main-track clips after them close up.',
    inputSchema: z.object({ ids: z.array(z.string()).min(1) }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('deleteClips', a)) }))

  server.registerTool('duplicate_clip', {
    title: 'Duplicate clip',
    description: 'Copy a clip right after itself (main track) or at the next free spot.',
    inputSchema: z.object({ id: z.string() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('duplicateClip', a)) }))

  server.registerTool('set_transition', {
    title: 'Set cross-fade',
    description: 'Cross-fade between a clip and the clip touching it on the right (or `to`). duration 0 removes it.',
    inputSchema: z.object({ from: z.string(), to: z.string().optional(), duration: Seconds }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('setTransition', a)) }))

  server.registerTool('add_track', {
    title: 'Add track',
    description: 'Add an empty track. Video tracks go above the top video row (drawn over the main track); other kinds after the last of their kind.',
    inputSchema: z.object({ kind: z.enum(['video', 'image', 'text', 'audio']), name: z.string().max(60).optional() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('addTrack', a)) }))

  server.registerTool('update_track', {
    title: 'Update track',
    description: 'Rename, hide/mute, reorder (row) or set ducking on a track (audio tracks dip under video-clip sound).',
    inputSchema: z.object({
      id: z.string(),
      name: z.string().max(60).optional(),
      hidden: z.boolean().optional().describe('Visual tracks: hidden. Audio tracks: muted'),
      row: z.number().int().min(0).optional(),
      duck: z.object({ enabled: z.boolean().optional(), amount: z.number().min(0).max(60).optional(), attack: z.number().min(0).max(5000).optional(), release: z.number().min(0).max(5000).optional() }).optional(),
    }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('updateTrack', a)) }))

  server.registerTool('remove_track', {
    title: 'Remove track',
    description: 'Remove an empty track (not the main track).',
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('removeTrack', a)) }))

  server.registerTool('close_gaps', {
    title: 'Close gaps',
    description: 'Butt video clips together on every video track (or one), keeping transitions.',
    inputSchema: z.object({ track: z.string().optional() }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('closeGaps', a)) }))

  server.registerTool('select_clips', {
    title: 'Select clips',
    description: 'Select clips in the editor (shows them in the inspector). [] clears.',
    inputSchema: z.object({ ids: z.array(z.string()) }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('select', a)) }))

  server.registerTool('undo', {
    title: 'Undo',
    description: 'Undo the last edits (any edit, by hand or through these tools).',
    inputSchema: z.object({ steps: z.number().int().min(1).max(100).default(1) }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('undo', a)) }))

  server.registerTool('redo', {
    title: 'Redo',
    description: 'Redo undone edits.',
    inputSchema: z.object({ steps: z.number().int().min(1).max(100).default(1) }),
    annotations: edit,
  }, async (a) => jsonResult({ ...(await editor<Record<string, unknown>>('redo', a)) }))

  server.registerTool('get_history', {
    title: 'Undo history',
    description: 'Labels of recent edits (past, oldest first) and of undone ones (future).',
    inputSchema: z.object({}),
    annotations: read,
  }, async () => jsonResult({ ...(await editor<Record<string, unknown>>('history')) }))

  // --- Preview ------------------------------------------------------------

  server.registerTool('playback', {
    title: 'Playback',
    description: 'Play, pause or seek the editor\'s preview (with sound, on this computer).',
    inputSchema: z.object({ action: z.enum(['play', 'pause', 'seek']), time: Seconds.optional() }),
    annotations: edit,
  }, async ({ action, time }) => {
    if (action === 'seek' && time == null) throw new Error('seek needs a time')
    if (action === 'seek') return jsonResult({ ...(await editor<EditorStateView>('seek', { time })) })
    return jsonResult({ ...(await editor<EditorStateView>(action)) })
  })

  server.registerTool('render_frame', {
    title: 'Render frame',
    description: 'Render the composited frame at a time with the export renderer and return it as an image. width up to the project width.',
    inputSchema: z.object({
      time: Seconds,
      width: z.number().int().min(64).max(3840).default(960),
      format: z.enum(['jpeg', 'png']).default('jpeg'),
    }),
    annotations: read,
  }, async (a) => {
    const f = await editor<FrameImage>('renderFrame', a, 30_000)
    return imageResult(f.image, f.mime, `Frame at ${a.time}s (${f.width}x${f.height})${f.complete ? '' : ' — some layers had not decoded yet; render again if anything is missing'}`)
  })

  server.registerTool('render_storyboard', {
    title: 'Render storyboard',
    description: 'A contact sheet of frames (labelled with their times) to review a whole cut at once: give `times`, or `count` frames spread over [from, to] (default the whole project).',
    inputSchema: z.object({
      times: z.array(Seconds).max(48).optional(),
      count: z.number().int().min(1).max(48).default(12),
      from: Seconds.optional(),
      to: Seconds.optional(),
      tileWidth: z.number().int().min(120).max(960).default(384),
      columns: z.number().int().min(1).max(8).default(4),
    }),
    annotations: read,
  }, async (a) => {
    let times = a.times
    if (!times?.length) {
      const total = (await state()).project?.duration ?? 0
      const from = a.from ?? 0
      const to = Math.min(a.to ?? total, total)
      const span = Math.max(0, to - from)
      times = Array.from({ length: a.count }, (_, i) => Math.round((from + (span * (i + 0.5)) / a.count) * 100) / 100)
    }
    const f = await editor<FrameImage>('storyboard', { times, width: a.tileWidth, columns: a.columns }, 180_000)
    return imageResult(f.image, f.mime, `Storyboard: ${times.map((t) => `${t}s`).join(', ')}${f.complete ? '' : ' (some layers had not decoded yet)'}`)
  })

  server.registerTool('screenshot_window', {
    title: 'Screenshot window',
    description: 'Capture the Trailer-V window (editor UI) as an image.',
    inputSchema: z.object({ width: z.number().int().min(320).max(3840).default(1280), format: z.enum(['jpeg', 'png']).default('jpeg') }),
    annotations: read,
  }, async ({ width, format }) => {
    const w = win()
    if (!w) throw new Error('The Trailer-V window is not open')
    let img = await w.webContents.capturePage()
    if (img.getSize().width > width) img = img.resize({ width, quality: 'best' })
    const { width: iw, height: ih } = img.getSize()
    return imageResult(format === 'png' ? img.toPNG() : img.toJPEG(88), `image/${format}`, `Trailer-V window (${iw}x${ih})`)
  })

  server.registerTool('list_fonts', {
    title: 'List fonts',
    description: 'Installed font families for text styles.',
    inputSchema: z.object({ query: z.string().optional().describe('Case-insensitive filter') }),
    annotations: read,
  }, async ({ query }) => {
    const all = await listFonts()
    const q = query?.toLowerCase()
    const fonts = q ? all.filter((f) => f.toLowerCase().includes(q)) : all
    return jsonResult({ count: fonts.length, fonts: fonts.slice(0, 300) })
  })

  // --- Export & generation (jobs) -----------------------------------------

  server.registerTool('export_video', {
    title: 'Export video',
    description: 'Render the open project to MP4 with NVENC (the same pipeline as the Export dialog): project resolution and frame rate, AAC audio. Runs as a job; waits up to waitSeconds (default 45) and returns its state.',
    inputSchema: z.object({
      outputPath: z.string().describe('Absolute .mp4 path'),
      codec: z.enum(['h264', 'hevc']).default('h264'),
      quality: z.enum(['fast', 'best']).default('best').describe('NVENC preset P4 (fast) or P6 (best)'),
      rateControl: z.enum(['vbr', 'cbr']).default('vbr'),
      videoMbps: z.number().min(1).max(200).optional().describe('Default: YouTube\'s recommendation for the resolution/fps'),
      audioKbps: z.union(AUDIO_BITRATES.map((b) => z.literal(b)) as unknown as [z.ZodLiteral<number>, z.ZodLiteral<number>]).default(DEFAULT_AUDIO_KBPS),
      overwrite: z.boolean().default(false),
      waitSeconds,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a, ctx) => {
    if (exportRunning() || runningJob('export')) throw new Error('An export is already running')
    if (!isAbsolute(a.outputPath)) throw new Error('outputPath must be absolute')
    const out = resolve(/\.mp4$/i.test(a.outputPath) ? a.outputPath : `${a.outputPath}.mp4`)
    if (!a.overwrite && (await stat(out).catch(() => null))) throw new Error(`${out} exists; pass overwrite: true to replace it`)
    const caps = await encoderCaps()
    if (!(a.codec === 'hevc' ? caps.hevc : caps.h264)) throw new Error(`${a.codec}_nvenc is not available on this GPU/driver`)
    const project = await editor<Project>('getProject', { raw: true })
    const duration = projectDuration(project)
    if (duration <= 0) throw new Error('The timeline is empty')
    await mkdir(dirname(out), { recursive: true })
    const s = project.settings
    const job: ExportJob = {
      outputPath: out, width: s.width, height: s.height, fps: s.fps, codec: a.codec, rateControl: a.rateControl, quality: a.quality,
      videoKbps: Math.round((a.videoMbps ?? recommendedVideoMbps(s.tier, s.fps)) * 1000), audioKbps: a.audioKbps,
      totalFrames: Math.max(1, frameIndex(duration, s.fps)),
    }
    return follow(startExportJob(win, project, job), a.waitSeconds, ctx)
  })

  server.registerTool('generate_music', {
    title: 'Generate music',
    description: 'Make a song or instrumental with YuE2 Studio on the local GPU (roughly 1-2x its length) and save the MP3 into <media folder>/AI Audio, ready for add_media_clip. For an exact beat grid give bpm + sections (instrumental only): bars x beats-per-bar x 60/bpm seconds each.',
    inputSchema: z.object({
      style: z.string().min(3).max(400).describe('Genre, mood, instruments, tempo, e.g. "driving synthwave, punchy drums, bright arps, 120 bpm"'),
      instrumental: z.boolean().default(true),
      lyrics: z.string().max(5000).optional().describe('With [verse]/[chorus] tags; needed unless instrumental'),
      seconds: z.number().int().min(10).max(360).optional().describe('Length (exact for instrumentals) when no sections are given'),
      bpm: z.number().min(40).max(240).optional(),
      meter: z.enum(['4/4', '3/4']).default('4/4'),
      sections: z
        .array(z.object({
          label: z.enum(['intro', 'verse', 'pre-chorus', 'chorus', 'bridge', 'interlude', 'instrumental', 'outro', 'silence']),
          bars: z.number().int().min(1).max(64),
          description: z.string().max(200).optional(),
        }))
        .max(24)
        .optional(),
      seed: z.number().int().optional(),
      name: z.string().max(48).optional().describe('File name (default: the style)'),
      folder: z.string().optional().describe('Default: the open project\'s media folder'),
      waitSeconds,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, async (a, ctx) => {
    if (!a.instrumental && !a.lyrics) throw new Error('Songs with vocals need lyrics (or set instrumental: true)')
    if (a.sections && !a.instrumental) throw new Error('sections (an exact timeline) are for instrumentals only')
    if (a.sections && !a.bpm) throw new Error('sections need a bpm')
    const folder = a.folder ? await folderExists(a.folder) : (await state()).project?.mediaFolder
    if (!folder) throw new Error('No folder given and the open project has no media folder')
    const args: Record<string, unknown> = { style: a.style, instrumental: a.instrumental }
    if (a.lyrics) args.lyrics = a.lyrics
    if (a.seconds) args.max_seconds = a.seconds
    if (a.seed != null) args.seed = a.seed
    if (a.sections) args.timeline = { bpm: a.bpm, meter: a.meter, strict: true, sections: a.sections }
    const job = await startMusicJob(win, args, folder, a.name ?? a.style)
    return follow(job, a.waitSeconds, ctx)
  })

  server.registerTool('job_status', {
    title: 'Job status',
    description: 'State of an export or music job; waits up to waitSeconds (default 25) for it to finish.',
    inputSchema: z.object({ jobId: z.string(), waitSeconds }),
    annotations: read,
  }, async ({ jobId, waitSeconds: w }, ctx) => {
    const job = getJob(jobId)
    if (!job) throw new Error(`No job ${jobId}`)
    return follow(job, w ?? 25, ctx)
  })

  server.registerTool('cancel_job', {
    title: 'Cancel job',
    description: 'Stop a running export or music job.',
    inputSchema: z.object({ jobId: z.string() }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async ({ jobId }) => {
    const job = getJob(jobId)
    if (!job) throw new Error(`No job ${jobId}`)
    if (job.state === 'running') await job.cancel()
    return jsonResult(jobView(job))
  })

  // --- Resources ----------------------------------------------------------

  server.registerResource('current-project', 'trailer-v://project/current', {
    title: 'Open project',
    description: 'The open project\'s timeline (same as get_project)',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(await editor<ProjectView>('getProject', { raw: false }), null, 2) }],
  }))

  return server
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

let http: Server | null = null

export function startMcpServer(win: Win): void {
  registerAutomationIpc()
  const w = win()
  if (w) trackPage(w)
  if (process.env.TRAILER_MCP === '0') return
  const port = Number(process.env.TRAILER_MCP_PORT) || DEFAULT_PORT
  const handler = createMcpHandler(() => buildServer(win), { onerror: (e) => console.log(`[mcp] ${e.message}`) })

  http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? `127.0.0.1:${port}`}`)
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Trailer-V MCP server: POST /mcp')
        return
      }
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : v)
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
      const abort = new AbortController()
      res.on('close', () => abort.abort())
      const request = new Request(url, { method: req.method, headers, body: body as BodyInit | undefined, signal: abort.signal })
      const response =
        hostHeaderValidationResponse(request, localhostAllowedHostnames()) ??
        originValidationResponse(request, localhostAllowedOrigins()) ??
        (await handler.fetch(request))
      const out: Record<string, string> = {}
      response.headers.forEach((v, k) => (out[k] = v))
      res.writeHead(response.status, out)
      if (!response.body) return void res.end()
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
      res.end()
    } catch (e) {
      console.log(`[mcp] request failed: ${(e as Error).message}`)
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' })
      res.end()
    }
  })
  http.on('error', (e) => console.log(`[mcp] not serving on port ${port}: ${e.message}`))
  http.listen(port, '127.0.0.1', () => console.log(`[mcp] Trailer-V MCP server on http://127.0.0.1:${port}/mcp`))
}

export function stopMcpServer(): void {
  http?.close()
  http = null
}
