import type { ReactNode } from 'react'
import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-b px-4 py-3.5">
      <div className="mb-2.5 flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="grid gap-3">{children}</div>
    </div>
  )
}

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-3">
      <span className="text-[13px] text-foreground/80">{label}</span>
      <div className="flex min-w-0 items-center gap-2">
        {children}
        {hint}
      </div>
    </div>
  )
}

export function SliderRow({ label, value, min, max, step, format, onChange, onReset }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
  onReset?: () => void
}) {
  return (
    <Row label={label}>
      <Slider className="flex-1" min={min} max={max} step={step} value={[value]} onValueChange={([v]) => onChange(v)} />
      <button className="w-14 shrink-0 text-right text-xs tabular text-muted-foreground hover:text-foreground" onDoubleClick={onReset} title={onReset ? 'Double-click to reset' : undefined}>
        {format(value)}
      </button>
    </Row>
  )
}

export function ColorField({ value, onChange, className }: { value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <label className={cn('relative inline-flex size-7 shrink-0 cursor-pointer overflow-hidden rounded-md border', className)} style={{ background: value }}>
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" />
    </label>
  )
}
