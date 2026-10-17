import { Copy, Film, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { ProjectSummary } from '@shared/model'
import { aspectPreset } from '@shared/presets'
import { formatTime } from '@shared/time'
import { AspectGlyph } from './AspectGlyph'
import { NewProjectDialog } from './NewProjectDialog'

function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ts).toLocaleDateString()
}

export function HomeScreen({ onOpen, busy }: { onOpen: (id: string) => void; busy: boolean }) {
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null)
  const [newName, setNewName] = useState('')

  const refresh = useCallback(() => {
    void window.api.projects.list().then(setProjects)
  }, [])
  useEffect(refresh, [refresh])

  const rename = async () => {
    if (!renaming) return
    await window.api.projects.rename(renaming.id, newName)
    setRenaming(null)
    refresh()
  }

  const remove = async () => {
    if (!deleting) return
    await window.api.projects.remove(deleting.id)
    toast.success(`"${deleting.name}" moved to the Recycle Bin`)
    setDeleting(null)
    refresh()
  }

  return (
    <div className="flex h-full flex-col">
      <header className="app-drag flex h-[52px] shrink-0 items-center gap-3 border-b px-5 pr-[150px]">
        <div className="flex items-center gap-2 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"><Film className="size-4" /></span>
          Trailer-V
        </div>
      </header>

      <main className="flex-1 overflow-y-auto px-10 py-8">
        <div className="mx-auto max-w-6xl">
          <div className="mb-6 flex items-end justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
              <p className="text-sm text-muted-foreground">Stored in Documents\Trailer-V\Projects</p>
            </div>
            <Button onClick={() => setCreating(true)} size="lg"><Plus /> New project</Button>
          </div>

          {projects && projects.length === 0 && (
            <button onClick={() => setCreating(true)}
              className="flex w-full flex-col items-center gap-3 rounded-xl border border-dashed py-20 text-muted-foreground hover:bg-card">
              <Plus className="size-8" />
              <span className="text-base text-foreground">Create your first project</span>
              <span className="text-sm">16:9, Shorts, square and more</span>
            </button>
          )}

          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-5">
            {projects?.map((p) => {
              const a = aspectPreset(p.aspect)
              return (
                <div key={p.id} className="group relative overflow-hidden rounded-xl border bg-card transition-colors hover:border-primary/60">
                  <button className="block w-full text-left" disabled={busy} onClick={() => onOpen(p.id)}>
                    <div className="relative aspect-video bg-black/60">
                      {p.poster ? (
                        <img src={p.poster} className="h-full w-full object-contain" draggable={false} />
                      ) : (
                        <div className="grid h-full place-items-center text-muted-foreground"><AspectGlyph w={a.w} h={a.h} size={44} /></div>
                      )}
                      <span className="absolute bottom-2 right-2 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular">{formatTime(p.duration)}</span>
                    </div>
                    <div className="px-3 py-2.5">
                      <div className="truncate font-medium">{p.name}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{p.aspect}</span>·<span className="tabular">{p.width}×{p.height}</span>·<span>{ago(p.updated)}</span>
                      </div>
                    </div>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="secondary" className="absolute right-2 top-2 size-7 opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100">
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => { setNewName(p.name); setRenaming(p) }}><Pencil /> Rename</DropdownMenuItem>
                      <DropdownMenuItem onSelect={async () => { await window.api.projects.duplicate(p.id); refresh() }}><Copy /> Duplicate</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(p)}><Trash2 /> Delete</DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              )
            })}
          </div>
        </div>
      </main>

      <NewProjectDialog open={creating} onOpenChange={setCreating} onCreated={(p) => { setCreating(false); onOpen(p.id) }} />

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
          <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(null)}>Cancel</Button>
            <Button onClick={rename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleting?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>The project file moves to the Recycle Bin. Your media folder is not touched.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-white hover:bg-destructive/90" onClick={remove}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
