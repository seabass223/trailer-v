import { useEffect, useMemo, useState } from 'react'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { ColorField } from '@/features/inspector/fields'
import { ClipInspector } from '@/features/inspector/InspectorPanel'
import { useEditor } from '@/state/store'
import { baseClip } from '@shared/factory'
import { mainTrack } from '@shared/timeline'

/**
 * The first time Chromium's GPU process draws a new kind of effect it compiles shaders: a
 * one-off 35-60 ms stall that landed on the first clip selection/drag (measured with a CDP
 * trace). Drawing the drag visuals and inspector controls once, nearly invisibly, right after
 * the editor opens moves that cost off the interaction.
 */
export function Prewarm() {
  const [on, setOn] = useState(true)
  const project = useEditor((s) => s.project)
  // A synthetic clip that lights up every inspector section (audio, fades, transform).
  const dummy = useMemo(
    () => project && baseClip({ kind: 'video', name: 'warm', trackId: mainTrack(project).id, hasAudio: true, duration: 4_000_000, sourceDuration: 4_000_000 }),
    [project],
  )
  useEffect(() => {
    const t = setTimeout(() => setOn(false), 1200)
    return () => clearTimeout(t)
  }, [])
  if (!on) return null
  return (
    <>
    {project && dummy && (
      <div aria-hidden className="pointer-events-none fixed bottom-0 right-0 z-[1] w-[330px] opacity-[0.02]">
        <ClipInspector clip={dummy} project={project} />
      </div>
    )}
    <div aria-hidden className="pointer-events-none fixed bottom-1 right-1 z-[1] flex h-8 w-[420px] items-center gap-2 overflow-hidden opacity-[0.02]">
      <div className="h-6 w-px shrink-0 bg-snap shadow-[0_0_6px_var(--snap)]" />
      <div className="h-6 w-1 shrink-0 rounded bg-primary shadow-[0_0_8px_var(--primary)]" />
      <div className="h-5 w-8 shrink-0 rounded-md border-2 border-dashed border-primary bg-primary/25" />
      <div className="h-5 w-8 shrink-0 rounded-md bg-tv-video opacity-90 shadow-xl shadow-black/50 ring-2 ring-primary" />
      <div className="shrink-0 rounded bg-popover px-1.5 py-0.5 text-[11px] shadow">0.00s</div>
      <div className="h-4 w-6 shrink-0 rounded-sm border border-primary/80 bg-primary/10" />
      <Slider className="w-20 shrink-0" defaultValue={[50]} tabIndex={-1} />
      <Switch defaultChecked tabIndex={-1} />
      <ToggleGroup type="single" variant="outline" size="sm" defaultValue="a">
        <ToggleGroupItem value="a" tabIndex={-1}>Fit</ToggleGroupItem>
        <ToggleGroupItem value="b" tabIndex={-1}>Fill</ToggleGroupItem>
      </ToggleGroup>
      <ColorField value="#3b82f6" onChange={() => {}} />
    </div>
    </>
  )
}
