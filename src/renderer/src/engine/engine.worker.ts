/// <reference lib="webworker" />
/**
 * Preview engine. Owns the preview canvas (OffscreenCanvas), the WebGPU device and every
 * decoder. Runs its own rAF loop driven by the shared audio clock, so React work on the UI
 * thread can never drop a frame.
 */
import type { Project } from '@shared/model'
import { clockTimeUs, CLOCK, isPlaying, STATS } from './clock'
import { Compositor } from './gpu/compositor'
import { FrameRenderer } from './frame-renderer'
import type { EngineInbound, EngineOutbound, PreviewQuality } from './protocol'

const post = (m: EngineOutbound, transfer: Transferable[] = []) => (self as DedicatedWorkerGlobalScope).postMessage(m, transfer)

let canvas: OffscreenCanvas
let ctx: GPUCanvasContext
let device: GPUDevice
let renderer: FrameRenderer
let clock: Int32Array
let stats: Float64Array
let project: Project | null = null
let quality: PreviewQuality = 'auto'
let cssW = 960
let cssH = 540
let dirty = true
let lastRenderedTime = -1
let lastSeekGen = -1
let wasPlaying = false
let debug = false
let preroll: { id: number; until: number } | null = null
// Stats
let frameCount = 0
let dropped = 0
let statsT0 = performance.now()
let renderMsAcc = 0

/** Size the canvas backing store: on-screen pixels, capped at project resolution. */
function applySize(): void {
  if (!project) return
  const { width: W, height: H } = project.settings
  let scale: number
  if (quality === 'full') scale = 1
  else {
    scale = Math.min(1, Math.max(cssW / W, cssH / H))
    if (quality === 'half') scale = Math.min(scale, 0.5)
  }
  const w = Math.max(2, Math.round(W * scale))
  const h = Math.max(2, Math.round(H * scale))
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w
    canvas.height = h
  }
  renderer.textScale = w / W
  dirty = true
}

function frameDuration(): number {
  return project ? 1_000_000 / project.settings.fps : 33_333
}

function tick(): void {
  requestAnimationFrame(tick)
  if (!project) return
  const playing = isPlaying(clock)
  const seekGen = Atomics.load(clock, CLOCK.SEEK_GEN)
  // Snap to the project frame grid: identical frame selection to export.
  const fd = frameDuration()
  const t = Math.floor(clockTimeUs(clock) / fd + 1e-6) * fd

  renderer.prepare(t, playing || !!preroll)
  if (preroll && (renderer.buffered(t, 4) || performance.now() > preroll.until)) {
    post({ type: 'prerolled', id: preroll.id })
    preroll = null
  }
  const moved = t !== lastRenderedTime || seekGen !== lastSeekGen
  if (!moved && !dirty && !(playing !== wasPlaying)) return

  const t0 = performance.now()
  const res = renderer.draw(t, ctx.getCurrentTexture())
  renderMsAcc += performance.now() - t0
  frameCount++
  if (playing && res.stale && moved && wasPlaying) {
    dropped++
    if (debug) post({ type: 'log', message: `drop #${dropped} t=${Math.round(t / 1000)}ms ${renderer.describe()}` })
  }
  // Keep re-rendering while paused until the exact frame has arrived.
  dirty = !res.complete
  stats[STATS.COMPLETE] = res.complete ? 1 : 0
  lastRenderedTime = t
  lastSeekGen = seekGen
  wasPlaying = playing

  const now = performance.now()
  if (now - statsT0 >= 500) {
    stats[STATS.FPS] = (frameCount * 1000) / (now - statsT0)
    stats[STATS.RENDER_MS] = renderMsAcc / Math.max(1, frameCount)
    stats[STATS.DROPPED] = dropped
    stats[STATS.DECODERS] = renderer.decoders()
    stats[STATS.FRAMES_HELD] = renderer.framesHeld()
    frameCount = 0
    renderMsAcc = 0
    statsT0 = now
  }
}

async function init(msg: Extract<EngineInbound, { type: 'init' }>): Promise<void> {
  canvas = msg.canvas
  clock = msg.clock
  stats = msg.stats
  const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw new Error('WebGPU is not available on this GPU/driver')
  device = await adapter.requestDevice()
  device.lost.then((info) => post({ type: 'error', message: `GPU device lost: ${info.message}` }))
  ctx = canvas.getContext('webgpu')!
  const format = navigator.gpu.getPreferredCanvasFormat()
  ctx.configure({ device, format, alphaMode: 'opaque' })
  renderer = new FrameRenderer(new Compositor(device, format))
  renderer.onContentChanged = () => (dirty = true)
  renderer.onLog = (message) => debug && post({ type: 'log', message })
  // Project/size messages can arrive while the GPU is still initialising: apply them now.
  if (project) renderer.setProject(project)
  applySize()
  post({ type: 'ready', adapter: `${adapter.info.vendor} ${adapter.info.architecture}`.trim() })
  requestAnimationFrame(tick)
}

/**
 * Off-screen frame: project thumbnails and MCP snapshots. Uses its own short-lived renderer +
 * decoders so it never disturbs the preview's decoders (a poster seek mid-playback would cause
 * visible catch-up drops).
 */
async function poster(msg: Extract<EngineInbound, { type: 'poster' }>): Promise<void> {
  const { time, id } = msg
  if (!project || isPlaying(clock)) return post({ type: 'poster', id, image: null, width: 0, height: 0, complete: false })
  const S = project.settings
  // Even sizes, never larger than the project frame.
  const W = Math.max(16, Math.min(S.width, Math.round((msg.width ?? 480) / 2) * 2))
  const H = Math.max(2, Math.round((W * S.height) / S.width / 2) * 2)
  const off = new OffscreenCanvas(W, H)
  const pctx = off.getContext('webgpu')!
  pctx.configure({ device, format: renderer.compositor.format, alphaMode: 'opaque' })
  const r = new FrameRenderer(new Compositor(device, renderer.compositor.format))
  try {
    r.textScale = W / S.width
    r.setProject(project)
    // Big snapshots may wait on a cold decoder for longer than a thumbnail would.
    const until = performance.now() + (W > 480 ? 8000 : 2000)
    let complete = false
    while (!complete) {
      r.prepare(time, false)
      complete = r.draw(time, pctx.getCurrentTexture()).complete
      if (complete || performance.now() > until) break
      await new Promise((res) => setTimeout(res, 25))
    }
    await device.queue.onSubmittedWorkDone()
    const mime = msg.mime ?? 'image/jpeg'
    const blob = await off.convertToBlob(mime === 'image/png' ? { type: mime } : { type: mime, quality: msg.quality ?? 0.82 })
    const buf = await blob.arrayBuffer()
    post({ type: 'poster', id, image: buf, width: W, height: H, complete }, [buf])
  } finally {
    r.dispose()
    r.compositor.destroy()
  }
}

self.onmessage = (e: MessageEvent<EngineInbound>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'init':
        void init(msg).catch((err) => post({ type: 'error', message: String(err?.message ?? err) }))
        break
      case 'project':
        project = msg.project
        renderer?.setProject(project)
        if (renderer) applySize()
        dirty = true
        break
      case 'resize':
        cssW = msg.width
        cssH = msg.height
        if (renderer) applySize()
        break
      case 'quality':
        quality = msg.quality
        if (renderer) applySize()
        break
      case 'hide-clip':
        if (renderer) renderer.hiddenClip = msg.clipId
        dirty = true
        break
      case 'play':
      case 'pause':
        if (debug) post({ type: 'log', message: `${msg.type} at ${Math.round(clockTimeUs(clock) / 1000)}ms` })
        dirty = true
        break
      case 'seek':
        dirty = true
        break
      case 'poster':
        void poster(msg)
        break
      case 'preroll':
        // Buffer a few frames per visible clip (GPU may be ramping up from idle), max 300 ms.
        preroll = { id: msg.id, until: performance.now() + 300 }
        break
      case 'debug':
        debug = msg.on
        break
      case 'describe':
        post({ type: 'log', message: `t=${Math.round(clockTimeUs(clock) / 1000)}ms canvas=${canvas.width}x${canvas.height} clips=${project?.clips.length ?? 0} ${renderer?.describe() ?? 'no renderer'}` })
        break
    }
  } catch (err) {
    post({ type: 'error', message: String((err as Error)?.message ?? err) })
  }
}
