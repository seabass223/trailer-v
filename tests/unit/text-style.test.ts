import { describe, expect, it } from 'vitest'
import { cssFont, paragraphs } from '@/engine/text/layout'
import { weightOfStyle, weightsByFamily } from '@/features/inspector/font-weights'
import type { RichNode } from '@shared/model'

const run = (marks: RichNode['marks']) =>
  paragraphs({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hi', marks }] }] })[0].runs[0].style

describe('text run style', () => {
  it('resolves weight from the bold mark and an explicit font-weight', () => {
    expect(run([]).weight).toBe(400)
    expect(run([{ type: 'bold' }]).weight).toBe(700)
    expect(run([{ type: 'textStyle', attrs: { fontWeight: '300' } }]).weight).toBe(300)
    // Both present: <strong> inside the span makes it CSS `bolder` of the span's weight.
    expect(run([{ type: 'textStyle', attrs: { fontWeight: '300' } }, { type: 'bold' }]).weight).toBe(400)
    expect(run([{ type: 'textStyle', attrs: { fontWeight: '600' } }, { type: 'bold' }]).weight).toBe(900)
  })

  it('uses the weight in the canvas font', () => {
    expect(cssFont(run([{ type: 'textStyle', attrs: { fontWeight: '350', fontSize: '50px', fontFamily: 'Segoe UI' } }]), 2))
      .toBe('350 100px "Segoe UI", "Segoe UI", sans-serif')
  })

  it('scales em letter spacing with the font size; px stays absolute', () => {
    expect(run([{ type: 'textStyle', attrs: { fontSize: '120px', letterSpacing: '0.1em' } }]).letterSpacing).toBeCloseTo(12)
    expect(run([{ type: 'textStyle', attrs: { letterSpacing: '-0.05em' } }]).letterSpacing).toBeCloseTo(-4.8)
    expect(run([{ type: 'textStyle', attrs: { letterSpacing: '6px' } }]).letterSpacing).toBe(6)
    expect(run([]).letterSpacing).toBe(0)
  })
})

describe('font weights', () => {
  it('maps face style names to weights, skipping italics and width variants', () => {
    expect(weightOfStyle('Regular')).toBe(400)
    expect(weightOfStyle('Semibold')).toBe(600)
    expect(weightOfStyle('SemiLight')).toBe(350)
    expect(weightOfStyle('Extra Bold')).toBe(800)
    expect(weightOfStyle('Black')).toBe(900)
    expect(weightOfStyle('Display Bold')).toBe(700)
    expect(weightOfStyle('Bold Italic')).toBeNull()
    expect(weightOfStyle('SemiBold SemiCondensed')).toBeNull()
    expect(weightOfStyle('Narrow')).toBeNull()
  })

  it('groups faces by family', () => {
    const m = weightsByFamily([
      { family: 'Segoe UI', style: 'Bold' }, { family: 'Segoe UI', style: 'Light' }, { family: 'Segoe UI', style: 'Regular' },
      { family: 'Segoe UI', style: 'Light Italic' }, { family: 'Arial', style: 'Black' },
    ])
    expect(m.get('segoe ui')).toEqual([300, 400, 700])
    expect(m.get('arial')).toEqual([900])
  })
})
