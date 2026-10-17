import { Plus } from 'lucide-react'
import { memo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { setCrossfade } from '@/features/editor/actions'
import type { Clip, Project } from '@shared/model'
import { DEFAULT_XFADE } from '@shared/presets'
import { adjacentPairs, transitionBetween } from '@shared/timeline'

function TransitionEditor({ a, b, duration }: { a: Clip; b: Clip; duration: number | null }) {
  const max = Math.min(a.duration, b.duration)
  const [d, setD] = useState(duration ?? Math.min(DEFAULT_XFADE, max))
  return (
    <div className="grid gap-3">
      <div className="text-sm font-medium">Transition</div>
      <ToggleGroup type="single" variant="outline" className="w-full" value={duration ? 'xfade' : 'none'}
        onValueChange={(v) => v && setCrossfade(a.id, b.id, v === 'xfade' ? d : null)}>
        <ToggleGroupItem value="none" className="flex-1">None</ToggleGroupItem>
        <ToggleGroupItem value="xfade" className="flex-1">Cross-fade</ToggleGroupItem>
      </ToggleGroup>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <Label className="text-xs text-muted-foreground">Duration</Label>
          <span className="text-xs tabular">{(d / 1e6).toFixed(2)}s</span>
        </div>
        <Slider min={100_000} max={Math.max(100_000, max)} step={50_000} value={[d]}
          onValueChange={([v]) => {
            setD(v)
            if (duration) setCrossfade(a.id, b.id, v)
          }} />
      </div>
      <p className="text-xs text-muted-foreground">
        Fade to a colour instead? Use the fade handles on the clip corners, or Fades in the inspector.
      </p>
    </div>
  )
}

/** "+" diamonds on touching clip boundaries and bow-tie glyphs on existing cross-fades. */
export const Junctions = memo(function Junctions({ project, trackId, pps, height }: { project: Project; trackId: string; pps: number; height: number }) {
  const pairs = adjacentPairs(project, trackId)
  return (
    <>
      {pairs.map(([a, b]) => {
        const tr = transitionBetween(project, a.id, b.id)
        const cutX = (b.start / 1e6) * pps
        if (tr) {
          const w = Math.max(14, (tr.duration / 1e6) * pps)
          return (
            <Popover key={`${a.id}-${b.id}`}>
              <PopoverTrigger asChild>
                <button
                  // Middle band only, so both clip edges stay grabbable for trimming above/below it.
                  className="absolute z-20 cursor-pointer"
                  style={{ left: cutX - w / 2, width: w, top: 4 + (height - 8) * 0.22, height: (height - 8) * 0.56 }}
                  aria-label="Edit cross-fade"
                  onPointerDown={(e) => e.stopPropagation()}
                >
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-full w-full drop-shadow">
                    <polygon points="0,0 50,30 100,0 100,100 50,70 0,100" fill="rgba(160,170,255,.35)" stroke="rgba(220,225,255,.85)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
                  </svg>
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-64" side="top">
                <TransitionEditor a={a} b={b} duration={tr.duration} />
              </PopoverContent>
            </Popover>
          )
        }
        return (
          <Popover key={`${a.id}-${b.id}`}>
            <PopoverTrigger asChild>
              <Button
                size="icon"
                variant="secondary"
                // Sits on the lane's top edge, clear of the trim zones at mid-height.
                className="absolute top-0 z-20 size-[18px] -translate-x-1/2 rotate-45 rounded-[5px] border border-white/30 bg-background/90 opacity-0 transition-opacity hover:opacity-100 focus-visible:opacity-100 group-hover/lane:opacity-80 data-[state=open]:opacity-100"
                style={{ left: cutX }}
                aria-label="Add transition"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Plus className="size-3 -rotate-45" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-64" side="top">
              <TransitionEditor a={a} b={b} duration={null} />
            </PopoverContent>
          </Popover>
        )
      })}
    </>
  )
})
