/**
 * Contract between the main-process MCP server and the editor's automation handlers.
 * Times are seconds here (the MCP-facing unit); the editor converts to microseconds.
 */
import type { AspectId, DuckSettings, FitMode, MediaFile, ProjectSettings, TierId, TrackKind } from './model'

export interface TextStyleInput {
  font?: string
  /** Reference px (1 unit = 1px at a 1080px short side). */
  size?: number
  color?: string
  /** 100-900. 400 is regular, 700 bold. */
  weight?: number
  italic?: boolean
  underline?: boolean
  /** Tracking in em. */
  letterSpacing?: number
}

export interface ParagraphInput {
  align?: 'left' | 'center' | 'right'
  runs: (TextStyleInput & { text: string })[]
}

export interface TextBoxInput {
  width?: number
  padding?: number
  background?: string
  opacity?: number
  radius?: number
  fullFrame?: boolean
}

export interface TransformInput {
  fit?: FitMode
  x?: number
  y?: number
  scale?: number
}

export interface FadeInput {
  duration: number
  color?: string
}

/** Clip properties settable on add and update. */
export interface ClipPropsInput {
  name?: string
  volume?: number
  muted?: boolean
  fadeIn?: FadeInput
  fadeOut?: FadeInput
  transform?: TransformInput
  /** Volume envelope: `t` in seconds from the clip start, linear gain. Empty clears it. */
  volumeKeys?: { t: number; gain: number }[]
}

export interface TextPropsInput {
  text?: string
  paragraphs?: ParagraphInput[]
  style?: TextStyleInput
  align?: 'left' | 'center' | 'right'
  box?: TextBoxInput
  knockout?: boolean
  lineHeight?: number
}

/** A track by id, or `main`, `new`, or a kind (its first track; `video` is the main track). */
export type TrackRef = string

export interface AddMediaParams extends ClipPropsInput {
  file: MediaFile
  track?: TrackRef
  start?: number
  inPoint?: number
  duration?: number
}

export interface AddTextParams extends ClipPropsInput, TextPropsInput {
  preset?: string
  track?: TrackRef
  start?: number
  duration?: number
}

export interface UpdateClipParams extends ClipPropsInput, TextPropsInput {
  id: string
  /** Slip: new source in-point, keeping the clip's place and length. */
  inPoint?: number
}

export interface ProjectSettingsInput {
  name?: string
  aspect?: AspectId
  tier?: TierId
  /** How visual media re-fits when the aspect changes. */
  fit?: FitMode
  fps?: number
  background?: string
  mediaFolder?: string | null
}

export interface TrackView {
  id: string
  kind: TrackKind
  name: string
  row: number
  main: boolean
  hidden: boolean
  duck?: DuckSettings
  clips: number
}

export interface ClipView {
  id: string
  track: string
  kind: string
  name: string
  source: string | null
  start: number
  end: number
  duration: number
  inPoint: number
  sourceDuration: number | null
  volume: number
  muted: boolean
  fadeIn: FadeInput
  fadeOut: FadeInput
  transform: Required<TransformInput>
  mediaSize?: [number, number]
  volumeKeys?: { t: number; gain: number }[]
  text?: {
    plain: string
    style: TextStyleInput & { align: string }
    box: Required<TextBoxInput>
    knockout: boolean
    lineHeight: number
  }
}

export interface ProjectView {
  id: string
  name: string
  mediaFolder: string | null
  settings: ProjectSettings
  duration: number
  tracks: TrackView[]
  clips: ClipView[]
  transitions: { id: string; from: string; to: string; duration: number }[]
}

export interface EditorStateView {
  screen: 'home' | 'editor'
  project: { id: string; name: string; duration: number; settings: ProjectSettings; mediaFolder: string | null; clips: number } | null
  time: number
  playing: boolean
  selection: string[]
  gpu: string
  engineError: string | null
  undo: string | null
  redo: string | null
}

export interface FrameImage {
  image: ArrayBuffer
  mime: string
  width: number
  height: number
  complete: boolean
}
