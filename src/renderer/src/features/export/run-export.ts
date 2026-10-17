import type { ExportEvent, ExportJob } from '@shared/ipc'
import type { Project } from '@shared/model'

export interface ExportHandle {
  cancel(): void
  done: Promise<{ size: number; seconds: number } | null>
}

/** Start an export in the hidden export window and follow its events. */
export function runExport(project: Project, job: ExportJob, onProgress: (m: Extract<ExportEvent, { type: 'progress' }>) => void): ExportHandle {
  let off: (() => void) | null = null
  const done = new Promise<{ size: number; seconds: number } | null>((resolve, reject) => {
    off = window.api.exporter.onEvent((e) => {
      if (e.type === 'progress') onProgress(e)
      else if (e.type === 'log') console.log(`[export] ${e.message}`)
      else if (e.type === 'done') resolve({ size: e.size, seconds: e.seconds })
      else if (e.type === 'cancelled') resolve(null)
      else if (e.type === 'error') reject(new Error(e.message))
    })
    window.api.exporter.start(project, job).catch(reject)
  }).finally(() => off?.())
  return { cancel: () => window.api.exporter.cancel(), done }
}
