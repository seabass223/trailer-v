import { useEffect } from 'react'
import { toast } from 'sonner'
import { engine } from '@/engine/client'
import { addFile } from '@/features/editor/actions'
import type { GenEvent } from '@shared/ipc'

/** Views currently on screen; their own UI shows progress, so the toast stays quiet meanwhile. */
const openViews = new Set<string>()
const jobView = new Map<string, { viewId: string; label: string; last?: Extract<GenEvent, { type: 'status' }> }>()

export function setViewOpen(viewId: string, open: boolean): void {
  if (open) return void openViews.add(viewId)
  openViews.delete(viewId)
  // Closing the dialog mid-job hands progress over to a toast; the job keeps running.
  for (const [jobId, j] of jobView) if (j.viewId === viewId) showProgress(jobId)
}

/** ipcRenderer.invoke wraps errors as "Error invoking remote method 'x': Error: …". */
export function ipcMessage(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '')
}

function showProgress(jobId: string): void {
  const j = jobView.get(jobId)
  if (!j || openViews.has(j.viewId)) return
  const pct = j.last?.progress != null ? ` · ${Math.round(j.last.progress * 100)}%` : ''
  toast.loading(j.label, {
    id: jobId,
    description: `${j.last?.message || 'Starting…'}${pct}`,
    duration: Infinity,
    action: { label: 'Cancel', onClick: () => void window.api.generate.cancel(jobId).catch(() => {}) },
  })
}

/** Follows the main process's job tracking for the session: progress, delivery and failures. */
export function useGenerateJobs(): void {
  useEffect(
    () =>
      window.api.generate.onEvent((e) => {
        switch (e.type) {
          case 'started':
            jobView.set(e.jobId, { viewId: e.viewId, label: e.label })
            return showProgress(e.jobId)
          case 'status': {
            const j = jobView.get(e.jobId)
            if (!j) return
            j.last = e
            return showProgress(e.jobId)
          }
          case 'delivered':
            jobView.delete(e.jobId)
            toast.success('Song ready', {
              id: e.jobId,
              description: `AI Audio / ${e.file.name}`,
              duration: 8000,
              action: { label: 'Add at playhead', onClick: () => void addFile(e.file, null, engine().time()) },
            })
            return
          case 'ended':
            jobView.delete(e.jobId)
            if (e.state === 'cancelled') toast.info('Song generation cancelled', { id: e.jobId, duration: 4000 })
            else toast.error(`Song generation failed: ${e.message}`, { id: e.jobId, duration: 10000 })
        }
      }),
    [],
  )
}
