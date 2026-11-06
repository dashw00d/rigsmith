import { describe, expect, it } from 'vitest'
import { explainRetain, retainReference, selectIslands, surfaceIslands } from './selection.ts'

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
  it('says which rule kept the reference, in plain words', () => {
    const names = ['Walk', 'Air squat']
    expect(explainRetain([.3,.3], [.2,.2], [0,0], [0,0], names)).toEqual({ retain: true, why: 'strained the 2 tests 50% more in all' })
    expect(explainRetain([.1,.23], [.2,.2], [0,0], [0,0], names)).toEqual({ retain: true, why: 'strained Air squat 15% more' })
    expect(explainRetain([.1,.1], [.2,.2], [10,21], [20,20], names)).toEqual({ retain: true, why: 'stretched 1 more edge past double length on Air squat' })
    expect(explainRetain([.1,.1], [.2,.2], [10,20], [20,20], names)).toEqual({ retain: false, why: 'was no worse on any of the 2 tests (50% less strain)' })
    expect(explainRetain([.2], [.2], [0], [0])).toEqual({ retain: false, why: 'was no worse on the test' })
  })
  it('weighs layer crossings: a skin that keeps the coat over the legs wins whatever its stretch, short of a broken fit', () => {
    const names = ['Walk', 'Air squat']
    expect(explainRetain([.2,.22], [.2,.2], [5,5], [5,5], names, { generated: [2,8], reference: [20,80] }))
      .toEqual({ retain: false, why: 'kept the layers apart (90% fewer points through the layer under them on the 2 tests, 5% more strain)' })
    // stretch can be painted out, a thigh through a coat can't: a third more on one test, more edges past double length
    expect(explainRetain([.17,.27], [.2,.2], [5,9], [5,5], names, { generated: [2,8], reference: [20,80] }))
      .toEqual({ retain: false, why: 'kept the layers apart (90% fewer points through the layer under them on the 2 tests, 10% more strain)' })
    // but not a broken fit: half as much strain again in all
    expect(explainRetain([.3,.32], [.2,.2], [5,5], [5,5], names, { generated: [2,8], reference: [20,80] }))
      .toEqual({ retain: true, why: 'strained the 2 tests 55% more in all' })
    // a skin with less strain that lets more points through is refused
    expect(explainRetain([.1,.1], [.2,.2], [0,0], [0,0], names, { generated: [30,90], reference: [20,40] }))
      .toEqual({ retain: true, why: 'let 60 more points through the layer under them on the 2 tests' })
    // the same layers either way: the strain rules as before
    expect(explainRetain([.1,.23], [.2,.2], [0,0], [0,0], names, { generated: [3,3], reference: [3,4] }))
      .toEqual({ retain: true, why: 'strained Air squat 15% more' })
    expect(() => explainRetain([.1], [.1], [0], [0], [], { generated: [1, 2], reference: [1] })).toThrow()
  })
})
