import { describe, expect, it } from 'vitest'
import { chooseViews, dilateGutters, flipRows, gutterOf, viewName } from './projection.ts'

const fill = (n: number, at: (i: number) => number): number[] => Array.from({ length: n }, (_, i) => at(i))

describe('choosing the views to capture', () => {
  it('takes nothing when there is nothing to see', () => {
    expect(chooseViews([])).toEqual([])
    expect(chooseViews([[], []])).toEqual([])
  })

  it('takes the views that each see what the others miss', () => {
    const front = fill(100, i => (i < 50 ? 1 : 0))
    const back = fill(100, i => (i < 50 ? 0 : 1))
    const glancing = fill(100, () => 0.3)
    expect(chooseViews([front, back, glancing])).toEqual([0, 1])
  })

  it('stops once all but a few samples are seen squarely enough', () => {
    // (the one sample left is 1% of them, under the 3% left short)
    const most = fill(100, i => (i < 99 ? 1 : 0))
    const rest = fill(100, i => (i < 99 ? 0 : 1))
    expect(chooseViews([most, rest])).toEqual([0])
  })

  it('leaves a view that would add too little to be worth another image', () => {
    const most = fill(10, i => (i < 8 ? 1 : 0))
    const glance = fill(10, i => (i < 8 ? 0 : 0.1))
    expect(chooseViews([most, glance])).toEqual([0])
  })

  it('takes at most `most` views', () => {
    const eighths = fill(8, d => d).map(d => fill(80, i => (Math.floor(i / 10) === d ? 1 : 0)))
    expect(chooseViews(eighths, 6)).toHaveLength(6)
    expect(chooseViews(eighths, 8)).toHaveLength(8)
  })
})

describe('naming a view', () => {
  it('says where the camera is from the character (facing +z, its left +x)', () => {
    expect(viewName({ x: 0, y: 0, z: 1 })).toBe('front')
    expect(viewName({ x: 1, y: 0, z: 0 })).toBe('left')
    expect(viewName({ x: 0, y: 0, z: -1 })).toBe('back')
    expect(viewName({ x: -Math.SQRT1_2, y: 0, z: Math.SQRT1_2 })).toBe('front-right')
    expect(viewName({ x: 0, y: 1, z: 0 })).toBe('above')
    expect(viewName({ x: 0.7, y: 0.7, z: 0 })).toBe('above left')
    expect(viewName({ x: 0, y: -0.9, z: -0.4 })).toBe('below back')
  })
})

describe('the bake past the islands\' borders', () => {
  it('runs the colour on ring by ring, leaving the islands as they are', () => {
    // one row: an island texel, then two outside any island
    const px = new Uint8ClampedArray([200, 100, 50, 255, 0, 0, 0, 0, 0, 0, 0, 0])
    dilateGutters(px, new Uint8Array([1, 0, 0]), 3, 1, 1)
    expect([...px]).toEqual([200, 100, 50, 255, 200, 100, 50, 255, 0, 0, 0, 0])
    dilateGutters(px, new Uint8Array([1, 0, 0]), 3, 1, 2)
    expect([...px.subarray(8)]).toEqual([200, 100, 50, 255])
  })

  it('takes colour only from what is painted, and alpha as it is', () => {
    // 2 x 2: a red texel and two clear ones on the island, the fourth outside it
    const px = new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0, 9, 9, 9, 9])
    dilateGutters(px, new Uint8Array([1, 1, 1, 0]), 2, 2, 4)
    expect([...px.subarray(12)]).toEqual([255, 0, 0, 85])
    expect([...px.subarray(0, 12)]).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('leaves texels next to nothing painted clear', () => {
    const px = new Uint8ClampedArray([0, 0, 0, 0, 7, 7, 7, 7])
    dilateGutters(px, new Uint8Array([1, 0]), 2, 1, 2)
    expect([...px]).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('reaches further on larger textures', () => {
    expect(gutterOf(512, 512)).toBe(4)
    expect(gutterOf(4096, 2048)).toBe(16)
  })
})

describe('pixel rows', () => {
  it('turns bottom-up rows top-down and back', () => {
    const px = new Uint8Array([1, 2, 3, 4, 5, 6])
    expect([...flipRows(px, 2, 3, 1)]).toEqual([5, 6, 3, 4, 1, 2])
    expect([...flipRows(flipRows(px, 1, 3, 2), 1, 3, 2)]).toEqual([...px])
  })
})
