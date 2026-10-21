import { useVirtualizer } from '@tanstack/react-virtual'
import { Ban, CopyPlus, Folder, FolderOpen, Image as ImageIcon, Loader2, Music, RefreshCw, Search, Sparkles, Type } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type DragEvent } from 'react'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useEditor, type LibraryTab } from '@/state/store'
import { TEXT_PRESETS, type TextPreset } from '@shared/factory'
import type { MediaFile } from '@shared/model'
import { dragFits, importFiles, openMediaFolder } from './import'
import { MediaCard, PresetCard } from './MediaCard'
import { chooseMediaFolder, refreshLibrary } from './useLibrary'

const TABS: { id: LibraryTab; label: string; icon: ComponentType<{ className?: string }> }[] = [
  { id: 'media', label: 'Media', icon: Folder },
  { id: 'text', label: 'Text', icon: Type },
  { id: 'image', label: 'Image', icon: ImageIcon },
  { id: 'audio', label: 'Audio', icon: Music },
]

type Item = { kind: 'file'; file: MediaFile } | { kind: 'preset'; preset: TextPreset }

const TAB_HINT: Record<LibraryTab, string> = { media: 'Video, image or audio', image: 'Images (jpg, png)', audio: 'Audio (mp3)', text: 'Text files (txt)' }

const isFileDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files')

type DropState = 'none' | 'fits' | 'refused'

/**
 * HTML5 drop target for files dragged in from Explorer. Refuses (no-drop cursor) when none of the
 * dragged files can belong on `tab`. The editor's own drags are pointer-based and never reach it.
 */
function useFileDrop(tab: LibraryTab, onFiles: (paths: string[]) => void, onHover?: () => void) {
  const [state, setState] = useState<DropState>('none')
  const depth = useRef(0)
  const hover = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = () => {
    depth.current = 0
    setState('none')
    if (hover.current) clearTimeout(hover.current)
    hover.current = null
  }
  useEffect(() => () => {
    if (hover.current) clearTimeout(hover.current)
  }, [])
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      if (depth.current++ === 0 && onHover) hover.current = setTimeout(onHover, 500)
      setState(dragFits(e.dataTransfer, tab) ? 'fits' : 'refused')
    },
    onDragOver: (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = dragFits(e.dataTransfer, tab) ? 'copy' : 'none'
    },
    onDragLeave: (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.stopPropagation()
      if (--depth.current <= 0) clear()
    },
    onDrop: (e: DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      clear()
      const paths = Array.from(e.dataTransfer.files).map((f) => window.api.library.pathForFile(f)).filter(Boolean)
      if (paths.length) onFiles(paths)
    },
  }
  return [state, handlers] as const
}

export function LibraryPanel() {
  const tab = useEditor((s) => s.libraryTab)
  const files = useEditor((s) => s.files)
  const folder = useEditor((s) => s.project?.mediaFolder ?? null)
  const loading = useEditor((s) => s.libraryLoading)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(400)
  /** Files just copied in: selected and scrolled to once the folder watcher lists them. */
  const [reveal, setReveal] = useState<string[] | null>(null)

  const drop = (target: LibraryTab) => (paths: string[]) => {
    useEditor.setState({ libraryTab: target })
    void importFiles(paths, target).then((copied) => copied.length && setReveal(copied.map((p) => p.toLowerCase())))
  }
  const [bodyDrop, bodyHandlers] = useFileDrop(tab, drop(tab))

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

  useEffect(() => {
    if (!reveal) return
    const idx = items.findIndex((it) => it.kind === 'file' && reveal.includes(it.file.path.toLowerCase()))
    if (idx < 0) return
    setSelected((items[idx] as Extract<Item, { kind: 'file' }>).file.path)
    virtualizer.scrollToIndex(Math.floor(idx / cols), { align: 'center' })
    setReveal(null)
  }, [items, reveal, cols, virtualizer])

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl bg-panel">
      <div className="grid grid-cols-4 gap-1 border-b p-2">
        {TABS.map((t) => (
          <TabButton key={t.id} id={t.id} label={t.label} icon={t.icon} active={tab === t.id} folder={folder} onFiles={drop(t.id)} />
        ))}
      </div>

      <div data-testid="library-body" className="relative flex min-h-0 flex-1 flex-col" {...bodyHandlers}>
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

        <TabMenu tab={tab} folder={folder}>
          <div ref={scrollRef} className="relative min-h-0 flex-1 overflow-y-auto" style={{ padding: `8px ${pad}px` }}>
            {loading && (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Scanning folder…</div>
            )}
            {!loading && items.length === 0 && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                {folder ? (query ? 'No matches' : 'No supported files here (mp4, mp3, jpg, png, txt)') : 'Pick a folder to see your media'}
                {folder && !query && (
                  <div className="mt-1 text-xs">Drag files here from Explorer to copy them in{tab === 'audio' ? ', or right-click to generate audio' : ''}</div>
                )}
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
        </TabMenu>
        {bodyDrop !== 'none' && <DropOverlay state={bodyDrop} tab={tab} folder={folder} />}
      </div>
    </section>
  )
}

function TabButton({ id, label, icon: Icon, active, folder, onFiles }: {
  id: LibraryTab
  label: string
  icon: ComponentType<{ className?: string }>
  active: boolean
  folder: string | null
  onFiles: (paths: string[]) => void
}) {
  const open = () => useEditor.setState({ libraryTab: id })
  // Hovering a tab while dragging files opens it, like Explorer's spring-loaded folders.
  const [state, handlers] = useFileDrop(id, onFiles, open)
  return (
    <TabMenu tab={id} folder={folder}>
      <button
        data-testid={`library-tab-${id}`}
        onContextMenu={open}
        onClick={open}
        {...handlers}
        className={cn(
          'flex flex-col items-center gap-1 rounded-lg py-2 text-[13px] text-muted-foreground outline-offset-[-2px] transition-colors hover:text-foreground',
          active && 'bg-accent text-foreground',
          state === 'fits' && 'bg-primary/15 text-foreground outline-2 outline-dashed outline-primary',
          state === 'refused' && 'opacity-50',
        )}
      >
        <Icon className="size-5" />
        {label}
      </button>
    </TabMenu>
  )
}

/** Right-click on a tab or its grid: open the media folder in Explorer (and generate audio on Audio). */
function TabMenu({ tab, folder, children }: { tab: LibraryTab; folder: string | null; children: React.ReactElement }) {
  return (
    <ContextMenu>
      {/* Always mounted so switching tabs never remounts the grid. */}
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem disabled={!folder} onSelect={() => void openMediaFolder()}>
          <FolderOpen /> Open in Explorer
        </ContextMenuItem>
        <ContextMenuItem disabled={!folder} onSelect={() => void refreshLibrary()}>
          <RefreshCw /> Refresh
        </ContextMenuItem>
        {tab === 'audio' && (
          <ContextMenuItem disabled={!folder} onSelect={() => useEditor.setState({ generateOpen: true })}>
            <Sparkles /> Generate audio…
          </ContextMenuItem>
        )}
        {!folder && <div className="px-2 pb-1.5 text-xs text-muted-foreground">Choose a media folder first</div>}
      </ContextMenuContent>
    </ContextMenu>
  )
}

function DropOverlay({ state, tab, folder }: { state: DropState; tab: LibraryTab; folder: string | null }) {
  const name = folder?.split(/[\\/]/).filter(Boolean).pop()
  const fits = state === 'fits' && !!folder
  return (
    <div
      data-testid="library-drop"
      className={cn(
        'pointer-events-none absolute inset-2 z-10 grid place-items-center rounded-xl border-2 border-dashed backdrop-blur-[2px]',
        fits ? 'border-primary bg-primary/10' : 'border-muted-foreground/40 bg-background/70',
      )}
    >
      <div className="flex flex-col items-center gap-2 px-6 text-center">
        {fits ? <CopyPlus className="size-8 text-primary" /> : <Ban className="size-8 text-muted-foreground" />}
        <div className="text-sm font-medium">
          {!folder ? 'Choose a media folder first' : fits ? `Drop to copy into ${name}` : `This tab takes ${TAB_HINT[tab].toLowerCase()}`}
        </div>
        {fits && <div className="text-xs text-muted-foreground">{TAB_HINT[tab]} · copied with Windows</div>}
      </div>
    </div>
  )
}
