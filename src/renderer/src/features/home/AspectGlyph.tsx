import { cn } from '@/lib/utils'

/** A small rectangle drawn at the given aspect ratio, fitted inside a square box. */
export function AspectGlyph({ w, h, size = 28, className }: { w: number; h: number; size?: number; className?: string }) {
  const k = size / Math.max(w, h)
  return (
    <span className={cn('inline-flex items-center justify-center', className)} style={{ width: size, height: size }}>
      <span className="rounded-[3px] border-2 border-current" style={{ width: Math.round(w * k), height: Math.round(h * k) }} />
    </span>
  )
}
