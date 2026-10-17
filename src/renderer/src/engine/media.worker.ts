/// <reference lib="webworker" />
/**
 * Background media work (pooled): probing, posters, filmstrips and audio decode to the
 * shared 48 kHz PCM the mixer reads. Never blocks the UI or the preview engine.
 */
import { ALL_FORMATS, CanvasSink, EncodedPacketSink, Input, UrlSource } from 'mediabunny'
import type { MediaMeta } from '@shared/model'
import { mediaUrl } from '@shared/media-url'
import { decodePcm } from './audio/decode-pcm'
import type { FilmstripResult, MediaRequest } from './protocol'

const open = (path: string) =>
  new Input({ source: new UrlSource(mediaUrl(path), { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS })

async function probe(path: string, kind: 'video' | 'audio' | 'image'): Promise<MediaMeta> {
  if (kind === 'image') {
    const bmp = await createImageBitmap(await (await fetch(mediaUrl(path))).blob())
    const meta = { duration: null, width: bmp.width, height: bmp.height, hasAudio: false, hasVideo: true, fps: null, codec: null }
    bmp.close()
    return meta
  }
  const input = open(path)
  try {
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    const duration = Math.round((await input.computeDuration()) * 1_000_000)
    let fps: number | null = null
    let codec: string | null = null
    let error: string | undefined
    if (video) {
      codec = await video.getCodecParameterString()
      if (!(await video.canDecode())) error = `Can't decode ${codec ?? 'this video codec'}`
      try {
        fps = Math.round((await video.computePacketStats(90)).averagePacketRate * 100) / 100
      } catch {
        /* unknown */
      }
    } else if (kind === 'video') {
      error = 'No video track'
    }
    const hasAudio = !!audio && (await audio.canDecode())
    if (kind === 'audio' && !hasAudio) error = 'No decodable audio track'
    return {
      duration,
      width: video?.displayWidth ?? 0,
      height: video?.displayHeight ?? 0,
      hasAudio,
      hasVideo: !!video,
      fps,
      codec: codec ?? (audio ? await audio.getCodecParameterString() : null),
      error,
    }
  } finally {
    input.dispose()
  }
}

async function poster(path: string, kind: 'video' | 'image', width: number): Promise<Blob> {
  if (kind === 'image') {
    const blob = await (await fetch(mediaUrl(path))).blob()
    const bmp = await createImageBitmap(blob, { resizeWidth: width, resizeQuality: 'medium' })
    const c = new OffscreenCanvas(bmp.width, bmp.height)
    c.getContext('2d')!.drawImage(bmp, 0, 0)
    bmp.close()
    // PNGs keep their transparency (shown over a checkerboard); photos stay compact JPEGs.
    return path.toLowerCase().endsWith('.png') ? c.convertToBlob({ type: 'image/png' }) : c.convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  }
  const input = open(path)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('No video track')
    const sink = new CanvasSink(track, { width, decoderOptions: { hardwareAcceleration: 'prefer-hardware' } })
    const duration = await input.computeDuration()
    // Nearest keyframe: one decoded frame instead of decoding forward through the GOP.
    const key = await new EncodedPacketSink(track).getKeyPacket(Math.min(1, duration * 0.1))
    const wrapped = await sink.getCanvas(key ? key.timestamp : 0)
    if (!wrapped) throw new Error('No frame')
    return (wrapped.canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: 0.8 })
  } finally {
    input.dispose()
  }
}

/** Keyframe-only strip: decoding just the keyframes is near-instant even for 4K. */
async function filmstrip(path: string, count: number, height: number): Promise<FilmstripResult> {
  const input = open(path)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('No video track')
    const duration = await input.computeDuration()
    const tileHeight = height
    const tileWidth = Math.max(1, Math.round((height * track.displayWidth) / track.displayHeight))
    const sink = new CanvasSink(track, { height: tileHeight, width: tileWidth, fit: 'cover', decoderOptions: { hardwareAcceleration: 'prefer-hardware' } })
    const packets = new EncodedPacketSink(track)
    const wanted = Array.from({ length: count }, (_, i) => ((i + 0.5) * duration) / count)
    const keyTimes: number[] = []
    for (const t of wanted) {
      const k = await packets.getKeyPacket(t)
      keyTimes.push(k ? k.timestamp : 0)
    }
    const sprite = new OffscreenCanvas(tileWidth * count, tileHeight)
    const ctx = sprite.getContext('2d')!
    const unique = [...new Set(keyTimes)]
    const drawn = new Map<number, CanvasImageSource>()
    let i = 0
    for await (const wrapped of sink.canvasesAtTimestamps(unique)) {
      await yieldToPlayback()
      if (wrapped) {
        const copy = new OffscreenCanvas(tileWidth, tileHeight)
        copy.getContext('2d')!.drawImage(wrapped.canvas, 0, 0)
        drawn.set(unique[i], copy)
      }
      i++
    }
    keyTimes.forEach((t, slot) => {
      const img = drawn.get(t)
      if (img) ctx.drawImage(img, slot * tileWidth, 0)
    })
    return {
      sprite: await sprite.convertToBlob({ type: 'image/jpeg', quality: 0.72 }),
      times: keyTimes.map((t) => Math.round(t * 1_000_000)),
      tileWidth,
      tileHeight,
    }
  } finally {
    input.dispose()
  }
}

/** Shared transport clock: background decoding pauses while the preview is playing. */
let clock: Int32Array | null = null
async function yieldToPlayback(): Promise<void> {
  while (clock && Atomics.load(clock, 0) === 1) await new Promise((r) => setTimeout(r, 120))
}

self.onmessage = async (e: MessageEvent<{ id: number; req: MediaRequest } | { type: 'clock'; clock: Int32Array }>) => {
  if ('type' in e.data) {
    clock = e.data.clock
    return
  }
  const { id, req } = e.data
  try {
    let result: unknown
    switch (req.type) {
      case 'probe':
        result = await probe(req.path, req.kind)
        break
      case 'poster':
        result = await poster(req.path, req.kind, req.width)
        break
      case 'filmstrip':
        result = await filmstrip(req.path, req.count, req.height)
        break
      case 'pcm':
        result = await decodePcm(req.path)
        break
    }
    postMessage({ id, ok: true, result })
  } catch (err) {
    postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) })
  }
}
