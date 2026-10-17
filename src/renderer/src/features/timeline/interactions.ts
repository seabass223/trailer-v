/**
 * Timeline pointer interactions. Moves use an imperative ghost (no React work per frame);
 * trims, fades and volume show a transient draft so the magnetic track ripples live, the
 * preview shows the new edge frame and playback hears the new gain. Each gesture commits
 * exactly one undo step.
 */
import { engine } from '@/engine/client'
import { moveClipTo, reorderTrack, trim, updateClip } from '@/features/editor/actions'
import { formatDb } from '@/lib/utils'
import { clearDraft, commit, select, setDraft, toggleSelect, useEditor } from '@/state/store'
import { trackAccepts } from '@shared/factory'
import { keyGainAt } from '@shared/envelope'
import type { Clip, Micros, Project } from '@shared/model'
import {
  applyTrim, clipEnd, isMain, mainBoundaryTime, mainInsertIndex, nearestFreeStart, trackMoveRange, trimPreview,
} from '@shared/timeline'
import { autoScroll, headerW, pxToUs, RULER_H, setHeaderW, rowTop, timeAtClientX, trackAtClientY, usToPx, view, ROW_H } from './view'

const SNAP_PX = 8

/** Edges everything snaps to: 0, playhead, and all other clip edges. */
function snapPoints(p: Project, exclude: Set<string>): Micros[] {
  const pts = [0, engine().time()]
  for (const c of p.clips) {
    if (exclude.has(c.id)) continue
    pts.push(c.start, clipEnd(c))
  }
  return pts
}

function snap(t: Micros, points: Micros[], enabled: boolean): { t: Micros; at: Micros | null } {
  if (!enabled) return { t, at: null }
  const tol = pxToUs(SNAP_PX)
  let best: Micros | null = null
  let dist = tol
  for (const s of points) {
    const d = Math.abs(s - t)
    if (d < dist) {
      dist = d
      best = s
    }
  }
  return best == null ? { t, at: null } : { t: best, at: best }
}

// --- Overlay helpers --------------------------------------------------------

function overlayEl(cls: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = cls
  view.overlay?.appendChild(el)
  return el
}

export function showSnapLine(el: HTMLDivElement, at: Micros | null): void {
  if (at == null) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  el.style.transform = `translateX(${headerW() + usToPx(at)}px)`
}

export const newSnapLine = () => overlayEl('pointer-events-none absolute top-0 bottom-0 left-0 z-40 hidden w-px bg-snap shadow-[0_0_6px_var(--snap)]')

// --- Move -------------------------------------------------------------------

export function beginMove(e: PointerEvent, clip: Clip, clipEl: HTMLElement): void {
  const p = useEditor.getState().project!
  const startX = e.clientX
  const startY = e.clientY
  const exclude = new Set([clip.id])
  const points = snapPoints(p, exclude)
  const grabOffset = timeAtClientX(e.clientX) - clip.start
  let started = false
  let ghost: HTMLElement | null = null
  let marker: HTMLDivElement | null = null
  let snapLine: HTMLDivElement | null = null
  let stopScroll: (() => void) | null = null
  let lastX = e.clientX
  let result: { trackId: string; at: Micros } | null = null
  let raf = 0

  const update = (ev: { clientX: number; clientY: number; altKey: boolean }) => {
    const row = trackAtClientY(p, ev.clientY)
    const trackId = row && trackAccepts(row.kind, clip.kind) ? row.id : clip.trackId
    const pointerT = timeAtClientX(ev.clientX)
    let desired = Math.max(0, pointerT - grabOffset)
    const enabled = useEditor.getState().snapping && !ev.altKey
    // Snap either edge of the moving clip.
    const a = snap(desired, points, enabled)
    const b = snap(desired + clip.duration, points, enabled)
    let snapAt: Micros | null = null
    if (a.at != null && (b.at == null || Math.abs(a.t - desired) <= Math.abs(b.t - desired - clip.duration))) {
      desired = a.t
      snapAt = a.at
    } else if (b.at != null) {
      desired = b.t - clip.duration
      snapAt = b.at
    }
    const top = rowTop(p, trackId)
    const h = ROW_H[p.tracks.find((t) => t.id === trackId)!.kind]
    if (isMain(p, trackId)) {
      const idx = mainInsertIndex(p, pointerT, exclude)
      const at = mainBoundaryTime(p, idx, exclude)
      marker!.style.display = 'block'
      marker!.style.transform = `translate(${headerW() + usToPx(at) - 2}px, ${top}px)`
      marker!.style.height = `${h}px`
      ghost!.style.transform = `translate(${headerW() + usToPx(desired)}px, ${top + 4}px)`
      result = { trackId, at: pointerT }
      showSnapLine(snapLine!, null)
    } else {
      marker!.style.display = 'none'
      const at = nearestFreeStart(p, trackId, desired, clip.duration, exclude)
      ghost!.style.transform = `translate(${headerW() + usToPx(at)}px, ${top + 4}px)`
      result = { trackId, at }
      showSnapLine(snapLine!, at === desired ? snapAt : null)
    }
  }

  const move = (ev: PointerEvent) => {
    lastX = ev.clientX
    if (!started) {
      if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return
      started = true
      ghost = clipEl.cloneNode(true) as HTMLElement
      ghost.style.left = '0px'
      ghost.style.top = '0px'
      ghost.style.height = `${clipEl.offsetHeight}px`
      ghost.classList.add('pointer-events-none', 'z-30', 'opacity-90', 'shadow-xl', 'shadow-black/50')
      view.overlay?.appendChild(ghost)
      clipEl.style.opacity = '0.35'
      marker = overlayEl('pointer-events-none absolute left-0 top-0 z-40 hidden w-1 rounded bg-primary shadow-[0_0_8px_var(--primary)]')
      snapLine = newSnapLine()
      stopScroll = autoScroll(() => lastX)
      document.body.style.cursor = 'grabbing'
    }
    if (!raf) {
      const snapshot = { clientX: ev.clientX, clientY: ev.clientY, altKey: ev.altKey }
      raf = requestAnimationFrame(() => {
        raf = 0
        update(snapshot)
      })
    }
  }

  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    cancelAnimationFrame(raf)
    stopScroll?.()
    document.body.style.cursor = ''
    if (!started) {
      // A click: select (Ctrl/Shift toggles).
      if (ev.ctrlKey || ev.shiftKey) toggleSelect(clip.id)
      else select([clip.id])
      return
    }
    update(ev)
    ghost?.remove()
    marker?.remove()
    snapLine?.remove()
    clipEl.style.opacity = ''
    if (result) moveClipTo(clip.id, result.trackId, result.at)
  }

  if (!useEditor.getState().selection.includes(clip.id) && !(e.ctrlKey || e.shiftKey)) select([clip.id])
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Trim -------------------------------------------------------------------

export function beginTrim(e: PointerEvent, clip: Clip, edge: 'start' | 'end'): void {
  const p = useEditor.getState().project!
  const startT = timeAtClientX(e.clientX)
  const points = snapPoints(p, new Set([clip.id]))
  const snapLine = newSnapLine()
  const tip = overlayEl('pointer-events-none absolute left-0 top-0 z-50 rounded bg-popover px-1.5 py-0.5 text-[11px] tabular text-popover-foreground shadow')
  let lastX = e.clientX
  const stopScroll = autoScroll(() => lastX)
  let raf = 0
  select([clip.id])
  document.body.style.cursor = 'ew-resize'

  const update = (clientX: number, altKey: boolean) => {
    let d = timeAtClientX(clientX) - startT
    const edgeT = (edge === 'start' ? clip.start : clipEnd(clip)) + d
    const s = snap(edgeT, points, useEditor.getState().snapping && !altKey)
    d += s.t - edgeT
    const r = trimPreview(p, clip.id, edge, d)
    if (!r) return
    setDraft((dr) => {
      const c = dr.clips.find((x) => x.id === clip.id)!
      applyTrim(c, r)
      // Ripple the magnetic track live.
      if (isMain(dr, c.trackId)) {
        let t = 0
        for (const x of dr.clips.filter((y) => y.trackId === c.trackId).sort((a, b) => a.start - b.start)) {
          x.start = t
          t += x.duration
        }
      }
    })
    const edgeNow = edge === 'start' ? (isMain(p, clip.trackId) ? clip.start : r.start) : r.start + r.duration
    showSnapLine(snapLine, s.at)
    // Preview the frame at the edit point.
    engine().seek(edge === 'start' ? edgeNow : Math.max(edgeNow - 1, r.start))
    const sc = view.scroller!
    const rect = sc.getBoundingClientRect()
    tip.style.transform = `translate(${clientX - rect.left + sc.scrollLeft + 10}px, ${e.clientY - rect.top + sc.scrollTop - 28}px)`
    tip.textContent = `${(r.duration / 1e6).toFixed(2)}s`
  }

  const move = (ev: PointerEvent) => {
    lastX = ev.clientX
    if (!raf) {
      const x = ev.clientX
      const alt = ev.altKey
      raf = requestAnimationFrame(() => {
        raf = 0
        update(x, alt)
      })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    cancelAnimationFrame(raf)
    stopScroll()
    snapLine.remove()
    tip.remove()
    document.body.style.cursor = ''
    const draft = useEditor.getState().draft
    const c = draft?.clips.find((x) => x.id === clip.id)
    clearDraft()
    if (!c) return
    if (edge === 'end') trim(clip.id, 'end', c.duration - clip.duration)
    else trim(clip.id, 'start', clip.duration - c.duration)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Fade handles -----------------------------------------------------------

export function beginFade(e: PointerEvent, clip: Clip, which: 'fadeIn' | 'fadeOut'): void {
  const startX = e.clientX
  const initial = clip[which].duration
  const other = which === 'fadeIn' ? clip.fadeOut.duration : clip.fadeIn.duration
  let raf = 0
  let value = initial
  select([clip.id])
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - startX
    value = Math.max(0, Math.min(clip.duration - other, initial + pxToUs(which === 'fadeIn' ? dx : -dx)))
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        setDraft((d) => {
          const c = d.clips.find((x) => x.id === clip.id)
          if (c) c[which] = { ...c[which], duration: value }
        })
      })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    cancelAnimationFrame(raf)
    clearDraft()
    if (value !== initial) {
      commit(which === 'fadeIn' ? `Fade in ${clip.name}` : `Fade out ${clip.name}`, (d) => {
        const c = d.clips.find((x) => x.id === clip.id)
        if (c) c[which] = { ...c[which], duration: value }
      })
    }
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Volume line ------------------------------------------------------------

export const MAX_VOLUME = 2
/** Envelope points may boost a quiet clip up to +12 dB over its volume. */
export const MAX_KEY_GAIN = 4
const VOLUME_PAD = 4
const UNITY_SNAP_PX = 4

/** Line position (px from the clip top) for a gain: 0% at the bottom, 100% mid, 200% top. */
export const volumeY = (v: number, clipH: number): number => VOLUME_PAD + (1 - v / MAX_VOLUME) * (clipH - VOLUME_PAD * 2)

/** Level the line shows at clip-relative `t`: volume × envelope, within the line's range. */
export const lineLevel = (clip: Pick<Clip, 'volume' | 'volumeKeys'>, t: Micros): number =>
  Math.min(MAX_VOLUME, clip.volume * keyGainAt(clip.volumeKeys, t))

/** Floating "−6.0 dB 50%" readout next to the pointer. */
function volumeTip(): { el: HTMLDivElement; show: (clientX: number, clientY: number, level: number) => void } {
  const el = overlayEl('pointer-events-none absolute left-0 top-0 z-50 flex gap-1.5 rounded bg-popover px-1.5 py-0.5 text-[11px] tabular text-popover-foreground shadow')
  el.dataset.testid = 'volume-tip'
  const dbEl = document.createElement('span')
  const pctEl = document.createElement('span')
  pctEl.className = 'text-muted-foreground'
  el.append(dbEl, pctEl)
  const show = (clientX: number, clientY: number, level: number) => {
    const sc = view.scroller!
    const rect = sc.getBoundingClientRect()
    el.style.transform = `translate(${clientX - rect.left + sc.scrollLeft + 14}px, ${clientY - rect.top + sc.scrollTop - 11}px)`
    dbEl.textContent = formatDb(level)
    pctEl.textContent = `${Math.round(level * 100)}%`
  }
  return { el, show }
}

/** Drag the volume line vertically. Shift = fine, Alt = no snap to 100%. */
export function beginVolume(e: PointerEvent, clip: Clip, clipEl: HTMLElement): void {
  const h = clipEl.offsetHeight
  const perPx = MAX_VOLUME / Math.max(1, h - VOLUME_PAD * 2)
  const initial = clip.volume
  const tip = volumeTip()
  let raw = initial
  let value = initial
  let lastY = e.clientY
  let lastX = e.clientX
  let raf = 0
  select([clip.id])
  document.body.style.cursor = 'ns-resize'

  const show = () => {
    // With an envelope the line sits at volume × envelope under the pointer.
    const r = clipEl.getBoundingClientRect()
    const level = Math.min(MAX_VOLUME, value * keyGainAt(clip.volumeKeys, pxToUs(lastX - r.left)))
    tip.show(lastX, r.top + volumeY(level, h), value)
  }
  show()

  const move = (ev: PointerEvent) => {
    raw = Math.max(0, Math.min(MAX_VOLUME, raw - (ev.clientY - lastY) * perPx * (ev.shiftKey ? 0.1 : 1)))
    lastY = ev.clientY
    lastX = ev.clientX
    const unity = !ev.altKey && !ev.shiftKey && Math.abs(raw - 1) < UNITY_SNAP_PX * perPx
    value = unity ? 1 : ev.shiftKey ? Math.round(raw * 1000) / 1000 : Math.round(raw * 100) / 100
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        setDraft((d) => {
          const c = d.clips.find((x) => x.id === clip.id)
          if (c) c.volume = value
        })
        show()
      })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    cancelAnimationFrame(raf)
    tip.el.remove()
    document.body.style.cursor = ''
    // Commit before dropping the draft so playback never hears the old gain in between.
    if (value !== initial) updateClip(clip.id, `Volume ${clip.name}`, (c) => {
      c.volume = value
    })
    clearDraft()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

/**
 * Drag a volume envelope point: sideways in time (between its neighbours, inside the clip),
 * up/down in level. With `index` null it first adds a point on the line under the pointer
 * (Alt/Ctrl-click), so adding and dragging is one undo step. Shift = fine, Alt = no snap to
 * the clip's volume.
 */
export function beginVolumeKey(e: PointerEvent, clip: Clip, clipEl: HTMLElement, index: number | null): void {
  const h = clipEl.offsetHeight
  const perPx = MAX_VOLUME / Math.max(1, h - VOLUME_PAD * 2)
  const keys = (clip.volumeKeys ?? []).map((k) => ({ ...k }))
  const added = index == null
  let i = index ?? 0
  if (index == null) {
    const t = Math.max(0, Math.min(clip.duration, pxToUs(e.clientX - clipEl.getBoundingClientRect().left)))
    i = keys.findIndex((k) => k.t > t)
    if (i < 0) i = keys.length
    keys.splice(i, 0, { t, gain: keyGainAt(clip.volumeKeys, t) })
  }
  const key = keys[i]
  const t0 = key.t
  const g0 = key.gain
  // Levels are edited on the line's scale (volume × gain); on a silent clip, the gain itself.
  const vol = clip.volume > 0 ? clip.volume : 1
  const lo = Math.max(0, keys[i - 1]?.t ?? 0)
  const hi = Math.min(clip.duration, keys[i + 1]?.t ?? clip.duration)
  const tip = volumeTip()
  let raw = Math.min(MAX_VOLUME, vol * g0)
  let lastY = e.clientY
  let moved = false
  let raf = 0
  select([clip.id])

  const draft = () =>
    setDraft((d) => {
      const c = d.clips.find((x) => x.id === clip.id)
      if (c) c.volumeKeys = keys.map((k) => ({ ...k }))
    })
  const show = (clientX: number) =>
    tip.show(clientX, clipEl.getBoundingClientRect().top + volumeY(Math.min(MAX_VOLUME, vol * key.gain), h), clip.volume * key.gain)
  if (added) draft()
  show(e.clientX)

  const move = (ev: PointerEvent) => {
    // A dead zone, so clicks (and double-click to delete) never nudge the point.
    if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 3) return
    if (!moved) document.body.style.cursor = 'move'
    moved = true
    raw = Math.max(0, Math.min(MAX_VOLUME, raw - (ev.clientY - lastY) * perPx * (ev.shiftKey ? 0.1 : 1)))
    lastY = ev.clientY
    const unity = !ev.altKey && !ev.shiftKey && Math.abs(raw - vol) < UNITY_SNAP_PX * perPx
    const gain = unity ? 1 : Math.min(MAX_KEY_GAIN, raw / vol)
    key.gain = ev.shiftKey ? Math.round(gain * 1000) / 1000 : Math.round(gain * 100) / 100
    // Shift locks time for fine level changes.
    key.t = ev.shiftKey ? key.t : Math.max(lo, Math.min(hi, t0 + pxToUs(ev.clientX - e.clientX)))
    const x = ev.clientX
    if (!raf) {
      raf = requestAnimationFrame(() => {
        raf = 0
        draft()
        show(x)
      })
    }
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    cancelAnimationFrame(raf)
    tip.el.remove()
    document.body.style.cursor = ''
    if (added || key.t !== t0 || key.gain !== g0) {
      updateClip(clip.id, `${added ? 'Add' : 'Move'} volume point ${clip.name}`, (c) => {
        c.volumeKeys = keys
      })
    }
    clearDraft()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

export function deleteVolumeKey(clip: Clip, index: number): void {
  if (!clip.volumeKeys?.[index]) return
  updateClip(clip.id, `Delete volume point ${clip.name}`, (c) => {
    c.volumeKeys = c.volumeKeys?.filter((_, j) => j !== index)
    if (!c.volumeKeys?.length) delete c.volumeKeys
  })
}

// --- Empty-area: click to seek, drag to marquee-select ----------------------

export function beginMarquee(e: PointerEvent): void {
  const p = useEditor.getState().project!
  const sc = view.scroller!
  const rect = sc.getBoundingClientRect()
  const toContent = (x: number, y: number) => ({ x: x - rect.left + sc.scrollLeft, y: y - rect.top + sc.scrollTop })
  const start = toContent(e.clientX, e.clientY)
  const additive = e.ctrlKey || e.shiftKey
  const base = additive ? useEditor.getState().selection : []
  let box: HTMLDivElement | null = null
  let lastX = e.clientX
  let stopScroll: (() => void) | null = null

  const move = (ev: PointerEvent) => {
    lastX = ev.clientX
    const cur = toContent(ev.clientX, ev.clientY)
    if (!box) {
      if (Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return
      box = overlayEl('pointer-events-none absolute left-0 top-0 z-40 rounded-sm border border-primary/80 bg-primary/10')
      stopScroll = autoScroll(() => lastX)
    }
    const x0 = Math.min(start.x, cur.x)
    const y0 = Math.min(start.y, cur.y)
    const x1 = Math.max(start.x, cur.x)
    const y1 = Math.max(start.y, cur.y)
    box.style.transform = `translate(${x0}px, ${y0}px)`
    box.style.width = `${x1 - x0}px`
    box.style.height = `${y1 - y0}px`
    const t0 = pxToUs(x0 - headerW())
    const t1 = pxToUs(x1 - headerW())
    const hits = p.clips.filter((c) => {
      const top = rowTop(p, c.trackId)
      const h = ROW_H[p.tracks.find((t) => t.id === c.trackId)?.kind ?? 'video']
      return c.start < t1 && clipEnd(c) > t0 && top < y1 && top + h > y0
    })
    select([...new Set([...base, ...hits.map((c) => c.id)])])
  }
  const up = (ev: PointerEvent) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    stopScroll?.()
    if (box) box.remove()
    else {
      if (!additive) select([])
      engine().seek(timeAtClientX(ev.clientX))
    }
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Ruler / playhead scrubbing ---------------------------------------------

export function beginScrub(e: PointerEvent): void {
  const wasPlaying = engine().playing
  if (wasPlaying) engine().pause()
  let lastX = e.clientX
  engine().seek(timeAtClientX(e.clientX))
  const stopScroll = autoScroll(() => lastX)
  const move = (ev: PointerEvent) => {
    lastX = ev.clientX
    engine().seek(timeAtClientX(ev.clientX))
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    stopScroll()
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Track reordering -------------------------------------------------------

/** Drag a track row (header + lane) up/down; a line marks where it lands. One undo step. */
export function beginTrackDrag(e: PointerEvent, trackId: string): void {
  const p = useEditor.getState().project
  const sc = view.scroller
  const row = sc?.querySelector<HTMLElement>(`[data-row="${trackId}"]`)
  const range = p && trackMoveRange(p, trackId)
  if (!p || !sc || !row || !range) return
  const from = p.tracks.findIndex((t) => t.id === trackId)
  // Row tops in lane coordinates (below the ruler), plus the bottom edge.
  const tops = [0]
  for (const t of p.tracks) tops.push(tops[tops.length - 1] + ROW_H[t.kind])
  const startY = e.clientY
  const startScroll = sc.scrollTop
  let line: HTMLDivElement | null = null
  let to = from

  const move = (ev: PointerEvent) => {
    const dy = ev.clientY - startY + sc.scrollTop - startScroll
    if (!line) {
      if (Math.abs(dy) < 4) return
      line = overlayEl('pointer-events-none absolute left-0 right-0 top-0 z-50 h-0.5 rounded bg-primary shadow-[0_0_8px_var(--primary)]')
      row.classList.add('relative', 'z-50', 'opacity-80', 'shadow-lg', 'pointer-events-none')
      document.body.style.cursor = 'grabbing'
    }
    row.style.transform = `translateY(${dy}px)`
    const y = ev.clientY - sc.getBoundingClientRect().top + sc.scrollTop - RULER_H
    let slot = 0
    for (let i = 0; i < p.tracks.length; i++) if (y > (tops[i] + tops[i + 1]) / 2) slot = i + 1
    to = Math.max(range[0], Math.min(range[1], slot > from ? slot - 1 : slot))
    line.style.display = to === from ? 'none' : 'block'
    line.style.transform = `translateY(${RULER_H + tops[to > from ? to + 1 : to] - 1}px)`
  }
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    if (!line) return
    line.remove()
    row.classList.remove('relative', 'z-50', 'opacity-80', 'shadow-lg', 'pointer-events-none')
    row.style.transform = ''
    document.body.style.cursor = ''
    if (to !== from) reorderTrack(trackId, to)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}

// --- Track-name column width ------------------------------------------------

export function beginHeaderResize(e: PointerEvent): void {
  const startX = e.clientX
  const startW = headerW()
  document.body.style.cursor = 'col-resize'
  const move = (ev: PointerEvent) => setHeaderW(startW + ev.clientX - startX)
  const up = () => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    document.body.style.cursor = ''
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
