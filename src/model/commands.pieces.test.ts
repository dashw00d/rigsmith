// slot.pieces.set (docs/motion-plan.md §11.5): a slot's source built from pieces, everything it stores moved with its
// piece in the same command, its rules, cycles refused, one undo; and what the other slot commands do with pieces.
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommand, applyCommands, CommandError } from './commands.ts'
import { restoreEntities, undoRecord } from './entities.ts'
import { makeCharacter, makeSlot } from './fixtures.ts'
import type { Character, Piece } from './types.ts'

function failure (f: () => unknown): { status: number, message: string } {
  try { f() } catch (e) {
    if (e instanceof CommandError) return { status: e.status, message: e.message }
    throw e
  }
  throw new Error('it did not fail')
}

const q: [number, number, number, number] = [0, 0, 0, 1]
const main: Piece = { id: 'main', kind: 'clip', clip: { id: 'mixamo-Slash' }, from: 0, to: 2 }
const held: Piece = { id: 'h', kind: 'hold', from: 0, to: 0.5 }
const run: Piece = { id: 'r', kind: 'slot', slot: 'run', from: 0, to: 1, blend: 0.25 }

function base (): Character {
  return makeCharacter({
    clips: [
      makeSlot({
        id: 'atk', name: 'Attack', clip: { id: 'mixamo-Slash' }, loop: false, inPlace: false,
        bones: { Spine: [{ u: 0.25, q }, { u: 1, q }] }, events: [{ id: 'hit', name: 'hit', u: 0.5 }],
      }),
      makeSlot({ id: 'run', name: 'Run', clip: { id: 'mixamo-Run' } }),
      makeSlot({ id: 'idle', name: 'Idle', clip: { id: 'mixamo-Idle' } }),
    ],
  })
}
const set = (pieces: Piece[] | null, o: Partial<Extract<Command, { type: 'slot.pieces.set' }>> = {}): Command => ({ type: 'slot.pieces.set', slot: 'atk', pieces, ...o })

describe('slot.pieces.set', () => {
  it('lengthens a clip playing its clip whole with a held pose, its keys and events kept where they play, one undo', () => {
    const c = base()
    const r = applyCommand(c, set([main, held], { seconds: 2 }))
    const s = r.character.clips[0]
    expect(s.pieces).toEqual([main, held])
    // (2 s of clip, then 0.5 s held: what was at u of 2 s is at u·2 / 2.5)
    expect(s.bones!.Spine.map(k => k.u)).toEqual([0.2, 0.8])
    expect(s.events![0].u).toBe(0.4)
    expect(r.changes).toEqual(['clip Attack: held 0.50 s at the end (2 pieces, 2.50 s)'])
    const undo = undoRecord(c, r.character)
    expect(undo.entities.map(e => e.key)).toEqual(['slot:atk'])
    expect(restoreEntities(r.character, undo).clips).toEqual(c.clips)
  })

  it('takes a piece\'s keys with it when it is removed, and back to the clip whole stores no list', () => {
    const c = applyCommand(base(), set([main, held], { seconds: 2 })).character
    // (a key keyed in the hold)
    const keyed = applyCommand(c, { type: 'slot.keys.set', slot: 'atk', tracks: [{ bone: 'Hips', keys: [{ u: 0.2, q }, { u: 0.9, q }] }] }).character
    const r = applyCommand(keyed, set(null, { seconds: 2 }))
    const s = r.character.clips[0]
    expect(s.pieces).toBeUndefined()
    expect(s.bones!.Hips.map(k => k.u)).toEqual([0.25])
    expect(s.bones!.Spine.map(k => k.u)).toEqual([0.25, 1])
    expect(r.changes[1]).toMatch(/1 key, event or window on what went, gone with it/)
    // (the same list as its clip whole is no list either)
    expect(applyCommand(keyed, set([main], { seconds: 2 })).character.clips[0].pieces).toBeUndefined()
  })

  it('appends another slot as it plays, blended, and keeps keys on the first piece where they are', () => {
    const r = applyCommand(base(), set([main, run], { seconds: 2 }))
    const s = r.character.clips[0]
    expect(s.bones!.Spine.map(k => k.u * 2.75)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(2, 6)])
    expect(r.changes[0]).toBe('clip Attack: Run as it plays at the end, blend 0.25 s (2 pieces, 2.75 s)')
  })

  it('splits a piece where time is put in, each key to the part that holds its moment', () => {
    const r = applyCommand(base(), set([{ ...main, to: 1 }, held, { ...main, id: 'b', from: 1 }], { seconds: 2, split: { b: 'main' } }))
    expect(r.character.clips[0].bones!.Spine.map(k => k.u * 2.5)).toEqual([expect.closeTo(0.5, 6), expect.closeTo(2.5, 6)])
    expect(r.character.clips[0].events![0].u).toBe(0.6)
  })

  it('refuses what breaks the rules: no length for a clip played whole, a bad list, a slot playing itself', () => {
    const c = base()
    expect(failure(() => applyCommand(c, set([main, held]))).message).toMatch(/seconds/)
    expect(failure(() => applyCommand(c, set([held], { seconds: 2 }))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([main, { ...held, blend: 1 }], { seconds: 2 }))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([main, { ...run, slot: 'atk' }], { seconds: 2 }))).message).toMatch(/itself/)
    expect(failure(() => applyCommand(c, set([main, { ...run, slot: 'gone' }], { seconds: 2 }))).status).toBe(404)
    // (Run plays Attack: Attack can't then play Run)
    const loop = applyCommand(c, { type: 'slot.pieces.set', slot: 'run', seconds: 1, pieces: [{ id: 'main', kind: 'clip', clip: { id: 'mixamo-Run' }, from: 0, to: 1 }, { id: 'a', kind: 'slot', slot: 'atk', from: 0, to: 1 }] }).character
    expect(failure(() => applyCommand(loop, set([main, run], { seconds: 2 }))).message).toMatch(/would play itself/)
    expect(failure(() => applyCommand(c, set([main, held], { seconds: 2, split: { x: 'main' } }))).status).toBe(400)
  })

  it('leaves the pieces to the other commands\' rules: fill drops them, remove refuses a slot played as a piece, copy refuses a cycle', () => {
    const c = applyCommand(base(), set([main, run], { seconds: 2 })).character
    expect(failure(() => applyCommand(c, { type: 'slot.remove', id: 'run' })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'slot.copy', from: 'atk', to: 'run' })).message).toMatch(/itself/)
    const copied = applyCommand(c, { type: 'slot.copy', from: 'atk', name: 'Attack 2', newId: 'atk2' }).character
    expect(copied.clips[3].pieces).toEqual([main, run])
    const filled = applyCommand(c, { type: 'slot.fill', id: 'atk', clip: { id: 'mixamo-Kick' }, keepAdjustments: true })
    expect(filled.character.clips[0].pieces).toBeUndefined()
    expect(filled.changes).toContain('clip Attack: its 2 pieces dropped (it plays mixamo-Kick now)')
    // (a set without Run: the piece playing it goes, with what was on it)
    const replaced = applyCommands(c, [{ type: 'clips.replace', slots: [c.clips[0], c.clips[2]] }]).character
    expect(replaced.clips[0].pieces).toEqual([main])
  })

  it('takes a slot with its pieces in slot.add and clips.replace', () => {
    const c = base()
    const added = applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'new', name: 'Combo', pieces: [main, { ...run, slot: 'atk' }] }) })
    expect(added.character.clips[3].pieces).toHaveLength(2)
    expect(failure(() => applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'new', name: 'Combo', pieces: [main, { ...run, slot: 'new' }] }) })).status).toBe(400)
  })
})
