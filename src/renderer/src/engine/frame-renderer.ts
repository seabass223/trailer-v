/**
 * Turns a project + time into GPU draws. Shared by the preview worker and the export worker,
 * so exported frames are pixel-identical to what the preview shows at the same resolution.
 */
import { mediaRect } from '@shared/geometry'
import type { Clip, Micros, Project } from '@shared/model'
import { mediaUrl } from '@shared/media-url'
import { framePlan, trackSpans, sourceTimeAt, type VisualLayer } from '@shared/render-plan'
import { ClipStream } from './decode/clip-stream'
import { releaseUnusedSources, videoSource } from './decode/sources'
import { Compositor, hexToRgba, type Draw, type FrameDraws, type Rect } from './gpu/compositor'
import { rasterizeText } from './text/raster'

interface TextEntry {
  key: string
  texture: GPUTexture
  rect: Rect
}

interface ImageEntry {
  texture: GPUTexture | null
  width: number
  height: number
  failed: boolean
}

export interface DrawResult {
  /** Every visible layer had its exact content (export waits for this). */
  complete: boolean
  /** A video layer had to show a stale frame (counts as a dropped frame while playing). */
  stale: boolean
}

const PREROLL_US = 1_000_000

export class FrameRenderer {
  readonly compositor: Compositor
  project: Project | null = null
  private streams = new Map<string, Promise<ClipStream>>()
  private ready = new Map<string, ClipStream>()
  private images = new Map<string, ImageEntry>()
  private texts = new Map<string, TextEntry>()
  /** Sources that failed to open (offline/unsupported). */
  private failed = new Set<string>()
  /** Render pixels per logical pixel; text is rasterized at this density. */
  textScale = 1
  hiddenClip: string | null = null
  /** Lookahead in frames while playing (export decodes ahead harder). */
  playLookahead = 6
  onContentChanged: (() => void) | null = null
  onLog: ((m: string) => void) | null = null

  constructor(compositor: Compositor) {
    this.compositor = compositor
  }

  setProject(p: Project): void {
    this.project = p
    // Give previously failed media another chance (the file may be back on disk).
    if (this.failed.size) {
      for (const c of p.clips) {
        if (c.source && this.failed.has(c.source)) this.dropStream(c.id, this.streams.get(c.id) ?? Promise.reject())
      }
      this.failed.clear()
    }
    this.compositor.setLogicalSize(p.settings.width, p.settings.height)
    const live = new Set(p.clips.map((c) => c.id))
    for (const [id, s] of this.streams) {
      if (!live.has(id)) this.dropStream(id, s)
    }
    for (const [id, t] of this.texts) {
      if (!live.has(id)) {
        t.texture.destroy()
        this.texts.delete(id)
      }
    }
    // A changed source (file replaced by the same clip id) needs a new decoder.
    for (const c of p.clips) {
      const s = this.ready.get(c.id)
      if (s && s.src.path !== c.source) this.dropStream(c.id, this.streams.get(c.id)!)
    }
    releaseUnusedSources(new Set(p.clips.filter((c) => c.kind === 'video' && c.source).map((c) => c.source!)))
  }

  private dropStream(id: string, s: Promise<ClipStream>): void {
    this.streams.delete(id)
    this.ready.delete(id)
    void s.then((x) => x.close()).catch(() => {})
  }

  private stream(clip: Clip): ClipStream | null {
    const ready = this.ready.get(clip.id)
    if (ready) return ready
    if (!this.streams.has(clip.id) && clip.source) {
      const p = videoSource(clip.source).then((src) => {
        const s = new ClipStream(clip.id, src)
        s.onFrame = () => this.onContentChanged?.()
        s.onLog = (m) => this.onLog?.(m)
        if (this.streams.get(clip.id) === p) this.ready.set(clip.id, s)
        else s.close()
        this.onContentChanged?.()
        return s
      })
      p.catch((e) => {
        // Missing/undecodable media renders as nothing instead of blocking forever.
        this.failed.add(clip.source!)
        this.onLog?.(`cannot open ${clip.source}: ${String(e?.message ?? e)}`)
        this.onContentChanged?.()
      })
      this.streams.set(clip.id, p)
    }
    return null
  }

  private image(path: string): ImageEntry {
    let e = this.images.get(path)
    if (!e) {
      const entry: ImageEntry = { texture: null, width: 0, height: 0, failed: false }
      e = entry
      this.images.set(path, entry)
      const max = 4096
      void (async () => {
        try {
          const blob = await (await fetch(mediaUrl(path))).blob()
          const probe = await createImageBitmap(blob)
          const k = Math.min(1, max / Math.max(probe.width, probe.height))
          const bmp = k < 1
            ? await createImageBitmap(blob, { resizeWidth: Math.round(probe.width * k), resizeHeight: Math.round(probe.height * k), resizeQuality: 'high' })
            : probe
          entry.width = probe.width
          entry.height = probe.height
          entry.texture = this.compositor.uploadBitmap(bmp)
          if (bmp !== probe) probe.close()
          bmp.close()
        } catch {
          entry.failed = true
        }
        this.onContentChanged?.()
      })()
    }
    return e
  }

  private text(clip: Clip): TextEntry | null {
    if (!clip.text || !this.project) return null
    const { width: W, height: H } = this.project.settings
    const scale = this.textScale
    const key = `${JSON.stringify(clip.text)}|${JSON.stringify(clip.transform)}|${W}x${H}@${scale.toFixed(3)}`
    const cached = this.texts.get(clip.id)
    if (cached?.key === key) return cached
    const r = rasterizeText(clip.text, clip.transform, W, H, scale)
    cached?.texture.destroy()
    const entry = { key, texture: this.compositor.uploadBitmap(r.canvas), rect: r.rect }
    this.texts.set(clip.id, entry)
    return entry
  }

  /** Point decoders at time t (and pre-roll clips starting soon). */
  prepare(t: Micros, playing: boolean): void {
    const p = this.project
    if (!p) return
    const lookahead = playing ? this.playLookahead : 1
    const wanted = new Set<string>()
    for (const track of p.tracks) {
      if (track.kind === 'audio' || track.hidden) continue
      for (const s of trackSpans(p, track.id)) {
        const c = s.clip
        if (c.kind !== 'video' || !c.source) continue
        const active = t >= s.from && t < s.to
        const upcoming = playing && s.from > t && s.from - t < PREROLL_US
        if (!active && !upcoming) continue
        wanted.add(c.id)
        const st = this.stream(c)
        st?.want(sourceTimeAt(c, active ? t : s.from), lookahead)
      }
    }
    // Free decoders that are neither visible nor about to be.
    for (const [id, s] of this.ready) {
      if (!wanted.has(id) && performance.now() - s.lastUsed > 1500) this.dropStream(id, this.streams.get(id)!)
    }
  }

  private layerDraws(layer: VisualLayer, res: DrawResult): Draw[] {
    const p = this.project!
    const { width: W, height: H } = p.settings
    const c = layer.clip
    if (c.id === this.hiddenClip) return []
    if (c.kind === 'video') {
      const s = this.ready.get(c.id)
      if ((c.source && this.failed.has(c.source)) || s?.error) return []
      const frame = s?.frameAt(layer.sourceTime)
      if (!frame) {
        res.complete = false
        res.stale = true
        return []
      }
      if (!s!.isExact(layer.sourceTime)) {
        res.complete = false
        res.stale = true
      }
      const mw = c.mediaWidth || frame.displayWidth
      const mh = c.mediaHeight || frame.displayHeight
      return [{ kind: 'video', frame, rect: mediaRect(W, H, mw, mh, c.transform), opacity: layer.opacity }]
    }
    if (c.kind === 'image' && c.source) {
      const img = this.image(c.source)
      if (!img.texture) {
        if (!img.failed) res.complete = false
        return []
      }
      return [{ kind: 'texture', texture: img.texture, rect: mediaRect(W, H, img.width, img.height, c.transform), opacity: layer.opacity }]
    }
    if (c.kind === 'text') {
      const t = this.text(c)
      return t ? [{ kind: 'texture', texture: t.texture, rect: t.rect, opacity: layer.opacity }] : []
    }
    return []
  }

  draw(t: Micros, target: GPUTexture): DrawResult {
    const res: DrawResult = { complete: true, stale: false }
    const p = this.project
    if (!p) return { complete: false, stale: false }
    const { width: W, height: H } = p.settings
    const plan = framePlan(p, t)
    const frame: FrameDraws = {
      background: hexToRgba(p.settings.background),
      // In a cross-dissolve each side is drawn opaque into its own target and mixed afterwards.
      base: plan.base.map((l) => this.layerDraws(plan.base.length > 1 ? { ...l, opacity: 1 } : l, res)),
      mix: plan.base.map((l) => l.opacity),
      top: [],
    }
    if (plan.dip) frame.top.push({ kind: 'solid', rect: [0, 0, W, H], color: hexToRgba(plan.dip.color), opacity: plan.dip.alpha })
    for (const l of plan.overlays) frame.top.push(...this.layerDraws(l, res))
    this.compositor.render(target, frame)
    return res
  }

  /** True when every video layer visible at `t` has at least `n` decoded frames ready ahead. */
  buffered(t: Micros, n: number): boolean {
    const p = this.project
    if (!p) return true
    const plan = framePlan(p, t)
    for (const l of [...plan.base, ...plan.overlays]) {
      const c = l.clip
      if (c.kind !== 'video' || !c.source || this.failed.has(c.source)) continue
      const s = this.ready.get(c.id)
      if (!s || s.error) {
        if (s?.error) continue
        return false
      }
      if (s.ahead(l.sourceTime) < s.scaled(n)) return false
    }
    return true
  }

  describe(): string {
    return [...this.ready.values()].map((s) => s.describe()).join(' | ')
  }

  framesHeld(): number {
    let n = 0
    for (const s of this.ready.values()) n += s.framesHeld
    return n
  }

  decoders(): number {
    return this.ready.size
  }

  dispose(): void {
    for (const [id, s] of this.streams) this.dropStream(id, s)
    for (const t of this.texts.values()) t.texture.destroy()
    for (const i of this.images.values()) i.texture?.destroy()
    this.texts.clear()
    this.images.clear()
  }
}
