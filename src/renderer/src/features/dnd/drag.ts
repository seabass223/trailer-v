/**
 * Pointer-driven drag from the library to the timeline. Fully imperative: the ghost moves
 * via transforms on rAF, and nothing re-renders React while dragging.
 */
import type { TextPreset } from '@shared/factory'
import type { MediaFile } from '@shared/model'

export type DragPayload = { type: 'file'; file: MediaFile } | { type: 'preset'; preset: TextPreset }

export interface DropTarget {
  /** Return true if (x, y) is over this target; the target draws its own drop preview. */
  over(x: number, y: number, payload: DragPayload, alt: boolean): boolean
  leave(): void
  drop(x: number, y: number, payload: DragPayload, alt: boolean): void
}

let target: DropTarget | null = null

export function registerDropTarget(t: DropTarget): () => void {
  target = t
  return () => {
    if (target === t) target = null
  }
}

export function startLibraryDrag(down: PointerEvent, payload: DragPayload, label: string, thumb: string | null): void {
  const startX = down.clientX
  const startY = down.clientY
  let active = false
  let ghost: HTMLDivElement | null = null
  let raf = 0
  let last = { x: startX, y: startY, alt: false }
  let overTarget = false

  const makeGhost = () => {
    ghost = document.createElement('div')
    ghost.className =
      'pointer-events-none fixed left-0 top-0 z-[100] flex w-44 flex-col overflow-hidden rounded-lg border border-primary/70 bg-card/95 shadow-2xl shadow-black/50 transition-opacity duration-100'
    ghost.innerHTML = `${thumb ? `<img src="${thumb}" class="aspect-video w-full object-cover" />` : '<div class="aspect-video w-full bg-muted"></div>'}<div class="truncate px-2 py-1 text-xs"></div>`
    ghost.lastElementChild!.textContent = label
    document.body.appendChild(ghost)
    document.body.style.cursor = 'grabbing'
  }

  const frame = () => {
    raf = 0
    if (!ghost) return
    overTarget = !!target?.over(last.x, last.y, payload, last.alt)
    ghost.style.opacity = overTarget ? '0' : '1'
    ghost.style.transform = `translate(${last.x - 88}px, ${last.y - 50}px) rotate(-2deg)`
  }

  const move = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY, alt: e.altKey }
    if (!active) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < 5) return
      active = true
      makeGhost()
    }
    if (!raf) raf = requestAnimationFrame(frame)
  }

  const finish = (drop: boolean) => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
    window.removeEventListener('keydown', key)
    cancelAnimationFrame(raf)
    document.body.style.cursor = ''
    ghost?.remove()
    if (active && target) {
      if (drop && target.over(last.x, last.y, payload, last.alt)) target.drop(last.x, last.y, payload, last.alt)
      target.leave()
    }
  }
  const up = (e: PointerEvent) => {
    last = { x: e.clientX, y: e.clientY, alt: e.altKey }
    finish(true)
  }
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') finish(false)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
  window.addEventListener('keydown', key)
}
