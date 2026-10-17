import { useEffect, useRef } from 'react'
import { useEditor } from '@/state/store'
import { formatTime } from '@shared/time'
import { beginScrub } from './interactions'
import { RULER_H, view } from './view'

const STEPS = [0.04, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

/** Canvas ruler for the visible range only; redraws on scroll/zoom via rAF. */
export function Ruler() {
  const ref = useRef<HTMLCanvasElement>(null)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const fps = useEditor((s) => s.project?.settings.fps ?? 30)
  const header = useEditor((s) => s.headerW)

  useEffect(() => {
    const canvas = ref.current
    const sc = view.scroller
    if (!canvas || !sc) return
    let raf = 0
    const draw = () => {
      raf = 0
      const dpr = window.devicePixelRatio || 1
      const w = Math.max(1, sc.clientWidth - header)
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(RULER_H * dpr)
        canvas.style.width = `${w}px`
        canvas.style.height = `${RULER_H}px`
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, RULER_H)
      const scroll = sc.scrollLeft
      // Major labels at least ~90px apart; minor ticks in 5 or 10 subdivisions.
      const major = STEPS.find((s) => s * pxPerSec >= 90) ?? 600
      const frameStep = 1 / fps
      const minor = major <= 0.2 ? Math.max(frameStep, major / 5) : major / (major >= 60 ? 6 : 5)
      const t0 = Math.floor(scroll / pxPerSec / minor) * minor
      const t1 = (scroll + w) / pxPerSec
      ctx.font = '12px "Segoe UI Variable Text", "Segoe UI", sans-serif'
      ctx.textBaseline = 'top'
      for (let t = t0; t <= t1 + minor; t += minor) {
        const x = Math.round(t * pxPerSec - scroll) + 0.5
        const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
        ctx.fillStyle = isMajor ? 'rgba(200,205,215,.55)' : 'rgba(200,205,215,.22)'
        ctx.fillRect(x, isMajor ? 8 : RULER_H - 9, 1, isMajor ? RULER_H - 8 : 9)
        if (isMajor) {
          ctx.fillStyle = 'rgba(200,205,215,.8)'
          const label = major < 1 ? `${formatTime(Math.round(t * 1e6))}.${String(Math.round((t % 1) * 100)).padStart(2, '0')}` : formatTime(Math.round(t * 1e6))
          ctx.fillText(label.replace(/^00:/, '0:'), x + 4, 6)
        }
      }
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(draw)
    }
    schedule()
    sc.addEventListener('scroll', schedule, { passive: true })
    const ro = new ResizeObserver(schedule)
    ro.observe(sc)
    return () => {
      sc.removeEventListener('scroll', schedule)
      ro.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [pxPerSec, fps, header])

  return (
    <canvas
      ref={ref}
      className="sticky cursor-pointer"
      style={{ left: header }}
      onPointerDown={(e) => e.button === 0 && beginScrub(e.nativeEvent)}
    />
  )
}
