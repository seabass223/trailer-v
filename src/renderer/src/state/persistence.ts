/** Debounced autosave + engine sync. Every committed project change reaches both. */
import { engine } from '@/engine/client'
import { useEditor } from './store'

let saveTimer: ReturnType<typeof setTimeout> | null = null
let posterTimer: ReturnType<typeof setTimeout> | null = null
let saving: Promise<void> = Promise.resolve()

export function startSync(): () => void {
  return useEditor.subscribe((state, prev) => {
    if (state.draft !== prev.draft) {
      const shown = state.draft ?? state.project
      if (shown) engine().setProject(shown)
      if (state.project === prev.project) return
    }
    const p = state.project
    if (!p || p === prev.project) return
    engine().setProject(p)
    if (prev.project?.id !== p.id) return // freshly loaded, nothing to save
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      const snapshot = useEditor.getState().project
      if (snapshot) saving = saving.then(() => window.api.projects.save(snapshot)).catch(() => {})
    }, 500)
    if (posterTimer) clearTimeout(posterTimer)
    posterTimer = setTimeout(() => void savePoster(), 4000)
  })
}

export async function savePoster(): Promise<void> {
  const p = useEditor.getState().project
  if (!p || !p.clips.length) return
  if (engine().playing) {
    // Try again once playback stops; never compete with the preview for the GPU decoders.
    if (posterTimer) clearTimeout(posterTimer)
    posterTimer = setTimeout(() => void savePoster(), 4000)
    return
  }
  const jpeg = await engine().poster(Math.min(1_000_000, engine().duration / 3))
  if (jpeg) await window.api.projects.savePoster(p.id, new Uint8Array(jpeg))
}

/** Flush pending saves (leaving the editor / closing). */
export async function flushSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
    const snapshot = useEditor.getState().project
    if (snapshot) saving = saving.then(() => window.api.projects.save(snapshot)).catch(() => {})
  }
  await saving
}
