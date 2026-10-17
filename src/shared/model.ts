/** All timeline times are integer microseconds (same unit as WebCodecs timestamps). */
export type Micros = number

export type AspectId = '16:9' | '9:16' | '1:1' | '4:5' | '4:3' | '21:9'
export type TierId = '720p' | '1080p' | '1440p' | '4K'
export type TrackKind = 'video' | 'image' | 'text' | 'audio'
export type MediaKind = 'video' | 'image' | 'audio' | 'text'
export type FitMode = 'contain' | 'cover'

export interface ProjectSettings {
  aspect: AspectId
  tier: TierId
  width: number
  height: number
  fps: number
  background: string
  historyDepth: number
}

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** Visual tracks: hidden. Audio tracks: muted. */
  hidden: boolean
  /** Audio tracks: dip under the sound of video-track clips. */
  duck?: DuckSettings
}

export interface DuckSettings {
  enabled: boolean
  /** How far the track dips, in dB (positive). */
  amount: number
  /** Ramp down before the clip audio starts, in ms. */
  attack: number
  /** Ramp back up after it ends, in ms. */
  release: number
}

/** A point on a clip's volume envelope. Gain is linear and multiplied by the clip volume. */
export interface VolumeKey {
  /** Relative to the clip start. May lie outside the clip after a trim, so trimming back restores it. */
  t: Micros
  gain: number
}

export interface Fade {
  duration: Micros
  /**
   * Colour faded to/from on video tracks; an upper video track dissolves into the video below
   * instead, where there is one. Overlays fade to transparent.
   */
  color: string
}

export interface Transform {
  fit: FitMode
  /** Offset of the layer centre from the frame centre, as a fraction of frame width/height. */
  x: number
  y: number
  /** Multiplier applied on top of the fit scale. */
  scale: number
}

/** Rich text document: ProseMirror/TipTap JSON. */
export interface RichNode {
  type: string
  attrs?: Record<string, unknown>
  marks?: { type: string; attrs?: Record<string, unknown> }[]
  text?: string
  content?: RichNode[]
}

export interface TextBox {
  /** Box width as a fraction of frame width. */
  width: number
  /** Padding in reference units (1 unit = 1px at a 1080px short side). */
  padding: number
  background: string
  backgroundOpacity: number
  radius: number
  /** Knockout plate covers the full frame instead of the box. */
  fullFrame: boolean
}

export interface TextData {
  doc: RichNode
  box: TextBox
  /** Letters are cut out of the background plate, revealing what's underneath. */
  knockout: boolean
  /** Line height multiplier (default 1.15). */
  lineHeight?: number
}

export interface Clip {
  id: string
  trackId: string
  kind: MediaKind
  name: string
  /** Absolute file path; null for built-in text presets. */
  source: string | null
  start: Micros
  duration: Micros
  inPoint: Micros
  /** Source media length; null = unlimited (images, text). */
  sourceDuration: Micros | null
  /** Linear gain, 1 = 100%. */
  volume: number
  /** Silent in preview and export; `volume` is kept so un-muting restores it. */
  muted?: boolean
  /** Volume envelope, sorted by `t`; interpolated linearly in dB. */
  volumeKeys?: VolumeKey[]
  fadeIn: Fade
  fadeOut: Fade
  transform: Transform
  /** Natural media size (for fit maths); 0 for audio/text. */
  mediaWidth: number
  mediaHeight: number
  hasAudio: boolean
  text?: TextData
}

export interface Transition {
  id: string
  fromClipId: string
  toClipId: string
  duration: Micros
}

export interface Project {
  version: 1
  id: string
  name: string
  created: number
  updated: number
  mediaFolder: string | null
  settings: ProjectSettings
  tracks: Track[]
  clips: Clip[]
  transitions: Transition[]
}

export interface ProjectSummary {
  id: string
  name: string
  updated: number
  aspect: AspectId
  width: number
  height: number
  duration: Micros
  poster: string | null
}

export interface MediaFile {
  path: string
  name: string
  rel: string
  ext: string
  kind: MediaKind
  size: number
  mtime: number
}

export interface MediaMeta {
  duration: Micros | null
  width: number
  height: number
  hasAudio: boolean
  hasVideo: boolean
  fps: number | null
  codec: string | null
  error?: string
}

export interface EncoderCaps {
  ffmpeg: string | null
  h264: boolean
  hevc: boolean
}
