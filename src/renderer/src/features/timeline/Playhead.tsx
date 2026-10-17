import { useEffect, useRef } from 'react'
import { engine } from '@/engine/client'
import { useEditor } from '@/state/store'
import { beginScrub } from './interactions'
import { RULER_H, view } from './view'

/** Playhead line + head, moved by transform from the clock (never through React state). */
export function Playhead() {
  const line = useRef<HTMLDivElement>(null)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const header = useEditor((s) => s.headerW)

  useEffect(
    () =>
      engine().subscribe((t, playing) => {
        const x = header + (t / 1e6) * pxPerSec
        if (line.current) line.current.style.transform = `translateX(${x}px)`
        const sc = view.scroller
        if (sc && playing) {
          // Page-follow while playing.
          const vx = x - sc.scrollLeft
          if (vx > sc.clientWidth - 40 || vx < header) sc.scrollLeft = Math.max(0, x - header - 40)
        }
      }),
    [pxPerSec, header],
  )

  return (
    <div ref={line} className="pointer-events-none absolute left-0 top-0 z-40 h-full w-0">
      <div className="absolute bottom-0 left-[-1px] top-[6px] w-[2px] bg-white/90 shadow-[0_0_4px_rgba(0,0,0,.6)]" />
      <div
        className="pointer-events-auto sticky top-0 -ml-[7px] cursor-ew-resize"
        style={{ height: RULER_H }}
        onPointerDown={(e) => {
          e.stopPropagation()
          beginScrub(e.nativeEvent)
        }}
      >
        <svg width="14" height="20" viewBox="0 0 14 20" className="mt-[4px] drop-shadow">
          <path d="M2 0h10a2 2 0 0 1 2 2v9.5a2 2 0 0 1-.7 1.5L7 19 .7 13A2 2 0 0 1 0 11.5V2a2 2 0 0 1 2-2z" fill="var(--playhead)" />
        </svg>
      </div>
    </div>
  )
}
