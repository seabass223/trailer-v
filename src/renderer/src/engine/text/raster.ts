import type { TextData, Transform } from '@shared/model'
import type { Rect } from '../gpu/compositor'
import { cssFont, layoutText, type TextLayout } from './layout'

export interface TextRaster {
  canvas: OffscreenCanvas
  /** Placement in logical project pixels. */
  rect: Rect
  layout: TextLayout
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, Math.max(0, Math.min(r, w / 2, h / 2)))
  ctx.fill()
}

export function rgba(hex: string, alpha: number): string {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h.slice(0, 6), 16)
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

/** Short side of the frame in reference units: 1080 reference px. */
export const unitFor = (W: number, H: number): number => Math.min(W, H) / 1080

/**
 * Rasterize a text clip. `scale` = render pixels per logical project pixel (preview < 1,
 * export = 1), so preview text is drawn crisp at its on-screen size.
 */
export function rasterizeText(text: TextData, transform: Transform, W: number, H: number, scale: number): TextRaster {
  const s = Math.max(0.05, transform.scale)
  const r = scale * s
  const u = unitFor(W, H) * r
  const boxW = Math.max(8, Math.round(text.box.width * W * r))
  const pad = text.box.padding * u
  const measureCanvas = new OffscreenCanvas(8, 8)
  const mctx = measureCanvas.getContext('2d')!
  const layout = layoutText(mctx, text, Math.max(8, boxW - pad * 2), u)
  const boxH = Math.max(8, Math.ceil(layout.height + pad * 2))

  const cx = W / 2 + transform.x * W
  const cy = H / 2 + transform.y * H
  const fullFrame = text.knockout && text.box.fullFrame
  const cw = fullFrame ? Math.round(W * scale) : boxW
  const ch = fullFrame ? Math.round(H * scale) : boxH
  const canvas = new OffscreenCanvas(cw, ch)
  const ctx = canvas.getContext('2d')!
  // Box origin inside the canvas.
  const ox = fullFrame ? cx * scale - boxW / 2 : 0
  const oy = fullFrame ? cy * scale - boxH / 2 : 0
  const radius = text.box.radius * u

  if (text.knockout) {
    ctx.fillStyle = rgba(text.box.background, text.box.backgroundOpacity)
    if (fullFrame) ctx.fillRect(0, 0, cw, ch)
    else roundRect(ctx, 0, 0, boxW, boxH, radius)
    ctx.globalCompositeOperation = 'destination-out'
  } else if (text.box.backgroundOpacity > 0) {
    ctx.fillStyle = rgba(text.box.background, text.box.backgroundOpacity)
    roundRect(ctx, 0, 0, boxW, boxH, radius)
  }

  const contentW = boxW - pad * 2
  ctx.textBaseline = 'alphabetic'
  for (const line of layout.lines) {
    const free = contentW - line.width
    const lx = ox + pad + (line.align === 'right' ? free : line.align === 'center' ? free / 2 : 0)
    const baseline = oy + pad + line.y + (line.height - (line.ascent + line.descent)) / 2 + line.ascent
    for (const p of line.pieces) {
      if (p.space && !p.style.underline && !p.style.strike) continue
      ctx.font = cssFont(p.style, u)
      ctx.letterSpacing = `${p.style.letterSpacing * u}px`
      ctx.fillStyle = text.knockout ? '#000' : p.style.color
      if (!p.space) ctx.fillText(p.text, lx + p.x, baseline)
      const size = p.style.fontSize * u
      if (p.style.underline) ctx.fillRect(lx + p.x, baseline + size * 0.09, p.width, Math.max(1, size * 0.06))
      if (p.style.strike) ctx.fillRect(lx + p.x, baseline - size * 0.3, p.width, Math.max(1, size * 0.06))
    }
  }
  ctx.globalCompositeOperation = 'source-over'

  const lw = boxW / scale
  const lh = boxH / scale
  const rect: Rect = fullFrame ? [0, 0, W, H] : [cx - lw / 2, cy - lh / 2, cx + lw / 2, cy + lh / 2]
  return { canvas, rect, layout }
}

/** Logical box rect of a text clip (for on-preview handles), without rasterizing glyphs. */
export function textBoxRect(text: TextData, transform: Transform, W: number, H: number): Rect {
  const s = Math.max(0.05, transform.scale)
  const u = unitFor(W, H) * s
  const boxW = text.box.width * W * s
  const pad = text.box.padding * u
  const mctx = new OffscreenCanvas(8, 8).getContext('2d')!
  const layout = layoutText(mctx, text, Math.max(8, boxW - pad * 2), u)
  const boxH = layout.height + pad * 2
  const cx = W / 2 + transform.x * W
  const cy = H / 2 + transform.y * H
  return [cx - boxW / 2, cy - boxH / 2, cx + boxW / 2, cy + boxH / 2]
}
