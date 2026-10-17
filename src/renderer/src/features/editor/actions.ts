/** User-level editing actions: each is one labelled undo step. */
import { toast } from 'sonner'
import { engine } from '@/engine/client'
import { probeMedia } from '@/engine/media-client'
import { commit, select, useEditor } from '@/state/store'
import { baseClip, textDoc, TEXT_PRESETS, trackAccepts, type TextPreset } from '@shared/factory'
import { DEFAULT_DUCK } from '@shared/envelope'
import type { AspectId, Clip, DuckSettings, FitMode, MediaFile, Micros, Project, TierId, TrackKind } from '@shared/model'
import { DEFAULT_IMAGE_DURATION, DEFAULT_XFADE } from '@shared/presets'
import {
  addClip, adjacentPairs, applyFormat, closeGaps, deleteClips, duplicateClip, findClip, insertTrack, isMain, mainTrack, moveClip,
  moveTrack, projectDuration, setTransition, splitAt, trimClip,
} from '@shared/timeline'

const project = () => useEditor.getState().project

export function defaultTrackFor(p: Project, kind: Clip['kind']): string {
  if (kind === 'video') return mainTrack(p).id
  const t = p.tracks.find((t) => t.kind === kind)
  return t ? t.id : mainTrack(p).id
}

export async function clipFromFile(file: MediaFile, trackId: string): Promise<Clip | null> {
  if (file.kind === 'text') {
    const content = await window.api.library.readText(file.path)
    const base = TEXT_PRESETS[0]
    return baseClip({
      kind: 'text', trackId, name: file.name, source: null,
      text: { ...structuredClone(base.text), doc: textDoc(content.trim() || file.name, { fontSize: 96 }) },
    })
  }
  const meta = await probeMedia(file)
  if (meta.error) {
    toast.error(`${file.name}: ${meta.error}`)
    return null
  }
  if (file.kind === 'image') {
    return baseClip({ kind: 'image', trackId, name: file.name, source: file.path, duration: DEFAULT_IMAGE_DURATION, mediaWidth: meta.width, mediaHeight: meta.height })
  }
  const duration = meta.duration ?? DEFAULT_IMAGE_DURATION
  return baseClip({
    kind: file.kind, trackId, name: file.name, source: file.path, duration, sourceDuration: duration,
    mediaWidth: meta.width, mediaHeight: meta.height, hasAudio: file.kind === 'audio' ? true : meta.hasAudio,
  })
}

export function textPresetClip(preset: TextPreset, trackId: string): Clip {
  const text = structuredClone(preset.text)
  return baseClip({ kind: 'text', trackId, name: preset.name, text, transform: { fit: 'contain', x: 0, y: preset.y, scale: 1 } })
}

function compatibleTrack(p: Project, trackId: string | null, kind: Clip['kind']): string {
  const t = trackId ? p.tracks.find((x) => x.id === trackId) : null
  return t && trackAccepts(t.kind, kind) ? t.id : defaultTrackFor(p, kind)
}

export async function addFile(file: MediaFile, trackId: string | null, at: Micros): Promise<void> {
  const p = project()
  if (!p) return
  const target = compatibleTrack(p, trackId, file.kind)
  const clip = await clipFromFile(file, target)
  if (!clip) return
  commit(`Add ${file.name}`, (d) => addClip(d, clip, target, at))
  select([clip.id])
}

export function addPreset(preset: TextPreset, trackId: string | null, at: Micros): void {
  const p = project()
  if (!p) return
  const target = compatibleTrack(p, trackId, 'text')
  const clip = textPresetClip(preset, target)
  commit(`Add ${preset.name}`, (d) => addClip(d, clip, target, at))
  select([clip.id])
}

export function moveClipTo(id: string, trackId: string, at: Micros): void {
  const c = project()?.clips.find((x) => x.id === id)
  if (!c) return
  commit(`Move ${c.name}`, (d) => moveClip(d, id, trackId, at))
}

export function trim(id: string, edge: 'start' | 'end', delta: Micros): void {
  const c = project()?.clips.find((x) => x.id === id)
  if (!c) return
  commit(`Trim ${c.name}`, (d) => trimClip(d, id, edge, delta))
}

export function splitAtPlayhead(): void {
  const p = project()
  if (!p) return
  const at = engine().time()
  const sel = useEditor.getState().selection
  let created: string[] = []
  const ok = commit(sel.length ? 'Split selection' : 'Split at playhead', (d) => {
    created = splitAt(d, at, sel)
  })
  if (!ok) toast('Nothing under the playhead to split', { duration: 1500 })
  else if (created.length) select(created)
}

export function deleteSelection(): void {
  const sel = useEditor.getState().selection
  if (!sel.length) return
  commit(sel.length === 1 ? `Delete ${findClip(project()!, sel[0])?.name ?? 'clip'}` : `Delete ${sel.length} clips`, (d) => deleteClips(d, sel))
  select([])
}

export function duplicateSelection(): void {
  const sel = useEditor.getState().selection
  if (sel.length !== 1) return
  let id: string | null = null
  commit('Duplicate clip', (d) => {
    id = duplicateClip(d, sel[0])
  })
  if (id) select([id])
}

export function updateClip(id: string, label: string, recipe: (c: Clip) => void, coalesceKey?: string): void {
  commit(label, (d) => {
    const c = d.clips.find((x) => x.id === id)
    if (c) recipe(c)
  }, { coalesceKey: coalesceKey ? `${coalesceKey}:${id}` : undefined })
}

export const clipHasSound = (c: Clip): boolean => !!c.source && (c.kind === 'audio' || (c.kind === 'video' && c.hasAudio))

/**
 * Mute or un-mute clips' own sound (volume is kept). Mixed selections all go muted first.
 * Defaults to the selected clips that have sound.
 */
export function toggleMute(ids?: readonly string[]): void {
  const p = project()
  if (!p) return
  const targets = p.clips.filter((c) => (ids ?? useEditor.getState().selection).includes(c.id) && clipHasSound(c))
  if (!targets.length) {
    if (!ids) toast('Select a clip with sound to mute it', { duration: 1500 })
    return
  }
  const mute = targets.some((c) => !c.muted)
  const name = targets.length === 1 ? ` ${targets[0].name}` : ` ${targets.length} clips`
  const set = new Set(targets.map((c) => c.id))
  commit(`${mute ? 'Mute' : 'Unmute'}${name}`, (d) => {
    for (const c of d.clips) {
      if (!set.has(c.id)) continue
      if (mute) c.muted = true
      else delete c.muted
    }
  })
}

/** Change an audio track's ducking; the first change enables it with the defaults. */
export function setDuck(trackId: string, patch: Partial<DuckSettings>, coalesceKey?: string): void {
  const t = project()?.tracks.find((x) => x.id === trackId)
  if (!t) return
  const label = patch.enabled === undefined ? 'Ducking' : patch.enabled ? `Duck ${t.name}` : `Stop ducking ${t.name}`
  commit(label, (d) => {
    const x = d.tracks.find((y) => y.id === trackId)
    if (x) x.duck = { ...DEFAULT_DUCK, ...x.duck, ...patch }
  }, { coalesceKey: coalesceKey ? `${coalesceKey}:${trackId}` : undefined })
}

export function setCrossfade(fromId: string, toId: string, duration: Micros | null): void {
  commit(duration ? 'Add cross-fade' : 'Remove transition', (d) => setTransition(d, fromId, toId, duration), {
    coalesceKey: duration ? `xfade:${fromId}` : undefined,
  })
}

/** Cross-fade from a clip into its right-hand neighbour, if they touch. */
export function nextNeighbour(p: Project, id: string): Clip | null {
  const c = findClip(p, id)
  if (!c) return null
  const pair = adjacentPairs(p, c.trackId).find(([a]) => a.id === id)
  return pair ? pair[1] : null
}

export function addCrossfadeAfter(id: string): void {
  const p = project()
  if (!p) return
  const next = nextNeighbour(p, id)
  if (next) setCrossfade(id, next.id, DEFAULT_XFADE)
  else toast('This clip has no clip right after it', { duration: 1500 })
}

export function toggleTrack(trackId: string): void {
  const t = project()?.tracks.find((x) => x.id === trackId)
  if (!t) return
  commit(t.kind === 'audio' ? (t.hidden ? 'Unmute track' : 'Mute track') : t.hidden ? 'Show track' : 'Hide track', (d) => {
    const x = d.tracks.find((y) => y.id === trackId)
    if (x) x.hidden = !x.hidden
  })
}

export function renameTrack(trackId: string, name: string): void {
  const t = project()?.tracks.find((x) => x.id === trackId)
  const next = name.trim()
  if (!t || !next || next === t.name) return
  commit(`Rename ${t.name}`, (d) => {
    const x = d.tracks.find((y) => y.id === trackId)
    if (x) x.name = next
  })
}

export function reorderTrack(trackId: string, to: number): void {
  const t = project()?.tracks.find((x) => x.id === trackId)
  if (!t) return
  commit(`Move ${t.name}`, (d) => {
    moveTrack(d, trackId, to)
  })
}

export function addTrack(kind: TrackKind): void {
  commit(`Add ${kind} track`, (d) => {
    insertTrack(d, kind)
  })
}

export function removeTrack(trackId: string): void {
  const p = project()
  if (!p) return
  const t = p.tracks.find((x) => x.id === trackId)
  if (!t || isMain(p, trackId)) return
  if (p.clips.some((c) => c.trackId === trackId)) {
    toast('Only empty tracks can be removed', { duration: 1500 })
    return
  }
  commit(`Remove ${t.name}`, (d) => {
    d.tracks = d.tracks.filter((x) => x.id !== trackId)
  })
}

/** Butt video clips together (all video tracks, or one), keeping transitions; one undo step. */
export function closeVideoGaps(trackId?: string): void {
  let closed = 0
  commit(trackId ? 'Close gaps on track' : 'Close gaps', (d) => {
    closed = closeGaps(d, 'video', trackId ? [trackId] : undefined)
  })
  if (closed) toast.success(`Closed ${closed} gap${closed === 1 ? '' : 's'}`, { duration: 1500 })
  else toast('No gaps between video clips', { duration: 1500 })
}

export function changeFormat(aspect: AspectId, tier: TierId, fit: FitMode | null): void {
  commit(aspect !== project()?.settings.aspect ? `Change aspect to ${aspect}` : `Resolution ${tier}`, (d) => applyFormat(d, aspect, tier, fit))
}

export function selectAll(): void {
  select(project()?.clips.map((c) => c.id) ?? [])
}

export function goToStart(): void {
  engine().seek(0)
}

export function goToEnd(): void {
  const p = project()
  if (p) engine().seek(projectDuration(p))
}
