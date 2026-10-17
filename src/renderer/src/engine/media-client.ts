/**
 * Main-thread side of the media worker pool, with a persistent IndexedDB cache for posters,
 * filmstrips and probe results (keyed by path + size + mtime, so edits on disk invalidate).
 */
import type { MediaFile, MediaMeta } from '@shared/model'
import type { FilmstripResult, MediaRequest, PcmResult } from './protocol'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

const POOL = Math.min(3, Math.max(2, Math.floor((navigator.hardwareConcurrency || 4) / 4)))

class Pool {
  private workers: Worker[] = []
  private busy: number[] = []
  private queue: { req: MediaRequest; pending: Pending; priority: number }[] = []
  private pending = new Map<number, { pending: Pending; worker: number }>()
  private nextId = 1

  private ensure(): void {
    if (this.workers.length) return
    for (let i = 0; i < POOL; i++) {
      const w = new Worker(new URL('./media.worker.ts', import.meta.url), { type: 'module', name: `media-${i}` })
      w.onmessage = (e: MessageEvent<{ id: number; ok: boolean; result?: unknown; error?: string }>) => {
        const p = this.pending.get(e.data.id)
        if (!p) return
        this.pending.delete(e.data.id)
        this.busy[p.worker]--
        if (e.data.ok) p.pending.resolve(e.data.result)
        else p.pending.reject(new Error(e.data.error))
        this.pump()
      }
      if (this.clock) w.postMessage({ type: 'clock', clock: this.clock })
      this.workers.push(w)
      this.busy.push(0)
    }
  }

  /** Returns true while the preview needs the hardware decoder (playing / just scrubbed). */
  previewBusy: (() => boolean) | null = null
  /** Transport clock (shared memory) so running jobs can pause during playback. */
  clock: Int32Array | null = null
  private retry: ReturnType<typeof setTimeout> | null = null

  private pump(): void {
    this.queue.sort((a, b) => b.priority - a.priority)
    while (this.queue.length) {
      // Thumbnails/filmstrips yield to the preview; probes and audio decode (>= 3) never wait.
      if (this.queue[0].priority < 3 && this.previewBusy?.()) {
        this.retry ??= setTimeout(() => {
          this.retry = null
          this.pump()
        }, 250)
        return
      }
      const idx = this.busy.indexOf(Math.min(...this.busy))
      if (this.busy[idx] >= 1) return
      const job = this.queue.shift()!
      const id = this.nextId++
      this.busy[idx]++
      this.pending.set(id, { pending: job.pending, worker: idx })
      this.workers[idx].postMessage({ id, req: job.req })
    }
  }

  run<T>(req: MediaRequest, priority = 0): Promise<T> {
    this.ensure()
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ req, pending: { resolve: resolve as (v: unknown) => void, reject }, priority })
      this.pump()
    })
  }
}

const pool = new Pool()

export function setPreviewBusyProbe(probe: () => boolean, clock: Int32Array): void {
  pool.previewBusy = probe
  pool.clock = clock
}

// ---------------------------------------------------------------------------
// IndexedDB cache
// ---------------------------------------------------------------------------

let dbp: Promise<IDBDatabase> | null = null
function db(): Promise<IDBDatabase> {
  dbp ??= new Promise((resolve, reject) => {
    const r = indexedDB.open('trailer-v-media', 1)
    r.onupgradeneeded = () => r.result.createObjectStore('cache')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  return dbp
}

async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    const d = await db()
    return await new Promise<T | undefined>((resolve) => {
      const r = d.transaction('cache').objectStore('cache').get(key)
      r.onsuccess = () => resolve(r.result as T | undefined)
      r.onerror = () => resolve(undefined)
    })
  } catch {
    return undefined
  }
}

async function cachePut(key: string, value: unknown): Promise<void> {
  try {
    const d = await db()
    d.transaction('cache', 'readwrite').objectStore('cache').put(value, key)
  } catch {
    /* cache is best-effort */
  }
}

const fileKey = (f: Pick<MediaFile, 'path' | 'size' | 'mtime'>) => `${f.path}|${f.size}|${f.mtime}`

// In-memory layers on top of IndexedDB.
const metaMem = new Map<string, Promise<MediaMeta>>()
const posterMem = new Map<string, Promise<string>>()
const stripMem = new Map<string, Promise<FilmstripView>>()
const pcmMem = new Map<string, Promise<PcmResult>>()

export interface FilmstripView {
  url: string
  times: number[]
  tileWidth: number
  tileHeight: number
}

export function probeMedia(f: MediaFile): Promise<MediaMeta> {
  const key = `meta:${fileKey(f)}`
  let p = metaMem.get(key)
  if (!p) {
    p = (async () => {
      const hit = await cacheGet<MediaMeta>(key)
      if (hit) return hit
      if (f.kind === 'text') return { duration: null, width: 0, height: 0, hasAudio: false, hasVideo: false, fps: null, codec: null }
      const meta = await pool.run<MediaMeta>({ type: 'probe', path: f.path, kind: f.kind }, 3)
      if (!meta.error) void cachePut(key, meta)
      return meta
    })()
    metaMem.set(key, p)
  }
  return p
}

export function posterUrl(f: MediaFile): Promise<string> {
  const key = `poster:${fileKey(f)}`
  let p = posterMem.get(key)
  if (!p) {
    p = (async () => {
      let blob = await cacheGet<Blob>(key)
      if (!blob) {
        if (f.kind !== 'video' && f.kind !== 'image') throw new Error('No poster for this kind')
        blob = await pool.run<Blob>({ type: 'poster', path: f.path, kind: f.kind, width: 320 }, 2)
        void cachePut(key, blob)
      }
      return URL.createObjectURL(blob)
    })()
    p.catch(() => posterMem.delete(key))
    posterMem.set(key, p)
  }
  return p
}

export function filmstrip(f: Pick<MediaFile, 'path' | 'size' | 'mtime'>, count = 48): Promise<FilmstripView> {
  const key = `strip:${fileKey(f)}:${count}`
  let p = stripMem.get(key)
  if (!p) {
    p = (async () => {
      let r = await cacheGet<FilmstripResult>(key)
      if (!r) {
        r = await pool.run<FilmstripResult>({ type: 'filmstrip', path: f.path, count, height: 72 }, 1)
        void cachePut(key, r)
      }
      return { url: URL.createObjectURL(r.sprite), times: r.times, tileWidth: r.tileWidth, tileHeight: r.tileHeight }
    })()
    p.catch(() => stripMem.delete(key))
    stripMem.set(key, p)
  }
  return p
}

/** Decoded 48 kHz PCM for the mixer (kept in memory; shared with the AudioWorklet). */
export function pcmFor(path: string): Promise<PcmResult> {
  let p = pcmMem.get(path)
  if (!p) {
    p = pool.run<PcmResult>({ type: 'pcm', path }, 4)
    p.catch(() => pcmMem.delete(path))
    pcmMem.set(path, p)
  }
  return p
}

export function peekPcm(path: string): Promise<PcmResult> | undefined {
  return pcmMem.get(path)
}

export function releasePcm(keep: Set<string>): void {
  for (const k of pcmMem.keys()) if (!keep.has(k)) pcmMem.delete(k)
}
