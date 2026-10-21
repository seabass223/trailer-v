/**
 * Rich-text layout for TipTap/ProseMirror JSON on a 2D canvas context. Runs in workers
 * (OffscreenCanvas resolves installed system fonts by family name).
 * Units: 1 reference unit = 1px at a 1080px short side; `unit` scales to the target.
 */
import type { RichNode, TextData } from '@shared/model'

export interface RunStyle {
  fontFamily: string
  fontSize: number
  color: string
  /** CSS font weight, 100–950. */
  weight: number
  italic: boolean
  underline: boolean
  strike: boolean
  letterSpacing: number
}

export interface Piece {
  text: string
  style: RunStyle
  width: number
  x: number
  /** Trailing whitespace is skipped when measuring line ends. */
  space: boolean
}

export interface Line {
  pieces: Piece[]
  width: number
  ascent: number
  descent: number
  height: number
  y: number
  align: 'left' | 'center' | 'right' | 'justify'
}

export interface TextLayout {
  lines: Line[]
  width: number
  height: number
}

export const DEFAULT_STYLE: RunStyle = {
  fontFamily: 'Segoe UI',
  fontSize: 96,
  color: '#ffffff',
  weight: 400,
  italic: false,
  underline: false,
  strike: false,
  letterSpacing: 0,
}

export function cssFont(s: RunStyle, unit: number): string {
  return `${s.italic ? 'italic ' : ''}${s.weight} ${Math.max(1, s.fontSize * unit)}px "${s.fontFamily}", "Segoe UI", sans-serif`
}

function px(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') {
    const n = parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

/** Letter spacing in reference units: `em` values scale with the font size. */
function spacing(v: unknown, fontSize: number): number {
  if (typeof v === 'string' && v.trim().endsWith('em')) return (parseFloat(v) || 0) * fontSize
  return px(v, 0)
}

/** CSS `bolder`: the bold mark renders as <strong> inside the textStyle span. */
const bolder = (w: number): number => (w < 350 ? 400 : w < 550 ? 700 : Math.max(900, w))

export function styleFrom(marks: RichNode['marks']): RunStyle {
  const s = { ...DEFAULT_STYLE }
  let bold = false
  let weight: number | null = null
  let letterSpacing: unknown = null
  for (const m of marks ?? []) {
    switch (m.type) {
      case 'bold':
        bold = true
        break
      case 'italic':
        s.italic = true
        break
      case 'underline':
        s.underline = true
        break
      case 'strike':
        s.strike = true
        break
      case 'textStyle': {
        const a = m.attrs ?? {}
        if (typeof a.fontFamily === 'string' && a.fontFamily) s.fontFamily = a.fontFamily.replace(/["']/g, '').split(',')[0].trim()
        if (a.fontSize) s.fontSize = px(a.fontSize, s.fontSize)
        if (typeof a.color === 'string' && a.color) s.color = a.color
        if (a.fontWeight) weight = px(a.fontWeight, 400)
        if (a.letterSpacing) letterSpacing = a.letterSpacing
        break
      }
    }
  }
  s.weight = bold ? bolder(weight ?? 400) : weight ?? 400
  s.letterSpacing = spacing(letterSpacing, s.fontSize)
  return s
}

interface Para {
  align: Line['align']
  runs: { text: string; style: RunStyle }[]
}

export function paragraphs(doc: RichNode): Para[] {
  const out: Para[] = []
  for (const block of doc.content ?? []) {
    if (block.type !== 'paragraph' && block.type !== 'heading') continue
    const align = (block.attrs?.textAlign as Para['align']) ?? 'center'
    const runs: Para['runs'] = []
    for (const n of block.content ?? []) {
      if (n.type === 'text' && n.text) runs.push({ text: n.text, style: styleFrom(n.marks) })
      else if (n.type === 'hardBreak') {
        out.push({ align, runs: runs.splice(0) })
      }
    }
    out.push({ align, runs })
  }
  return out.length ? out : [{ align: 'center', runs: [] }]
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null

function words(text: string): string[] {
  if (!segmenter) return text.split(/(\s+)/).filter(Boolean)
  return Array.from(segmenter.segment(text), (s) => s.segment)
}

type Ctx = OffscreenCanvasRenderingContext2D

function measure(ctx: Ctx, text: string, style: RunStyle, unit: number): number {
  ctx.font = cssFont(style, unit)
  ctx.letterSpacing = `${style.letterSpacing * unit}px`
  return ctx.measureText(text).width
}

function metrics(ctx: Ctx, style: RunStyle, unit: number): { ascent: number; descent: number } {
  ctx.font = cssFont(style, unit)
  const m = ctx.measureText('Hg')
  const size = style.fontSize * unit
  return { ascent: m.fontBoundingBoxAscent || size * 0.8, descent: m.fontBoundingBoxDescent || size * 0.2 }
}

/** Greedy line breaking across styled runs; breaks overlong words by grapheme. */
export function layoutText(ctx: Ctx, text: TextData, maxWidth: number, unit: number): TextLayout {
  const lineHeight = text.lineHeight ?? 1.15
  const lines: Line[] = []
  let y = 0
  for (const para of paragraphs(text.doc)) {
    let line: Line = { pieces: [], width: 0, ascent: 0, descent: 0, height: 0, y: 0, align: para.align }
    const flush = (emptyStyle?: RunStyle) => {
      // Drop trailing whitespace from the measured width.
      let w = 0
      let last = line.pieces.length - 1
      while (last >= 0 && line.pieces[last].space) last--
      for (let i = 0; i <= last; i++) w = line.pieces[i].x + line.pieces[i].width
      line.width = w
      if (!line.pieces.length) {
        const m = metrics(ctx, emptyStyle ?? DEFAULT_STYLE, unit)
        line.ascent = m.ascent
        line.descent = m.descent
      }
      const natural = line.ascent + line.descent
      const maxSize = Math.max(...line.pieces.map((p) => p.style.fontSize * unit), (emptyStyle ?? DEFAULT_STYLE).fontSize * unit)
      line.height = Math.max(natural, maxSize * lineHeight)
      line.y = y
      y += line.height
      lines.push(line)
      line = { pieces: [], width: 0, ascent: 0, descent: 0, height: 0, y: 0, align: para.align }
    }
    const place = (t: string, style: RunStyle, width: number, space: boolean) => {
      const m = metrics(ctx, style, unit)
      line.ascent = Math.max(line.ascent, m.ascent)
      line.descent = Math.max(line.descent, m.descent)
      const x = line.pieces.length ? line.pieces[line.pieces.length - 1].x + line.pieces[line.pieces.length - 1].width : 0
      line.pieces.push({ text: t, style, width, x, space })
    }
    const cursor = () => {
      const last = line.pieces[line.pieces.length - 1]
      return last ? last.x + last.width : 0
    }
    for (const run of para.runs) {
      for (const word of words(run.text)) {
        const space = /^\s+$/.test(word)
        const w = measure(ctx, word, run.style, unit)
        if (!space && cursor() + w > maxWidth && line.pieces.some((p) => !p.space)) flush()
        if (space && !line.pieces.length) continue
        if (!space && w > maxWidth) {
          // Break a single overlong word across lines.
          let chunk = ''
          for (const g of Array.from(word)) {
            const cw = measure(ctx, chunk + g, run.style, unit)
            if (cursor() + cw > maxWidth && chunk) {
              place(chunk, run.style, measure(ctx, chunk, run.style, unit), false)
              flush()
              chunk = g
            } else chunk += g
          }
          if (chunk) place(chunk, run.style, measure(ctx, chunk, run.style, unit), false)
          continue
        }
        place(word, run.style, w, space)
      }
    }
    flush(para.runs[0]?.style)
  }
  return { lines, width: Math.max(0, ...lines.map((l) => l.width)), height: y }
}
