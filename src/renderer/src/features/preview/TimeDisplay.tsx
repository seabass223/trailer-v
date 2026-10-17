import { useEffect, useRef } from 'react'
import { engine } from '@/engine/client'
import { useEditor } from '@/state/store'
import { projectDuration } from '@shared/timeline'
import { formatTime, formatTimecode } from '@shared/time'

/** Elapsed / total. Updated imperatively from the clock: no React renders during playback. */
export function TimeDisplay({ frames }: { frames: boolean }) {
  const elapsed = useRef<HTMLSpanElement>(null)
  const total = useEditor((s) => (s.project ? projectDuration(s.project) : 0))
  const fps = useEditor((s) => s.project?.settings.fps ?? 30)

  useEffect(
    () =>
      engine().subscribe((t) => {
        if (elapsed.current) elapsed.current.textContent = frames ? formatTimecode(t, fps) : formatTime(t)
      }),
    [frames, fps],
  )

  return (
    <span className="tabular text-[15px]">
      <span ref={elapsed} className="text-foreground">00:00</span>
      <span className="text-muted-foreground"> / {frames ? formatTimecode(total, fps) : formatTime(total)}</span>
    </span>
  )
}
