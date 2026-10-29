// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear } from '../../../model/fixtures.ts'
import { hiddenOf, hide, holderOptions, holderValue, moveBoundary, moveEdge, moveSpan, removeBoundary, segmentsOf, setHolder, shownFrom, splitAt, toggleFrom, unhide } from './strips.ts'

const spear = makeGear({
  id: 'spear', name: 'Spear', attach: { kind: 'bone', bone: 'Spine2', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [{ id: 'front', name: 'Front', kind: 'grip', hand: 'Left', place: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] } }],
})
const half = (u: number): number => u / 2

describe('the Held-by strip', () => {
  it('draws a segment per holder in played phases, the first the Gear attach bone', () => {
    const held = [{ u: 0.4, bone: 'RightHand' }, { u: 1.2, bone: 'Spine2', placed: true as const }]
    expect(segmentsOf(spear, held, half)).toEqual([
      { index: -1, from: 0, to: 0.2, bone: 'Spine2', how: 'gear' },
      { index: 0, from: 0.2, to: 0.6, bone: 'RightHand', how: 'free' },
      { index: 1, from: 0.6, to: 1, bone: 'Spine2', how: 'placed' },
    ])
    // (a holder from before the start: the attach bone's segment has no length)
    expect(segmentsOf(spear, [{ u: -0.1, bone: 'RightHand' }], u => u).map(s => s.index)).toEqual([0])
  })

  it('splits at a moment (the same holder, where it is), moves a boundary between its neighbours, removes one', () => {
    const one = splitAt(spear, [], 0.3)!
    expect(one).toEqual([{ u: 0.3, bone: 'Spine2' }])
    const two = splitAt(spear, setHolder(one, 0, { bone: 'RightHand', handle: 'front' }), 0.6)!
    expect(two).toEqual([{ u: 0.3, bone: 'RightHand', handle: 'front' }, { u: 0.6, bone: 'RightHand' }])
    expect(splitAt(spear, two, 0.6005)).toBeNull()
    expect(moveBoundary(two, 0, 0.9)[0].u).toBeCloseTo(0.599, 9)
    expect(moveBoundary(two, 1, 0.1)[1].u).toBeCloseTo(0.301, 9)
    expect(moveBoundary(two, 0, -1)[0].u).toBe(0)
    expect(removeBoundary(two, 0)).toEqual([{ u: 0.6, bone: 'RightHand' }])
  })

  it('sets the first segment\'s holder by an entry at the start', () => {
    expect(setHolder([{ u: 0.5, bone: 'RightHand' }], -1, { bone: 'LeftHand' })).toEqual([{ u: 0, bone: 'LeftHand' }, { u: 0.5, bone: 'RightHand' }])
    expect(setHolder([{ u: 0, bone: 'RightHand' }], -1, { bone: 'LeftHand' })).toEqual([{ u: 0, bone: 'LeftHand' }])
  })

  it('offers its places first (its Gear placement, its handles on their hands), then bones', () => {
    const options = holderOptions(makeCharacter(), spear)
    expect(options.slice(0, 2).map(o => o.label)).toEqual(['Spine2, as placed in Gear', 'Left hand on Front'])
    expect(options.find(o => o.value === 'bone:RightHand')?.group).toBe('Where it is, on')
    expect(holderValue({ u: 0.2, bone: 'LeftHand', handle: 'front' }, spear)).toBe('handle:front:LeftHand')
    expect(holderValue(null, spear)).toBe('placed:Spine2')
    expect(options.some(o => o.value === holderValue({ u: 0.2, bone: 'Hips' }, spear))).toBe(true)
  })
})

describe('the Shown strip', () => {
  it('reads hidden spans, to the end when nothing shows it again', () => {
    expect(hiddenOf([{ u: 0.2, shown: false }, { u: 0.5, shown: true }, { u: 0.8, shown: false }])).toEqual([
      { from: 0.2, to: 0.5, start: 0, end: 1 }, { from: 0.8, to: Infinity, start: 2, end: -1 },
    ])
    expect(hiddenOf([{ u: 0.3, shown: true }])).toEqual([])
  })

  it('hides a range, merging what it touches; moves a span or an edge; shows it again', () => {
    const one = hide([], 0.2, 0.4)
    expect(one).toEqual([{ u: 0.2, shown: false }, { u: 0.4, shown: true }])
    expect(hide(one, 0.35, 0.6)).toEqual([{ u: 0.2, shown: false }, { u: 0.6, shown: true }])
    expect(moveSpan(one, 0, 0.1).map(x => +x.u.toFixed(9))).toEqual([0.3, 0.5])
    expect(moveSpan(one, 0, -1).map(x => +x.u.toFixed(9))).toEqual([0, 0.2])
    expect(moveEdge(one, 0, 'to', 0.9)).toEqual([{ u: 0.2, shown: false }, { u: 0.9, shown: true }])
    expect(moveEdge(one, 0, 'from', 0.5)[0].u).toBeCloseTo(0.399, 9)
    expect(unhide(one, 0)).toEqual([])
    expect(shownFrom([[0.5, Infinity]])).toEqual([{ u: 0.5, shown: false }])
  })

  it('toggles from the playhead: hidden to the next span, or shown again from there', () => {
    expect(toggleFrom([], 0.6)).toEqual([{ u: 0.6, shown: false }])
    expect(toggleFrom([{ u: 0.6, shown: false }], 0.8)).toEqual([{ u: 0.6, shown: false }, { u: 0.8, shown: true }])
    expect(toggleFrom([{ u: 0.6, shown: false }], 0.2)).toEqual([{ u: 0.2, shown: false }])
  })
})
