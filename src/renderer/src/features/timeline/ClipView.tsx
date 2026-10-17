import { AudioLines, Copy, Image as ImageIcon, Scissors, Trash2, Type, Unplug, Volume2, VolumeX } from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from '@/components/ui/context-menu'
import { filmstrip, pcmFor, posterUrl, type FilmstripView } from '@/engine/media-client'
import { addCrossfadeAfter, deleteSelection, duplicateSelection, splitAtPlayhead, toggleMute, updateClip } from '@/features/editor/actions'
import { cn } from '@/lib/utils'
import { select, useEditor } from '@/state/store'
import { envelopeAt, gainToDb } from '@shared/envelope'
import type { Clip, MediaFile } from '@shared/model'
import { SAMPLE_RATE } from '@shared/mixer'
import { beginFade, beginMove, beginTrim, beginVolume, beginVolumeKey, deleteVolumeKey, MAX_VOLUME, volumeY } from './interactions'

const statFor = (files: MediaFile[], path: string | null) => files.find((f) => f.path === path)

function Filmstrip({ clip, width }: { clip: Clip; width: number }) {
  const files = useEditor((s) => s.files)
  const [strip, setStrip] = useState<FilmstripView | null>(null)
  useEffect(() => {
    if (!clip.source) return
    const f = statFor(files, clip.source) ?? { path: clip.source, size: 0, mtime: 0 }
    let alive = true
    void filmstrip(f).then((s) => alive && setStrip(s)).catch(() => {})
    return () => {
      alive = false
    }
  }, [clip.source, files])
  if (!strip || !clip.sourceDuration) return null
  const tileW = Math.max(40, (strip.tileWidth * 64) / strip.tileHeight)
  const tiles = Math.min(60, Math.max(1, Math.ceil(width / tileW)))
  const w = width / tiles
  const n = strip.times.length
  return (
    <div className="absolute inset-0 flex">
      {Array.from({ length: tiles }, (_, i) => {
        const t = clip.inPoint + ((i + 0.5) / tiles) * clip.duration
        let idx = 0
        while (idx + 1 < n && strip.times[idx + 1] <= t) idx++
        return (
          <div key={i} className="h-full shrink-0 bg-cover" style={{
            width: w,
            backgroundImage: `url(${strip.url})`,
            backgroundSize: `${n * 100}% 100%`,
            backgroundPosition: `${(idx / Math.max(1, n - 1)) * 100}% 0`,
          }} />
        )
      })}
    </div>
  )
}

function Waveform({ clip, width, height }: { clip: Clip; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Uint8Array | null>(null)
  useEffect(() => {
    if (!clip.source) return
    let alive = true
    void pcmFor(clip.source).then((p) => alive && setPeaks(p.peaks)).catch(() => {})
    return () => {
      alive = false
    }
  }, [clip.source])
  useEffect(() => {
    const c = ref.current
    if (!c || !peaks) return
    const w = Math.max(1, Math.min(8192, Math.round(width)))
    const dpr = window.devicePixelRatio || 1
    c.width = Math.round(w * dpr)
    c.height = Math.round(height * dpr)
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, w, height)
    ctx.fillStyle = clip.muted ? 'rgba(255, 255, 255, 0.22)' : 'rgba(180, 255, 220, 0.55)'
    const bucketsPerSec = SAMPLE_RATE / (SAMPLE_RATE / 100)
    const startB = (clip.inPoint / 1e6) * bucketsPerSec
    const spanB = (clip.duration / 1e6) * bucketsPerSec
    const env = envelopeOf(clip)
    const mid = height / 2
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(startB + (x / w) * spanB)
      const b1 = Math.max(b0 + 1, Math.floor(startB + ((x + 1) / w) * spanB))
      let m = 0
      for (let b = b0; b < b1 && b < peaks.length; b++) if (peaks[b] > m) m = peaks[b]
      const gain = Math.min(2, clip.volume * envelopeAt(env.ts, env.dbs, ((x + 0.5) / w) * clip.duration))
      const a = Math.min(1, (m / 255) * gain) * (mid - 2)
      if (a > 0.3) ctx.fillRect(x, mid - a, 1, a * 2)
    }
  }, [peaks, width, height, clip.inPoint, clip.duration, clip.volume, clip.volumeKeys, clip.muted])
  return <canvas ref={ref} className="absolute inset-0 h-full w-full" />
}

const envelopeOf = (clip: Clip) => ({
  ts: (clip.volumeKeys ?? []).map((k) => k.t),
  dbs: (clip.volumeKeys ?? []).map((k) => gainToDb(k.gain)),
})

/**
 * The line's points in px: through every point inside the clip, and sampled between points
 * that differ (gain moves in dB, so on this linear scale the segments curve).
 */
function linePoints(clip: Clip, width: number, h: number): string {
  const { ts, dbs } = envelopeOf(clip)
  const yAt = (x: number) => volumeY(Math.min(MAX_VOLUME, clip.volume * envelopeAt(ts, dbs, (x / width) * clip.duration)), h)
  const xs = [0, ...ts.filter((t) => t > 0 && t < clip.duration).map((t) => (t / clip.duration) * width), width]
  const out: string[] = []
  for (let i = 0; i < xs.length; i++) {
    out.push(`${xs[i].toFixed(1)},${yAt(xs[i]).toFixed(1)}`)
    if (i + 1 === xs.length) break
    const a = xs[i]
    const b = xs[i + 1]
    if (Math.abs(yAt(a) - yAt(b)) < 0.5) continue
    const n = Math.min(48, Math.floor((b - a) / 6))
    for (let j = 1; j < n; j++) {
      const x = a + ((b - a) * j) / n
      out.push(`${x.toFixed(1)},${yAt(x).toFixed(1)}`)
    }
  }
  return out.join(' ')
}

/**
 * Volume line: drag it vertically to set the clip volume (0–200%, double-click resets),
 * Alt/Ctrl-click to add an envelope point. Points drag freely; double-click deletes one.
 */
function VolumeLine({ clip, width, height, edge, selected, clipRef }: {
  clip: Clip
  width: number
  height: number
  edge: number
  selected: boolean
  clipRef: React.RefObject<HTMLDivElement | null>
}) {
  const points = useMemo(() => linePoints(clip, width, height), [clip, width, height])
  const keys = clip.volumeKeys ?? []
  const quiet = clip.kind === 'video' && clip.volume === 1 && !keys.length && !clip.muted && !selected
  return (
    <>
      {/* Hit area: only the stroke takes the pointer, and it stays clear of the trim edges. */}
      <svg className="peer/vol pointer-events-none absolute top-0 z-10 overflow-hidden" style={{ left: edge }} width={Math.max(0, width - edge * 2)} height={height}
        viewBox={`${edge} 0 ${Math.max(0, width - edge * 2)} ${height}`}>
        <polyline
          data-testid="volume-line"
          points={points}
          fill="none"
          stroke="transparent"
          strokeWidth={10}
          pointerEvents="stroke"
          className="cursor-ns-resize"
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            if (e.altKey || e.ctrlKey) beginVolumeKey(e.nativeEvent, clip, clipRef.current!, null)
            else beginVolume(e.nativeEvent, clip, clipRef.current!)
          }}
          onDoubleClick={(e) => {
            e.stopPropagation()
            if (clip.volume !== 1) updateClip(clip.id, `Reset volume ${clip.name}`, (c) => {
              c.volume = 1
            })
          }}
        />
      </svg>
      <svg
        className={cn(
          'pointer-events-none absolute inset-0 z-10 text-white/70 drop-shadow-[0_0_1px_rgba(0,0,0,.9)] [stroke-width:1px] peer-hover/vol:text-white peer-hover/vol:[stroke-width:2px]',
          quiet && 'opacity-0 group-hover/clip:opacity-100',
        )}
        width={width}
        height={height}
      >
        <polyline points={points} fill="none" stroke="currentColor" strokeDasharray={clip.muted ? '4 3' : undefined} />
      </svg>
      {keys.map((k, i) =>
        k.t < 0 || k.t > clip.duration ? null : (
          <div
            key={i}
            data-testid="volume-key"
            className="absolute z-20 size-2.5 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border border-black/60 bg-white shadow before:absolute before:-inset-1.5 before:content-[''] hover:scale-125"
            style={{ left: (k.t / clip.duration) * width, top: volumeY(Math.min(MAX_VOLUME, clip.volume * k.gain), height) }}
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              beginVolumeKey(e.nativeEvent, clip, clipRef.current!, i)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              deleteVolumeKey(clip, i)
            }}
          />
        ),
      )}
    </>
  )
}

function Poster({ clip }: { clip: Clip }) {
  const files = useEditor((s) => s.files)
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    const f = statFor(files, clip.source)
    if (!f) return
    void posterUrl(f).then(setUrl).catch(() => {})
  }, [clip.source, files])
  return url ? <img src={url} draggable={false} className="absolute right-0 top-0 h-full w-24 object-cover opacity-80 [mask-image:linear-gradient(to_right,transparent,black_40%)]" /> : null
}

function firstLine(clip: Clip): string {
  const p = clip.text?.doc.content?.[0]
  return p?.content?.map((n) => n.text ?? '').join('') || clip.name
}

export const ClipView = memo(function ClipView({ clip, pps, height, selected, offline }: {
  clip: Clip
  pps: number
  height: number
  selected: boolean
  offline: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const left = (clip.start / 1e6) * pps
  const width = Math.max(2, (clip.duration / 1e6) * pps)
  const fadeInW = (clip.fadeIn.duration / 1e6) * pps
  const fadeOutW = (clip.fadeOut.duration / 1e6) * pps
  const edge = Math.min(8, width / 4)
  const hasSound = clip.kind === 'audio' || (clip.kind === 'video' && clip.hasAudio)

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const r = ref.current!.getBoundingClientRect()
    const x = e.clientX - r.left
    if (x < edge) beginTrim(e.nativeEvent, clip, 'start')
    else if (x > r.width - edge) beginTrim(e.nativeEvent, clip, 'end')
    else beginMove(e.nativeEvent, clip, ref.current!)
  }

  const colors =
    clip.kind === 'video' ? 'bg-tv-video' :
    clip.kind === 'text' ? 'bg-tv-text' :
    clip.kind === 'image' ? 'bg-tv-image' : 'bg-tv-audio'

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={ref}
          data-clip={clip.id}
          onPointerDown={onPointerDown}
          onContextMenu={() => !selected && select([clip.id])}
          onDoubleClick={() => clip.kind === 'text' && useEditor.setState({ inspectorOpen: true, editingTextId: clip.id })}
          className={cn(
            'group/clip absolute top-1 cursor-grab overflow-hidden rounded-md text-[13px] text-white shadow-sm active:cursor-grabbing',
            colors,
            selected ? 'ring-2 ring-primary ring-offset-0 z-10' : 'ring-1 ring-white/10 hover:ring-white/40',
            offline && 'bg-[repeating-linear-gradient(135deg,#7f1d1d_0_8px,#450a0a_8px_16px)]',
          )}
          style={{ left, width, height: height - 8 }}
        >
          {!offline && clip.kind === 'video' && <Filmstrip clip={clip} width={width} />}
          {!offline && clip.kind === 'audio' && <Waveform clip={clip} width={width} height={height - 8} />}
          {!offline && clip.kind === 'image' && <Poster clip={clip} />}

          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-1.5 truncate px-2 pb-1.5 pt-4 [text-shadow:0_1px_2px_rgba(0,0,0,.8)] bg-gradient-to-t from-black/50 to-transparent">
            {clip.kind === 'text' && <Type className="size-4 shrink-0" />}
            {clip.kind === 'image' && <ImageIcon className="size-4 shrink-0" />}
            {clip.kind === 'audio' && <AudioLines className="size-4 shrink-0" />}
            {offline && <Unplug className="size-4 shrink-0" />}
            <span className="truncate">{clip.kind === 'text' ? firstLine(clip) : clip.name}</span>
            {clip.volume !== 1 && clip.kind !== 'text' && clip.kind !== 'image' && (
              <span className="ml-auto shrink-0 rounded bg-black/40 px-1 text-[10px] tabular">{Math.round(clip.volume * 100)}%</span>
            )}
            {hasSound && width > 56 && (
              <button
                data-testid="clip-mute"
                aria-label={clip.muted ? 'Unmute clip' : 'Mute clip'}
                aria-pressed={!!clip.muted}
                title={clip.muted ? 'Unmute clip (M)' : 'Mute clip (M)'}
                className={cn(
                  'pointer-events-auto relative z-30 -my-1 -mr-1 shrink-0 rounded p-0.5 hover:bg-black/50',
                  clip.volume === 1 && 'ml-auto',
                  clip.muted ? 'text-amber-300' : 'opacity-0 group-hover/clip:opacity-100',
                  selected && 'opacity-100',
                )}
                onPointerDown={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  toggleMute([clip.id])
                }}
              >
                {clip.muted ? <VolumeX className="size-3.5" /> : <Volume2 className="size-3.5" />}
              </button>
            )}
          </div>

          {/* Fade ramps */}
          {fadeInW > 1 && (
            <svg className="pointer-events-none absolute left-0 top-0 h-full" width={fadeInW} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polygon points="0,0 100,0 0,100" fill="rgba(0,0,0,.45)" />
              <line x1="0" y1="100" x2="100" y2="0" stroke="rgba(255,255,255,.7)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {fadeOutW > 1 && (
            <svg className="pointer-events-none absolute right-0 top-0 h-full" width={fadeOutW} preserveAspectRatio="none" viewBox="0 0 100 100">
              <polygon points="0,0 100,0 100,100" fill="rgba(0,0,0,.45)" />
              <line x1="0" y1="0" x2="100" y2="100" stroke="rgba(255,255,255,.7)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
            </svg>
          )}
          {/* Fade handles */}
          {width > 40 && (
            <>
              <div
                className="absolute top-0.5 z-20 size-2.5 -translate-x-1/2 cursor-ew-resize rounded-full border border-black/50 bg-white opacity-0 group-hover/clip:opacity-100"
                style={{ left: Math.max(6, fadeInW) }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  beginFade(e.nativeEvent, clip, 'fadeIn')
                }}
                title="Drag to fade in"
              />
              <div
                className="absolute top-0.5 z-20 size-2.5 translate-x-1/2 cursor-ew-resize rounded-full border border-black/50 bg-white opacity-0 group-hover/clip:opacity-100"
                style={{ right: Math.max(6, fadeOutW) }}
                onPointerDown={(e) => {
                  e.stopPropagation()
                  beginFade(e.nativeEvent, clip, 'fadeOut')
                }}
                title="Drag to fade out"
              />
            </>
          )}
          {hasSound && !offline && width > 24 && (
            <VolumeLine clip={clip} width={width} height={height - 8} edge={edge} selected={selected} clipRef={ref} />
          )}
          {/* Trim grips */}
          <div className="absolute inset-y-0 left-0 w-1.5 cursor-ew-resize bg-white/0 group-hover/clip:bg-white/50" />
          <div className="absolute inset-y-0 right-0 w-1.5 cursor-ew-resize bg-white/0 group-hover/clip:bg-white/50" />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-56">
        <ContextMenuItem onSelect={splitAtPlayhead}><Scissors /> Split at playhead <ContextMenuShortcut>S</ContextMenuShortcut></ContextMenuItem>
        <ContextMenuItem onSelect={duplicateSelection}><Copy /> Duplicate <ContextMenuShortcut>Ctrl+D</ContextMenuShortcut></ContextMenuItem>
        {clip.kind !== 'audio' && <ContextMenuItem onSelect={() => addCrossfadeAfter(clip.id)}>Cross-fade into next</ContextMenuItem>}
        {hasSound && (
          <ContextMenuItem onSelect={() => toggleMute(selected ? undefined : [clip.id])}>
            {clip.muted ? <Volume2 /> : <VolumeX />} {clip.muted ? 'Unmute' : 'Mute'} clip audio <ContextMenuShortcut>M</ContextMenuShortcut>
          </ContextMenuItem>
        )}
        {hasSound && !!clip.volumeKeys?.length && (
          <ContextMenuItem onSelect={() => updateClip(clip.id, `Clear volume points ${clip.name}`, (c) => {
            delete c.volumeKeys
          })}>Clear volume points</ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={deleteSelection}><Trash2 /> Delete <ContextMenuShortcut>Del</ContextMenuShortcut></ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})
