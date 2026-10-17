/**
 * Hidden, Node-enabled export window. Renders every frame with the same FrameRenderer as the
 * preview (on its own WebGPU device, so the editor stays responsive), converts to NV12 with a
 * compute shader, and writes the frames straight into FFmpeg's stdin for NVENC. No IPC hop for
 * the ~3 MB frames: this is what makes export NVENC-bound instead of transport-bound.
 */
import { decodePcm } from '@/engine/audio/decode-pcm'
import { FrameRenderer } from '@/engine/frame-renderer'
import { Compositor } from '@/engine/gpu/compositor'
import { NV12_WGSL } from '@/engine/gpu/shaders'
import { ffmpegArgs } from '@shared/ffmpeg-args'
import type { ExportEvent, ExportJob } from '@shared/ipc'
import type { Project } from '@shared/model'
import { compileSegments, mix, SAMPLE_RATE, type PcmSource } from '@shared/mixer'
import { audioPlan } from '@shared/render-plan'
import { frameToUs } from '@shared/time'

/* eslint-disable @typescript-eslint/no-explicit-any */
const nodeRequire = (window as unknown as { require: (id: string) => any }).require
const { ipcRenderer } = nodeRequire('electron')
const { spawn } = nodeRequire('node:child_process')
const fs = nodeRequire('node:fs')
const os = nodeRequire('node:os')
const nodePath = nodeRequire('node:path')

const emit = (e: ExportEvent) => ipcRenderer.send('export:event', e)
let cancelled = false
ipcRenderer.on('export:cancel', () => {
  cancelled = true
})

async function run(project: Project, job: ExportJob, ffmpeg: string): Promise<void> {
  const t0 = performance.now()
  const W = job.width
  const H = job.height

  // GPU + decoder pre-roll start immediately, overlapping audio decode/mix.
  const gpu = (async () => {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })
    if (!adapter) throw new Error('WebGPU unavailable')
    const device = await adapter.requestDevice()
    const renderer = new FrameRenderer(new Compositor(device, 'rgba8unorm'))
    renderer.playLookahead = 8
    renderer.textScale = 1
    renderer.setProject(project)
    renderer.prepare(0, true)
    return { device, renderer }
  })()

  // ---- Audio: decode sources, mix with the preview's mixer, write f32le for FFmpeg. ----
  emit({ type: 'progress', frame: 0, total: job.totalFrames, fps: 0, phase: 'audio' })
  const plan = audioPlan(project)
  const sources = new Map<string, PcmSource>()
  await Promise.all(
    [...new Set(plan.map((s) => s.source))].map(async (p) => {
      const pcm = await decodePcm(p)
      sources.set(p, { data: pcm.data, frames: pcm.frames })
    }),
  )
  const audioPath = nodePath.join(os.tmpdir(), `trailer-v-${Date.now()}-${Math.random().toString(36).slice(2)}.f32`)
  const fd = fs.openSync(audioPath, 'w')
  const segs = compileSegments(plan)
  const totalSamples = Math.ceil((frameToUs(job.totalFrames, job.fps) * SAMPLE_RATE) / 1e6)
  const L = new Float32Array(SAMPLE_RATE)
  const R = new Float32Array(SAMPLE_RATE)
  const inter = new Float32Array(SAMPLE_RATE * 2)
  for (let s = 0; s < totalSamples; s += SAMPLE_RATE) {
    const n = Math.min(SAMPLE_RATE, totalSamples - s)
    mix(L, R, s, n, segs, sources)
    for (let i = 0; i < n; i++) {
      inter[i * 2] = Math.max(-1, Math.min(1, L[i]))
      inter[i * 2 + 1] = Math.max(-1, Math.min(1, R[i]))
    }
    fs.writeSync(fd, new Uint8Array(inter.buffer, 0, n * 8))
  }
  fs.closeSync(fd)
  const tAudio = performance.now() - t0

  // ---- Encoder ----
  const proc = spawn(ffmpeg, ffmpegArgs(job, audioPath), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
  let stderr = ''
  proc.stderr.on('data', (d: Uint8Array) => {
    stderr = (stderr + String(d)).slice(-4000)
  })
  const exited = new Promise<number>((resolve) => {
    proc.on('error', (err: Error) => {
      stderr += `\n${err.message}`
      resolve(-1)
    })
    proc.on('close', (code: number) => resolve(code))
  })
  proc.stdin.on('error', () => {
    /* surfaced through the exit code */
  })

  const { device, renderer } = await gpu
  let changed: (() => void) | null = null
  renderer.onContentChanged = () => changed?.()

  const target = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING })
  const nv12Bytes = (W * H * 3) / 2
  // Storage-buffer binding offsets must be 256-byte aligned.
  const padded = Math.ceil(nv12Bytes / 256) * 256
  // Frames converted per readback. Each map is a round trip through Chromium's GPU process (whose
  // main thread also drives hardware decode), so batching cuts those round trips 4x.
  // Measured on an RTX 3060: >3 frames in flight starves Chromium's 4K hardware decoder (decoder
  // pictures stay busy until the GPU work sampling them completes), so 4K timelines use 1.
  const heavy = project.clips.some((c) => c.kind === 'video' && Math.max(c.mediaWidth, c.mediaHeight) > 2560)
  const BATCH = heavy ? 1 : 4
  // Readbacks in flight; deeper rings measurably starve the hardware decoder.
  const RING = 3
  const storage = device.createBuffer({ size: padded * BATCH, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code: NV12_WGSL(W, H) }), entryPoint: 'main' } })
  const binds = Array.from({ length: BATCH }, (_, b) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: target.createView() }, { binding: 1, resource: { buffer: storage, offset: b * padded, size: nv12Bytes } }],
    }),
  )
  interface Slot {
    buffer: GPUBuffer
    mapped: Promise<void>
    /** Resolves once FFmpeg's pipe has taken the bytes and the buffer is unmapped again. */
    written: Promise<void>
    count: number
  }
  const slots: Slot[] = Array.from({ length: RING }, () => ({
    buffer: device.createBuffer({ size: padded * BATCH, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }),
    mapped: Promise.resolve(),
    written: Promise.resolve(),
    count: 0,
  }))
  const pending: Slot[] = []
  const words = (W * H) / 4 + (H / 2) * (W / 4)
  const timing = { content: 0, map: 0, write: 0, retries: 0 }

  // Zero-copy: the pipe writes straight from the mapped readback memory; the slot is unmapped
  // (and reusable) only after its last frame has been written.
  const flushOne = async () => {
    const s = pending.shift()!
    const t = performance.now()
    await s.mapped
    timing.map += performance.now() - t
    const range = s.buffer.getMappedRange(0, padded * s.count)
    s.written = new Promise<void>((resolve) => {
      for (let k = 0; k < s.count; k++) {
        const last = k === s.count - 1
        proc.stdin.write(new Uint8Array(range, k * padded, nv12Bytes), last ? () => {
          s.buffer.unmap()
          resolve()
        } : undefined)
      }
    })
  }

  let lastReport = 0
  let inBatch = 0
  let batches = 0
  for (let i = 0; i < job.totalFrames && !cancelled; i++) {
    const t = frameToUs(i, job.fps)
    const tc = performance.now()
    const deadline = tc + 15_000
    for (;;) {
      renderer.prepare(t, true)
      if (renderer.draw(t, target).complete || performance.now() > deadline) break
      timing.retries++
      await new Promise<void>((r) => {
        changed = r
        setTimeout(r, 20)
      })
      changed = null
    }
    timing.content += performance.now() - tc
    const enc = device.createCommandEncoder()
    const pass = enc.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, binds[inBatch])
    pass.dispatchWorkgroups(Math.ceil(words / 64))
    pass.end()
    inBatch++
    if (inBatch === BATCH || i === job.totalFrames - 1) {
      if (pending.length >= RING) await flushOne()
      const slot = slots[batches++ % RING]
      const tw = performance.now()
      await slot.written
      timing.write += performance.now() - tw
      enc.copyBufferToBuffer(storage, 0, slot.buffer, 0, padded * inBatch)
      device.queue.submit([enc.finish()])
      slot.count = inBatch
      slot.mapped = slot.buffer.mapAsync(GPUMapMode.READ, 0, padded * inBatch)
      pending.push(slot)
      inBatch = 0
    } else {
      device.queue.submit([enc.finish()])
    }
    const now = performance.now()
    if (now - lastReport > 120 || i === job.totalFrames - 1) {
      lastReport = now
      emit({ type: 'progress', frame: i + 1, total: job.totalFrames, fps: (i + 1) / ((now - t0) / 1000), phase: 'video' })
    }
  }
  while (pending.length && !cancelled) await flushOne()
  await Promise.all(slots.map((s) => s.written))
  renderer.dispose()

  if (cancelled) {
    proc.kill()
    await exited
    fs.rmSync(job.outputPath, { force: true })
    fs.rmSync(audioPath, { force: true })
    emit({ type: 'cancelled' })
    return
  }
  proc.stdin.end()
  const code = await exited
  fs.rmSync(audioPath, { force: true })
  const f = (v: number) => `${Math.round(v)}ms`
  emit({ type: 'log', message: `audio ${f(tAudio)}, total ${f(performance.now() - t0)}; waits: content ${f(timing.content)} (${timing.retries}), gpu map ${f(timing.map)}, pipe ${f(timing.write)}` })
  if (code !== 0) throw new Error(stderr.trim() || `FFmpeg exited with code ${code}`)
  emit({ type: 'done', size: fs.statSync(job.outputPath).size, seconds: (performance.now() - t0) / 1000 })
  device.destroy()
}

ipcRenderer.once('export:job', (_e: unknown, msg: { project: Project; job: ExportJob; ffmpeg: string }) => {
  run(msg.project, msg.job, msg.ffmpeg).catch((err) => emit({ type: 'error', message: String((err as Error)?.message ?? err) }))
})
ipcRenderer.send('export:window-ready')
