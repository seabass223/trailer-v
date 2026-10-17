import { Check, ChevronDown } from 'lucide-react'
import { useState } from 'react'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { changeFormat } from '@/features/editor/actions'
import { AspectGlyph } from '@/features/home/AspectGlyph'
import { cn } from '@/lib/utils'
import { useEditor } from '@/state/store'
import type { AspectId, FitMode } from '@shared/model'
import { ASPECTS, aspectPreset, resolutionFor } from '@shared/presets'

export function AspectMenu() {
  const settings = useEditor((s) => s.project?.settings)
  const hasVisuals = useEditor((s) => !!s.project?.clips.some((c) => c.kind === 'video' || c.kind === 'image'))
  const [pending, setPending] = useState<AspectId | null>(null)
  const [fit, setFit] = useState<FitMode>('contain')
  if (!settings) return null

  const choose = (id: AspectId) => {
    if (id === settings.aspect) return
    if (!hasVisuals) changeFormat(id, settings.tier, 'contain')
    else setPending(id)
  }
  const target = pending ? resolutionFor(pending, settings.tier) : null

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="secondary" size="sm" className="h-8 gap-1.5 px-3 tabular">
            {settings.aspect} <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          {ASPECTS.map((a) => (
            <DropdownMenuItem key={a.id} onSelect={() => choose(a.id)}>
              <AspectGlyph w={a.w} h={a.h} size={18} className="text-muted-foreground" />
              <span className="w-10 tabular">{a.id}</span>
              <span className="text-muted-foreground">{a.label}</span>
              <Check className={cn('ml-auto', a.id !== settings.aspect && 'opacity-0')} />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Change aspect ratio to {pending}?</AlertDialogTitle>
            <AlertDialogDescription>
              All video and image clips will be resized to fit the new {target?.width}×{target?.height} frame. Any custom position or
              scale on those clips is reset. Text keeps its place. You can undo this.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid grid-cols-2 gap-2">
            {(['contain', 'cover'] as const).map((m) => (
              <button key={m} onClick={() => setFit(m)}
                className={cn('flex items-center gap-3 rounded-lg border bg-card p-3 text-left text-sm hover:bg-accent', fit === m && 'border-primary bg-primary/10')}>
                <span className="relative grid size-10 shrink-0 place-items-center overflow-hidden rounded border bg-black">
                  {pending && (
                    <AspectGlyph w={aspectPreset(pending).w} h={aspectPreset(pending).h} size={36} className="absolute text-muted-foreground" />
                  )}
                  <span className={cn('bg-primary/70', m === 'contain' ? 'h-3 w-8' : 'h-8 w-14')} />
                </span>
                <span>
                  <span className="block font-medium">{m === 'contain' ? 'Fit' : 'Fill'}</span>
                  <span className="text-xs text-muted-foreground">{m === 'contain' ? 'Whole frame visible, with bars' : 'Fill the frame, edges cropped'}</span>
                </span>
              </button>
            ))}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && changeFormat(pending, settings.tier, fit)}>Resize media</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
