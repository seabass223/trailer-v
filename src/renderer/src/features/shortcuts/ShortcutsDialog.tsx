import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useEditor } from '@/state/store'

const GROUPS: [string, [string, string][]][] = [
  ['Playback', [['Space', 'Play / pause'], ['Home / End', 'Start / end'], ['← / →', 'Previous / next frame'], ['Shift + ← / →', 'Back / forward 1 s'], ['J / K / L', 'Back 5 s / pause / play'], ['F', 'Fullscreen']]],
  ['Editing', [['S  or  Ctrl+B', 'Split at playhead'], ['Delete', 'Delete selection'], ['Ctrl+D', 'Duplicate'], ['Ctrl+A', 'Select all'], ['Ctrl+Z', 'Undo'], ['Ctrl+Y  or  Ctrl+Shift+Z', 'Redo'], ['Alt (while dragging)', 'Bypass snapping']]],
  ['View', [['+ / −  or  Ctrl+wheel', 'Zoom timeline'], ['Shift+Z', 'Zoom to fit'], ['Ctrl+Shift+P', 'Performance HUD'], ['Ctrl+E', 'Export'], ['Ctrl+S', 'Save now']]],
]

export function ShortcutsDialog() {
  const open = useEditor((s) => s.shortcutsOpen)
  return (
    <Dialog open={open} onOpenChange={(o) => useEditor.setState({ shortcutsOpen: o })}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader><DialogTitle>Keyboard shortcuts</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {GROUPS.map(([title, rows]) => (
            <div key={title}>
              <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</div>
              {rows.map(([k, label]) => (
                <div key={k} className="flex items-center justify-between py-1 text-sm">
                  <span>{label}</span>
                  <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">{k}</kbd>
                </div>
              ))}
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
