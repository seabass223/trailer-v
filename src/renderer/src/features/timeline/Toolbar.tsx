import { ChevronDown, Copy, FoldHorizontal, Magnet, Redo2, Scissors, Trash2, Undo2, ZoomIn, ZoomOut } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Separator } from '@/components/ui/separator'
import { Slider } from '@/components/ui/slider'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { deleteSelection, duplicateSelection, seamState, seamVideo, splitAtPlayhead } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import { jumpTo, redo, undo, useEditor } from '@/state/store'
import { projectDuration } from '@shared/timeline'
import { MAX_PPS, MIN_PPS, setZoom, zoomToFit } from './view'

function Tool({ label, keys, onClick, disabled, children, active }: { label: string; keys?: string; onClick: () => void; disabled?: boolean; children: ReactNode; active?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" className={cn('size-9', active && 'text-primary')} onClick={onClick} disabled={disabled} aria-label={label}>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label} {keys && <span className="ml-1 text-muted-foreground">{keys}</span>}
      </TooltipContent>
    </Tooltip>
  )
}

// Zoom slider works in log space so it feels even from 2 to 1200 px/s.
const toSlider = (pps: number) => (Math.log(pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)) * 100
const fromSlider = (v: number) => MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v / 100)

export function Toolbar() {
  const past = useEditor((s) => s.past)
  const future = useEditor((s) => s.future)
  const hasSel = useEditor((s) => s.selection.length > 0)
  const single = useEditor((s) => s.selection.length === 1)
  const snapping = useEditor((s) => s.snapping)
  const pxPerSec = useEditor((s) => s.pxPerSec)
  const duration = useEditor((s) => (s.project ? projectDuration(s.project) : 0))
  // A string (not an object) so the selector result is stable between renders.
  const seam = useEditor((s) => seamState(s.project, s.selection))
  const [seamKind, seamArg] = seam.split(/:(.*)/)
  const one = seamArg === '1'
  const seamLabel =
    seamKind === 'seam' ? (one ? 'Close the gap before the selected clip' : `Seam ${seamArg} selected clips, top track first`) :
    seamKind === 'seamed' ? (one ? 'No gap before the selected clip' : 'Selected clips are already seamed') :
    seamKind === 'gaps' ? 'Close gaps between video clips' : 'No gaps between video clips'

  return (
    <div className="flex h-12 shrink-0 items-center gap-1 px-3">
      <Tool label="Undo" keys="Ctrl+Z" onClick={undo} disabled={!past.length}><Undo2 className="size-5" /></Tool>
      <Tool label="Redo" keys="Ctrl+Y" onClick={redo} disabled={!future.length}><Redo2 className="size-5" /></Tool>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="icon" className="size-7 text-muted-foreground" aria-label="History" disabled={!past.length && !future.length}>
                <ChevronDown />
              </Button>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent>History</TooltipContent>
        </Tooltip>
        <PopoverContent align="start" className="w-72 p-1">
          <div className="px-2 py-1.5 text-xs text-muted-foreground">History · {past.length} step{past.length === 1 ? '' : 's'}</div>
          <div className="max-h-80 overflow-y-auto">
            <button className={cn('flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent', past.length === 0 && 'text-primary')} onClick={() => jumpTo(0)}>
              Opened project
            </button>
            {past.map((h, i) => (
              <button key={`p${i}`} onClick={() => jumpTo(i + 1)}
                className={cn('flex w-full items-center rounded px-2 py-1.5 text-left text-sm hover:bg-accent', i === past.length - 1 && 'bg-accent/60 text-primary')}>
                <span className="truncate">{h.label}</span>
              </button>
            ))}
            {future.map((h, i) => (
              <button key={`f${i}`} onClick={() => jumpTo(past.length + i + 1)}
                className="flex w-full items-center rounded px-2 py-1.5 text-left text-sm text-muted-foreground/60 hover:bg-accent">
                <span className="truncate">{h.label}</span>
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>
      <Separator orientation="vertical" className="mx-2 !h-5" />
      <Tool label="Split" keys="S" onClick={splitAtPlayhead}><Scissors className="size-5" /></Tool>
      <Tool label="Duplicate" keys="Ctrl+D" onClick={duplicateSelection} disabled={!single}><Copy className="size-[18px]" /></Tool>
      <Tool label="Delete" keys="Del" onClick={deleteSelection} disabled={!hasSel}><Trash2 className="size-5" /></Tool>
      <Tool label={seamLabel} keys="G" onClick={seamVideo} disabled={seamKind !== 'seam' && seamKind !== 'gaps'} active={seamKind === 'seam'}>
        <FoldHorizontal className="size-5" />
      </Tool>

      <div className="ml-auto flex items-center gap-1">
        <Tool label={snapping ? 'Snapping on' : 'Snapping off'} keys="(hold Alt to bypass)" onClick={() => useEditor.setState({ snapping: !snapping })} active={snapping}>
          <Magnet className="size-[18px]" />
        </Tool>
        <Separator orientation="vertical" className="mx-2 !h-5" />
        <Tool label="Zoom out" keys="-" onClick={() => setZoom(pxPerSec / 1.4)}><ZoomOut className="size-[18px]" /></Tool>
        <Slider className="w-32" min={0} max={100} step={0.5} value={[toSlider(pxPerSec)]} onValueChange={([v]) => setZoom(fromSlider(v))} />
        <Tool label="Zoom in" keys="+" onClick={() => setZoom(pxPerSec * 1.4)}><ZoomIn className="size-[18px]" /></Tool>
        <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={() => zoomToFit(duration)}>Fit</Button>
      </div>
    </div>
  )
}
