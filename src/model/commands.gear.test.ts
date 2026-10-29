// @vitest-environment node
// slot.gear.update's holders (docs/motion-plan.md §4; src/engine/geartracks.ts plays them): a handle of the piece on
// the hand it is for, its Gear placement on its own bone, and a set copied in by name keeping its handles.
import { describe, expect, it } from 'vitest'
import { applyCommand, CommandError } from './commands.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import type { Character } from './types.ts'

const spear = makeGear({
  id: 'spear', name: 'Spear', attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' },
    { id: 'front', name: 'Front', kind: 'grip', hand: 'Left', place: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] } },
    { id: 'draw', name: 'Draw', kind: 'pull', hand: 'Left', pull: { bone: 'LeftHand', grip: [0, 0, 0], rest: [0, 0, 0] } },
  ],
})
const base = (): Character => makeCharacter({ gear: [spear], clips: [makeSlot({ id: 'atk', name: 'Attack' })] })
const status = (f: () => unknown): number => {
  try { f() } catch (e) { if (e instanceof CommandError) return e.status; throw e }
  return 200
}
const update = (heldBy: unknown): ReturnType<typeof applyCommand> => applyCommand(base(), { type: 'slot.gear.update', slot: 'atk', gear: 'spear', patch: { heldBy: heldBy as never } })

describe('slot.gear.update: holders', () => {
  it('takes a handle on the hand it is for, and the Gear placement on the piece\'s own bone', () => {
    const r = update([{ u: 0.3, bone: 'LeftHand', handle: 'front' }, { u: 0.7, bone: 'RightHand', placed: true }])
    expect(r.character.clips[0].gear!.spear.heldBy).toEqual([{ u: 0.3, bone: 'LeftHand', handle: 'front' }, { u: 0.7, bone: 'RightHand', placed: true }])
    expect(update([{ u: 0.3, bone: 'RightHand', handle: 'carry' }]).character.clips[0].gear!.spear.heldBy).toEqual([{ u: 0.3, bone: 'RightHand', handle: 'carry' }])
  })

  it('refuses a handle another hand holds, a pull, a missing one, a placement off its bone, and two ways at once', () => {
    expect(status(() => update([{ u: 0.3, bone: 'RightHand', handle: 'front' }]))).toBe(400)
    expect(status(() => update([{ u: 0.3, bone: 'LeftHand', handle: 'draw' }]))).toBe(400)
    expect(status(() => update([{ u: 0.3, bone: 'LeftHand', handle: 'nope' }]))).toBe(404)
    expect(status(() => update([{ u: 0.3, bone: 'LeftHand', placed: true }]))).toBe(400)
    expect(status(() => update([{ u: 0.3, bone: 'LeftHand', handle: 'front', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }]))).toBe(400)
    expect(status(() => update([{ u: 0.3, bone: 'LeftHand', grip: 'front' }]))).toBe(400)
  })

  it('keeps a handle by its name when a set is copied in, and holds where it is without one', () => {
    const c = base()
    const slots = [makeSlot({ id: 'x', name: 'Attack', gear: { other: { heldBy: [{ u: 0.3, bone: 'LeftHand', handle: 'h9' }, { u: 0.6, bone: 'RightHand', handle: 'h8' }] } } })]
    const r = applyCommand(c, { type: 'clips.replace', slots, gearNames: { other: 'Spear' }, handleNames: { 'other/h9': 'Front' } })
    expect(r.character.clips[0].gear!.spear.heldBy).toEqual([{ u: 0.3, bone: 'LeftHand', handle: 'front' }, { u: 0.6, bone: 'RightHand' }])
    expect(r.changes.some(x => x.includes('held by RightHand where it is'))).toBe(true)
  })
})
