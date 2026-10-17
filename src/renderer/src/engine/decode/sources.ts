import { ALL_FORMATS, EncodedPacketSink, Input, UrlSource, type InputVideoTrack } from 'mediabunny'
import { mediaUrl } from '@shared/media-url'
import { lengthSize, nalFormat, type NalFormat } from './disposable'

export interface VideoSource {
  path: string
  input: Input
  track: InputVideoTrack
  sink: EncodedPacketSink
  config: VideoDecoderConfig
  frameDuration: number
  /** Bitstream framing, for skipping disposable frames during catch-up decode. */
  nal: NalFormat
  nalLength: number
}

const cache = new Map<string, Promise<VideoSource>>()

async function open(path: string): Promise<VideoSource> {
  const input = new Input({
    source: new UrlSource(mediaUrl(path), { maxCacheSize: 64 * 1024 * 1024 }),
    formats: ALL_FORMATS,
  })
  const track = await input.getPrimaryVideoTrack()
  if (!track) throw new Error(`No video track in ${path}`)
  const base = await track.getDecoderConfig()
  if (!base) throw new Error(`Unsupported video codec in ${path}`)
  const config: VideoDecoderConfig = { ...base, hardwareAcceleration: 'prefer-hardware' }
  const supported = await VideoDecoder.isConfigSupported(config)
  if (!supported.supported) {
    config.hardwareAcceleration = 'no-preference'
    if (!(await VideoDecoder.isConfigSupported(config)).supported) throw new Error(`Cannot decode ${base.codec}`)
  }
  let frameDuration = 33_333
  try {
    const stats = await track.computePacketStats(60)
    if (stats.averagePacketRate > 0) frameDuration = Math.round(1_000_000 / stats.averagePacketRate)
  } catch {
    /* keep default */
  }
  // Annex-B streams (no description) aren't length-prefixed: don't try to parse them.
  const nal = config.description ? nalFormat(config.codec) : null
  return { path, input, track, sink: new EncodedPacketSink(track), config, frameDuration, nal, nalLength: lengthSize(nal, config.description) }
}

/** Demuxers are shared per file; decoders are per clip (two clips of one file can cross-fade). */
export function videoSource(path: string): Promise<VideoSource> {
  let p = cache.get(path)
  if (!p) {
    p = open(path)
    p.catch(() => cache.delete(path))
    cache.set(path, p)
  }
  return p
}

export function releaseUnusedSources(inUse: Set<string>): void {
  for (const [path, p] of cache) {
    if (inUse.has(path)) continue
    cache.delete(path)
    void p.then((s) => s.input.dispose()).catch(() => {})
  }
}
