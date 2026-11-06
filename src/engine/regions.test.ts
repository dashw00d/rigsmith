import { describe, expect, it } from 'vitest'
import { hiddenRegions, regionMask, regionsOf, withoutRegions } from './regions.ts'

// Two strips split at a seam: vertices 0-3 (two triangles) and 4-7 (two triangles), vertex 8 unused.
const index = [0, 1, 2, 1, 3, 2, 4, 5, 6, 5, 7, 6]

describe('regions', () => {
  it('splits the body at its split vertices', () => {
    const r = regionsOf(index, 9)
    expect(r.count).toBe(2)
    expect(Array.from(r.of)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, -1])
    expect(Array.from(r.vertices)).toEqual([4, 4])
  })

  it('numbers regions the same whatever the triangle order', () => {
    const reordered = [5, 7, 6, 0, 1, 2, 4, 5, 6, 1, 3, 2]
    expect(Array.from(regionsOf(reordered, 9).of)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, -1])
  })

  it('joins triangles that only meet through a later one', () => {
    const r = regionsOf([0, 1, 2, 3, 4, 5, 2, 3, 6], 7)
    expect(r.count).toBe(1)
  })

  it('hides a region only when nearly all of it is covered', () => {
    const r = regionsOf(index, 9)
    expect(hiddenRegions(r, [1, 1, 1, 1, 1, 1, 0, 0, 0])).toEqual([0])
    expect(hiddenRegions(r, [1, 1, 1, 0, 0, 0, 0, 0, 0])).toEqual([])
    expect(hiddenRegions(r, [1, 1, 1, 0, 0, 0, 0, 0, 0], 0.75)).toEqual([0])
  })

  it('drops the hidden regions\' triangles', () => {
    const r = regionsOf(index, 9)
    expect(withoutRegions(index, r, [0])).toEqual([4, 5, 6, 5, 7, 6])
  })

  it('packs regions into a mask', () => {
    expect(regionMask([0, 3])).toEqual({ mask: 9, unfit: [] })
    expect(regionMask([40]).unfit).toEqual([40])
  })
})
