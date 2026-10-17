/**
 * WebGPU compositor. Draws are expressed in logical project pixels, so the same draw list
 * renders a small preview canvas or a full-resolution export target.
 * Video frames are sampled zero-copy via importExternalTexture.
 */
import { QUAD_WGSL, TEX_WGSL } from './shaders'

export type Rect = [left: number, top: number, right: number, bottom: number]
export type RGBA = [number, number, number, number]

export type Draw =
  | { kind: 'solid'; rect: Rect; color: RGBA; opacity: number }
  | { kind: 'video'; frame: VideoFrame; rect: Rect; opacity: number }
  | { kind: 'texture'; texture: GPUTexture; rect: Rect; opacity: number }

export interface FrameDraws {
  background: RGBA
  /** Main-track layers; each composited over the background, then mixed by `mix[i]`. */
  base: Draw[][]
  mix: number[]
  /** Dip-to-colour and overlays, bottom to top. */
  top: Draw[]
}

const SLOT = 256
const SLOTS = 512
const FLOATS_PER_SLOT = SLOT / 4

export function hexToRgba(hex: string, alpha = 1): RGBA {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha]
}

export class Compositor {
  readonly device: GPUDevice
  readonly format: GPUTextureFormat
  private sampler: GPUSampler
  private uniLayout: GPUBindGroupLayout
  private extLayout: GPUBindGroupLayout
  private texLayout: GPUBindGroupLayout
  private emptyGroup: GPUBindGroup
  private uniGroup: GPUBindGroup
  private uniBuffer: GPUBuffer
  private uniData = new Float32Array(SLOTS * FLOATS_PER_SLOT)
  private slot = 0
  private extPipeline: GPURenderPipeline
  private texPipeline: GPURenderPipeline
  private solidPipeline: GPURenderPipeline
  private intermediates: GPUTexture[] = []
  private texGroups = new WeakMap<GPUTexture, GPUBindGroup>()
  logicalWidth = 1920
  logicalHeight = 1080

  constructor(device: GPUDevice, format: GPUTextureFormat) {
    this.device = device
    this.format = format
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' })
    this.uniBuffer = device.createBuffer({ size: SLOT * SLOTS, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.uniLayout = device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: 48 } }],
    })
    this.extLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
      ],
    })
    this.texLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
      ],
    })
    const emptyLayout = device.createBindGroupLayout({ entries: [] })
    this.emptyGroup = device.createBindGroup({ layout: emptyLayout, entries: [] })
    this.uniGroup = device.createBindGroup({ layout: this.uniLayout, entries: [{ binding: 0, resource: { buffer: this.uniBuffer, size: 48 } }] })

    const blend: GPUBlendState = {
      color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    }
    const quad = device.createShaderModule({ code: QUAD_WGSL })
    const tex = device.createShaderModule({ code: TEX_WGSL })
    const make = (module: GPUShaderModule, fs: string, group0: GPUBindGroupLayout) =>
      device.createRenderPipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [group0, this.uniLayout] }),
        vertex: { module, entryPoint: 'vs' },
        fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
        primitive: { topology: 'triangle-strip' },
      })
    this.extPipeline = make(quad, 'fsExt', this.extLayout)
    this.texPipeline = make(tex, 'fsTex', this.texLayout)
    this.solidPipeline = make(tex, 'fsSolid', emptyLayout)
  }

  setLogicalSize(w: number, h: number): void {
    this.logicalWidth = w
    this.logicalHeight = h
  }

  private intermediate(i: number, w: number, h: number): GPUTexture {
    const t = this.intermediates[i]
    if (t && t.width === w && t.height === h) return t
    t?.destroy()
    const next = this.device.createTexture({
      size: [w, h],
      format: this.format,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.intermediates[i] = next
    return next
  }

  private writeSlot(rect: Rect, color: RGBA, opacity: number, sx: number, sy: number): number {
    if (this.slot >= SLOTS) throw new Error('Too many draws in one frame')
    const W = this.logicalWidth
    const H = this.logicalHeight
    const o = this.slot * FLOATS_PER_SLOT
    const d = this.uniData
    d[o] = (rect[0] / W) * 2 - 1
    d[o + 1] = 1 - (rect[1] / H) * 2
    d[o + 2] = (rect[2] / W) * 2 - 1
    d[o + 3] = 1 - (rect[3] / H) * 2
    d.set(color, o + 4)
    d[o + 8] = opacity
    d[o + 9] = sx
    d[o + 10] = sy
    return this.slot++ * SLOT
  }

  private texGroup(texture: GPUTexture): GPUBindGroup {
    let g = this.texGroups.get(texture)
    if (!g) {
      g = this.device.createBindGroup({
        layout: this.texLayout,
        entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: texture.createView() }],
      })
      this.texGroups.set(texture, g)
    }
    return g
  }

  /** Pre-pass: allocate uniform slots and bind groups (external textures expire each task). */
  private prepare(draws: Draw[], targetW: number): (pass: GPURenderPassEncoder) => void {
    const ops: ((pass: GPURenderPassEncoder) => void)[] = []
    const pxScale = targetW / this.logicalWidth
    for (const dr of draws) {
      if (dr.opacity <= 0.001) continue
      if (dr.kind === 'solid') {
        const off = this.writeSlot(dr.rect, dr.color, dr.opacity, 0, 0)
        ops.push((p) => {
          p.setPipeline(this.solidPipeline)
          p.setBindGroup(0, this.emptyGroup)
          p.setBindGroup(1, this.uniGroup, [off])
          p.draw(4)
        })
      } else if (dr.kind === 'video') {
        const drawnW = (dr.rect[2] - dr.rect[0]) * pxScale
        const drawnH = (dr.rect[3] - dr.rect[1]) * pxScale
        const ratio = dr.frame.displayWidth / Math.max(1, drawnW)
        const multi = ratio > 1.5
        const off = this.writeSlot(dr.rect, [0, 0, 0, 0], dr.opacity, multi ? 1 / drawnW : 0, multi ? 1 / drawnH : 0)
        const ext = this.device.importExternalTexture({ source: dr.frame })
        const group = this.device.createBindGroup({
          layout: this.extLayout,
          entries: [{ binding: 0, resource: this.sampler }, { binding: 1, resource: ext }],
        })
        ops.push((p) => {
          p.setPipeline(this.extPipeline)
          p.setBindGroup(0, group)
          p.setBindGroup(1, this.uniGroup, [off])
          p.draw(4)
        })
      } else {
        const off = this.writeSlot(dr.rect, [0, 0, 0, 0], dr.opacity, 0, 0)
        const group = this.texGroup(dr.texture)
        ops.push((p) => {
          p.setPipeline(this.texPipeline)
          p.setBindGroup(0, group)
          p.setBindGroup(1, this.uniGroup, [off])
          p.draw(4)
        })
      }
    }
    return (pass) => {
      for (const op of ops) op(pass)
    }
  }

  /** Render a frame into `target` (canvas texture or export texture). */
  render(target: GPUTexture, frame: FrameDraws): void {
    this.slot = 0
    const W = target.width
    const H = target.height
    const full: Rect = [0, 0, this.logicalWidth, this.logicalHeight]
    const [br, bg, bb] = frame.background
    const clear: GPUColor = { r: br, g: bg, b: bb, a: 1 }
    const encoder = this.device.createCommandEncoder()

    const mainDraws: Draw[] = []
    if (frame.base.length <= 1) {
      mainDraws.push(...(frame.base[0] ?? []))
    } else {
      // True cross-dissolve: each side over the background on its own, then mixed.
      frame.base.forEach((draws, i) => {
        const tex = this.intermediate(i, W, H)
        const run = this.prepare(draws, W)
        const pass = encoder.beginRenderPass({
          colorAttachments: [{ view: tex.createView(), loadOp: 'clear', storeOp: 'store', clearValue: clear }],
        })
        run(pass)
        pass.end()
        mainDraws.push({ kind: 'texture', texture: tex, rect: full, opacity: i === 0 ? 1 : frame.mix[i] })
      })
    }
    mainDraws.push(...frame.top)
    const run = this.prepare(mainDraws, W)
    if (this.slot > 0) this.device.queue.writeBuffer(this.uniBuffer, 0, this.uniData, 0, this.slot * FLOATS_PER_SLOT)
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: clear }],
    })
    run(pass)
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  /** Upload an ImageBitmap (premultiplied) as a sampled texture. */
  uploadBitmap(bitmap: ImageBitmap | OffscreenCanvas): GPUTexture {
    const texture = this.device.createTexture({
      size: [bitmap.width, bitmap.height],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture({ source: bitmap }, { texture, premultipliedAlpha: true }, [bitmap.width, bitmap.height])
    return texture
  }

  destroy(): void {
    for (const t of this.intermediates) t.destroy()
    this.uniBuffer.destroy()
  }
}
