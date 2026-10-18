import { ArrowDown, ArrowUp, Eye, EyeOff, FoldHorizontal, GripVertical, Image as ImageIcon, Magnet, Music, Pencil, Plus, Trash2, Type, Video, Volume2, VolumeX } from 'lucide-react'
import { memo, type CSSProperties, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { probeMedia } from '@/engine/media-client'
import { registerDropTarget, type DragPayload } from '@/features/dnd/drag'
import { addFile, addPreset, addTrack, closeVideoGaps, removeTrack, renameTrack, reorderTrack, toggleTrack } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import { shownProject, useEditor } from '@/state/store'
import { trackAccepts } from '@shared/factory'
import type { Clip, Project, Track, TrackKind } from '@shared/model'
import { DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION } from '@shared/presets'
import { isMain, mainBoundaryTime, mainInsertIndex, mainTrack, nearestFreeStart, projectDuration, trackMoveRange, tracksWithGaps } from '@shared/timeline'
import { ClipView } from './ClipView'
import { beginHeaderResize, beginMarquee, beginTrackDrag, newSnapLine, showSnapLine } from './interactions'
import { Junctions } from './Junctions'
import { Playhead } from './Playhead'
import { Ruler } from './Ruler'
import { Toolbar } from './Toolbar'
import { headerW, resetHeaderW, ROW_H, RULER_H, rowTop, setHeaderW, setZoom, timeAtClientX, trackAtClientY, usToPx, view } from './view'

const ICONS: Record<TrackKind, typeof Video> = { video: Video, text: Type, image: ImageIcon, audio: Music }

/** Drag handle on the right edge of the track-name column; double-click resets it. */
function ColumnResizer() {
  return (
    <div
      data-resize
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize track names"
      tabIndex={0}
      className="absolute inset-y-0 -right-1 z-10 w-2 cursor-col-resize outline-none after:absolute after:inset-y-0 after:left-[3px] after:w-0.5 after:bg-primary after:opacity-0 after:transition-opacity hover:after:opacity-100 focus-visible:after:opacity-100"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        beginHeaderResize(e.nativeEvent)
      }}
      onDoubleClick={resetHeaderW}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault()
          e.stopPropagation()
          setHeaderW(headerW() + (e.key === 'ArrowLeft' ? -8 : 8))
        }
      }}
    />
  )
}

const TrackHeader = memo(function TrackHeader({ track, index, main, magnet, canUp, canDown, gaps }: {
  track: Track
  index: number
  main: boolean
  magnet: boolean
  canUp: boolean
  canDown: boolean
  /** Video track with dead space between clips. */
  gaps: boolean
}) {
  const Icon = ICONS[track.kind]
  const audio = track.kind === 'audio'
  const Toggle = audio ? (track.hidden ? VolumeX : Volume2) : track.hidden ? EyeOff : Eye
  const [editing, setEditing] = useState(false)
  // Set when Rename is picked from the menu so its close doesn't pull focus back off the input.
  const renaming = useRef(false)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          data-track={track.id}
          className="group/header sticky left-0 z-30 flex shrink-0 cursor-grab items-center gap-3 border-b border-track-divider bg-timeline pl-4 pr-2"
          style={{ width: 'var(--header-w)', height: ROW_H[track.kind] }}
          onPointerDown={(e) => {
            if (e.button !== 0 || editing || (e.target as HTMLElement).closest('button, input, [data-resize]')) return
            beginTrackDrag(e.nativeEvent, track.id)
          }}
        >
          <GripVertical className="absolute left-0.5 size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover/header:opacity-100" />
          <Icon className="size-5 shrink-0 text-foreground/80" />
          {editing ? (
            <input
              autoFocus
              defaultValue={track.name}
              aria-label="Track name"
              maxLength={64}
              className="h-7 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1.5 text-[14px] outline-none"
              onFocus={(e) => e.currentTarget.select()}
              onBlur={(e) => {
                renameTrack(track.id, e.currentTarget.value)
                setEditing(false)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') e.currentTarget.blur()
                else if (e.key === 'Escape') {
                  e.currentTarget.value = track.name
                  e.currentTarget.blur()
                }
              }}
            />
          ) : (
            <span
              className={cn('truncate text-[14px]', track.hidden && 'text-muted-foreground')}
              title="Double-click to rename"
              onDoubleClick={() => setEditing(true)}
            >
              {track.name}
            </span>
          )}
          {magnet && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Magnet className="-ml-1.5 size-3.5 shrink-0 text-muted-foreground" aria-label="Main track" />
              </TooltipTrigger>
              <TooltipContent>Main track: clips stay back to back</TooltipContent>
            </Tooltip>
          )}
          <Button variant="ghost" size="icon" className="ml-auto size-8 text-foreground/70" onClick={() => toggleTrack(track.id)}
            aria-label={audio ? 'Mute track' : 'Toggle visibility'}>
            <Toggle className="size-[18px]" />
          </Button>
          <ColumnResizer />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(e) => {
        if (renaming.current) e.preventDefault()
        renaming.current = false
      }}>
        <ContextMenuItem onSelect={() => { renaming.current = true; setEditing(true) }}><Pencil /> Rename track</ContextMenuItem>
        <ContextMenuItem disabled={!canUp} onSelect={() => reorderTrack(track.id, index - 1)}><ArrowUp /> Move up</ContextMenuItem>
        <ContextMenuItem disabled={!canDown} onSelect={() => reorderTrack(track.id, index + 1)}><ArrowDown /> Move down</ContextMenuItem>
        {track.kind === 'video' && !main && (
          <ContextMenuItem disabled={!gaps} onSelect={() => closeVideoGaps(track.id)}><FoldHorizontal /> Close gaps on this track</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => addTrack(track.kind)}><Plus /> Add {track.kind} track</ContextMenuItem>
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
  const header = useEditor((s) => s.headerW)
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
        // Fall back to the natural track for this media (main for video, same kind first, then any that accepts it).
        const t = kind === 'video' ? mainTrack(p) : p.tracks.find((t) => t.kind === kind) ?? p.tracks.find((t) => trackAccepts(t.kind, kind))
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
        ghost.style.transform = `translate(${headerW() + usToPx(hit.ghostAt)}px, ${hit.row.top + 4}px)`
        ghost.style.width = `${Math.max(8, usToPx(hit.duration))}px`
        ghost.style.height = `${hit.row.height - 8}px`
        marker!.style.display = hit.insert ? 'block' : 'none'
        marker!.style.transform = `translate(${headerW() + usToPx(hit.ghostAt) - 2}px, ${hit.row.top}px)`
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
  const mainId = mainTrack(project).id
  // Only worth pointing out which video track is magnetic once there is a choice.
  const manyVideo = project.tracks.filter((t) => t.kind === 'video').length > 1
  const gapTracks = new Set(tracksWithGaps(project).map((t) => t.id))

  return (
    <section className="flex h-full flex-col overflow-hidden border-t bg-timeline">
      <Toolbar />
      <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-auto overscroll-none">
        <div className="relative" style={{ width: header + contentW, minHeight: '100%', '--header-w': `${header}px` } as CSSProperties}>
          {/* Ruler row: above the sticky track headers (z-30), so "+ Track" in its corner stays
              visible and clickable however far the track list is scrolled. */}
          <div className="sticky top-0 z-50 flex border-b border-track-divider bg-timeline" style={{ height: RULER_H }}>
            <div className="sticky left-0 z-40 flex shrink-0 items-center bg-timeline pl-2" style={{ width: header }}>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground"><Plus className="size-3.5" /> Track</Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem onSelect={() => addTrack('video')}><Video /> Video track</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addTrack('text')}><Type /> Text track</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addTrack('image')}><ImageIcon /> Image track</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => addTrack('audio')}><Music /> Audio track</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <ColumnResizer />
            </div>
            <Ruler />
          </div>

          {project.tracks.map((t, i) => {
            const range = trackMoveRange(project, t.id)!
            return (
              <div key={t.id} data-row={t.id} className="flex">
                <TrackHeader track={t} index={i} main={t.id === mainId} magnet={manyVideo && t.id === mainId}
                  canUp={i - 1 >= range[0]} canDown={i + 1 <= range[1]} gaps={gapTracks.has(t.id)} />
                <Lane project={project} track={t} pps={pxPerSec} width={contentW} selection={selection} offline={offline} />
              </div>
            )
          })}

          {project.clips.length === 0 && (
            <div className="pointer-events-none absolute text-sm text-muted-foreground" style={{ left: header + 24, top: RULER_H + 22 }}>
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
