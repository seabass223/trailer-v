import { useEffect, useRef } from 'react'
import { STATS } from '@/engine/clock'
import { engine } from '@/engine/client'

/** Live engine + UI-thread stats (Ctrl+Shift+P). Reads shared memory; no React renders. */
export function PerfHud() {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    engine().setDebug(true)
    return () => engine().setDebug(false)
  }, [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let worst = 0
    let frames = 0
    let uiFps = 0
    let t0 = last
    const loop = () => {
      raf = requestAnimationFrame(loop)
      const now = performance.now()
      worst = Math.max(worst, now - last)
      last = now
      frames++
      if (now - t0 >= 500) {
        uiFps = (frames * 1000) / (now - t0)
        frames = 0
        t0 = now
        const s = engine().stats
        if (ref.current) {
          ref.current.textContent =
            `GPU      ${engine().adapter || '…'}\n` +
            `engine   ${s[STATS.FPS].toFixed(0)} fps   render ${s[STATS.RENDER_MS].toFixed(2)} ms\n` +
            `dropped  ${s[STATS.DROPPED]}\n` +
            `decoders ${s[STATS.DECODERS]}   frames held ${s[STATS.FRAMES_HELD]}\n` +
            `UI       ${uiFps.toFixed(0)} fps   worst frame ${worst.toFixed(1)} ms`
        }
        worst = 0
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <pre ref={ref} data-testid="perf-hud"
      className="pointer-events-none fixed left-3 top-14 z-[90] rounded-lg border bg-black/80 px-3 py-2 font-mono text-[11px] leading-relaxed text-emerald-300 shadow-xl" />
  )
}
