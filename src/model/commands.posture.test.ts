// The adjustments of docs/motion-plan.md §12 through slot.adjust.*: posture and layer, their rules and words, a weight
// only where one means something, a layer playing another slot followed like a slot piece (cycles refused, a layered
// slot kept from removal, ids mapped by freshSet, a layer of a clip not in the set dropped by clips.replace), and piece
// edits carrying their windows.
import { describe, expect, it } from 'vitest'
import { applyCommand, CommandError } from './commands.ts'
import { makeCharacter, makeSlot } from './fixtures.ts'
import { bakeCycle, slotsUnder } from './pieces.ts'
import { freshSet } from './select.ts'
import type { Adjustment, Character, Piece } from './types.ts'
import { envelope } from './envelope.ts'

function failure (f: () => unknown): { status: number, message: string } {
  try { f() } catch (e) {
    if (e instanceof CommandError) return { status: e.status, message: e.message }
    throw e
  }
  throw new Error('it did not fail')
}

function base (): Character {
  return makeCharacter({
    clips: [
      makeSlot({ id: 'atk', name: 'Attack', clip: { id: 'mixamo-Slash' }, loop: false }),
      makeSlot({ id: 'run', name: 'Run', clip: { id: 'mixamo-Run' } }),
      makeSlot({ id: 'idle', name: 'Idle', clip: { id: 'mixamo-Idle' } }),
    ],
  })
}
const add = (c: Character, slot: string, adjustment: unknown): ReturnType<typeof applyCommand> =>
  applyCommand(c, { type: 'slot.adjust.add', slot, adjustment: adjustment as Adjustment })

describe('posture', () => {
  it('is added in words, its windows and fade kept, a weight of 1 not stored', () => {
    const r = add(base(), 'run', { id: 'p', kind: 'posture', part: 'lean', amount: 12, windows: [[0.2, 0.45]], fade: 0.1, weight: 1 })
    expect(r.character.clips[1].adjustments).toEqual([{ id: 'p', enabled: true, kind: 'posture', part: 'lean', amount: 12, windows: [[0.2, 0.45]], fade: 0.1 }])
    expect(r.changes).toEqual(['clip Run: lean 12° forward in 20%-45% added'])
    const back = add(base(), 'run', { id: 'p', kind: 'posture', part: 'armsOut', amount: -8, weight: 0.5 })
    expect(back.changes).toEqual(['clip Run: arms 8° in in the whole clip at 50% added'])
  })

  it('refuses a part it has not, a turn past 90°, empty windows and a weight on a hand pose', () => {
    expect(failure(() => add(base(), 'run', { id: 'p', kind: 'posture', part: 'knees', amount: 5 })).message).toMatch(/part must be one of/)
    expect(failure(() => add(base(), 'run', { id: 'p', kind: 'posture', part: 'lean', amount: 120 })).message).toMatch(/at most 90/)
    expect(failure(() => add(base(), 'run', { id: 'p', kind: 'posture', part: 'lean', amount: 5, windows: [] })).message).toMatch(/can't be empty/)
    expect(failure(() => add(base(), 'run', { id: 'h', kind: 'handPose', hand: 'Left', pose: 'clip', weight: 0.5 })).message).toMatch(/takes no weight/)
    expect(failure(() => add(base(), 'run', { id: 'g', kind: 'ground', lift: 0.1, weight: 2 })).message).toMatch(/at most 1/)
  })

  it('takes a weight by update, and an update of null takes it off', () => {
    const c = add(base(), 'run', { id: 'g', kind: 'ground', lift: 0.02 }).character
    const r = applyCommand(c, { type: 'slot.adjust.update', slot: 'run', id: 'g', patch: { weight: 0.25 } })
    expect(r.character.clips[1].adjustments[0].weight).toBe(0.25)
    expect(r.changes).toEqual(['clip Run: ground lift 0.02 -> ground lift 0.02 at 25%'])
    expect(applyCommand(r.character, { type: 'slot.adjust.update', slot: 'run', id: 'g', patch: { weight: null } }).character.clips[1].adjustments[0].weight).toBeUndefined()
  })
})

describe('layer', () => {
  it('plays a library clip or another slot on parts of the body, in words', () => {
    const r = add(base(), 'run', { id: 'l', kind: 'layer', play: { kind: 'slot', slot: 'atk' }, mask: ['head', 'torso', 'rightArm', 'leftArm'], windows: [[0.5, 1]], offset: 0.2 })
    // (the mask kept in the parts' own order)
    expect(r.character.clips[1].adjustments[0]).toMatchObject({ kind: 'layer', mask: ['torso', 'head', 'leftArm', 'rightArm'], offset: 0.2 })
    expect(r.changes).toEqual(['clip Run: layer Attack on upper body in 50%-100% added'])
    expect(add(base(), 'run', { id: 'l', kind: 'layer', play: { kind: 'clip', clip: { id: 'mixamo-Wave' } }, mask: ['rightArm'], loop: true }).changes)
      .toEqual(['clip Run: layer mixamo-Wave on right arm in the whole clip added'])
  })

  it('refuses an empty or repeated mask, itself, a clip not there, and a cycle through other slots', () => {
    const layer = (slot: string, mask: string[] = ['torso']): unknown => ({ id: 'l', kind: 'layer', play: { kind: 'slot', slot }, mask })
    expect(failure(() => add(base(), 'run', layer('atk', []))).message).toMatch(/can't be empty/)
    expect(failure(() => add(base(), 'run', layer('atk', ['torso', 'torso']))).message).toMatch(/twice/)
    expect(failure(() => add(base(), 'run', layer('run'))).message).toMatch(/can't play itself as a layer/)
    expect(failure(() => add(base(), 'run', layer('nope'))).status).toBe(404)
    const one = add(base(), 'run', layer('atk')).character
    expect(failure(() => add(one, 'atk', layer('run'))).message).toMatch(/would play itself/)
    // (a slot piece back round counts too)
    const piece: Piece = { id: 'p', kind: 'slot', slot: 'run', from: 0, to: 1 }
    expect(failure(() => applyCommand(one, { type: 'slot.pieces.set', slot: 'atk', pieces: [piece], seconds: 2 })).message).toMatch(/play itself/)
    expect(bakeCycle(one)).toBeNull()
    expect(slotsUnder(one, one.clips[1]).map(s => s.id)).toEqual(['atk'])
  })

  it('keeps the slot it plays from being removed, and follows it through freshSet', () => {
    const c = add(base(), 'run', { id: 'l', kind: 'layer', play: { kind: 'slot', slot: 'atk' }, mask: ['torso'] }).character
    expect(failure(() => applyCommand(c, { type: 'slot.remove', id: 'atk' })).message).toMatch(/plays Attack as a layer/)
    let n = 0
    const copy = freshSet(c.clips, () => `n${++n}`)
    const layer = copy[1].adjustments[0] as Extract<Adjustment, { kind: 'layer' }>
    expect(layer.play).toEqual({ kind: 'slot', slot: copy[0].id })
  })

  it('moves its windows with its piece when the pieces change', () => {
    const c = add(base(), 'run', { id: 'l', kind: 'layer', play: { kind: 'clip', clip: { id: 'mixamo-Wave' } }, mask: ['torso'], windows: [[0.5, 1]] }).character
    const p = add(c, 'run', { id: 'p', kind: 'posture', part: 'nod', amount: 10 }).character
    // (1 s of Run, then 1 s held: Run is the first half now, so its windows halve)
    const pieces: Piece[] = [{ id: 'main', kind: 'clip', clip: { id: 'mixamo-Run' }, from: 0, to: 1 }, { id: 'h', kind: 'hold', from: 0, to: 1 }]
    const r = applyCommand(p, { type: 'slot.pieces.set', slot: 'run', pieces, seconds: 1 })
    const [layer, posture] = r.character.clips[1].adjustments
    expect((layer as Extract<Adjustment, { kind: 'layer' }>).windows).toEqual([[0.25, 0.5]])
    expect((posture as Extract<Adjustment, { kind: 'posture' }>).windows).toBeUndefined()
  })
})

describe('the envelope', () => {
  it('is 1 inside a window, ramps over the fade, at most half the window, 0 outside', () => {
    expect(envelope(0.3, undefined)).toBe(1)
    expect(envelope(0.1, [[0.2, 0.6]], 0.1)).toBe(0)
    expect(envelope(0.2, [[0.2, 0.6]], 0.1)).toBe(0)
    expect(envelope(0.25, [[0.2, 0.6]], 0.1)).toBeCloseTo(0.5, 6)
    expect(envelope(0.4, [[0.2, 0.6]], 0.1)).toBe(1)
    expect(envelope(0.55, [[0.2, 0.6]], 0.1)).toBeCloseTo(0.5, 6)
    expect(envelope(0.4, [[0.2, 0.6]], 1)).toBe(1)
    expect(envelope(0.3, [[0.2, 0.6]])).toBe(1)
  })
})
