import { useEffect } from 'react'
import { toast } from 'sonner'
import { commit, useEditor } from '@/state/store'

/** Scan + watch the project's media folder. */
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
    return () => {
      alive = false
      off()
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
