import type { ExportJob } from './ipc'

/** NVENC presets: P4 is NVIDIA's balanced default; P6 trades ~25% speed for quality. */
export const NVENC_PRESET: Record<ExportJob['quality'], string> = { fast: 'p4', best: 'p6' }

/** Raw NV12 frames on stdin + pre-mixed f32 audio file -> MP4 (NVENC + AAC, faststart). */
export function ffmpegArgs(job: ExportJob, audioPath: string): string[] {
  const k = job.videoKbps
  const video =
    job.codec === 'hevc'
      ? ['-c:v', 'hevc_nvenc', '-profile:v', 'main', '-tag:v', 'hvc1']
      : ['-c:v', 'h264_nvenc', '-profile:v', 'high']
  const rate =
    job.rateControl === 'cbr'
      ? ['-rc', 'cbr', '-b:v', `${k}k`, '-minrate', `${k}k`, '-maxrate', `${k}k`, '-bufsize', `${k * 2}k`]
      : ['-rc', 'vbr', '-b:v', `${k}k`, '-maxrate', `${Math.round(k * 1.5)}k`, '-bufsize', `${k * 2}k`]
  return [
    '-hide_banner', '-y', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'nv12', '-s:v', `${job.width}x${job.height}`, '-framerate', String(job.fps),
    '-i', 'pipe:0',
    '-f', 'f32le', '-ar', '48000', '-ac', '2', '-i', audioPath,
    '-map', '0:v:0', '-map', '1:a:0',
    ...video,
    '-preset', NVENC_PRESET[job.quality], '-tune', 'hq', ...rate,
    '-bf', '3', '-b_ref_mode', 'middle', '-spatial_aq', '1', '-temporal_aq', '1', '-rc-lookahead', '20',
    '-g', String(job.fps * 2),
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:a', 'aac', '-b:a', `${job.audioKbps}k`, '-ar', '48000',
    '-shortest', '-movflags', '+faststart',
    job.outputPath,
  ]
}
