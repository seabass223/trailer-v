/**
 * Export runs in a hidden, Node-enabled window: its renderer owns a separate WebGPU device and
 * writes frames directly to FFmpeg's stdin. Only small progress events cross IPC.
 */
import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import type { ExportEvent, ExportJob } from '@shared/ipc'
import type { Project } from '@shared/model'
import { encoderCaps } from './encoder'

let win: BrowserWindow | null = null
let ui: WebContents | null = null
let listener: ((e: ExportEvent) => void) | null = null

function relay(e: ExportEvent): void {
  if (ui && !ui.isDestroyed()) ui.send('export:event', e)
  listener?.(e)
  if (e.type === 'done' || e.type === 'error' || e.type === 'cancelled') {
    const w = win
    win = null
    listener = null
    setTimeout(() => w?.destroy(), 200)
  }
}

export const exportRunning = (): boolean => win !== null

export function cancelExport(): void {
  win?.webContents.send('export:cancel')
}

export interface ExportStartOptions {
  /** Editor that started the export; gets every event over IPC. */
  ui?: WebContents | null
  /** Window the off-screen export window sits next to. */
  anchor?: BrowserWindow | null
  /** In-process subscriber (the MCP server). */
  onEvent?: (e: ExportEvent) => void
}

/** Start an export (one at a time). Resolves once the export window is loading. */
export async function startExport(project: Project, job: ExportJob, opts: ExportStartOptions = {}): Promise<void> {
  if (win) throw new Error('An export is already running')
  const caps = await encoderCaps()
  if (!caps.ffmpeg) throw new Error('FFmpeg was not found on PATH')
  ui = opts.ui ?? null
  listener = opts.onEvent ?? null
  // Chromium deprioritises GPU work from hidden windows (measured: 4K export 0.5x vs 3.3x real
  // time), so the export window is "shown" but fully transparent, frameless, unfocusable and
  // kept off the taskbar: visible to Chromium, invisible to the user.
  const anchor = (opts.anchor ?? (ui ? BrowserWindow.fromWebContents(ui) : null))?.getBounds()
  win = new BrowserWindow({
    show: false,
    x: anchor ? anchor.x + 8 : 0,
    y: anchor ? anchor.y + 8 : 0,
    width: 64,
    height: 64,
    frame: false,
    transparent: true,
    opacity: 0,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  const w = win
  w.setIgnoreMouseEvents(true)
  w.showInactive()
  w.webContents.on('render-process-gone', (_ev, details) => {
    if (win === w) relay({ type: 'error', message: `Export renderer stopped (${details.reason})` })
  })
  if (!app.isPackaged) {
    w.webContents.on('console-message', (ev) => console.log(`[export-window:${ev.level}] ${ev.message}`))
  }
  ipcMain.once('export:window-ready', (ready) => {
    if (ready.sender === w.webContents) w.webContents.send('export:job', { project, job, ffmpeg: caps.ffmpeg })
  })
  const url = !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? `${process.env.ELECTRON_RENDERER_URL}/export.html`
    : 'app://bundle/export.html'
  void w.loadURL(url)
  console.log(`[export] ${job.width}x${job.height}@${job.fps} ${job.codec} ${job.quality} ${job.videoKbps}k -> ${job.outputPath}`)
}

export function registerExportIpc(): void {
  ipcMain.on('export:event', (e, ev: ExportEvent) => {
    if (win && e.sender === win.webContents) relay(ev)
  })
  ipcMain.on('export:cancel', () => cancelExport())
  ipcMain.handle('export:start', (e, project: Project, job: ExportJob) => startExport(project, job, { ui: e.sender }))
}
