import { describe, expect, it } from 'vitest'
import {
  appended, bakeCycle, blended, endAt, fitFor, insertAt, isWhole, layoutOf, MAIN, moved, ownerAt, piecesProblem, playsItself, remapper, remapSlot, removed, rewarp,
  slotsUnder, startAt, trimmed, wholeClip,
} from './pieces.ts'
import type { Piece, Slot } from './types.ts'

let n = 0
const id = (): string => `n${++n}`
const clip = (pid: string, from: number, to: number, blend?: number): Piece => ({ id: pid, kind: 'clip', clip: { id: pid }, from, to, ...(blend !== undefined ? { blend } : {}) })
const hold = (pid: string, from: number, to: number, blend?: number): Piece => ({ id: pid, kind: 'hold', from, to, ...(blend !== undefined ? { blend } : {}) })
const q = (x: number): [number, number, number, number] => [x, 0, 0, 1]
const slotWith = (o: Partial<Slot>): Slot => ({ id: 's', name: 'Attack', clip: { id: 'a' }, speed: 1, loop: false, inPlace: false, adjustments: [], ...o })

describe('the layout of pieces', () => {
  it('starts each piece where the one before ends, less its blend', () => {
    const L = layoutOf([clip('a', 0, 1), clip('b', 2, 3.5, 0.5), hold('h', 0, 0.25)])
    expect(L.placed.map(p => [p.start, p.length, p.blend])).toEqual([[0, 1, 0], [0.5, 1.5, 0.5], [2, 0.25, 0]])
    expect(L.seconds).toBe(2.25)
  })

  it('gives a moment inside a blend to the piece before up to its middle, and past the end to the last', () => {
    const L = layoutOf([clip('a', 0, 1), clip('b', 0, 1, 0.4)])
    expect(ownerAt(L, 0.7).index).toBe(0)
    expect(ownerAt(L, 0.8).index).toBe(1)
    expect(ownerAt(L, 2)).toEqual({ index: 1, local: 1.4, past: true })
  })

  it('checks its rules', () => {
    expect(piecesProblem([clip('a', 0, 1)])).toBeNull()
    expect(piecesProblem([hold('h', 0, 1)])).toMatch(/not only held/)
    expect(piecesProblem([clip('a', 0, 1, 0.2)])).toMatch(/first piece/)
    expect(piecesProblem([clip('a', 0, 1), clip('b', 0, 0.3, 0.5)])).toMatch(/longer than/)
    expect(piecesProblem([clip('a', 0, 1), clip('b', 0, 0.5, 0.3), clip('c', 0, 1, 0.3)])).toMatch(/overlap/)
    expect(piecesProblem([clip('a', 0, 1), clip('a', 0, 1)])).toMatch(/repeat/)
    expect(isWhole(wholeClip({ id: 'x' }, 2), { id: 'x' }, 2)).toBe(true)
    expect(isWhole([clip('x', 0, 1.5)], { id: 'x' }, 2)).toBe(false)
  })
})

describe('remapping what a slot stores', () => {
  const A = clip('A', 0, 1); const B = clip('B', 0, 1)

  it('keeps keys on piece B where they were on B when piece A is trimmed', () => {
    const r = remapper([A, B], [{ ...A, from: 0.25 }, B])
    // (B's key at 0.5 s into it: at 1.5 of 2 s before, at 1.25 of 1.75 s after)
    expect(r.point(1.5 / 2)! * 1.75).toBeCloseTo(1.25, 12)
    // (A's key at 0.5 s of its clip: at 0.25 s now; one at 0.1 s trimmed off)
    expect(r.point(0.5 / 2)! * 1.75).toBeCloseTo(0.25, 12)
    expect(r.point(0.1 / 2)).toBeNull()
  })

  it('takes a removed piece\'s keys with it, and moves those after it back', () => {
    const r = remapper([A, B, clip('C', 0, 1)], [A, clip('C', 0, 1)])
    expect(r.point(1.5 / 3)).toBeNull()
    expect(r.point(2.5 / 3)! * 2).toBeCloseTo(1.5, 12)
    // (a window's end on it: the seam where it was)
    expect(r.clamp(1.5 / 3) * 2).toBeCloseTo(1, 12)
  })

  it('moves keys with their piece when the pieces are reordered or blended', () => {
    const r = remapper([A, B], [B, A])
    expect(r.point(0.25 / 2)! * 2).toBeCloseTo(1.25, 12)
    expect(r.point(1.25 / 2)! * 2).toBeCloseTo(0.25, 12)
    const b = remapper([A, B], [A, { ...B, blend: 0.5 }])
    expect(b.point(1.75 / 2)! * 1.5).toBeCloseTo(1.25, 12)
  })

  it('sends what was past the end as far from the last piece\'s start, into a hold put after it', () => {
    const r = remapper([A], [A, hold('h', 0, 1)])
    expect(r.point(1.5)! * 2).toBeCloseTo(1.5, 12)
  })

  it('splits a piece: each item to the part holding its moment, the one at the cut after the time put in', () => {
    const edit = insertAt([clip('A', 0, 2)], 1, 0.5, id)!
    expect(edit.pieces.map(p => [p.kind, p.from, p.to])).toEqual([['clip', 0, 1], ['hold', 0, 0.5], ['clip', 1, 2]])
    const r = remapper([clip('A', 0, 2)], edit.pieces, edit.split)
    expect(r.point(0.25)! * 2.5).toBeCloseTo(0.5, 12)
    expect(r.point(0.5)! * 2.5).toBeCloseTo(1.5, 12)
    expect(r.point(0.75)! * 2.5).toBeCloseTo(2, 12)
  })

  it('remaps a whole slot: keys, events, windows, holders, markers; a removed piece\'s go and are counted', () => {
    const s = slotWith({
      pieces: [A, B],
      bones: { Spine: [{ u: 0.25, q: q(0.1) }, { u: 0.75, q: q(0.2) }] },
      gear: { spear: { keys: [{ u: 0.8, q: q(0) }], heldBy: [{ u: 0.6, bone: 'LeftHand' }] } },
      events: [{ id: 'e1', name: 'hit', u: 0.75 }, { id: 'e2', name: 'swing', u: 0.25, to: 0.75 }],
      adjustments: [{ id: 'p', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.6, 0.9]] }],
      time: { markers: [{ id: 'm', u: 0.75, to: 0.7 }] },
    })
    const { slot, dropped } = remapSlot(s, [A, B], [B])
    expect(slot.bones).toEqual({ Spine: [{ u: 0.5, q: q(0.2) }] })
    expect(slot.gear!.spear.keys![0].u).toBeCloseTo(0.6, 9)
    expect(slot.gear!.spear.heldBy![0].u).toBeCloseTo(0.2, 9)
    expect(slot.events!.map(e => [e.id, e.u, e.to])).toEqual([['e2', 0, 0.5], ['e1', 0.5, undefined]])
    expect((slot.adjustments[0] as { windows: number[][] }).windows).toEqual([[expect.closeTo(0.2, 12), expect.closeTo(0.8, 12)]])
    // (B played its first half at 14/15 speed and its second at 6/5: still so, spread over B alone (0.4375 of it)
    expect(slot.time!.markers![0]).toMatchObject({ u: 0.5, to: expect.closeTo(0.4375, 12) })
    expect(dropped).toBe(1)
  })
})

describe('retime markers through a piece edit (the review: an append re-warped the clip)', () => {
  // (a 2 s clip, its first half played in 0.5 s (marker u 0.5 -> 0.25), a hit at 0.75)
  const W = (ms: Array<{ u: number, to: number }>, u: number): number => {
    const xs = [0, ...ms.map(m => m.u), 1]; const ys = [0, ...ms.map(m => m.to), 1]
    let i = 1; while (i < xs.length - 1 && xs[i] < u) i++
    return ys[i - 1] + (u - xs[i - 1]) / (xs[i] - xs[i - 1]) * (ys[i] - ys[i - 1])
  }
  const ms = [{ id: 'm', u: 0.5, to: 0.25 }]

  it('plays every old part as it played and what is appended unwarped', () => {
    const next = [clip('A', 0, 2), clip('B', 0, 2)]
    const out = rewarp(ms, [clip('A', 0, 2)], next)
    // (seconds played of a source second, before (2 s) and after (4 s))
    const before = (t: number): number => W(ms, t / 2) * 2
    const after = (t: number): number => W(out, t / 4) * 4
    for (const t of [0.5, 1, 1.5, 2]) expect(after(t)).toBeCloseTo(before(t), 12)
    expect(after(3) - after(2)).toBeCloseTo(1, 12)
    expect(out[0].id).toBe('m')
    expect(rewarp(ms, [clip('A', 0, 2)], [hold('h', 0, 1), clip('A', 0, 2)]).map(m => [m.u * 3, m.to * 3])).toEqual([[expect.closeTo(1, 12), expect.closeTo(1, 12)], [expect.closeTo(2, 12), expect.closeTo(1.5, 12)]])
  })

  it('a slot without markers gets none', () => {
    expect(rewarp([], [clip('A', 0, 2)], [clip('A', 0, 2), clip('B', 0, 2)])).toEqual([])
  })
})

describe('a window across a seam when the pieces under it are reordered (the review: it was dropped)', () => {
  it('keeps the part on the piece its start is on', () => {
    const s = slotWith({ pieces: [clip('A', 0, 1), clip('B', 0, 1)], adjustments: [{ id: 'p', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.25, 0.75]] }], events: [{ id: 'sw', name: 'swing', u: 0.25, to: 0.75 }] })
    const { slot, dropped } = remapSlot(s, [clip('A', 0, 1), clip('B', 0, 1)], [clip('B', 0, 1), clip('A', 0, 1)])
    expect((slot.adjustments[0] as { windows: number[][] }).windows).toEqual([[expect.closeTo(0.75, 12), expect.closeTo(1, 12)]])
    expect([slot.events![0].u, slot.events![0].to]).toEqual([expect.closeTo(0.75, 12), expect.closeTo(1, 12)])
    expect(dropped).toBe(0)
  })

  it('leaves every number as it was where nothing round it moved', () => {
    const r = remapper([clip('A', 0, 1), clip('B', 0, 1)], [clip('A', 0, 1), { ...clip('B', 0, 1), from: 0 }])
    expect(r.point(0.1 + 0.2)).toBe(0.1 + 0.2)
  })
})

describe('the strip\'s gestures', () => {
  it('lengthens the end with a held pose, and grows that hold the next time', () => {
    const one = endAt([clip('A', 0, 1)], 1.5, id)!
    expect(one.pieces.map(p => [p.kind, p.from, p.to])).toEqual([['clip', 0, 1], ['hold', 0, 0.5]])
    expect(endAt(one.pieces, 2, id)!.pieces.map(p => p.to)).toEqual([1, 1])
    // (shorter: the piece there trimmed, those after it gone)
    expect(endAt(one.pieces, 0.5, id)!.pieces.map(p => [p.id, p.to])).toEqual([['A', 0.5]])
  })

  it('lengthens the start with a hold whose clock runs back, so what is keyed in it stays', () => {
    const one = startAt([clip('A', 0, 1)], -0.5, id)!
    expect(one.pieces.map(p => [p.kind, p.from, p.to])).toEqual([['hold', -0.5, 0], ['clip', 0, 1]])
    const two = startAt(one.pieces, -0.25, id)!
    expect(two.pieces[0]).toMatchObject({ from: -0.75, to: 0 })
    // (a key 0.1 s before the clip, in the hold: still 0.1 s before it)
    const r = remapper(one.pieces, two.pieces)
    expect(r.point(0.4 / 1.5)! * 1.75).toBeCloseTo(0.65, 12)
    expect(startAt(one.pieces, 1, id)!.pieces.map(p => [p.id, p.from, p.to])).toEqual([['A', 0.5, 1]])
  })

  it('inserts time in a hold by setting its second part\'s clock back', () => {
    const edit = insertAt([clip('A', 0, 1), hold('h', 0, 1)], 1.5, 0.25, id)!
    expect(edit.pieces.map(p => [p.kind, p.from, p.to])).toEqual([['clip', 0, 1], ['hold', 0, 0.5], ['hold', 0.25, 1]])
    const r = remapper([clip('A', 0, 1), hold('h', 0, 1)], edit.pieces, edit.split)
    expect(r.point(1.25 / 2)! * 2.25).toBeCloseTo(1.25, 12)
    expect(r.point(1.75 / 2)! * 2.25).toBeCloseTo(2, 12)
    expect(insertAt([clip('A', 0, 1), clip('B', 0, 1, 0.5)], 0.75, 0.25, id)).toBeNull()
  })

  it('appends with as much blend as the pieces allow, trims within the content, blends, reorders, removes', () => {
    expect(appended([clip('A', 0, 1)], clip('B', 0, 0.1)).pieces[1].blend).toBe(0.1)
    expect(appended([clip('A', 0, 1)], clip('B', 0, 1), 0).pieces[1].blend).toBeUndefined()
    expect(trimmed([clip('A', 0, 1)], 'A', 'end', 0.5, 1.2)!.pieces[0].to).toBe(1.2)
    expect(trimmed([clip('A', 0, 1)], 'A', 'start', -1, 1.2)!.pieces[0].from).toBe(0)
    expect(trimmed([hold('h', 0, 1), clip('A', 0, 1)], 'h', 'start', -1)!.pieces[0].from).toBe(-1)
    expect(blended([clip('A', 0, 1), clip('B', 0, 0.3)], 'B', 0.5)!.pieces[1].blend).toBe(0.3)
    const m = moved([clip('A', 0, 1), clip('B', 0, 1, 0.2)], 'B', 0)!
    expect(m.pieces.map(p => [p.id, p.blend])).toEqual([['B', undefined], ['A', undefined]])
    expect(removed([clip('A', 0, 1), hold('h', 0, 1)], ['A'])).toBeNull()
    expect(removed([clip('A', 0, 1), clip('B', 0, 1, 0.2)], ['A'])!.pieces).toEqual([clip('B', 0, 1)])
  })

  it('keeps the blow fit\'s start and blow, ending where the edit says', () => {
    expect(fitFor({ enabled: true, at: 0.45 }, 0, 0.35, 1.28)).toEqual({ enabled: true, at: 0.35 / 1.28 })
    expect(fitFor({ enabled: true, at: 0.45, window: 0.8 }, 0.1, 0.5, 1.1)).toEqual({ enabled: true, at: expect.closeTo(0.4, 12), window: 1 })
    expect(fitFor({ enabled: true, at: 0.45 }, 0, 1.2, 1)).toBeNull()
  })
})

describe('slots played as pieces', () => {
  const c = {
    clips: [
      slotWith({ id: 'a', name: 'A', pieces: [clip('x', 0, 1), { id: 'p', kind: 'slot', slot: 'b', from: 0, to: 1 }] }),
      slotWith({ id: 'b', name: 'B', pieces: [clip('y', 0, 1), { id: 'q', kind: 'slot', slot: 'c', from: 0, to: 1 }], time: { pace: { enabled: true, like: 'd' } } }),
      slotWith({ id: 'c', name: 'C' }),
      slotWith({ id: 'd', name: 'D' }),
    ],
  }

  it('finds a chain that leads back to the slot, through pieces and the paces they follow', () => {
    expect(playsItself(c, 'c', [clip('z', 0, 1), { id: 'r', kind: 'slot', slot: 'a', from: 0, to: 1 }])).toBe(true)
    // (D playing A: A plays B, B paces like D, whose source plays A again)
    expect(playsItself(c, 'd', [{ id: 'r', kind: 'slot', slot: 'a', from: 0, to: 1 }])).toBe(true)
    expect(playsItself(c, 'c', [{ id: 'r', kind: 'slot', slot: 'd', from: 0, to: 1 }])).toBe(false)
  })

  it('finds a slot that paces like a clip playing it (the review\'s endless bake), and lets two paces follow each other', () => {
    const paced = { clips: [slotWith({ id: 'A', name: 'A', time: { pace: { enabled: true, like: 'B' } } }), slotWith({ id: 'B', name: 'B', pieces: [clip('b', 0, 1), { id: 'p', kind: 'slot', slot: 'A', from: 0, to: 1 }] })] }
    expect(bakeCycle(paced)?.id).toBeDefined()
    // (a pace measures the other timed without its own pace: two following each other end)
    const mutual = { clips: [slotWith({ id: 'A', name: 'A', time: { pace: { enabled: true, like: 'B' } } }), slotWith({ id: 'B', name: 'B', time: { pace: { enabled: true, like: 'A' } } })] }
    expect(bakeCycle(mutual)).toBeNull()
  })

  it('lists what a slot\'s bake reads of the others', () => {
    expect(slotsUnder(c, c.clips[0]).map(s => s.id).sort()).toEqual(['b', 'c', 'd'])
    expect(MAIN).toBe('main')
  })
})
