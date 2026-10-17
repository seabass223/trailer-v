import { execFile } from 'node:child_process'
import type { EncoderCaps } from '@shared/model'

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      resolve({ code: err ? 1 : 0, stdout })
    })
  })
}

/** 1-frame test encode: listing an encoder doesn't prove the GPU/driver can open a session. */
async function canEncode(ffmpeg: string, codec: string): Promise<boolean> {
  const r = await run(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:r=30',
    '-frames:v', '1', '-c:v', codec, '-f', 'null', '-',
  ])
  return r.code === 0
}

let cached: Promise<EncoderCaps> | null = null

export function encoderCaps(): Promise<EncoderCaps> {
  cached ??= (async () => {
    const ffmpeg = process.env.TRAILER_FFMPEG || 'ffmpeg'
    const version = await run(ffmpeg, ['-hide_banner', '-version'])
    if (version.code !== 0) return { ffmpeg: null, h264: false, hevc: false }
    const [h264, hevc] = await Promise.all([canEncode(ffmpeg, 'h264_nvenc'), canEncode(ffmpeg, 'hevc_nvenc')])
    return { ffmpeg, h264, hevc }
  })()
  return cached
}
