import { Eye, EyeOff, Image as ImageIcon, Music, Plus, Trash2, Type, Video, Volume2, VolumeX } from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { probeMedia } from '@/engine/media-client'
import { registerDropTarget, type DragPayload } from '@/features/dnd/drag'
import { addFile, addPreset, addTrack, removeTrack, toggleTrack } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import { shownProject, useEditor } from '@/state/store'
import { trackAccepts } from '@shared/factory'
import type { Clip, Project, Track, TrackKind } from '@shared/model'
import { DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION } from '@shared/presets'
import { isMain, mainBoundaryTime, mainInsertIndex, nearestFreeStart, projectDuration } from '@shared/timeline'
import { ClipView } from './ClipView'
import { beginMarquee, newSnapLine, showSnapLine } from './interactions'
import { Junctions } from './Junctions'
import { Playhead } from './Playhead'
import { Ruler } from './Ruler'
import { Toolbar } from './Toolbar'
import { HEADER_W, ROW_H, RULER_H, rowTop, setZoom, timeAtClientX, trackAtClientY, usToPx, view } from './view'

const ICONS: Record<TrackKind, typeof Video> = { video: Video, text: Type, image: ImageIcon, audio: Music }

const TrackHeader = memo(function TrackHeader({ track, main }: { track: Track; main: boolean }) {
  const Icon = ICONS[track.kind]
  const audio = track.kind === 'audio'
  const Toggle = audio ? (track.hidden ? VolumeX : Volume2) : track.hidden ? EyeOff : Eye
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className="sticky left-0 z-30 flex shrink-0 items-center gap-3 border-b border-track-divider bg-timeline pl-4 pr-2"
          style={{ width: HEADER_W, height: ROW_H[track.kind] }}
        >
          <Icon className="size-5 shrink-0 text-foreground/80" />
          <span className={cn('truncate text-[14px]', track.hidden && 'text-muted-foreground')}>{track.name}</span>
          <Button variant="ghost" size="icon" className="ml-auto size-8 text-foreground/70" onClick={() => toggleTrack(track.id)}
            aria-label={audio ? 'Mute track' : 'Toggle visibility'}>
            <Toggle className="size-[18px]" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {track.kind !== 'video' && <ContextMenuItem onSelect={() => addTrack(track.kind as Exclude<TrackKind, 'video'>)}><Plus /> Add {track.kind} track</ContextMenuItem>}
        {!main && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={() => removeTrack(track.id)}><Trash2 /> Remove track</ContextMenuItem>
          </>
        )}
        {main && <ContextMenuItem disabled>Main track (magnetic)</ContextMenuItem>}
      </ContextMenuContent>
    </ContextMenu>
  )
})

const Lane = memo(function Lane({ project, track, pps, width, selection, offline }: {
  project: Project
  track: Track
  pps: number
  width: number
  selection: string[]
  offline: Set<string>
}) {
  const clips = useMemo(() => project.clips.filter((c) => c.trackId === track.id), [project.clips, track.id])
  const h = ROW_H[track.kind]
  return (
    <div
      className={cn('group/lane relative shrink-0 border-b border-track-divider', track.hidden && 'opacity-40')}
      style={{ width, height: h }}
      onPointerDown={(e) => e.button === 0 && beginMarquee(e.nativeEvent)}
    >
      {clips.map((c: Clip) => (
        <ClipView key={c.id} clip={c} pps={pps} height={h} selected={selection.includes(c.id)} offline={!!c.source && offline.has(c.source)} />
      ))}
      <Junctions project={project} trackId={track.id} pps={pps} height={h} />
    </div>
  )
})

function payloadKind(p: DragPayload): Clip['kind'] {
  return p.type === 'preset' ? 'text' : p.file.kind
}

export function Timeline() {
  const project = useEditor(shownProject)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const selection = useEditor((s) => s.selection)
  const files = useEditor((s) => s.files)
  const scrollRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    view.scroller = scrollRef.current
    view.overlay = overlayRef.current
  }, [])

  // Ctrl+wheel zooms around the cursor; needs a non-passive listener.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return
      e.preventDefault()
      setZoom(useEditor.getState().pxPerSec * Math.pow(1.0018, -e.deltaY), e.clientX)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Library -> timeline drop target with a live, clip-shaped preview.
  useEffect(() => {
    let ghost: HTMLDivElement | null = null
    let marker: HTMLDivElement | null = null
    let snapLine: HTMLDivElement | null = null
    const durations = new Map<string, number>()
    const durationOf = (p: DragPayload): number => {
      if (p.type === 'preset') return DEFAULT_TEXT_DURATION
      if (p.file.kind === 'image') return DEFAULT_IMAGE_DURATION
      if (p.file.kind === 'text') return DEFAULT_TEXT_DURATION
      const known = durations.get(p.file.path)
      if (known == null) {
        durations.set(p.file.path, DEFAULT_IMAGE_DURATION)
        void probeMedia(p.file).then((m) => m.duration && durations.set(p.file.path, m.duration))
      }
      return durations.get(p.file.path)!
    }
    const target = (x: number, y: number, payload: DragPayload) => {
      const p = useEditor.getState().project
      const sc = scrollRef.current
      if (!p || !sc) return null
      const r = sc.getBoundingClientRect()
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null
      const kind = payloadKind(payload)
      let row = trackAtClientY(p, y)
      if (!row || !trackAccepts(row.kind, kind)) {
        // Fall back to the natural track for this media (same kind first, then any that accepts it).
        const t = p.tracks.find((t) => t.kind === kind) ?? p.tracks.find((t) => trackAccepts(t.kind, kind))
        if (!t) return null
        row = { id: t.id, kind: t.kind, top: rowTop(p, t.id), height: ROW_H[t.kind] }
      }
      const t = timeAtClientX(x)
      const duration = durationOf(payload)
      if (isMain(p, row.id)) {
        const idx = mainInsertIndex(p, t)
        return { trackId: row.id, at: t, ghostAt: mainBoundaryTime(p, idx), insert: true, row, duration }
      }
      const at = nearestFreeStart(p, row.id, t, duration)
      return { trackId: row.id, at, ghostAt: at, insert: false, row, duration }
    }
    return registerDropTarget({
      over(x, y, payload) {
        const hit = target(x, y, payload)
        if (!hit) {
          if (ghost) ghost.style.display = 'none'
          if (marker) marker.style.display = 'none'
          return false
        }
        if (!ghost) {
          ghost = document.createElement('div')
          ghost.className = 'pointer-events-none absolute left-0 top-0 z-30 rounded-md border-2 border-dashed border-primary bg-primary/25'
          overlayRef.current!.appendChild(ghost)
          marker = document.createElement('div')
          marker.className = 'pointer-events-none absolute left-0 top-0 z-40 w-1 rounded bg-primary shadow-[0_0_8px_var(--primary)]'
          overlayRef.current!.appendChild(marker)
          snapLine = newSnapLine()
        }
        ghost.style.display = 'block'
        ghost.style.transform = `translate(${HEADER_W + usToPx(hit.ghostAt)}px, ${hit.row.top + 4}px)`
        ghost.style.width = `${Math.max(8, usToPx(hit.duration))}px`
        ghost.style.height = `${hit.row.height - 8}px`
        marker!.style.display = hit.insert ? 'block' : 'none'
        marker!.style.transform = `translate(${HEADER_W + usToPx(hit.ghostAt) - 2}px, ${hit.row.top}px)`
        marker!.style.height = `${hit.row.height}px`
        showSnapLine(snapLine!, null)
        return true
      },
      leave() {
        ghost?.remove()
        marker?.remove()
        snapLine?.remove()
        ghost = marker = snapLine = null
      },
      drop(x, y, payload) {
        const hit = target(x, y, payload)
        if (!hit) return
        if (payload.type === 'preset') addPreset(payload.preset, hit.trackId, hit.at)
        else void addFile(payload.file, hit.trackId, hit.at)
      },
    })
  }, [])

  const offline = useMemo(() => {
    const folder = project?.mediaFolder?.toLowerCase()
    const have = new Set(files.map((f) => f.path))
    const out = new Set<string>()
    if (!folder || !files.length) return out
    for (const c of project?.clips ?? []) {
      if (c.source && c.source.toLowerCase().startsWith(folder) && !have.has(c.source)) out.add(c.source)
    }
    return out
  }, [project?.clips, project?.mediaFolder, files])

  if (!project) return null
  const duration = projectDuration(project)
  const contentW = Math.max((duration / 1e6 + 30) * pxPerSec, 2000)
  const mainId = project.tracks.find((t) => t.kind === 'video')?.id

  return (
    <section className="flex h-full flex-col overflow-hidden border-t bg-timeline">
      <Toolbar />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-none">
        <div className="relative" style={{ width: HEADER_W + contentW, minHeight: '100%' }}>
          {/* Ruler row */}
          <div className="sticky top-0 z-30 flex border-b border-track-divider bg-timeline" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-40 flex shrink-0 items-center bg-timeline pl-2" style={{ width: HEADER_W }}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground"><Plus className="size-3.5" /> Track</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => addTrack('text')}><Type /> Text track</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addTrack('image')}><ImageIcon /> Image track</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addTrack('audio')}><Music /> Audio track</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <Ruler />
          </div>

          {project.tracks.map((t) => (
            <div key={t.id} className="flex">
              <TrackHeader track={t} main={t.id === mainId} />
              <Lane project={project} track={t} pps={pxPerSec} width={contentW} selection={selection} offline={offline} />
            </div>
          ))}

          {project.clips.length === 0 && (
            <div className="pointer-events-none absolute text-sm text-muted-foreground" style={{ left: HEADER_W + 24, top: RULER_H + 22 }}>
              Drag media here from the library, or double-click a file to add it at the playhead.
            </div>
          )}

          <div ref={overlayRef} className="pointer-events-none absolute inset-0" />
          <Playhead />
        </div>
      </div>
    </section>
  )
}
