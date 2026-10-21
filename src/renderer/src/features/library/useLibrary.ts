import { useEffect } from 'react'
import { toast } from 'sonner'
import { commit, useEditor } from '@/state/store'

/**
 * Rescan the project's media folder now (this also restarts the main process's folder watcher).
 * Used where the editor knows the folder changed, and on focus, so a watcher that silently
 * stopped reporting never leaves the library stale.
 */
export async function refreshLibrary(): Promise<void> {
  const folder = useEditor.getState().project?.mediaFolder
  if (!folder) return
  try {
    const files = await window.api.library.scan(folder)
    if (useEditor.getState().project?.mediaFolder === folder) useEditor.setState({ files })
  } catch {
    /* the folder watcher's own error path reports problems */
  }
}

/** Scan + watch the project's media folder; rescan when the window regains focus. */
export function useLibrary(): void {
  const folder = useEditor((s) => s.project?.mediaFolder ?? null)
  useEffect(() => {
    if (!folder) {
      useEditor.setState({ files: [], libraryLoading: false })
      return
    }
    let alive = true
    useEditor.setState({ libraryLoading: true })
    window.api.library
      .scan(folder)
      .then((files) => alive && useEditor.setState({ files, libraryLoading: false }))
      .catch((e) => {
        if (!alive) return
        useEditor.setState({ files: [], libraryLoading: false })
        toast.error(`Can't read ${folder}: ${(e as Error).message}`)
      })
    const off = window.api.library.onChanged((f, files) => {
      if (f === folder) useEditor.setState({ files })
    })
    // Back from Explorer (or anywhere): pick up whatever changed meanwhile.
    let last = performance.now()
    const onFocus = () => {
      if (performance.now() - last < 1500) return
      last = performance.now()
      void refreshLibrary()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      alive = false
      off()
      window.removeEventListener('focus', onFocus)
    }
  }, [folder])
}

export async function chooseMediaFolder(): Promise<void> {
  const current = useEditor.getState().project?.mediaFolder ?? undefined
  const f = await window.api.dialog.pickFolder(current)
  if (f && f !== current) {
    commit('Change media folder', (d) => {
      d.mediaFolder = f
    })
  }
}
