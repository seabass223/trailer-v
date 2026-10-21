import type { Project } from '@shared/model'

export type PreviewQuality = 'auto' | 'full' | 'half'

export type EngineInbound =
  | { type: 'init'; canvas: OffscreenCanvas; clock: Int32Array; stats: Float64Array }
  | { type: 'project'; project: Project }
  | { type: 'resize'; width: number; height: number }
  | { type: 'quality'; quality: PreviewQuality }
  /** Paused render request; the latest one wins. */
  | { type: 'seek'; time: number }
  | { type: 'play' }
  | { type: 'pause' }
  /** Fill decoder buffers at the playhead, then answer 'prerolled' (playback starts smoothly). */
  | { type: 'preroll'; id: number }
  /** Hide one text clip while it's edited inline over the preview. */
  | { type: 'hide-clip'; clipId: string | null }
  /** Render one frame off-screen (posters, MCP snapshots). Width defaults to 480. */
  | { type: 'poster'; time: number; id: number; width?: number; mime?: 'image/jpeg' | 'image/png'; quality?: number }
  /** Debug: log decoder state. */
  | { type: 'describe' }
  /** Verbose decoder/drop logging (on while the perf HUD is open). */
  | { type: 'debug'; on: boolean }

export type EngineOutbound =
  | { type: 'ready'; adapter: string }
  | { type: 'error'; message: string }
  | { type: 'poster'; id: number; image: ArrayBuffer | null; width: number; height: number; complete: boolean }
  | { type: 'log'; message: string }
  | { type: 'prerolled'; id: number }

export type MediaRequest =
  | { type: 'probe'; path: string; kind: 'video' | 'audio' | 'image' }
  | { type: 'poster'; path: string; kind: 'video' | 'image'; width: number }
  | { type: 'filmstrip'; path: string; count: number; height: number }
  | { type: 'pcm'; path: string }

export interface FilmstripResult {
  sprite: Blob
  /** Source timestamps (µs) of each tile, left to right. */
  times: number[]
  tileWidth: number
  tileHeight: number
}

export interface PcmResult {
  data: Int16Array
  frames: number
  /** Waveform peaks: max |sample| per 10 ms bucket, 0..255. */
  peaks: Uint8Array
}
