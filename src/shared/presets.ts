import type { AspectId, TierId } from './model'

export interface Resolution {
  tier: TierId
  width: number
  height: number
}

export interface AspectPreset {
  id: AspectId
  label: string
  hint: string
  w: number
  h: number
  resolutions: Resolution[]
}

// Widths are multiples of 4 and heights even (NV12 export path); all fit within NVENC H.264 limits.
export const ASPECTS: AspectPreset[] = [
  {
    id: '16:9', label: 'Landscape', hint: 'YouTube standard', w: 16, h: 9,
    resolutions: [
      { tier: '720p', width: 1280, height: 720 },
      { tier: '1080p', width: 1920, height: 1080 },
      { tier: '1440p', width: 2560, height: 1440 },
      { tier: '4K', width: 3840, height: 2160 },
    ],
  },
  {
    id: '9:16', label: 'Shorts', hint: 'Vertical', w: 9, h: 16,
    resolutions: [
      { tier: '720p', width: 720, height: 1280 },
      { tier: '1080p', width: 1080, height: 1920 },
      { tier: '1440p', width: 1440, height: 2560 },
      { tier: '4K', width: 2160, height: 3840 },
    ],
  },
  {
    id: '1:1', label: 'Square', hint: 'Community posts', w: 1, h: 1,
    resolutions: [
      { tier: '720p', width: 720, height: 720 },
      { tier: '1080p', width: 1080, height: 1080 },
      { tier: '1440p', width: 1440, height: 1440 },
      { tier: '4K', width: 2160, height: 2160 },
    ],
  },
  {
    id: '4:5', label: 'Portrait', hint: 'Tall feed', w: 4, h: 5,
    resolutions: [
      { tier: '720p', width: 720, height: 900 },
      { tier: '1080p', width: 1080, height: 1350 },
      { tier: '1440p', width: 1440, height: 1800 },
      { tier: '4K', width: 2160, height: 2700 },
    ],
  },
  {
    id: '4:3', label: 'Classic', hint: 'Retro / archival', w: 4, h: 3,
    resolutions: [
      { tier: '720p', width: 960, height: 720 },
      { tier: '1080p', width: 1440, height: 1080 },
      { tier: '1440p', width: 1920, height: 1440 },
      { tier: '4K', width: 2880, height: 2160 },
    ],
  },
  {
    id: '21:9', label: 'Cinematic', hint: 'Ultrawide', w: 21, h: 9,
    resolutions: [
      { tier: '720p', width: 1680, height: 720 },
      { tier: '1080p', width: 2560, height: 1080 },
      { tier: '1440p', width: 3440, height: 1440 },
    ],
  },
]

export const FPS_OPTIONS = [24, 25, 30, 50, 60] as const

export function aspectPreset(id: AspectId): AspectPreset {
  return ASPECTS.find((a) => a.id === id) ?? ASPECTS[0]
}

/** Resolution for an aspect at a tier, falling back to the closest available tier. */
export function resolutionFor(aspect: AspectId, tier: TierId): Resolution {
  const preset = aspectPreset(aspect)
  return (
    preset.resolutions.find((r) => r.tier === tier) ??
    preset.resolutions[preset.resolutions.length - 1]
  )
}

/** YouTube recommended SDR upload bitrates in Mbps: [<=30fps, >=48fps]. */
const YT_BITRATES: Record<TierId, [number, number]> = {
  '720p': [5, 7.5],
  '1080p': [8, 12],
  '1440p': [16, 24],
  '4K': [40, 60],
}

export function recommendedVideoMbps(tier: TierId, fps: number): number {
  const [low, high] = YT_BITRATES[tier]
  return fps >= 48 ? high : low
}

export const AUDIO_BITRATES = [128, 192, 256, 320, 384] as const
export const DEFAULT_AUDIO_KBPS = 384

export const SUPPORTED_EXTENSIONS: Record<string, 'video' | 'image' | 'audio' | 'text'> = {
  mp4: 'video',
  m4v: 'video',
  mov: 'video',
  mp3: 'audio',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  txt: 'text',
}

export const DEFAULT_IMAGE_DURATION = 5_000_000
export const DEFAULT_TEXT_DURATION = 5_000_000
export const DEFAULT_XFADE = 1_000_000
