import { useEffect } from 'react'
import { toast } from 'sonner'
import { engine } from '@/engine/client'
import {
  closeVideoGaps, deleteSelection, duplicateSelection, goToEnd, goToStart, selectAll, splitAtPlayhead, toggleMute,
} from '@/features/editor/actions'
import { toggleFullscreen } from '@/features/preview/PreviewPanel'
import { setZoom, zoomToFit } from '@/features/timeline/view'
import { flushSave } from '@/state/persistence'
import { redo, select, undo, useEditor } from '@/state/store'
import { projectDuration } from '@shared/timeline'

function typing(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null
  if (!t) return false
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.getAttribute('role') === 'slider'
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const ctrl = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      // History works even from most fields except real text inputs.
      if (ctrl && !typing(e)) {
        if (key === 'z' && !e.shiftKey) return void (e.preventDefault(), undo())
        if (key === 'y' || (key === 'z' && e.shiftKey)) return void (e.preventDefault(), redo())
        if (key === 'd') return void (e.preventDefault(), duplicateSelection())
        if (key === 'a') return void (e.preventDefault(), selectAll())
        if (key === 'b') return void (e.preventDefault(), splitAtPlayhead())
        if (key === 'e') return void (e.preventDefault(), useEditor.setState({ exportOpen: true }))
        if (key === 's') {
          e.preventDefault()
          void flushSave().then(() => toast.success('Saved', { duration: 1200 }))
          return
        }
        if (key === 'p' && e.shiftKey) return void (e.preventDefault(), useEditor.setState((s) => ({ hud: !s.hud })))
      }
      if (ctrl || e.altKey || typing(e)) return
      const fps = useEditor.getState().project?.settings.fps ?? 30
      switch (e.key) {
        case ' ':
          e.preventDefault()
          engine().toggle()
          break
        case 'Home':
          goToStart()
          break
        case 'End':
          goToEnd()
          break
        case 'ArrowLeft':
          e.preventDefault()
          engine().step(e.shiftKey ? -fps : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          engine().step(e.shiftKey ? fps : 1)
          break
        case 'Delete':
        case 'Backspace':
          deleteSelection()
          break
        case 'Escape':
          select([])
          break
        case 's':
        case 'S':
          splitAtPlayhead()
          break
        case 'm':
        case 'M':
          toggleMute()
          break
        case 'g':
        case 'G':
          closeVideoGaps()
          break
        case 'k':
        case 'K':
          engine().pause()
          break
        case 'l':
        case 'L':
          void engine().play()
          break
        case 'j':
        case 'J':
          engine().seek(engine().time() - 5_000_000)
          break
        case 'f':
        case 'F':
          toggleFullscreen()
          break
        case '+':
        case '=':
          setZoom(useEditor.getState().pxPerSec * 1.4)
          break
        case '-':
        case '_':
          setZoom(useEditor.getState().pxPerSec / 1.4)
          break
        case 'Z':
          if (e.shiftKey) {
            const p = useEditor.getState().project
            if (p) zoomToFit(projectDuration(p))
          }
          break
        case '?':
          useEditor.setState({ shortcutsOpen: true })
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
