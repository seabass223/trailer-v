import type { Clip, MediaKind, Project, ProjectSettings, RichNode, TextData, Track, TrackKind } from './model'
import { DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION } from './presets'

export const uid = (): string => crypto.randomUUID().replace(/-/g, '').slice(0, 12)

export const TRACK_LABELS: Record<TrackKind, string> = {
  video: 'Video',
  text: 'Text',
  image: 'Image',
  audio: 'Audio',
}

export function newTrack(kind: TrackKind, name = TRACK_LABELS[kind]): Track {
  return { id: uid(), kind, name, hidden: false }
}

export function newProject(name: string, settings: ProjectSettings, mediaFolder: string | null): Project {
  const now = Date.now()
  return {
    version: 1,
    id: uid(),
    name,
    created: now,
    updated: now,
    mediaFolder,
    settings,
    // Row order follows the inspiration layout; compositing order is video < image < text.
    tracks: [newTrack('video'), newTrack('text'), newTrack('image'), newTrack('audio')],
    clips: [],
    transitions: [],
  }
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
}

export function textDoc(text: string, style: Partial<TextStyle> = {}): RichNode {
  const s: TextStyle = {
    fontFamily: 'Segoe UI',
    fontSize: 96,
    color: '#ffffff',
    bold: true,
    italic: false,
    align: 'center',
    ...style,
  }
  const marks: NonNullable<RichNode['marks']> = [
    { type: 'textStyle', attrs: { fontFamily: s.fontFamily, fontSize: `${s.fontSize}px`, color: s.color } },
  ]
  if (s.bold) marks.push({ type: 'bold' })
  if (s.italic) marks.push({ type: 'italic' })
  return {
    type: 'doc',
    content: text.split(/\r?\n/).map((line) => ({
      type: 'paragraph',
      attrs: { textAlign: s.align },
      content: line ? [{ type: 'text', text: line, marks }] : undefined,
    })),
  }
}

export interface TextPreset {
  id: string
  name: string
  text: TextData
  y: number
}

export const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'title',
    name: 'Title',
    y: 0,
    text: {
      doc: textDoc('A Brighter Tomorrow', { fontSize: 120 }),
      box: { width: 0.8, padding: 24, background: '#000000', backgroundOpacity: 0, radius: 0, fullFrame: false },
      knockout: false,
    },
  },
  {
    id: 'subtitle',
    name: 'Subtitle',
    y: 0.36,
    text: {
      doc: textDoc('Subtitle text', { fontSize: 56, bold: false }),
      box: { width: 0.7, padding: 16, background: '#000000', backgroundOpacity: 0.55, radius: 12, fullFrame: false },
      knockout: false,
    },
  },
  {
    id: 'lower-third',
    name: 'Lower third',
    y: 0.3,
    text: {
      doc: textDoc('Name Surname\nTitle or role', { fontSize: 52, align: 'left' }),
      box: { width: 0.42, padding: 28, background: '#3b82f6', backgroundOpacity: 0.92, radius: 10, fullFrame: false },
      knockout: false,
    },
  },
  {
    id: 'knockout',
    name: 'Knockout title',
    y: 0,
    text: {
      doc: textDoc('COMING SOON', { fontSize: 220, fontFamily: 'Impact', bold: false }),
      box: { width: 1, padding: 0, background: '#000000', backgroundOpacity: 1, radius: 0, fullFrame: true },
      knockout: true,
    },
  },
]

export function trackKindFor(kind: MediaKind): TrackKind {
  return kind
}

/** Which track kinds accept which media. The main video track also takes stills. */
export function trackAccepts(track: TrackKind, media: MediaKind): boolean {
  if (track === 'video') return media === 'video' || media === 'image'
  return track === media
}

export function baseClip(partial: Partial<Clip> & Pick<Clip, 'kind' | 'name' | 'trackId'>): Clip {
  return {
    id: uid(),
    source: null,
    start: 0,
    duration: partial.kind === 'text' ? DEFAULT_TEXT_DURATION : DEFAULT_IMAGE_DURATION,
    inPoint: 0,
    sourceDuration: null,
    volume: 1,
    fadeIn: { duration: 0, color: '#000000' },
    fadeOut: { duration: 0, color: '#000000' },
    transform: { fit: 'contain', x: 0, y: 0, scale: 1 },
    mediaWidth: 0,
    mediaHeight: 0,
    hasAudio: false,
    ...partial,
  }
}
