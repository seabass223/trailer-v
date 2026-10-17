import { Gauge, Maximize, Minimize, Pause, Play, SkipBack, SkipForward } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { engine } from '@/engine/client'
import type { PreviewQuality } from '@/engine/protocol'
import { goToEnd, goToStart } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import { useEditor } from '@/state/store'
import { AspectMenu } from './AspectMenu'
import { TimeDisplay } from './TimeDisplay'
import { TransformOverlay } from './TransformOverlay'

export function usePlaying(): boolean {
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    let last = engine().playing
    setPlaying(last)
    return engine().subscribe((_t, p) => {
      if (p !== last) {
        last = p
        setPlaying(p)
      }
    })
  }, [])
  return playing
}

export function toggleFullscreen(): void {
  const el = document.getElementById('preview-root')
  if (!el) return
  if (document.fullscreenElement) void document.exitFullscreen()
  else void el.requestFullscreen()
}

export function PreviewPanel() {
  const settings = useEditor((s) => s.project?.settings)
  const quality = useEditor((s) => s.quality)
  const playing = usePlaying()
  const stageRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const [fullscreen, setFullscreen] = useState(false)
  const [frames, setFrames] = useState(false)
  const [idle, setIdle] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Mount the engine's persistent canvas (it survives editor remounts).
  useLayoutEffect(() => {
    const host = frameRef.current
    if (!host) return
    host.prepend(engine().canvas)
  }, [])

  // Fit the frame to the stage at the project aspect.
  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || !settings) return
    const fit = () => {
      const sw = stage.clientWidth
      const sh = stage.clientHeight
      const ar = settings.width / settings.height
      const w = Math.max(1, Math.floor(Math.min(sw, sh * ar)))
      const h = Math.max(1, Math.floor(w / ar))
      setBox((b) => (b.w === w && b.h === h ? b : { w, h }))
      engine().resize(w, h)
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [settings?.width, settings?.height])

  useEffect(() => {
    engine().setQuality(quality)
  }, [quality])

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement?.id === 'preview-root')
    document.addEventListener('fullscreenchange', on)
    return () => document.removeEventListener('fullscreenchange', on)
  }, [])

  const poke = () => {
    setIdle(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    if (fullscreen) idleTimer.current = setTimeout(() => setIdle(true), 2200)
  }

  if (!settings) return null

  return (
    <section
      id="preview-root"
      onPointerMove={poke}
      className={cn('relative flex h-full flex-col overflow-hidden rounded-xl bg-panel', fullscreen && 'rounded-none bg-black', fullscreen && idle && 'cursor-none')}
    >
      <div ref={stageRef} className={cn('relative min-h-0 flex-1', fullscreen ? 'm-0' : 'mx-4 mt-4 mb-2')}>
        <div
          ref={frameRef}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 overflow-hidden bg-black shadow-lg shadow-black/40"
          style={{ width: box.w, height: box.h }}
          onDoubleClick={() => !fullscreen && toggleFullscreen()}
        >
          {!fullscreen && <TransformOverlay width={box.w} height={box.h} />}
        </div>
      </div>

      <div
        className={cn(
          'relative flex h-14 shrink-0 items-center px-4 transition-opacity duration-300',
          fullscreen && 'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent',
          fullscreen && idle && 'pointer-events-none opacity-0',
        )}
      >
        <button className="rounded-md bg-secondary/70 px-2.5 py-1 hover:bg-accent" onClick={() => setFrames(!frames)} title="Toggle frames">
          <TimeDisplay frames={frames} />
        </button>

        <div className="absolute left-1/2 flex -translate-x-1/2 items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={goToStart} aria-label="Restart"><SkipBack className="fill-current" /></Button>
            </TooltipTrigger>
            <TooltipContent>Restart (Home)</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon" className="size-11 rounded-full hover:bg-accent" onClick={() => engine().toggle()} aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? <Pause className="size-6 fill-current" /> : <Play className="size-6 fill-current" />}
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={goToEnd} aria-label="Go to end"><SkipForward className="fill-current" /></Button>
            </TooltipTrigger>
            <TooltipContent>End (End)</TooltipContent>
          </Tooltip>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" aria-label="Preview quality"><Gauge /></Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel className="text-xs text-muted-foreground">Preview quality</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuRadioGroup value={quality} onValueChange={(v) => useEditor.setState({ quality: v as PreviewQuality })}>
                <DropdownMenuRadioItem value="auto">Auto (match screen)</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="full">Full resolution</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="half">Half</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          {!fullscreen && <AspectMenu />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="size-8" onClick={toggleFullscreen} aria-label="Fullscreen">
                {fullscreen ? <Minimize /> : <Maximize />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fullscreen (F)</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </section>
  )
}
