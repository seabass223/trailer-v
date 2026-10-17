import { Check, ChevronDown, Copy, Film, FolderOpen, Home, Keyboard, PanelRight, Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { commit, useEditor } from '@/state/store'
import type { ProjectSummary, TierId } from '@shared/model'
import { aspectPreset } from '@shared/presets'
import { cn } from '@/lib/utils'
import { changeFormat } from './actions'

export function TopBar({ onHome, onOpen }: { onHome: () => void; onOpen: (id: string) => void }) {
  const name = useEditor((s) => s.project?.name ?? '')
  const id = useEditor((s) => s.project?.id ?? '')
  const settings = useEditor((s) => s.project?.settings)
  const inspectorOpen = useEditor((s) => s.inspectorOpen)
  const [recent, setRecent] = useState<ProjectSummary[]>([])
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    void window.api.projects.list().then(setRecent)
  }, [id])

  if (!settings) return null
  const preset = aspectPreset(settings.aspect)

  const rename = () => {
    commit('Rename project', (d) => {
      d.name = draft.trim() || d.name
    })
    setRenaming(false)
  }

  const duplicate = async () => {
    const copy = await window.api.projects.duplicate(id)
    toast.success(`Duplicated as "${copy.name}"`, { action: { label: 'Open', onClick: () => onOpen(copy.id) } })
  }

  return (
    <header className="app-drag flex h-[52px] shrink-0 items-center gap-2 pl-3 pr-[150px]">
      <Button variant="ghost" size="icon" className="app-no-drag" onClick={onHome} aria-label="All projects">
        <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground"><Film className="size-4" /></span>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="app-no-drag h-9 gap-1.5 px-3 text-[15px] font-medium">
            {name} <ChevronDown className="size-4 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          <DropdownMenuItem onSelect={() => { setDraft(name); setRenaming(true) }}><Pencil /> Rename…</DropdownMenuItem>
          <DropdownMenuItem onSelect={duplicate}><Copy /> Duplicate</DropdownMenuItem>
          <DropdownMenuItem onSelect={onHome}><Home /> All projects</DropdownMenuItem>
          {recent.filter((r) => r.id !== id).length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs text-muted-foreground">Recent</DropdownMenuLabel>
              {recent.filter((r) => r.id !== id).slice(0, 6).map((r) => (
                <DropdownMenuItem key={r.id} onSelect={() => onOpen(r.id)}>
                  <FolderOpen /> <span className="truncate">{r.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground">{r.aspect}</span>
                </DropdownMenuItem>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex-1" />

      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className="app-no-drag" onClick={() => useEditor.setState({ shortcutsOpen: true })}>
            <Keyboard />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon" className={cn('app-no-drag', inspectorOpen && 'text-primary')}
            onClick={() => useEditor.setState({ inspectorOpen: !inspectorOpen })}>
            <PanelRight />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Inspector</TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" className="app-no-drag gap-1.5 text-[15px] text-muted-foreground hover:text-foreground">
            {settings.tier} <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuLabel className="text-xs text-muted-foreground">Output resolution · {settings.aspect}</DropdownMenuLabel>
          {preset.resolutions.map((r) => (
            <DropdownMenuItem key={r.tier} onSelect={() => changeFormat(settings.aspect, r.tier as TierId, null)}>
              <Check className={cn(r.tier !== settings.tier && 'opacity-0')} />
              {r.tier}
              <span className="ml-auto pl-6 text-xs text-muted-foreground tabular">{r.width}×{r.height}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button className="app-no-drag ml-1 h-9 px-5 text-[15px]" onClick={() => useEditor.setState({ exportOpen: true })}>
        Export
      </Button>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader><DialogTitle>Rename project</DialogTitle></DialogHeader>
          <Input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && rename()} />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Cancel</Button>
            <Button onClick={rename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </header>
  )
}
