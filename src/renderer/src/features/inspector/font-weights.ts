/**
 * Real weights of installed font families, from the Local Font Access API (faces listed as
 * family + style, e.g. "Segoe UI" / "Semibold"). Chromium resolves a CSS/canvas weight to the
 * matching face, so these are exactly the weights that render distinctly.
 */
import { useEffect, useMemo, useState } from 'react'

export const WEIGHT_NAMES: Record<number, string> = {
  100: 'Thin', 200: 'Extra Light', 300: 'Light', 350: 'Semilight', 400: 'Regular', 500: 'Medium',
  600: 'Semibold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black', 950: 'Extra Black',
}

const WORDS: [RegExp, number][] = [
  [/(extra|ultra)black/, 950], [/(extra|ultra)bold/, 800], [/(semi|demi)bold/, 600], [/(extra|ultra)light/, 200],
  [/(semi|demi)light/, 350], [/thin|hairline/, 100], [/black|heavy/, 900], [/bold/, 700], [/medium/, 500], [/light/, 300],
]

/** Weight of an upright, normal-width face from its style name; null for italics and width variants. */
export function weightOfStyle(style: string): number | null {
  const s = style.toLowerCase().replace(/[\s_-]+/g, '')
  if (/italic|oblique|condensed|narrow|compressed|expanded|extended|wide/.test(s)) return null
  for (const [re, w] of WORDS) if (re.test(s)) return w
  return 400
}

/** Weights per family (lower-cased), from face style names. */
export function weightsByFamily(faces: { family: string; style: string }[]): Map<string, number[]> {
  const sets = new Map<string, Set<number>>()
  for (const f of faces) {
    const w = weightOfStyle(f.style)
    if (w == null) continue
    const key = f.family.toLowerCase()
    if (!sets.has(key)) sets.set(key, new Set())
    sets.get(key)!.add(w)
  }
  return new Map([...sets].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]))
}

let cache: Map<string, number[]> | null = null
let pending: Promise<Map<string, number[]>> | null = null

function load(): Promise<Map<string, number[]>> {
  pending ??= (async () => {
    try {
      const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string; style: string }[]> }).queryLocalFonts
      cache = weightsByFamily(q ? await q() : [])
    } catch {
      cache = new Map()
    }
    return cache
  })()
  return pending
}

/** Weights to offer for a family: its real faces, plus Regular and Bold (synthesized if missing). */
export function useFontWeights(family: string, current: number): number[] {
  const [map, setMap] = useState(cache)
  useEffect(() => {
    if (!map) void load().then(setMap)
  }, [map])
  return useMemo(() => {
    const set = new Set(map?.get(family.toLowerCase()) ?? [])
    set.add(400).add(700).add(current)
    return [...set].sort((a, b) => a - b)
  }, [map, family, current])
}
