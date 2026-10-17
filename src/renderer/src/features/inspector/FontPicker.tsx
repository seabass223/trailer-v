import { useVirtualizer } from '@tanstack/react-virtual'
import { Check, ChevronsUpDown } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { useEditor } from '@/state/store'

/** Installed system fonts, each previewed in its own face; virtualized (hundreds of fonts). */
export function FontPicker({ value, onChange }: { value: string; onChange: (f: string) => void }) {
  const fonts = useEditor((s) => s.fonts)
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const listRef = useRef<HTMLDivElement>(null)
  const list = useMemo(() => {
    const s = q.trim().toLowerCase()
    return s ? fonts.filter((f) => f.toLowerCase().includes(s)) : fonts
  }, [fonts, q])
  const v = useVirtualizer({ count: list.length, getScrollElement: () => listRef.current, estimateSize: () => 34, overscan: 6 })

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setQ('') }}>
      <PopoverTrigger asChild>
        <Button variant="secondary" className="h-8 min-w-0 flex-1 justify-between px-2.5 font-normal">
          <span className="truncate" style={{ fontFamily: `"${value}"` }}>{value}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <div className="border-b p-2">
          <Input autoFocus placeholder={`Search ${fonts.length} fonts`} value={q} onChange={(e) => setQ(e.target.value)} className="h-8"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && list[0]) {
                onChange(list[0])
                setOpen(false)
              }
            }} />
        </div>
        <div ref={listRef} className="h-72 overflow-y-auto p-1">
          <div style={{ height: v.getTotalSize(), position: 'relative' }}>
            {v.getVirtualItems().map((it) => {
              const f = list[it.index]
              return (
                <button key={f}
                  className={cn('absolute inset-x-0 flex h-[34px] items-center gap-2 rounded px-2 text-left text-[15px] hover:bg-accent', f === value && 'text-primary')}
                  style={{ top: it.start }}
                  onClick={() => {
                    onChange(f)
                    setOpen(false)
                  }}
                >
                  <Check className={cn('size-3.5 shrink-0', f !== value && 'opacity-0')} />
                  <span className="truncate" style={{ fontFamily: `"${f}"` }}>{f}</span>
                </button>
              )
            })}
          </div>
          {!list.length && <div className="p-3 text-sm text-muted-foreground">No fonts match</div>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
