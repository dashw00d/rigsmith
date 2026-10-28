import { describe, expect, it } from 'vitest'
import { retainReference, selectIslands, surfaceIslands } from './selection.ts'

describe('skin candidate selection', () => {
  it('rejects a better mean strain when another motion gains extreme deformation', () => {
    expect(retainReference([.1,.1], [.2,.2], [10,21], [20,20])).toBe(true)
    expect(retainReference([.1,.1], [.2,.2], [10,20], [20,20])).toBe(false)
    expect(retainReference([.1,.23], [.2,.2], [10,10], [20,20])).toBe(true)
    expect(() => retainReference([NaN], [1], [0], [0])).toThrow()
  })
  it('keeps split seams in one island and separate cloth sheets apart', () => {
    const r = surfaceIslands([0,0,0, 1,0,0, 0,1,0, 1,0,0, 1,1,0, 0,1,0, 0,0,.01, 1,0,.01, 0,1,.01], [0,1,2, 3,4,5, 6,7,8])
    expect(r.count).toBe(2)
    expect(r.labels[0]).toBe(r.labels[5])
    expect(r.labels[0]).not.toBe(r.labels[6])
  })
  it('improves independent islands without hiding a motion regression in the average', () => {
    expect(selectIslands([[4,1,10], [4,1,1]], [[1,4,1], [1,4,2]], false)).toEqual([true, false, false])
    expect(selectIslands([[4,1,10], [4,1,1]], [[1,4,1], [1,4,2]], true)).toEqual([true, false, true])
  })
  it('rejects nonfinite or incompatible score tables', () => {
    expect(() => selectIslands([[NaN]], [[1]], false)).toThrow()
    expect(() => selectIslands([[1]], [[1,2]], false)).toThrow()
  })
})
