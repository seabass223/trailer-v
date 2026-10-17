/**
 * Editor state. The project document only changes through `commit`, which records Immer
 * patches for undo/redo (one labelled entry per user action). Hot interactions (drag, trim,
 * scrub) never touch this store until pointer-up.
 */
import { applyPatches, enablePatches, produce, produceWithPatches, type Patch } from 'immer'
import { create } from 'zustand'
import type { EncoderCaps, MediaFile, MediaMeta, Project } from '@shared/model'
import type { PreviewQuality } from '@/engine/protocol'

enablePatches()

export interface HistoryEntry {
  label: string
  patches: Patch[]
  inverse: Patch[]
  at: number
  coalesceKey?: string
}

export type LibraryTab = 'media' | 'text' | 'image' | 'audio'

export interface EditorState {
  project: Project | null
  /** Transient project shown during a trim/fade drag (not in history until pointer-up). */
  draft: Project | null
  past: HistoryEntry[]
  future: HistoryEntry[]
  selection: string[]
  files: MediaFile[]
  meta: Record<string, MediaMeta>
  libraryTab: LibraryTab
  libraryLoading: boolean
  pxPerSec: number
  /** Width of the timeline's track-name column (px). */
  headerW: number
  inspectorOpen: boolean
  snapping: boolean
  quality: PreviewQuality
  fonts: string[]
  caps: EncoderCaps | null
  hud: boolean
  exportOpen: boolean
  shortcutsOpen: boolean
  editingTextId: string | null
}

export const HEADER_W_DEFAULT = 168

function storedHeaderW(): number {
  try {
    const v = Number(localStorage.getItem('timeline.headerW'))
    return v > 0 ? Math.min(420, Math.max(120, v)) : HEADER_W_DEFAULT
  } catch {
    return HEADER_W_DEFAULT
  }
}

export const useEditor = create<EditorState>(() => ({
  project: null,
  draft: null,
  past: [],
  future: [],
  selection: [],
  files: [],
  meta: {},
  libraryTab: 'media',
  libraryLoading: false,
  pxPerSec: 60,
  headerW: storedHeaderW(),
  inspectorOpen: true,
  snapping: true,
  quality: 'auto',
  fonts: [],
  caps: null,
  hud: false,
  exportOpen: false,
  shortcutsOpen: false,
  editingTextId: null,
}))

const get = useEditor.getState
const set = useEditor.setState

export function loadProject(p: Project): void {
  set({ project: p, past: [], future: [], selection: [], editingTextId: null })
}

export function closeProject(): void {
  set({ project: null, past: [], future: [], selection: [], files: [], meta: {}, editingTextId: null })
}

export interface CommitOptions {
  /** Consecutive commits with the same key within 1.5 s merge into one undo step (sliders). */
  coalesceKey?: string
}

/** Apply an edit as one undoable step. Returns false if nothing changed. */
export function commit(label: string, recipe: (draft: Project) => void, opts: CommitOptions = {}): boolean {
  const { project, past } = get()
  if (!project) return false
  const [next, patches, inverse] = produceWithPatches(project, recipe)
  if (!patches.length) return false
  const depth = project.settings.historyDepth || 200
  const last = past[past.length - 1]
  const now = performance.now()
  let entries: HistoryEntry[]
  if (opts.coalesceKey && last?.coalesceKey === opts.coalesceKey && now - last.at < 1500) {
    entries = [...past.slice(0, -1), { ...last, patches: [...last.patches, ...patches], inverse: [...inverse, ...last.inverse], at: now }]
  } else {
    entries = [...past, { label, patches, inverse, at: now, coalesceKey: opts.coalesceKey }]
    if (entries.length > depth) entries = entries.slice(entries.length - depth)
  }
  const ids = new Set(next.clips.map((c) => c.id))
  set({ project: next, past: entries, future: [], selection: get().selection.filter((id) => ids.has(id)) })
  return true
}

export function undo(): void {
  const { project, past, future } = get()
  const entry = past[past.length - 1]
  if (!project || !entry) return
  const next = applyPatches(project, entry.inverse)
  const ids = new Set(next.clips.map((c) => c.id))
  set({ project: next, past: past.slice(0, -1), future: [entry, ...future], selection: get().selection.filter((id) => ids.has(id)) })
}

export function redo(): void {
  const { project, past, future } = get()
  const entry = future[0]
  if (!project || !entry) return
  const next = applyPatches(project, entry.patches)
  set({ project: next, past: [...past, entry], future: future.slice(1) })
}

/** Jump so that `pastLength` entries are applied (History popover). */
export function jumpTo(pastLength: number): void {
  while (get().past.length > pastLength) undo()
  while (get().past.length < pastLength && get().future.length) redo()
}

/** Show a transient edit (live drag preview) without touching history. */
export function setDraft(recipe: (draft: Project) => void): void {
  const p = get().project
  if (!p) return
  set({ draft: produce(p, recipe) })
}

export function clearDraft(): void {
  if (get().draft) set({ draft: null })
}

/** The project as currently displayed (draft while dragging). */
export const shownProject = (s: EditorState) => s.draft ?? s.project

export function select(ids: string[]): void {
  set({ selection: ids })
}

export function toggleSelect(id: string): void {
  const s = get().selection
  set({ selection: s.includes(id) ? s.filter((x) => x !== id) : [...s, id] })
}

export const selectedClip = (s: EditorState) =>
  s.selection.length === 1 ? s.project?.clips.find((c) => c.id === s.selection[0]) ?? null : null
