/**
 * Files dragged in from Explorer onto a library tab are copied into the project's media folder
 * with a Windows shell copy; the folder watcher then shows them in the library.
 */
import { toast } from 'sonner'
import { ipcMessage } from '@/features/generate/jobs'
import { useEditor, type LibraryTab } from '@/state/store'
import type { MediaKind } from '@shared/model'
import { SUPPORTED_EXTENSIONS } from '@shared/presets'
import { chooseMediaFolder, refreshLibrary } from './useLibrary'

/** What each tab shows, and so accepts. */
export const TAB_KINDS: Record<LibraryTab, readonly MediaKind[]> = {
  media: ['video', 'image', 'audio'],
  image: ['image'],
  audio: ['audio'],
  text: ['text'],
}

const TAB_NOUN: Record<LibraryTab, string> = { media: 'video, image or audio files', image: 'images', audio: 'audio files', text: 'text files' }

const kindOf = (path: string): MediaKind | null => SUPPORTED_EXTENSIONS[path.split('.').pop()?.toLowerCase() ?? ''] ?? null

/** Best guess from a drag's MIME types (names aren't readable until the drop). Unknown types may still fit. */
export function dragFits(dt: DataTransfer | null, tab: LibraryTab): boolean {
  if (!dt || !Array.from(dt.types).includes('Files')) return false
  const kinds = TAB_KINDS[tab]
  return Array.from(dt.items).some((it) => {
    if (it.kind !== 'file') return false
    const t = it.type
    if (!t) return true
    if (t.startsWith('video/')) return kinds.includes('video')
    if (t === 'image/png' || t === 'image/jpeg') return kinds.includes('image')
    if (t === 'audio/mpeg' || t === 'audio/mp3') return kinds.includes('audio')
    if (t === 'text/plain') return kinds.includes('text')
    return false
  })
}

const inside = (path: string, folder: string): boolean => {
  const norm = (p: string) => p.replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase()
  return norm(path).startsWith(`${norm(folder)}\\`)
}

const names = (paths: string[]) => paths.map((p) => p.split(/[\\/]/).pop()).join(', ')

/**
 * Copy dropped files that belong on `tab` into the media folder. Resolves with the destination
 * paths of what was copied (empty if nothing was).
 */
export async function importFiles(paths: string[], tab: LibraryTab): Promise<string[]> {
  const folder = useEditor.getState().project?.mediaFolder
  if (!folder) {
    toast.error('Choose a media folder first', { action: { label: 'Choose folder', onClick: () => void chooseMediaFolder() } })
    return []
  }
  const kinds = TAB_KINDS[tab]
  const fits = paths.filter((p) => {
    const k = kindOf(p)
    return !!k && kinds.includes(k)
  })
  const wrongType = paths.filter((p) => !fits.includes(p))
  const already = fits.filter((p) => inside(p, folder))
  const todo = fits.filter((p) => !already.includes(p))
  const notes = [
    wrongType.length && `${wrongType.length === 1 ? names(wrongType) : `${wrongType.length} files`} — this tab takes ${TAB_NOUN[tab]}`,
    already.length && `${already.length === 1 ? names(already) : `${already.length} files`} already in the media folder`,
  ].filter(Boolean) as string[]
  if (!todo.length) {
    toast(notes.length ? 'Nothing to copy' : 'No files to copy', { description: notes.join('. ') || undefined })
    return []
  }

  const id = `copy-${Date.now()}`
  const n = todo.length
  toast.loading(`Copying ${n === 1 ? names(todo) : `${n} files`}…`, { id, description: `To ${folder}` })
  try {
    const r = await window.api.library.copyIn(todo, folder)
    const parts = [...notes]
    if (r.skipped.length) parts.unshift(`Skipped ${r.skipped.length === 1 ? names(r.skipped) : `${r.skipped.length} files`}`)
    if (!r.copied.length) {
      toast(r.cancelled ? 'Copy cancelled' : 'Nothing copied', { id, description: parts.join('. ') || undefined, duration: 4000 })
      return []
    }
    // Show the files now rather than waiting on the folder watcher.
    await refreshLibrary()
    toast.success(`Copied ${r.copied.length === 1 ? names(r.copied) : `${r.copied.length} files`}`, {
      id, description: parts.join('. ') || `To ${folder}`, duration: 4000,
    })
    return r.copied
  } catch (e) {
    toast.error('Copy failed', { id, description: ipcMessage(e) })
    return []
  }
}

export async function openMediaFolder(): Promise<void> {
  const folder = useEditor.getState().project?.mediaFolder
  if (!folder) return
  try {
    await window.api.library.openFolder(folder)
  } catch (e) {
    toast.error("Couldn't open the folder", { description: ipcMessage(e) })
  }
}
