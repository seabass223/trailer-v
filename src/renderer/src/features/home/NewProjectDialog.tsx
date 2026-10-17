import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { AspectId, Project, TierId } from '@shared/model'
import { ASPECTS, FPS_OPTIONS, aspectPreset, resolutionFor } from '@shared/presets'
import { AspectGlyph } from './AspectGlyph'

export function NewProjectDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (p: Project) => void
}) {
  const [name, setName] = useState('')
  const [aspect, setAspect] = useState<AspectId>('16:9')
  const [tier, setTier] = useState<TierId>('1080p')
  const [fps, setFps] = useState(30)
  const [folder, setFolder] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const preset = aspectPreset(aspect)
  const res = resolutionFor(aspect, tier)

  const pick = async () => {
    const f = await window.api.dialog.pickFolder(folder ?? undefined)
    if (f) setFolder(f)
  }

  const create = async () => {
    setBusy(true)
    try {
      const p = await window.api.projects.create({
        name: name.trim() || 'Untitled project',
        mediaFolder: folder,
        settings: { aspect, tier: res.tier, width: res.width, height: res.height, fps, background: '#000000', historyDepth: 200 },
      })
      onCreated(p)
      setName('')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Pick a YouTube format. You can change the aspect ratio later.</DialogDescription>
        </DialogHeader>

        <div className="grid gap-5">
          <div className="grid gap-2">
            <Label htmlFor="np-name">Name</Label>
            <Input id="np-name" autoFocus placeholder="My trailer" value={name} onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !busy && create()} />
          </div>

          <div className="grid gap-2">
            <Label>Aspect ratio</Label>
            <div className="grid grid-cols-6 gap-2">
              {ASPECTS.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => setAspect(a.id)}
                  className={cn(
                    'flex flex-col items-center gap-1.5 rounded-lg border bg-card px-2 py-3 text-xs transition-colors hover:bg-accent',
                    aspect === a.id ? 'border-primary bg-primary/10 text-foreground' : 'text-muted-foreground',
                  )}
                >
                  <AspectGlyph w={a.w} h={a.h} size={30} className={aspect === a.id ? 'text-primary' : ''} />
                  <span className="font-medium text-foreground">{a.id}</span>
                  <span className="text-[11px] leading-none">{a.label}</span>
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{preset.hint}</p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Resolution</Label>
              <Select value={res.tier} onValueChange={(v) => setTier(v as TierId)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {preset.resolutions.map((r) => (
                    <SelectItem key={r.tier} value={r.tier}>
                      {r.tier} <span className="text-muted-foreground tabular">{r.width}×{r.height}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Frame rate</Label>
              <Select value={String(fps)} onValueChange={(v) => setFps(Number(v))}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FPS_OPTIONS.map((f) => (
                    <SelectItem key={f} value={String(f)}>{f} fps</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Media folder</Label>
            <button type="button" onClick={pick}
              className="flex items-center gap-3 rounded-lg border border-dashed bg-card px-3 py-2.5 text-left text-sm hover:bg-accent">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className={cn('truncate', !folder && 'text-muted-foreground')}>{folder ?? 'Choose a Windows folder with your mp4, mp3, jpg, png and txt files'}</span>
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={create} disabled={busy}>Create project</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
