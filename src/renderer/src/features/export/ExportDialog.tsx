import { AlertTriangle, CheckCircle2, Cpu, FolderOpen, Loader2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { engine } from '@/engine/client'
import { useEditor } from '@/state/store'
import type { ExportJob } from '@shared/ipc'
import { AUDIO_BITRATES, DEFAULT_AUDIO_KBPS, recommendedVideoMbps } from '@shared/presets'
import { projectDuration } from '@shared/timeline'
import { formatTime, frameIndex } from '@shared/time'
import { runExport, type ExportHandle } from './run-export'

type Phase = { kind: 'setup' } | { kind: 'running'; frame: number; total: number; fps: number; started: number; audio: boolean } | { kind: 'done'; size: number; seconds: number; path: string } | { kind: 'error'; message: string }

function fmtSize(bytes: number): string {
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} GB`
  return `${(bytes / 1e6).toFixed(bytes > 1e8 ? 0 : 1)} MB`
}

export function ExportDialog() {
  const open = useEditor((s) => s.exportOpen)
  const project = useEditor((s) => s.project)
  const caps = useEditor((s) => s.caps)
  const [codec, setCodec] = useState<'h264' | 'hevc'>('h264')
  const [rate, setRate] = useState<'vbr' | 'cbr'>('vbr')
  const [quality, setQuality] = useState<'fast' | 'best'>('fast')
  const [mbps, setMbps] = useState(8)
  const [audio, setAudio] = useState<number>(DEFAULT_AUDIO_KBPS)
  const [path, setPath] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'setup' })
  const handle = useRef<ExportHandle | null>(null)

  const s = project?.settings
  const recommended = s ? recommendedVideoMbps(s.tier, s.fps) : 8

  useEffect(() => {
    if (!open || !project) return
    setPhase({ kind: 'setup' })
    setMbps(recommendedVideoMbps(project.settings.tier, project.settings.fps))
    setPath((prev) => prev || '')
    if (engine().playing) engine().pause()
  }, [open, project?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!project || !s) return null
  const duration = projectDuration(project)
  const seconds = duration / 1e6
  const estimate = ((mbps * 1000 + audio) * 1000 * seconds) / 8
  const nvenc = codec === 'hevc' ? caps?.hevc : caps?.h264

  const browse = async () => {
    const p = await window.api.dialog.saveVideo(`${project.name.replace(/[\\/:*?"<>|]/g, '_')}.mp4`)
    if (p) setPath(p)
    return p
  }

  const start = async () => {
    const out = path || (await browse())
    if (!out) return
    const job: ExportJob = {
      outputPath: out,
      width: s.width,
      height: s.height,
      fps: s.fps,
      codec,
      rateControl: rate,
      quality,
      videoKbps: Math.round(mbps * 1000),
      audioKbps: audio,
      totalFrames: Math.max(1, frameIndex(duration, s.fps)),
    }
    const started = performance.now()
    setPhase({ kind: 'running', frame: 0, total: job.totalFrames, fps: 0, started, audio: true })
    const h = runExport(project, job, (m) =>
      setPhase({ kind: 'running', frame: m.frame, total: m.total, fps: m.fps, started, audio: m.phase === 'audio' }),
    )
    handle.current = h
    try {
      const r = await h.done
      if (r) setPhase({ kind: 'done', size: r.size, seconds: r.seconds, path: out })
      else setPhase({ kind: 'setup' })
    } catch (e) {
      setPhase({ kind: 'error', message: (e as Error).message })
    } finally {
      handle.current = null
    }
  }

  const close = (o: boolean) => {
    if (!o && phase.kind === 'running') return
    useEditor.setState({ exportOpen: o })
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-[560px]" onEscapeKeyDown={(e) => phase.kind === 'running' && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Export video</DialogTitle>
          <DialogDescription>MP4 for YouTube · {formatTime(duration)} · {project.name}</DialogDescription>
        </DialogHeader>

        {phase.kind === 'setup' && (
          <div className="grid gap-5">
            <div className="grid grid-cols-3 gap-3 rounded-lg border bg-card p-3 text-sm">
              <div><div className="text-xs text-muted-foreground">Resolution</div><div className="font-medium tabular">{s.width}×{s.height}</div><div className="text-xs text-muted-foreground">{s.tier} · {s.aspect}</div></div>
              <div><div className="text-xs text-muted-foreground">Frame rate</div><div className="font-medium tabular">{s.fps} fps</div></div>
              <div><div className="text-xs text-muted-foreground">Estimated size</div><div className="font-medium tabular">{fmtSize(estimate)}</div></div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Video codec</Label>
                <Select value={codec} onValueChange={(v) => setCodec(v as 'h264' | 'hevc')}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="h264">H.264 · recommended for YouTube</SelectItem>
                    <SelectItem value="hevc" disabled={!caps?.hevc}>HEVC (H.265)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Rate control</Label>
                <ToggleGroup type="single" variant="outline" className="w-full" value={rate} onValueChange={(v) => v && setRate(v as 'vbr' | 'cbr')}>
                  <ToggleGroupItem value="vbr" className="flex-1">VBR</ToggleGroupItem>
                  <ToggleGroupItem value="cbr" className="flex-1">CBR</ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex items-center justify-between">
                <Label>Video bitrate</Label>
                <div className="flex items-center gap-2">
                  {Math.abs(mbps - recommended) > 0.01 && (
                    <button className="text-xs text-primary hover:underline" onClick={() => setMbps(recommended)}>YouTube recommends {recommended} Mbps</button>
                  )}
                  <Input type="number" min={1} max={150} step={0.5} value={mbps} onChange={(e) => setMbps(Math.max(1, Math.min(150, Number(e.target.value) || 1)))} className="h-8 w-20 tabular" />
                  <span className="text-sm text-muted-foreground">Mbps</span>
                </div>
              </div>
              <Slider min={1} max={Math.max(80, recommended * 2)} step={0.5} value={[mbps]} onValueChange={([v]) => setMbps(v)} />
            </div>

            <div className="grid gap-2">
              <Label>Encoder preset</Label>
              <ToggleGroup type="single" variant="outline" className="w-full" value={quality} onValueChange={(v) => v && setQuality(v as 'fast' | 'best')}>
                <ToggleGroupItem value="fast" className="flex-1">Fast · NVENC P4</ToggleGroupItem>
                <ToggleGroupItem value="best" className="flex-1">Best quality · P6</ToggleGroupItem>
              </ToggleGroup>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>Audio bitrate (AAC, 48 kHz)</Label>
                <Select value={String(audio)} onValueChange={(v) => setAudio(Number(v))}>
                  <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {AUDIO_BITRATES.map((b) => <SelectItem key={b} value={String(b)}>{b} kbps{b === DEFAULT_AUDIO_KBPS ? ' · recommended' : ''}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-2">
                <Label>Encoder</Label>
                <div className="flex h-9 items-center gap-2">
                  {nvenc ? (
                    <Badge variant="secondary" className="gap-1.5 bg-emerald-500/15 text-emerald-300"><Cpu className="size-3.5" /> NVIDIA NVENC</Badge>
                  ) : (
                    <Badge variant="secondary" className="gap-1.5 bg-amber-500/15 text-amber-300"><AlertTriangle className="size-3.5" /> {caps?.ffmpeg ? 'NVENC unavailable' : 'FFmpeg not found'}</Badge>
                  )}
                </div>
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Save to</Label>
              <div className="flex gap-2">
                <Input readOnly value={path} placeholder="Choose where to save…" className="flex-1" onClick={browse} />
                <Button variant="secondary" onClick={browse}><FolderOpen /> Browse</Button>
              </div>
            </div>
          </div>
        )}

        {phase.kind === 'running' && (
          <div className="grid gap-3 py-2">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              {phase.audio ? 'Mixing audio…' : `Encoding frame ${phase.frame} of ${phase.total}`}
              <span className="ml-auto tabular text-muted-foreground">{Math.round((phase.frame / phase.total) * 100)}%</span>
            </div>
            <Progress value={(phase.frame / phase.total) * 100} />
            <div className="flex justify-between text-xs tabular text-muted-foreground">
              <span>{phase.fps > 0 ? `${phase.fps.toFixed(0)} fps · ${(phase.fps / s.fps).toFixed(1)}× real-time` : 'Starting NVENC…'}</span>
              <span>
                {phase.fps > 0 && phase.frame > 0
                  ? `about ${formatTime(((phase.total - phase.frame) / phase.fps) * 1e6)} left`
                  : `${formatTime((performance.now() - phase.started) * 1000)} elapsed`}
              </span>
            </div>
          </div>
        )}

        {phase.kind === 'done' && (
          <div className="grid gap-2 py-2">
            <div className="flex items-center gap-2 font-medium"><CheckCircle2 className="size-5 text-emerald-400" /> Export complete</div>
            <div className="text-sm text-muted-foreground">
              {fmtSize(phase.size)} in {phase.seconds.toFixed(1)}s ({(seconds / phase.seconds).toFixed(1)}× real-time)
            </div>
            <div className="truncate text-xs text-muted-foreground">{phase.path}</div>
          </div>
        )}

        {phase.kind === 'error' && (
          <div className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive"><AlertTriangle className="size-4" /> Export failed</div>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{phase.message}</pre>
          </div>
        )}

        <DialogFooter>
          {phase.kind === 'setup' && (
            <>
              <Button variant="ghost" onClick={() => close(false)}>Cancel</Button>
              <Button onClick={start} disabled={!caps?.ffmpeg || duration <= 0 || !nvenc}>Export</Button>
            </>
          )}
          {phase.kind === 'running' && <Button variant="secondary" onClick={() => handle.current?.cancel()}>Cancel export</Button>}
          {phase.kind === 'done' && (
            <>
              <Button variant="secondary" onClick={() => void window.api.shell.showItem(phase.path)}><FolderOpen /> Show in folder</Button>
              <Button onClick={() => { close(false); toast.success('Export saved') }}>Done</Button>
            </>
          )}
          {phase.kind === 'error' && <Button onClick={() => setPhase({ kind: 'setup' })}>Back</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
