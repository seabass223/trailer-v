/**
 * Detect "disposable" coded pictures — frames no other frame references — so a seek that has to
 * decode forward from a distant keyframe can skip them (they never need to be on screen).
 * Works on length-prefixed (MP4-style) H.264 and HEVC samples.
 */
export type NalFormat = 'avc' | 'hevc' | null

export function nalFormat(codec: string): NalFormat {
  if (/^(avc1|avc3)/.test(codec)) return 'avc'
  if (/^(hvc1|hev1)/.test(codec)) return 'hevc'
  return null
}

/** Length-field size from an avcC / hvcC decoder configuration record (usually 4). */
export function lengthSize(format: NalFormat, description: AllowSharedBufferSource | undefined): number {
  if (!description || !format) return 4
  const bytes = ArrayBuffer.isView(description)
    ? new Uint8Array(description.buffer, description.byteOffset, description.byteLength)
    : new Uint8Array(description as ArrayBuffer)
  if (format === 'avc' && bytes.length > 4) return (bytes[4] & 3) + 1
  if (format === 'hevc' && bytes.length > 21) return (bytes[21] & 3) + 1
  return 4
}

export function isDisposable(data: Uint8Array, format: NalFormat, lenSize: number): boolean {
  if (!format) return false
  let off = 0
  let sawSlice = false
  while (off + lenSize < data.length) {
    let len = 0
    for (let i = 0; i < lenSize; i++) len = len * 256 + data[off + i]
    const h = off + lenSize
    if (len <= 0 || h + len > data.length) return false
    if (format === 'avc') {
      const type = data[h] & 0x1f
      if (type === 1 || type === 5) {
        if (type === 5 || ((data[h] >> 5) & 3) !== 0) return false
        sawSlice = true
      }
    } else {
      const type = (data[h] >> 1) & 0x3f
      if (type <= 31) {
        // VCL NAL: even types below 16 are sub-layer non-reference pictures.
        if (type >= 16 || type % 2 === 1) return false
        sawSlice = true
      }
    }
    off = h + len
  }
  return sawSlice
}
