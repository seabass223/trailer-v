import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Linear gain as decibels, e.g. "+3.5 dB". */
export function formatDb(gain: number): string {
  if (gain <= 0.0001) return '−∞ dB'
  const d = 20 * Math.log10(gain)
  return `${d > 0 ? '+' : ''}${d.toFixed(1)} dB`
}
