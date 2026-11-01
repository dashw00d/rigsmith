import { describe, expect, it } from 'vitest'
import { BrushStroke } from './brushstroke.ts'

describe('brush stroke sampling', () => {
  it('covers a fast drag with the same dabs as many small pointer events', () => {
    const fast = new BrushStroke({ x: 0, y: 0 }, 3)
    const slow = new BrushStroke({ x: 0, y: 0 }, 3)
    const a = [...fast.move({ x: 20, y: 0 }), ...fast.end()]
    const b = Array.from({ length: 20 }, (_, i) => slow.move({ x: i + 1, y: 0 })).flat()
    b.push(...slow.end())
    expect(a).toEqual(b)
    expect(a.map(s => s.x)).toEqual([3, 6, 9, 12, 15, 18, 20])
  })

  it('keeps spacing through a corner and does not repaint stationary input', () => {
    const stroke = new BrushStroke({ x: 0, y: 0 }, 5)
    expect(stroke.move({ x: 3, y: 0 })).toEqual([])
    expect(stroke.move({ x: 3, y: 4 })).toEqual([{ x: 3, y: 2 }])
    expect(stroke.move({ x: 3, y: 4 })).toEqual([])
    expect(stroke.end()).toEqual([{ x: 3, y: 4 }])
    expect(stroke.end()).toEqual([])
  })
})
