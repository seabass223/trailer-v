import { ALL_FORMATS, AudioSampleSink, Input, UrlSource } from 'mediabunny'
import { mediaUrl } from '@shared/media-url'
import { SAMPLE_RATE } from '@shared/mixer'
import { resample } from '@shared/resample'
import type { PcmResult } from '../protocol'

/**
 * Decode a file's whole audio track to 48 kHz interleaved stereo Int16 (shared memory when
 * the context is cross-origin isolated) plus 10 ms waveform peaks.
 */
export async function decodePcm(path: string): Promise<PcmResult> {
  const input = new Input({ source: new UrlSource(mediaUrl(path), { maxCacheSize: 32 * 1024 * 1024 }), formats: ALL_FORMATS })
  try {
    const track = await input.getPrimaryAudioTrack()
    if (!track) throw new Error('No audio track')
    const rate = track.sampleRate
    const duration = await input.computeDuration()
    let cap = Math.ceil((duration + 1) * rate)
    let L = new Float32Array(cap)
    let R = new Float32Array(cap)
    let length = 0
    const sink = new AudioSampleSink(track)
    let tmp = new Float32Array(0)
    for await (const sample of sink.samples()) {
      const n = sample.numberOfFrames
      const at = Math.round(sample.timestamp * rate)
      const start = Math.max(0, at)
      const skip = start - at
      if (start + n > cap) {
        cap = Math.ceil((start + n) * 1.5)
        const nl = new Float32Array(cap)
        nl.set(L)
        const nr = new Float32Array(cap)
        nr.set(R)
        L = nl
        R = nr
      }
      if (tmp.length < n) tmp = new Float32Array(n)
      sample.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' })
      L.set(tmp.subarray(skip, n), start)
      if (sample.numberOfChannels > 1) sample.copyTo(tmp, { planeIndex: 1, format: 'f32-planar' })
      R.set(tmp.subarray(skip, n), start)
      length = Math.max(length, start + n - skip)
      sample.close()
    }
    const l48 = resample(L.subarray(0, length), rate, SAMPLE_RATE)
    const r48 = resample(R.subarray(0, length), rate, SAMPLE_RATE)
    const frames = l48.length
    const bytes = frames * 4
    const data = new Int16Array(globalThis.crossOriginIsolated ? new SharedArrayBuffer(bytes) : new ArrayBuffer(bytes))
    const bucket = SAMPLE_RATE / 100
    const peaks = new Uint8Array(Math.ceil(frames / bucket))
    for (let i = 0; i < frames; i++) {
      const a = Math.max(-1, Math.min(1, l48[i]))
      const b = Math.max(-1, Math.min(1, r48[i]))
      data[i * 2] = a < 0 ? a * 32768 : a * 32767
      data[i * 2 + 1] = b < 0 ? b * 32768 : b * 32767
      const m = Math.max(Math.abs(a), Math.abs(b))
      const pi = (i / bucket) | 0
      const v = Math.min(255, Math.round(m * 255))
      if (v > peaks[pi]) peaks[pi] = v
    }
    return { data, frames, peaks }
  } finally {
    input.dispose()
  }
}
