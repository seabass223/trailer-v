import type { EncoderCaps, MediaFile, Project, ProjectSettings, ProjectSummary } from './model'

export interface CreateProjectInput {
  name: string
  settings: ProjectSettings
  mediaFolder: string | null
}

export interface ExportJob {
  outputPath: string
  width: number
  height: number
  fps: number
  codec: 'h264' | 'hevc'
  rateControl: 'vbr' | 'cbr'
  /** NVENC speed/quality trade-off. */
  quality: 'fast' | 'best'
  videoKbps: number
  audioKbps: number
  totalFrames: number
}

/** Events from the hidden export window, relayed to the editor by the main process. */
export type ExportEvent =
  | { type: 'progress'; frame: number; total: number; fps: number; phase: 'audio' | 'video' }
  | { type: 'done'; size: number; seconds: number }
  | { type: 'error'; message: string }
  | { type: 'cancelled' }
  | { type: 'log'; message: string }

/** A YuE2 micro-UI View mounted for one "Generate audio" dialog. */
export interface GenView {
  viewId: string
  /** mcpview:// URL serving the View HTML with its own CSP. */
  url: string
  startTool: string
}

/** Main-process job tracking (MCP Micro-UI Jobs), relayed to the editor. */
export type GenEvent =
  | { type: 'started'; jobId: string; viewId: string; label: string }
  | { type: 'status'; jobId: string; progress: number | null; message: string; phase: string }
  | { type: 'delivered'; jobId: string; viewId: string; label: string; file: MediaFile; artifacts: string[] }
  | { type: 'ended'; jobId: string; state: 'failed' | 'cancelled'; message: string }

/** The API exposed on `window.api` by the preload script. */
export interface TrailerApi {
  projects: {
    list(): Promise<ProjectSummary[]>
    create(input: CreateProjectInput): Promise<Project>
    read(id: string): Promise<Project>
    save(project: Project): Promise<void>
    rename(id: string, name: string): Promise<void>
    duplicate(id: string): Promise<ProjectSummary>
    remove(id: string): Promise<void>
    savePoster(id: string, jpeg: Uint8Array): Promise<void>
  }
  library: {
    scan(folder: string): Promise<MediaFile[]>
    onChanged(cb: (folder: string, files: MediaFile[]) => void): () => void
    readText(path: string): Promise<string>
  }
  dialog: {
    pickFolder(defaultPath?: string): Promise<string | null>
    saveVideo(defaultName: string): Promise<string | null>
  }
  fonts: { list(): Promise<string[]> }
  encoder: { caps(): Promise<EncoderCaps> }
  exporter: {
    /** Renders in a hidden export window that pipes NV12 frames straight into FFmpeg NVENC. */
    start(project: Project, job: ExportJob): Promise<void>
    cancel(): void
    onEvent(cb: (e: ExportEvent) => void): () => void
  }
  shell: { showItem(path: string): Promise<void> }
  generate: {
    /** Connects to YuE2 Studio and prepares its View; new jobs save into `folder`. */
    openView(folder: string): Promise<GenView>
    closeView(viewId: string): void
    /** Proxies a View `tools/call` (app-visible tools only). */
    callTool(viewId: string, name: string, args: Record<string, unknown>): Promise<unknown>
    readResource(uri: string): Promise<unknown>
    /** The View started a job itself (`micro-ui-jobs/notifications/started`). */
    adopt(viewId: string, handle: unknown): void
    /** Early delivery trigger from the View's `completed` notification. */
    deliverNow(jobId: string): void
    cancel(jobId: string): Promise<void>
    openLink(url: string): Promise<void>
    onEvent(cb: (e: GenEvent) => void): () => void
  }
  mediaUrl(path: string): string
}
