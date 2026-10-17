import { AlertTriangle, AudioLines, FileText } from 'lucide-react'
import { memo, useEffect, useRef, useState } from 'react'
import { engine } from '@/engine/client'
import { filmstrip, posterUrl, probeMedia, type FilmstripView } from '@/engine/media-client'
import { startLibraryDrag } from '@/features/dnd/drag'
import { addFile, addPreset } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import type { TextPreset } from '@shared/factory'
import type { MediaFile, MediaMeta } from '@shared/model'
import { formatTime } from '@shared/time'

function useMediaInfo(file: MediaFile) {
  const [meta, setMeta] = useState<MediaMeta | null>(null)
  const [poster, setPoster] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void probeMedia(file).then((m) => alive && setMeta(m)).catch(() => {})
    if (file.kind === 'video' || file.kind === 'image') {
      void posterUrl(file).then((u) => alive && setPoster(u)).catch(() => {})
    }
    return () => {
      alive = false
    }
  }, [file])
  return { meta, poster }
}

export const MediaCard = memo(function MediaCard({ file, selected, onSelect }: { file: MediaFile; selected: boolean; onSelect: () => void }) {
  const { meta, poster } = useMediaInfo(file)
  const [strip, setStrip] = useState<FilmstripView | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const thumbRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState<string | null>(null)

  useEffect(() => {
    if (file.kind === 'text') void window.api.library.readText(file.path).then((t) => setText(t.slice(0, 120))).catch(() => {})
  }, [file])

  const onMove = (e: React.PointerEvent) => {
    if (file.kind !== 'video') return
    if (!strip) {
      void filmstrip(file).then(setStrip).catch(() => {})
      return
    }
    const r = thumbRef.current!.getBoundingClientRect()
    setScrub(Math.max(0, Math.min(0.999, (e.clientX - r.left) / r.width)))
  }

  const error = meta?.error
  const tile = strip && scrub != null ? Math.floor(scrub * strip.times.length) : null

  return (
    <div
      className="group flex cursor-grab flex-col gap-1.5 active:cursor-grabbing"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        onSelect()
        startLibraryDrag(e.nativeEvent, { type: 'file', file }, file.name, poster)
      }}
      onDoubleClick={() => void addFile(file, null, engine().time())}
      title={error ?? file.rel}
    >
      <div
        ref={thumbRef}
        onPointerMove={onMove}
        onPointerLeave={() => setScrub(null)}
        className={cn(
          'relative aspect-video overflow-hidden rounded-lg border-2 border-transparent bg-muted transition-[border-color]',
          selected && 'border-primary',
          error && 'opacity-50',
        )}
      >
        {tile != null && strip ? (
          <div
            className="h-full w-full bg-no-repeat"
            style={{
              backgroundImage: `url(${strip.url})`,
              backgroundSize: `${strip.times.length * 100}% 100%`,
              backgroundPosition: `${(tile / Math.max(1, strip.times.length - 1)) * 100}% 0`,
            }}
          />
        ) : poster ? (
          <img src={poster} draggable={false}
            className={cn('h-full w-full', file.ext === 'png' ? 'bg-[repeating-conic-gradient(#2a2e36_0_25%,#1d2026_0_50%)_0_0/12px_12px] object-contain' : 'object-cover')} />
        ) : file.kind === 'audio' ? (
          <div className="grid h-full place-items-center bg-gradient-to-br from-tv-audio/40 to-tv-audio/10">
            <AudioLines className="size-8 text-emerald-300/80" />
          </div>
        ) : file.kind === 'text' ? (
          <div className="flex h-full items-center justify-center p-2 text-center text-xs font-semibold leading-tight text-foreground/90">
            {text ? <span className="line-clamp-3">{text}</span> : <FileText className="size-7 text-muted-foreground" />}
          </div>
        ) : null}
        {error && <AlertTriangle className="absolute left-1.5 top-1.5 size-4 text-amber-400" />}
        {tile != null && strip && <div className="absolute inset-x-0 bottom-0 h-0.5 bg-primary" style={{ width: `${(scrub ?? 0) * 100}%` }} />}
        {meta?.duration != null && (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">
            {formatTime(meta.duration)}
          </span>
        )}
      </div>
      <div className="truncate px-0.5 text-[13px] text-foreground/90">{file.name}</div>
    </div>
  )
})

export const PresetCard = memo(function PresetCard({ preset, selected, onSelect }: { preset: TextPreset; selected: boolean; onSelect: () => void }) {
  const knock = preset.text.knockout
  return (
    <div
      className="group flex cursor-grab flex-col gap-1.5 active:cursor-grabbing"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        onSelect()
        startLibraryDrag(e.nativeEvent, { type: 'preset', preset }, preset.name, null)
      }}
      onDoubleClick={() => addPreset(preset, null, engine().time())}
    >
      <div className={cn('relative grid aspect-video place-items-center overflow-hidden rounded-lg border-2 border-transparent bg-muted', selected && 'border-primary')}>
        {knock ? (
          <span className="bg-gradient-to-br from-amber-300 via-rose-400 to-sky-500 bg-clip-text text-2xl font-black tracking-tight text-transparent [font-family:Impact]">SOON</span>
        ) : preset.id === 'lower-third' ? (
          <span className="absolute bottom-3 left-3 rounded bg-primary px-2 py-1 text-[11px] font-semibold">Name Surname</span>
        ) : preset.id === 'subtitle' ? (
          <span className="absolute bottom-3 rounded bg-black/60 px-2 py-0.5 text-[11px]">Subtitle text</span>
        ) : (
          <span className="text-3xl font-semibold">Aa</span>
        )}
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] font-medium tabular text-white">00:05</span>
      </div>
      <div className="truncate px-0.5 text-[13px] text-foreground/90">{preset.name}</div>
    </div>
  )
})
