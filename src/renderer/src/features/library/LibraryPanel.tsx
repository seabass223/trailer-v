import { useVirtualizer } from '@tanstack/react-virtual'
import { Folder, FolderOpen, Image as ImageIcon, Loader2, Music, Search, Sparkles, Type } from 'lucide-react'
import { useLayoutEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useEditor, type LibraryTab } from '@/state/store'
import { TEXT_PRESETS, type TextPreset } from '@shared/factory'
import type { MediaFile } from '@shared/model'
import { MediaCard, PresetCard } from './MediaCard'
import { chooseMediaFolder } from './useLibrary'

const TABS: { id: LibraryTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'media', label: 'Media', icon: Folder },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'audio', label: 'Audio', icon: Music },
]

type Item = { kind: 'file'; file: MediaFile } | { kind: 'preset'; preset: TextPreset }

export function LibraryPanel() {
  const tab = useEditor((s) => s.libraryTab)
  const files = useEditor((s) => s.files)
  const folder = useEditor((s) => s.project?.mediaFolder ?? null)
  const loading = useEditor((s) => s.libraryLoading)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const match = (f: MediaFile) => !q || f.rel.toLowerCase().includes(q)
    const filesOf = (pred: (f: MediaFile) => boolean): Item[] => files.filter((f) => pred(f) && match(f)).map((file) => ({ kind: 'file', file }))
    switch (tab) {
      case 'media':
        return filesOf((f) => f.kind !== 'text')
      case 'image':
        return filesOf((f) => f.kind === 'image')
      case 'audio':
        return filesOf((f) => f.kind === 'audio')
      case 'text':
        return [
          ...TEXT_PRESETS.filter((p) => !q || p.name.toLowerCase().includes(q)).map((preset): Item => ({ kind: 'preset', preset })),
          ...filesOf((f) => f.kind === 'text'),
        ]
    }
  }, [files, tab, query])

  const gap = 14
  const pad = 14
  const cols = Math.max(2, Math.floor((width - pad * 2 + gap) / (150 + gap)))
  const cardW = (width - pad * 2 - gap * (cols - 1)) / cols
  const rowH = cardW * (9 / 16) + 30 + gap
  const rows = Math.ceil(items.length / cols)

  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowH,
    overscan: 3,
  })
  useLayoutEffect(() => virtualizer.measure(), [rowH, virtualizer])

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl bg-panel">
      <div className="grid grid-cols-4 gap-1 border-b p-2">
        {TABS.map((t) => (
          <AudioMenu key={t.id} enabled={t.id === 'audio'} folder={folder}>
            <button
              onContextMenu={() => t.id === 'audio' && useEditor.setState({ libraryTab: 'audio' })}
              onClick={() => useEditor.setState({ libraryTab: t.id })}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg py-2 text-[13px] text-muted-foreground transition-colors hover:text-foreground',
                tab === t.id && 'bg-accent text-foreground',
              )}
            >
              <t.icon className="size-5" />
              {t.label}
            </button>
          </AudioMenu>
        ))}
      </div>

      <div className="flex flex-col gap-2 px-3.5 pb-1 pt-3">
        {folder ? (
          <div className="flex items-center gap-2">
            <button onClick={chooseMediaFolder} title={folder}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-left text-sm hover:bg-accent">
              <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{folder.split(/[\\/]/).filter(Boolean).pop()}</span>
              <span className="ml-auto shrink-0 text-xs text-muted-foreground">{files.length} files</span>
            </button>
            <div className="relative w-[42%]">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search" className="h-9 pl-8" />
            </div>
          </div>
        ) : (
          <Button variant="secondary" className="h-10 w-full" onClick={chooseMediaFolder}>
            <FolderOpen /> Choose media folder
          </Button>
        )}
      </div>

      <AudioMenu enabled={tab === 'audio'} folder={folder}>
        <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto" style={{ padding: `8px ${pad}px` }}>
          {loading && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Scanning folder…</div>
          )}
          {!loading && items.length === 0 && (
            <div className="py-10 text-center text-sm text-muted-foreground">
              {folder ? (query ? 'No matches' : 'No supported files here (mp4, mp3, jpg, png, txt)') : 'Pick a folder to see your media'}
              {folder && tab === 'audio' && !query && <div className="mt-1 text-xs">Right-click to generate audio</div>}
            </div>
          )}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                className="absolute left-0 right-0 grid"
                style={{ top: row.start, gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, columnGap: gap }}
              >
                {items.slice(row.index * cols, row.index * cols + cols).map((it) =>
                  it.kind === 'preset' ? (
                    <PresetCard key={`p:${it.preset.id}`} preset={it.preset} selected={selected === `p:${it.preset.id}`}
                      onSelect={() => setSelected(`p:${it.preset.id}`)} />
                  ) : (
                    <MediaCard key={it.file.path} file={it.file} selected={selected === it.file.path} onSelect={() => setSelected(it.file.path)} />
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
      </AudioMenu>
    </section>
  )
}

/** Right-click "Generate audio…" on the Audio tab and its grid; other tabs pass through untouched. */
function AudioMenu({ enabled, folder, children }: { enabled: boolean; folder: string | null; children: React.ReactElement }) {
  return (
    <ContextMenu>
      {/* Always mounted (just disabled) so switching tabs never remounts the grid. */}
      <ContextMenuTrigger asChild disabled={!enabled}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!folder} onSelect={() => useEditor.setState({ generateOpen: true })}>
          <Sparkles /> Generate audio…
        </ContextMenuItem>
        {!folder && <div className="px-2 pb-1.5 text-xs text-muted-foreground">Choose a media folder first</div>}
      </ContextMenuContent>
    </ContextMenu>
  )
}
