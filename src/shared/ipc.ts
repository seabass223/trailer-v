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
  mediaUrl(path: string): string
}
