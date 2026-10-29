import { describe, expect, it } from 'vitest'
import type { ClipKey, Slot } from './types.ts'
import { resolveTime } from './timemap.ts'
import {
  copyKeys, deleteKeys, duplicateKeys, easeKeys, keysIn, keysOf, keysToFrame, momentsOf, moveKeys, pasteKeys, putKey, spanOf,
  stretchKeys, stretchMarkers, warpAt, warpFactor, type TimeFrame,
} from './keyedit.ts'

const q = (w = 1): ClipKey['q'] => [0, 0, Math.sqrt(1 - w * w), w]
const k = (u: number, extra: Partial<ClipKey> = {}): ClipKey => ({ u, q: q(0.9), ...extra })
const slot = (bones: Record<string, ClipKey[]>, gear: Record<string, ClipKey[]> = {}): Pick<Slot, 'bones' | 'gear'> => ({
  bones, gear: Object.fromEntries(Object.entries(gear).map(([g, keys]) => [g, { keys }])),
})
// (10 frames, played = source)
const plain: TimeFrame = { toPlayed: u => u, toSource: v => v, frames: 10 }

describe('moving keys', () => {
  it('moves the selection by whole frames, the grabbed key snapped', () => {
    const s = slot({ Arm: [k(0.2), k(0.5)], Leg: [k(0.2)] })
    const e = moveKeys(s, [{ track: 'body:Arm', u: 0.2 }, { track: 'body:Leg', u: 0.2 }], 0.13, plain)!
    expect(e.tracks).toEqual([{ bone: 'Arm', keys: [k(0.3), k(0.5)] }, { bone: 'Leg', keys: [k(0.3)] }])
    expect(e.selection).toEqual([{ track: 'body:Arm', u: 0.3 }, { track: 'body:Leg', u: 0.3 }])
  })

  it('a key moved onto another replaces it; Alt (free) does not snap', () => {
    const s = slot({ Arm: [k(0.2), k(0.5, { ease: 'step' })] })
    expect(moveKeys(s, [{ track: 'body:Arm', u: 0.2 }], 0.3, plain)!.tracks[0].keys).toEqual([k(0.5)])
    expect(moveKeys(s, [{ track: 'body:Arm', u: 0.2 }], 0.033, plain, { free: true })!.tracks[0].keys.map(x => x.u)).toEqual([0.233, 0.5])
  })

  it('stays inside the clip and does nothing for no move', () => {
    const s = slot({ Arm: [k(0.2), k(0.9)] })
    const e = moveKeys(s, [{ track: 'body:Arm', u: 0.2 }, { track: 'body:Arm', u: 0.9 }], 0.5, plain)!
    expect(e.tracks[0].keys.map(x => x.u)).toEqual([0.3, 1])
    expect(moveKeys(s, [{ track: 'body:Arm', u: 0.2 }], 0.02, plain)).toBeNull()
    expect(moveKeys(s, [{ track: 'body:Leg', u: 0.2 }], 0.2, plain)).toBeNull()
  })

  it('writes source moments through the time map (a blow fit keeping the middle of the source)', () => {
    const map = resolveTime({ seconds: 2, speed: 1, kept: [0.5, 1.5] })
    const f: TimeFrame = { toPlayed: map.toPlayed, toSource: map.toSource, frames: 30 }
    const s = slot({ Arm: [k(0.5)] })
    // (source 0.5 plays at 0.5; a move of 3 frames is 0.1 played, 0.05 of the source)
    const e = moveKeys(s, [{ track: 'body:Arm', u: 0.5 }], 0.1, f)!
    expect(e.tracks[0].keys[0].u).toBeCloseTo(0.55, 9)
  })

  it('moves gear keys and a typed frame moves the earliest there', () => {
    const s = slot({}, { spear: [k(0.1, { p: [0, 1, 0] }), k(0.4)] })
    const e = keysToFrame(s, [{ track: 'gear:spear', u: 0.1 }, { track: 'gear:spear', u: 0.4 }], 5, plain)!
    expect(e.tracks).toEqual([{ gear: 'spear', keys: [k(0.5, { p: [0, 1, 0] }), k(0.8)] }])
  })
})

describe('stretching, duplicating, deleting', () => {
  it('stretches by the end edge about the start, and by the start about the end', () => {
    const s = slot({ Arm: [k(0.2), k(0.3), k(0.4)] })
    const sel = keysOf(s, 'body:Arm').map(x => ({ track: 'body:Arm', u: x.u }))
    expect(stretchKeys(s, sel, 'end', 0.6, plain)!.tracks[0].keys.map(x => x.u)).toEqual([0.2, 0.4, 0.6])
    expect(stretchKeys(s, sel, 'start', 0, plain)!.tracks[0].keys.map(x => x.u)).toEqual([0, 0.2, 0.4])
    // (never under a frame long)
    const two = [{ track: 'body:Arm', u: 0.2 }, { track: 'body:Arm', u: 0.4 }]
    const squeezed = stretchKeys(slot({ Arm: [k(0.2), k(0.4)] }), two, 'end', 0.2, plain)!
    expect(spanOf(slot({ Arm: squeezed.tracks[0].keys }), squeezed.selection, plain)).toEqual([0.2, 0.3])
    // (keys a frame apart can't be squeezed at all)
    expect(stretchKeys(s, sel, 'end', 0.2, plain)).toBeNull()
  })

  it('squeezes no further than a frame between two keys of a track (none merged)', () => {
    const f30: TimeFrame = { toPlayed: u => u, toSource: v => v, frames: 30 }
    const four = slot({ Spine: [0, 1, 2, 3].map(i => k(i / 30)) })
    const all = keysOf(four, 'body:Spine').map(x => ({ track: 'body:Spine', u: x.u }))
    expect(stretchKeys(four, all, 'end', 1 / 30, f30)).toBeNull()
    const spread = slot({ Spine: [0, 2, 4].map(i => k(i / 30)) })
    const sel = keysOf(spread, 'body:Spine').map(x => ({ track: 'body:Spine', u: x.u }))
    const e = stretchKeys(spread, sel, 'end', 1 / 30, f30)!
    expect(e.tracks[0].keys.map(x => Math.round(x.u * 30))).toEqual([0, 1, 2])
    expect(e.selection.length).toBe(3)
    // (free, it goes down to a frame and keeps every key)
    expect(stretchKeys(four, all, 'end', 1 / 30, f30, { free: true })!.tracks[0].keys.length).toBe(4)
  })

  it('duplicates just after itself, the copies selected; no room, nothing', () => {
    const s = slot({ Arm: [k(0.2), k(0.3)] })
    const sel = [{ track: 'body:Arm', u: 0.2 }, { track: 'body:Arm', u: 0.3 }]
    const e = duplicateKeys(s, sel, plain)!
    expect(e.tracks[0].keys.map(x => x.u)).toEqual([0.2, 0.3, 0.4, 0.5])
    expect(e.selection).toEqual([{ track: 'body:Arm', u: 0.4 }, { track: 'body:Arm', u: 0.5 }])
    expect(duplicateKeys(slot({ Arm: [k(0.9), k(1)] }), [{ track: 'body:Arm', u: 0.9 }, { track: 'body:Arm', u: 1 }], plain)).toBeNull()
  })

  it('deletes across tracks (a track left empty goes)', () => {
    const s = slot({ Arm: [k(0.2), k(0.3)] }, { spear: [k(0.2)] })
    const e = deleteKeys(s, [{ track: 'body:Arm', u: 0.3 }, { track: 'gear:spear', u: 0.2 }])!
    expect(e.tracks).toEqual([{ bone: 'Arm', keys: [k(0.2)] }, { gear: 'spear', keys: [] }])
  })
})

describe('keys put inside a hold (its whole played span is one source moment)', () => {
  // (a second of source with half a second held at its middle: 45 frames played, the hold frames 15-30)
  const map = resolveTime({ seconds: 1, speed: 1, time: { holds: [{ id: 'h', u: 0.5, seconds: 0.5 }] } })
  const held: TimeFrame = { toPlayed: map.toPlayed, toSource: map.toSource, frames: 45 }
  const distinct = (keys: ClipKey[]): boolean => keys.every((x, i) => i === 0 || x.u - keys[i - 1].u >= 1e-6)

  it('moves two keys into it without merging them', () => {
    const s = slot({ Spine: [k(0.3), k(0.4), k(0.8)] })
    const sel = [{ track: 'body:Spine', u: 0.3 }, { track: 'body:Spine', u: 0.4 }]
    const e = moveKeys(s, sel, 0.2, held, { free: true })!
    const keys = e.tracks[0].keys
    expect(keys.length).toBe(3)
    expect(distinct(keys)).toBe(true)
    expect(keys[0].u).toBe(0.5)
    expect(keys[1].u).toBeCloseTo(0.5, 5)
    expect(e.selection.length).toBe(2)
  })

  it('pastes, duplicates and types a frame into it, every key kept', () => {
    const s = slot({ Spine: [k(0.1), k(0.2)] })
    const sel = [{ track: 'body:Spine', u: 0.1 }, { track: 'body:Spine', u: 0.2 }]
    const clip = copyKeys(s, sel, held)
    const pasted = pasteKeys(slot({}), clip, 18, held)!
    expect(pasted.tracks[0].keys.length).toBe(2)
    expect(distinct(pasted.tracks[0].keys)).toBe(true)
    expect(pasted.selection.length).toBe(2)
    const typed = keysToFrame(s, sel, 17, held)!
    expect(typed.tracks[0].keys.length).toBe(2)
    expect(distinct(typed.tracks[0].keys)).toBe(true)
    const close = slot({ Spine: [k(0.4), k(0.45)] })
    const dup = duplicateKeys(close, [{ track: 'body:Spine', u: 0.4 }, { track: 'body:Spine', u: 0.45 }], held)!
    expect(dup.tracks[0].keys.length).toBe(4)
    expect(distinct(dup.tracks[0].keys)).toBe(true)
  })
})

describe('copy and paste in time', () => {
  it('pastes at a frame with the copied offsets, replacing keys there, into another slot too', () => {
    const s = slot({ Arm: [k(0.2, { ease: 'linear' }), k(0.4)], Leg: [k(0.3)] })
    const clip = copyKeys(s, [{ track: 'body:Arm', u: 0.2 }, { track: 'body:Leg', u: 0.3 }], plain)
    expect(clip.items.map(i => [i.track, i.frames])).toEqual([['body:Arm', 0], ['body:Leg', 1]])
    const e = pasteKeys(s, clip, 6, plain)!
    expect(e.tracks).toEqual([{ bone: 'Arm', keys: [k(0.2, { ease: 'linear' }), k(0.4), k(0.6, { ease: 'linear' })] }, { bone: 'Leg', keys: [k(0.3), k(0.7)] }])
    // (past the end: left out)
    expect(pasteKeys(slot({}), clip, 10, plain)!.tracks).toEqual([{ bone: 'Arm', keys: [k(1, { ease: 'linear' })] }])
    expect(pasteKeys(slot({}), clip, 6, plain, { tracks: t => t !== 'body:Leg' })!.tracks.length).toBe(1)
  })
})

describe('easing, putting, finding', () => {
  it('eases the spans of the selected keys (smooth stored as unset)', () => {
    const s = slot({ Arm: [k(0.2, { ease: 'step' }), k(0.4)] })
    expect(easeKeys(s, [{ track: 'body:Arm', u: 0.2 }], 'smooth')!.tracks[0].keys).toEqual([k(0.2), k(0.4)])
    expect(easeKeys(s, [{ track: 'body:Arm', u: 0.2 }], 'step')).toBeNull()
  })

  it('puts a key, finds keys in a box, groups moments by frame', () => {
    const s = slot({ Arm: [k(0.2)], Leg: [k(0.2), k(0.6)] })
    expect(putKey(s, 'body:Arm', k(0.2, { ease: 'hold' })).tracks[0].keys).toEqual([k(0.2, { ease: 'hold' })])
    expect(keysIn(s, ['body:Arm', 'body:Leg'], 0.5, 0.1, plain)).toEqual([{ track: 'body:Arm', u: 0.2 }, { track: 'body:Leg', u: 0.2 }])
    const m = momentsOf(s, ['body:Arm', 'body:Leg'], plain)
    expect(m.map(x => [x.v, x.keys.length])).toEqual([[0.2, 2], [0.6, 1]])
  })
})

describe('retime markers from a stretch', () => {
  let n = 0
  const id = (): string => `m${++n}`
  it('stretches the source span in the warp, the outside kept', () => {
    const ms = stretchMarkers(undefined, 0.2, 0.4, 'end', 1.5, id)!
    expect(ms.map(m => [m.u, m.to])).toEqual([[0.2, 0.2], [0.4, 0.5]])
    expect(warpAt(ms, 0.3)).toBeCloseTo(0.35, 9)
    // (again on those markers: their ids kept, the inside scaled)
    const again = stretchMarkers(ms, 0.2, 0.4, 'end', 0.5, id)!
    expect(again.map(m => [m.id, m.u, m.to])).toEqual([[ms[0].id, 0.2, 0.2], [ms[1].id, 0.4, 0.35]])
  })

  it('lands the dragged edge where it was dragged with a hold inside the span (warpFactor)', () => {
    const time = { holds: [{ id: 'h', u: 0.3, seconds: 0.5 }] }
    const map = resolveTime({ seconds: 1, speed: 1, time })
    const from = 0.2; const to = 0.4
    const span: [number, number] = [map.toPlayed(from), map.toPlayed(to)]
    const target = 0.8
    const factor = (target - span[0]) / (span[1] - span[0])
    const warp = warpFactor(map, time.holds, from, to, factor)!
    const ms = stretchMarkers(undefined, from, to, 'end', warp, id)!
    const after = resolveTime({ seconds: 1, speed: 1, time: { ...time, markers: ms } })
    expect(after.toPlayed(to)).toBeCloseTo(target, 6)
    expect(after.toPlayed(from)).toBeCloseTo(span[0], 9)
    // (squeezed below the hold's own length: refused)
    expect(warpFactor(map, time.holds, from, to, 0.1)).toBeNull()
  })

  it('refuses a moving edge at the clip ends or running past the end', () => {
    expect(stretchMarkers(undefined, 0, 1, 'end', 1.2, id)).toBeNull()
    expect(stretchMarkers(undefined, 0.5, 0.9, 'end', 3, id)).toBeNull()
    expect(stretchMarkers(undefined, 0, 0.5, 'end', 1.2, id)!.map(m => [m.u, m.to])).toEqual([[0.5, 0.6]])
  })
})
