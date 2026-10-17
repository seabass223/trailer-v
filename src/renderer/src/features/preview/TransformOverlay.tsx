/**
 * Direct manipulation on the preview: move / scale the selected image, video or text layer.
 * Drags update a transient project sent straight to the engine (live preview); one undo
 * step is committed on release. Double-clicking a text layer edits it in place.
 */
import { produce } from 'immer'
import { useEffect, useRef, useState } from 'react'
import { engine } from '@/engine/client'
import { textBoxRect } from '@/engine/text/raster'
import { updateClip } from '@/features/editor/actions'
import { selectedClip, useEditor } from '@/state/store'
import { mediaRect, type Rect } from '@shared/geometry'
import type { Clip, Project, Transform } from '@shared/model'
import { clipEnd } from '@shared/timeline'
import { InlineTextEditor } from './InlineTextEditor'

function rectFor(p: Project, c: Clip, t: Transform): Rect | null {
  const { width: W, height: H } = p.settings
  if (c.kind === 'text' && c.text) return textBoxRect(c.text, t, W, H)
  if (c.kind === 'video' || c.kind === 'image') return mediaRect(W, H, c.mediaWidth, c.mediaHeight, t)
  return null
}

const SNAP_PX = 6

export function TransformOverlay({ width, height }: { width: number; height: number }) {
  const clip = useEditor(selectedClip)
  const project = useEditor((s) => s.project)
  const boxRef = useRef<HTMLDivElement>(null)
  const guideX = useRef<HTMLDivElement>(null)
  const guideY = useRef<HTMLDivElement>(null)
  const live = useRef<Transform | null>(null)
  const [editing, setEditing] = useState<{ id: string; x: number; y: number } | null>(null)

  const visual = clip && clip.kind !== 'audio' ? clip : null
  const inline = visual?.kind === 'text' && editing?.id === visual.id ? editing : null

  // Selecting another clip ends inline editing for good.
  useEffect(() => {
    if (editing && editing.id !== visual?.id) setEditing(null)
  }, [editing, visual?.id])

  // Position the box; hide it when the playhead is outside the clip.
  useEffect(() => {
    if (!visual || !project) return
    const place = (tf: Transform) => {
      const el = boxRef.current
      const r = rectFor(project, visual, tf)
      if (!el || !r) return
      const k = width / project.settings.width
      el.style.transform = `translate(${r[0] * k}px, ${r[1] * k}px)`
      el.style.width = `${(r[2] - r[0]) * k}px`
      el.style.height = `${(r[3] - r[1]) * k}px`
    }
    place(visual.transform)
    return engine().subscribe((t) => {
      const el = boxRef.current
      if (!el) return
      const inside = t >= visual.start && t < clipEnd(visual) && !engine().playing
      el.style.display = inside ? 'block' : 'none'
    })
  }, [visual, project, width, height, inline])

  if (!visual || !project) return null
  if (inline) {
    return <InlineTextEditor key={visual.id} clip={visual} project={project} width={width} at={inline} onDone={() => setEditing(null)} />
  }
  const k = width / project.settings.width

  const begin = (e: React.PointerEvent, mode: 'move' | 'scale') => {
    e.stopPropagation()
    e.preventDefault()
    const el = boxRef.current!
    el.setPointerCapture(e.pointerId)
    const start = { x: e.clientX, y: e.clientY }
    const t0 = { ...visual.transform }
    const r0 = rectFor(project, visual, t0)!
    const frame = el.parentElement!.getBoundingClientRect()
    const center = { x: frame.left + ((r0[0] + r0[2]) / 2) * k, y: frame.top + ((r0[1] + r0[3]) / 2) * k }
    const d0 = Math.max(4, Math.hypot(start.x - center.x, start.y - center.y))
    let raf = 0

    const apply = (tf: Transform) => {
      live.current = tf
      const r = rectFor(project, visual, tf)!
      el.style.transform = `translate(${r[0] * k}px, ${r[1] * k}px)`
      el.style.width = `${(r[2] - r[0]) * k}px`
      el.style.height = `${(r[3] - r[1]) * k}px`
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0
          const tfNow = live.current!
          engine().setProject(produce(project, (d) => {
            const c = d.clips.find((x) => x.id === visual.id)
            if (c) c.transform = tfNow
          }))
        })
      }
    }

    const move = (ev: PointerEvent) => {
      if (mode === 'move') {
        let x = t0.x + (ev.clientX - start.x) / width
        let y = t0.y + (ev.clientY - start.y) / height
        const snapX = !ev.altKey && Math.abs(x * width) < SNAP_PX
        const snapY = !ev.altKey && Math.abs(y * height) < SNAP_PX
        if (snapX) x = 0
        if (snapY) y = 0
        guideX.current!.style.display = snapX ? 'block' : 'none'
        guideY.current!.style.display = snapY ? 'block' : 'none'
        apply({ ...t0, x, y })
      } else {
        const d = Math.hypot(ev.clientX - center.x, ev.clientY - center.y)
        apply({ ...t0, scale: Math.max(0.05, Math.min(10, (t0.scale * d) / d0)) })
      }
    }
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      cancelAnimationFrame(raf)
      guideX.current!.style.display = 'none'
      guideY.current!.style.display = 'none'
      const tf = live.current
      live.current = null
      if (tf && (tf.x !== t0.x || tf.y !== t0.y || tf.scale !== t0.scale)) {
        updateClip(visual.id, mode === 'move' ? `Move ${visual.name}` : `Scale ${visual.name}`, (c) => {
          c.transform = tf
        })
      } else {
        engine().setProject(useEditor.getState().project!)
      }
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const handle = 'absolute size-2.5 rounded-[2px] border border-primary bg-white'
  return (
    <>
      <div ref={guideX} className="pointer-events-none absolute inset-y-0 left-1/2 hidden w-px bg-snap/80" />
      <div ref={guideY} className="pointer-events-none absolute inset-x-0 top-1/2 hidden h-px bg-snap/80" />
      <div
        ref={boxRef}
        data-testid="transform-box"
        className="absolute left-0 top-0 cursor-move outline outline-1 outline-primary"
        onPointerDown={(e) => begin(e, 'move')}
        onDoubleClick={(e) => {
          e.stopPropagation()
          if (visual.kind === 'text') setEditing({ id: visual.id, x: e.clientX, y: e.clientY })
        }}
      >
        {(['nw', 'ne', 'sw', 'se'] as const).map((c) => (
          <div
            key={c}
            onPointerDown={(e) => begin(e, 'scale')}
            className={handle}
            style={{
              left: c.endsWith('w') ? -5 : undefined,
              right: c.endsWith('e') ? -5 : undefined,
              top: c.startsWith('n') ? -5 : undefined,
              bottom: c.startsWith('s') ? -5 : undefined,
              cursor: c === 'nw' || c === 'se' ? 'nwse-resize' : 'nesw-resize',
            }}
          />
        ))}
      </div>
    </>
  )
}
