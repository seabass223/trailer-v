/**
 * Editor side of the MCP server (src/main/mcp): the main process calls these over IPC. Every
 * edit goes through `commit`, so it is one labelled undo step, shows live in the editor and is
 * autosaved — exactly like the same action done by hand. Times arrive in seconds.
 */
import { toast } from 'sonner'
import { engine } from '@/engine/client'
import { probeMedia } from '@/engine/media-client'
import { paragraphs, styleFrom, type RunStyle } from '@/engine/text/layout'
import { defaultTrackFor, nextNeighbour, textPresetClip } from '@/features/editor/actions'
import { flushSave, savePoster } from '@/state/persistence'
import { closeProject, commit, loadProject, redo, select, undo, useEditor } from '@/state/store'
import type {
  AddMediaParams, AddTextParams, ClipPropsInput, ClipView, EditorStateView, FrameImage, ParagraphInput, ProjectSettingsInput,
  ProjectView, TextPropsInput, TextStyleInput, TrackRef, UpdateClipParams,
} from '@shared/automation'
import { DEFAULT_DUCK } from '@shared/envelope'
import { baseClip, DEFAULT_TEXT_STYLE, TEXT_PRESETS, textMarks, TRACK_LABELS, trackAccepts, type TextStyle } from '@shared/factory'
import type { Clip, DuckSettings, MediaKind, Micros, Project, RichNode, TrackKind } from '@shared/model'
import { DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION } from '@shared/presets'
import { secToUs, snapToFrame } from '@shared/time'
import {
  addClip, applyFormat, clipEnd, closeGaps, deleteClips, duplicateClip, findClip, insertTrack, isMain, mainTrack,
  minClipDuration, moveClip, moveTrack, normalize, projectDuration, setTransition, splitAt, transitionBetween, trimClip,
} from '@shared/timeline'

const get = useEditor.getState

/** Seconds with millisecond precision, for readable results. */
const sec = (us: Micros): number => Math.round(us / 1000) / 1000

function requireProject(): Project {
  const p = get().project
  if (!p) throw new Error('No project is open. Call open_project or create_project first.')
  return p
}

function requireClip(p: Project, id: string): Clip {
  const c = findClip(p, id)
  if (!c) throw new Error(`No clip with id ${id}`)
  return c
}

/** Seconds → µs on the project's frame grid. */
const frames = (p: Project) => (s: number): Micros => snapToFrame(secToUs(s), p.settings.fps)

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()))

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

const plainText = (doc: RichNode): string => paragraphs(doc).map((para) => para.runs.map((r) => r.text).join('')).join('\n')

function clipView(p: Project, c: Clip): ClipView {
  const v: ClipView = {
    id: c.id,
    track: c.trackId,
    kind: c.kind,
    name: c.name,
    source: c.source,
    start: sec(c.start),
    end: sec(clipEnd(c)),
    duration: sec(c.duration),
    inPoint: sec(c.inPoint),
    sourceDuration: c.sourceDuration == null ? null : sec(c.sourceDuration),
    volume: c.volume,
    muted: !!c.muted,
    fadeIn: { duration: sec(c.fadeIn.duration), color: c.fadeIn.color },
    fadeOut: { duration: sec(c.fadeOut.duration), color: c.fadeOut.color },
    transform: { ...c.transform },
  }
  if (c.mediaWidth) v.mediaSize = [c.mediaWidth, c.mediaHeight]
  if (c.volumeKeys?.length) v.volumeKeys = c.volumeKeys.map((k) => ({ t: sec(k.t), gain: k.gain }))
  if (c.text) {
    const first = paragraphs(c.text.doc)[0]
    const run = first?.runs[0]?.style
    const b = c.text.box
    v.text = {
      plain: plainText(c.text.doc),
      style: {
        ...(run ? { font: run.fontFamily, size: run.fontSize, color: run.color, weight: run.weight, italic: run.italic, letterSpacing: run.fontSize ? run.letterSpacing / run.fontSize : 0 } : {}),
        align: first?.align ?? 'center',
      },
      box: { width: b.width, padding: b.padding, background: b.background, opacity: b.backgroundOpacity, radius: b.radius, fullFrame: b.fullFrame },
      knockout: c.text.knockout,
      lineHeight: c.text.lineHeight ?? 1.15,
    }
  }
  return v
}

function projectView(p: Project): ProjectView {
  const main = mainTrack(p).id
  const row = new Map(p.tracks.map((t, i) => [t.id, i]))
  return {
    id: p.id,
    name: p.name,
    mediaFolder: p.mediaFolder,
    settings: { ...p.settings },
    duration: sec(projectDuration(p)),
    tracks: p.tracks.map((t, i) => ({
      id: t.id, kind: t.kind, name: t.name, row: i, main: t.id === main, hidden: t.hidden,
      ...(t.duck ? { duck: t.duck } : {}),
      clips: p.clips.filter((c) => c.trackId === t.id).length,
    })),
    clips: [...p.clips]
      .sort((a, b) => row.get(a.trackId)! - row.get(b.trackId)! || a.start - b.start)
      .map((c) => clipView(p, c)),
    transitions: p.transitions.map((t) => ({ id: t.id, from: t.fromClipId, to: t.toClipId, duration: sec(t.duration) })),
  }
}

function stateView(): EditorStateView {
  const s = get()
  const p = s.project
  const e = engine()
  return {
    screen: p ? 'editor' : 'home',
    project: p
      ? { id: p.id, name: p.name, duration: sec(projectDuration(p)), settings: { ...p.settings }, mediaFolder: p.mediaFolder, clips: p.clips.length }
      : null,
    time: sec(e.time()),
    playing: e.playing,
    selection: s.selection,
    gpu: e.adapter,
    engineError: e.error,
    undo: s.past.at(-1)?.label ?? null,
    redo: s.future[0]?.label ?? null,
  }
}

const clipResult = (id: string, note?: string) => {
  const p = requireProject()
  const c = requireClip(p, id)
  return { clip: clipView(p, c), ...(note ? { note } : {}), projectDuration: sec(projectDuration(p)) }
}

// ---------------------------------------------------------------------------
// Tracks and placement
// ---------------------------------------------------------------------------

const TRACK_KINDS = Object.keys(TRACK_LABELS) as TrackKind[]

/** Resolve a TrackRef inside a recipe (may create a track). */
function resolveTrack(d: Project, ref: TrackRef | undefined, kind: MediaKind): string {
  const accepts = (t: { kind: TrackKind; name: string }) => {
    if (!trackAccepts(t.kind, kind)) throw new Error(`Track "${t.name}" (${t.kind}) can't hold ${kind} clips`)
  }
  if (!ref) return defaultTrackFor(d, kind)
  if (ref === 'main') {
    const t = mainTrack(d)
    accepts(t)
    return t.id
  }
  if (ref === 'new') return insertTrack(d, kind).id
  if ((TRACK_KINDS as string[]).includes(ref)) {
    const t = ref === 'video' ? mainTrack(d) : d.tracks.find((x) => x.kind === ref)
    if (t) {
      accepts(t)
      return t.id
    }
    accepts({ kind: ref as TrackKind, name: ref })
    return insertTrack(d, ref as TrackKind).id
  }
  const t = d.tracks.find((x) => x.id === ref) ?? d.tracks.find((x) => x.name === ref)
  if (!t) throw new Error(`No track "${ref}". Use a track id from get_project, "main", "new", or a kind.`)
  accepts(t)
  return t.id
}

/** Main track: insert at the nearest clip boundary (append without `start`). Free tracks: never overlap. */
function place(d: Project, clip: Clip, trackId: string, start: Micros | undefined): void {
  addClip(d, clip, trackId, start ?? (isMain(d, trackId) ? Number.MAX_SAFE_INTEGER : 0))
}

function placementNote(requested: number | undefined, c: Clip, main: boolean): string | undefined {
  if (requested == null) return undefined
  if (Math.abs(sec(c.start) - requested) < 0.0015) return undefined
  return main
    ? `The main track is magnetic: the clip was inserted at the nearest clip boundary (${sec(c.start)}s).`
    : `That spot was taken on this track; the clip went to the nearest free spot (${sec(c.start)}s). Use another track (track: "new") to overlap clips.`
}

// ---------------------------------------------------------------------------
// Clip properties
// ---------------------------------------------------------------------------

function applyProps(p: Project, c: Clip, x: ClipPropsInput): void {
  const f = frames(p)
  if (x.name != null) c.name = x.name
  if (x.volume != null) c.volume = Math.max(0, Math.min(4, x.volume))
  if (x.muted === true) c.muted = true
  else if (x.muted === false) delete c.muted
  if (x.fadeIn) c.fadeIn = { duration: Math.max(0, f(x.fadeIn.duration)), color: x.fadeIn.color ?? c.fadeIn.color }
  if (x.fadeOut) c.fadeOut = { duration: Math.max(0, f(x.fadeOut.duration)), color: x.fadeOut.color ?? c.fadeOut.color }
  if (x.transform) c.transform = { ...c.transform, ...x.transform }
  if (x.volumeKeys) {
    if (x.volumeKeys.length) c.volumeKeys = x.volumeKeys.map((k) => ({ t: secToUs(k.t), gain: Math.max(0, k.gain) })).sort((a, b) => a.t - b.t)
    else delete c.volumeKeys
  }
}

function runToStyle(r: RunStyle): TextStyle {
  return {
    fontFamily: r.fontFamily, fontSize: r.fontSize, color: r.color, weight: r.weight, bold: r.weight >= 700, italic: r.italic,
    underline: r.underline, letterSpacing: r.fontSize ? r.letterSpacing / r.fontSize : 0, align: 'center',
  }
}

function withStyle(base: TextStyle, s: TextStyleInput | undefined): TextStyle {
  if (!s) return base
  const weight = s.weight ?? base.weight ?? (base.bold ? 700 : 400)
  return {
    ...base,
    fontFamily: s.font ?? base.fontFamily,
    fontSize: s.size ?? base.fontSize,
    color: s.color ?? base.color,
    weight,
    bold: weight >= 700,
    italic: s.italic ?? base.italic,
    underline: s.underline ?? base.underline,
    letterSpacing: s.letterSpacing ?? base.letterSpacing,
  }
}

const firstRunStyle = (doc: RichNode | null): TextStyle => {
  const run = doc ? paragraphs(doc)[0]?.runs[0] : undefined
  return run ? runToStyle(run.style) : { ...DEFAULT_TEXT_STYLE }
}

const firstAlign = (doc: RichNode | null): 'left' | 'center' | 'right' => {
  const a = doc ? paragraphs(doc)[0]?.align : undefined
  return a === 'left' || a === 'right' ? a : 'center'
}

function docFromParagraphs(paras: ParagraphInput[], base: TextStyle, align: 'left' | 'center' | 'right'): RichNode {
  return {
    type: 'doc',
    content: paras.map((para) => ({
      type: 'paragraph',
      attrs: { textAlign: para.align ?? align },
      content: para.runs.filter((r) => r.text).map((r) => ({ type: 'text', text: r.text, marks: textMarks(withStyle(base, r)) })),
    })),
  }
}

function docFromText(text: string, style: TextStyle, align: 'left' | 'center' | 'right'): RichNode {
  const marks = textMarks(style)
  return {
    type: 'doc',
    content: text.split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      attrs: { textAlign: align },
      content: line ? [{ type: 'text', text: line, marks }] : undefined,
    })),
  }
}

/** Restyle every run, keeping what `style` doesn't mention. */
function restyle(doc: RichNode, style: TextStyleInput | undefined, align: string | undefined): RichNode {
  // `doc` may be an Immer draft (a Proxy), which structuredClone can't copy.
  const next = JSON.parse(JSON.stringify(doc)) as RichNode
  for (const block of next.content ?? []) {
    if (align) block.attrs = { ...block.attrs, textAlign: align }
    for (const n of block.content ?? []) {
      if (n.type === 'text' && style) n.marks = textMarks(withStyle(runToStyle(styleFrom(n.marks)), style))
    }
  }
  return next
}

const hasTextProps = (x: TextPropsInput) =>
  x.text != null || x.paragraphs != null || x.style != null || x.align != null || x.box != null || x.knockout != null || x.lineHeight != null

function applyText(c: Clip, x: TextPropsInput): void {
  if (!c.text) {
    if (hasTextProps(x)) throw new Error(`${c.name} is not a text clip`)
    return
  }
  const doc = c.text.doc
  const align = x.align ?? firstAlign(doc)
  if (x.paragraphs) c.text.doc = docFromParagraphs(x.paragraphs, withStyle(firstRunStyle(doc), x.style), align)
  else if (x.text != null) c.text.doc = docFromText(x.text, withStyle(firstRunStyle(doc), x.style), align)
  else if (x.style || x.align) c.text.doc = restyle(doc, x.style, x.align)
  if (x.box) {
    const b = c.text.box
    c.text.box = {
      width: x.box.width ?? b.width,
      padding: x.box.padding ?? b.padding,
      background: x.box.background ?? b.background,
      backgroundOpacity: x.box.opacity ?? b.backgroundOpacity,
      radius: x.box.radius ?? b.radius,
      fullFrame: x.box.fullFrame ?? b.fullFrame,
    }
  }
  if (x.knockout != null) c.text.knockout = x.knockout
  if (x.lineHeight != null) c.text.lineHeight = x.lineHeight
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function openProject({ id }: { id: string }): Promise<ProjectView> {
  const cur = get().project
  if (cur?.id === id) return projectView(cur)
  const next = await window.api.projects.read(id)
  if (cur) await leaveProject()
  loadProject(next)
  await nextFrame()
  await nextFrame()
  return projectView(requireProject())
}

async function leaveProject(): Promise<void> {
  if (engine().playing) engine().pause()
  await savePoster().catch(() => {})
  await flushSave()
  closeProject()
}

function addMedia(x: AddMediaParams): Promise<unknown> {
  return (async () => {
    const p = requireProject()
    const file = x.file
    if (file.kind === 'text') throw new Error('Use add_text_clip for text')
    const meta = await probeMedia(file)
    if (meta.error) throw new Error(`${file.name}: ${meta.error}`)
    const f = frames(p)
    const srcDur = file.kind === 'image' ? null : meta.duration
    const inPoint = x.inPoint != null && srcDur != null ? Math.max(0, Math.min(f(x.inPoint), srcDur - minClipDuration(p.settings.fps))) : 0
    const avail = srcDur == null ? Number.POSITIVE_INFINITY : srcDur - inPoint
    const want = x.duration != null ? f(x.duration) : srcDur == null ? DEFAULT_IMAGE_DURATION : avail
    const clip = baseClip({
      kind: file.kind, trackId: '', name: x.name ?? file.name, source: file.path,
      duration: Math.max(minClipDuration(p.settings.fps), Math.min(want, avail)),
      inPoint, sourceDuration: srcDur, mediaWidth: meta.width, mediaHeight: meta.height,
      hasAudio: file.kind === 'audio' ? true : meta.hasAudio,
    })
    const note = x.duration != null && want > avail ? `The source only has ${sec(avail)}s after the in-point; the clip is that long.` : undefined
    applyProps(p, clip, { ...x, name: undefined })
    let main = false
    commit(`Add ${clip.name}`, (d) => {
      const track = resolveTrack(d, x.track, file.kind)
      main = isMain(d, track)
      place(d, clip, track, x.start != null ? f(x.start) : undefined)
    })
    select([clip.id])
    const placed = requireClip(requireProject(), clip.id)
    return clipResult(clip.id, [placementNote(x.start, placed, main), note].filter(Boolean).join(' ') || undefined)
  })()
}

function addText(x: AddTextParams): unknown {
  const p = requireProject()
  const preset = TEXT_PRESETS.find((t) => t.id === (x.preset ?? 'title'))
  if (!preset) throw new Error(`Unknown text preset "${x.preset}". Presets: ${TEXT_PRESETS.map((t) => t.id).join(', ')}`)
  if (x.text == null && x.paragraphs == null) throw new Error('Give text or paragraphs')
  const f = frames(p)
  const clip = textPresetClip(preset, '')
  clip.duration = Math.max(minClipDuration(p.settings.fps), f(x.duration ?? DEFAULT_TEXT_DURATION / 1e6))
  applyText(clip, x)
  clip.name = x.name ?? (plainText(clip.text!.doc).split('\n')[0].slice(0, 40) || preset.name)
  applyProps(p, clip, { ...x, name: undefined })
  let main = false
  commit(`Add ${clip.name}`, (d) => {
    const track = resolveTrack(d, x.track, 'text')
    main = isMain(d, track)
    place(d, clip, track, x.start != null ? f(x.start) : undefined)
  })
  select([clip.id])
  return clipResult(clip.id, placementNote(x.start, requireClip(requireProject(), clip.id), main))
}

function updateClip(x: UpdateClipParams): unknown {
  const p = requireProject()
  const c = requireClip(p, x.id)
  const f = frames(p)
  commit(`Edit ${c.name}`, (d) => {
    const dc = requireClip(d, x.id)
    applyProps(d, dc, x)
    applyText(dc, x)
    if (x.inPoint != null) {
      if (dc.sourceDuration == null) throw new Error(`${dc.name} has no source length to slip`)
      dc.inPoint = Math.max(0, Math.min(f(x.inPoint), dc.sourceDuration - dc.duration))
    }
    normalize(d)
  })
  return clipResult(x.id)
}

function moveClipTo({ id, track, start }: { id: string; track?: TrackRef; start: number }): unknown {
  const p = requireProject()
  const c = requireClip(p, id)
  let main = false
  commit(`Move ${c.name}`, (d) => {
    const t = track ? resolveTrack(d, track, c.kind) : c.trackId
    main = isMain(d, t)
    moveClip(d, id, t, frames(d)(start))
  })
  return clipResult(id, placementNote(start, requireClip(requireProject(), id), main))
}

function trim({ id, edge, to, by }: { id: string; edge: 'start' | 'end'; to?: number; by?: number }): unknown {
  const p = requireProject()
  const c = requireClip(p, id)
  const f = frames(p)
  if (to == null && by == null) throw new Error('Give `to` (timeline seconds) or `by` (seconds, + = rightwards)')
  const delta = by != null ? f(by) : f(to!) - (edge === 'start' ? c.start : clipEnd(c))
  commit(`Trim ${c.name}`, (d) => trimClip(d, id, edge, delta))
  return clipResult(id)
}

function split({ at, ids }: { at: number; ids?: string[] }): unknown {
  requireProject()
  let created: string[] = []
  commit(ids?.length ? 'Split selection' : 'Split at playhead', (d) => {
    created = splitAt(d, frames(d)(at), ids)
  })
  if (!created.length) throw new Error(`Nothing to split at ${at}s${ids?.length ? ' in those clips' : ''}`)
  const next = requireProject()
  return { created: created.map((id) => clipView(next, requireClip(next, id))) }
}

function remove({ ids }: { ids: string[] }): unknown {
  const p = requireProject()
  const missing = ids.filter((id) => !findClip(p, id))
  if (missing.length) throw new Error(`No clips with ids ${missing.join(', ')}`)
  commit(ids.length === 1 ? `Delete ${findClip(p, ids[0])!.name}` : `Delete ${ids.length} clips`, (d) => deleteClips(d, ids))
  select([])
  return { deleted: ids.length, projectDuration: sec(projectDuration(requireProject())) }
}

function duplicate({ id }: { id: string }): unknown {
  requireClip(requireProject(), id)
  let copy: string | null = null
  commit('Duplicate clip', (d) => {
    copy = duplicateClip(d, id)
  })
  if (!copy) throw new Error('Could not duplicate')
  return clipResult(copy)
}

function transition({ from, to, duration }: { from: string; to?: string; duration: number }): unknown {
  const p = requireProject()
  requireClip(p, from)
  const next = to ?? nextNeighbour(p, from)?.id
  if (!next) throw new Error('That clip has no clip right after it on its track')
  requireClip(p, next)
  commit(duration > 0 ? 'Add cross-fade' : 'Remove transition', (d) => setTransition(d, from, next, duration > 0 ? frames(d)(duration) : null))
  const t = transitionBetween(requireProject(), from, next)
  if (duration > 0 && !t) throw new Error('Cross-fades need two clips that touch on the same track')
  return { transition: t ? { id: t.id, from, to: next, duration: sec(t.duration) } : null }
}

function addTrack({ kind, name }: { kind: TrackKind; name?: string }): unknown {
  let id = ''
  commit(`Add ${kind} track`, (d) => {
    const t = insertTrack(d, kind)
    if (name?.trim()) t.name = name.trim()
    id = t.id
  })
  return { track: projectView(requireProject()).tracks.find((t) => t.id === id) }
}

function updateTrack(x: { id: string; name?: string; hidden?: boolean; duck?: Partial<DuckSettings>; row?: number }): unknown {
  const p = requireProject()
  const t = p.tracks.find((y) => y.id === x.id)
  if (!t) throw new Error(`No track with id ${x.id}`)
  if (x.duck && t.kind !== 'audio') throw new Error('Only audio tracks duck')
  commit(`Edit ${t.name}`, (d) => {
    const dt = d.tracks.find((y) => y.id === x.id)!
    if (x.name?.trim()) dt.name = x.name.trim()
    if (x.hidden != null) dt.hidden = x.hidden
    if (x.duck) dt.duck = { ...DEFAULT_DUCK, ...dt.duck, ...x.duck }
    if (x.row != null) moveTrack(d, x.id, x.row)
  })
  return { track: projectView(requireProject()).tracks.find((y) => y.id === x.id) }
}

function removeTrack({ id }: { id: string }): unknown {
  const p = requireProject()
  const t = p.tracks.find((x) => x.id === id)
  if (!t) throw new Error(`No track with id ${id}`)
  if (isMain(p, id)) throw new Error('The main video track cannot be removed')
  if (p.clips.some((c) => c.trackId === id)) throw new Error('Only empty tracks can be removed')
  commit(`Remove ${t.name}`, (d) => {
    d.tracks = d.tracks.filter((x) => x.id !== id)
  })
  return { removed: id }
}

function settings(x: ProjectSettingsInput): unknown {
  const p = requireProject()
  if (x.fps != null && ![24, 25, 30, 50, 60].includes(x.fps)) throw new Error('fps must be 24, 25, 30, 50 or 60')
  commit(x.aspect && x.aspect !== p.settings.aspect ? `Change aspect to ${x.aspect}` : 'Project settings', (d) => {
    if (x.name?.trim()) d.name = x.name.trim()
    if (x.aspect || x.tier) applyFormat(d, x.aspect ?? d.settings.aspect, x.tier ?? d.settings.tier, x.fit ?? 'contain')
    if (x.fps != null) d.settings.fps = x.fps
    if (x.background) d.settings.background = x.background
    if (x.mediaFolder !== undefined) d.mediaFolder = x.mediaFolder
  })
  return projectView(requireProject())
}

function history(): unknown {
  const s = get()
  return { past: s.past.slice(-30).map((e) => e.label), future: s.future.slice(0, 30).map((e) => e.label) }
}

function step(dir: 'undo' | 'redo', steps = 1): unknown {
  requireProject()
  const labels: string[] = []
  for (let i = 0; i < steps; i++) {
    const s = get()
    const entry = dir === 'undo' ? s.past.at(-1) : s.future[0]
    if (!entry) break
    labels.push(entry.label)
    if (dir === 'undo') undo()
    else redo()
  }
  return { [dir === 'undo' ? 'undone' : 'redone']: labels, ...(history() as object) }
}

async function frame({ time, width, format, quality }: { time: number; width?: number; format?: 'jpeg' | 'png'; quality?: number }): Promise<FrameImage> {
  const p = requireProject()
  if (engine().playing) engine().pause()
  const mime = format === 'png' ? 'image/png' : 'image/jpeg'
  const t = Math.max(0, Math.min(frames(p)(time), projectDuration(p)))
  const r = await engine().snapshot(t, { width: width ?? 960, mime, quality: quality ?? 0.9, timeoutMs: 15_000 })
  if (!r) throw new Error('The frame did not render in time (is the GPU busy?)')
  return { image: r.image, mime, width: r.width, height: r.height, complete: r.complete }
}

/** Frames at `times` tiled into one labelled contact sheet. */
async function storyboard({ times, width, columns }: { times: number[]; width?: number; columns?: number }): Promise<FrameImage> {
  const p = requireProject()
  if (!times.length) throw new Error('Give at least one time')
  const tileW = Math.max(120, Math.min(width ?? 384, 960))
  const tileH = Math.round((tileW * p.settings.height) / p.settings.width)
  const cols = Math.max(1, Math.min(columns ?? 4, times.length))
  const rows = Math.ceil(times.length / cols)
  const gap = 8
  const canvas = new OffscreenCanvas(cols * tileW + (cols + 1) * gap, rows * tileH + (rows + 1) * gap)
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#0f1115'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  let complete = true
  for (let i = 0; i < times.length; i++) {
    const f = await frame({ time: times[i], width: tileW, format: 'jpeg', quality: 0.85 })
    complete &&= f.complete
    const bmp = await createImageBitmap(new Blob([f.image], { type: f.mime }))
    const x = gap + (i % cols) * (tileW + gap)
    const y = gap + Math.floor(i / cols) * (tileH + gap)
    ctx.drawImage(bmp, x, y, tileW, tileH)
    bmp.close()
    const label = `${times[i].toFixed(2)}s`
    ctx.font = '600 13px "Segoe UI", sans-serif'
    const w = ctx.measureText(label).width + 12
    ctx.fillStyle = 'rgba(0,0,0,0.7)'
    ctx.fillRect(x + 6, y + tileH - 26, w, 20)
    ctx.fillStyle = '#ffffff'
    ctx.fillText(label, x + 12, y + tileH - 11)
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 })
  return { image: await blob.arrayBuffer(), mime: 'image/jpeg', width: canvas.width, height: canvas.height, complete }
}

async function play(): Promise<unknown> {
  requireProject()
  await engine().play()
  return stateView()
}

type ToastKind = 'info' | 'success' | 'error' | 'loading'

function notify({ kind, message, description, id, dismiss }: { kind?: ToastKind; message?: string; description?: string; id?: string; dismiss?: boolean }): unknown {
  if (dismiss && id) {
    toast.dismiss(id)
    return {}
  }
  const opts = { id, description, duration: kind === 'loading' ? Infinity : 5000 }
  const fn = kind === 'success' ? toast.success : kind === 'error' ? toast.error : kind === 'loading' ? toast.loading : toast
  fn(message ?? '', opts)
  return {}
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const handlers: Record<string, (params: any) => unknown> = {
  state: () => stateView(),
  openProject,
  closeProject: async () => {
    if (get().project) await leaveProject()
    return stateView()
  },
  getProject: ({ raw }: { raw?: boolean }) => (raw ? requireProject() : projectView(requireProject())),
  updateProject: settings,
  probe: async ({ file }) => probeMedia(file),
  addMedia,
  addText,
  updateClip,
  moveClip: moveClipTo,
  trimClip: trim,
  splitClip: split,
  deleteClips: remove,
  duplicateClip: duplicate,
  setTransition: transition,
  addTrack,
  updateTrack,
  removeTrack,
  closeGaps: ({ track }: { track?: string }) => {
    let closed = 0
    commit(track ? 'Close gaps on track' : 'Close gaps', (d) => {
      closed = closeGaps(d, 'video', track ? [track] : undefined)
    })
    return { closed }
  },
  select: ({ ids }: { ids: string[] }) => {
    select(ids.filter((id) => findClip(requireProject(), id)))
    return { selection: get().selection }
  },
  history,
  undo: ({ steps }: { steps?: number }) => step('undo', steps),
  redo: ({ steps }: { steps?: number }) => step('redo', steps),
  seek: ({ time }: { time: number }) => {
    const p = requireProject()
    engine().seek(frames(p)(time))
    return stateView()
  },
  play,
  pause: () => {
    engine().pause()
    return stateView()
  },
  renderFrame: frame,
  storyboard,
  toast: notify,
}

/** Serve the main process's automation calls for the life of the page. */
export function startAutomation(): () => void {
  const api = window.api.automation
  const off = api.onCall((id, method, params) => {
    void (async () => {
      try {
        const fn = handlers[method]
        if (!fn) throw new Error(`Unknown automation method: ${method}`)
        api.reply(id, true, await fn(params ?? {}))
      } catch (e) {
        api.reply(id, false, (e as Error)?.message ?? String(e))
      }
    })()
  })
  api.ready()
  return off
}
