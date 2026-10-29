// @vitest-environment node
// A piece's holders kept fitting it (review fixes): a handle removed or moved to the other hand, or the piece moved to
// another bone, mends the slots' heldBy (as slot.ik is pruned) so the strip can still be edited; slot.add, slot.fill and
// clips.replace check holders and keyed bones as slot.gear.update and slot.keys.set do; no two slots may play under
// one name in the game (`Attack 2` and `Attack_2`).
import { describe, expect, it } from 'vitest'
import { applyCommand, CommandError } from './commands.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import type { Character, HeldBy } from './types.ts'

const spear = makeGear({
  id: 'spear', name: 'Spear', attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' },
    { id: 'front', name: 'Front', kind: 'grip', hand: 'Left', place: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] } },
  ],
})
const held: HeldBy[] = [{ u: 0.2, bone: 'LeftHand', handle: 'front' }, { u: 0.5, bone: 'RightHand', handle: 'carry' }, { u: 0.8, bone: 'RightHand', placed: true }]
const base = (): Character => makeCharacter({ gear: [structuredClone(spear)], clips: [makeSlot({ id: 'atk', name: 'Attack', gear: { spear: { heldBy: structuredClone(held) } } })] })
const status = (f: () => unknown): number => {
  try { f() } catch (e) { if (e instanceof CommandError) return e.status; throw e }
  return 200
}
const heldOf = (c: Character): HeldBy[] | undefined => c.clips[0].gear?.spear?.heldBy
/** The strip resent as it is (what the timeline does on any edit of it): refused if a holder is stale. */
const resend = (c: Character): number => status(() => applyCommand(c, { type: 'slot.gear.update', slot: 'atk', gear: 'spear', patch: { heldBy: heldOf(c) as never } }))

describe('holders kept fitting their piece', () => {
  it('holds where it is once its handle is removed', () => {
    const r = applyCommand(base(), { type: 'gear.handle.remove', gear: 'spear', id: 'front' })
    expect(heldOf(r.character)?.[0]).toEqual({ u: 0.2, bone: 'LeftHand' })
    expect(r.changes.some(x => x.includes('where it is'))).toBe(true)
    expect(resend(r.character)).toBe(200)
  })

  it("follows a grip moved to the other hand, and the piece moved to another bone (its carry handle's and placement's)", () => {
    const grip = applyCommand(base(), { type: 'gear.handle.update', gear: 'spear', id: 'front', patch: { hand: 'Right' } })
    expect(heldOf(grip.character)?.[0]).toEqual({ u: 0.2, bone: 'RightHand', handle: 'front' })
    expect(resend(grip.character)).toBe(200)
    const moved = applyCommand(base(), { type: 'gear.attach', id: 'spear', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } } })
    expect(heldOf(moved.character)?.slice(1)).toEqual([{ u: 0.5, bone: 'LeftHand', handle: 'carry' }, { u: 0.8, bone: 'LeftHand', placed: true }])
    expect(resend(moved.character)).toBe(200)
    const back = applyCommand(base(), { type: 'gear.attach', id: 'spear', attach: { kind: 'bone', bone: 'Spine2', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } } })
    // (off the hands it has no carry handle: held where it is)
    expect(heldOf(back.character)?.slice(1)).toEqual([{ u: 0.5, bone: 'RightHand' }, { u: 0.8, bone: 'Spine2', placed: true }])
    expect(resend(back.character)).toBe(200)
  })

  it('leaves holders that fit as they are', () => {
    const r = applyCommand(base(), { type: 'gear.handle.update', gear: 'spear', id: 'front', patch: { name: 'Fore' } })
    expect(heldOf(r.character)).toEqual(held)
  })
})

describe('slot.add, slot.fill and clips.replace check tracks', () => {
  it('refuses a holder that does not fit or a bone the skeleton lacks, on add and fill', () => {
    const c = makeCharacter({ gear: [structuredClone(spear)] })
    const add = (gear: unknown, bones?: unknown): number => status(() => applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'n', name: 'New', gear: gear as never, bones: bones as never }) }))
    expect(add({ spear: { heldBy: [{ u: 0.2, bone: 'RightHand', handle: 'front' }] } })).toBe(400)
    expect(add({ spear: { heldBy: [{ u: 0.2, bone: 'LeftHand', handle: 'nope' }] } })).toBe(404)
    expect(add({ spear: { heldBy: [{ u: 0.2, bone: 'Wing' }] } })).toBe(400)
    expect(add(undefined, { Wing: [{ u: 0, q: [0, 0, 0, 1] }] })).toBe(400)
    expect(add({ spear: { heldBy: [{ u: 0.2, bone: 'LeftHand', handle: 'front' }] } })).toBe(200)
    const fill = (gear: unknown): number => status(() => applyCommand(c, { type: 'slot.fill', name: 'New', newId: 'n', clip: { id: 'x' }, gear: gear as never }))
    expect(fill({ spear: { heldBy: [{ u: 0.2, bone: 'LeftHand', placed: true }] } })).toBe(400)
    expect(fill({ spear: { heldBy: [{ u: 0.2, bone: 'RightHand', placed: true }] } })).toBe(200)
  })

  it('drops on clips.replace what this skeleton or piece cannot take, and says so', () => {
    const c = makeCharacter({ gear: [structuredClone(spear)] })
    const slots = [makeSlot({
      id: 'x', name: 'Attack', bones: { Wing: [{ u: 0, q: [0, 0, 0, 1] }], Spine: [{ u: 0, q: [0, 0, 0, 1] }] },
      gear: { spear: { heldBy: [{ u: 0.1, bone: 'Tail' }, { u: 0.3, bone: 'RightHand', handle: 'front' }, { u: 0.6, bone: 'LeftHand', placed: true }] } },
    })]
    const r = applyCommand(c, { type: 'clips.replace', slots })
    expect(Object.keys(r.character.clips[0].bones ?? {})).toEqual(['Spine'])
    expect(heldOf(r.character)).toEqual([{ u: 0.3, bone: 'LeftHand', handle: 'front' }, { u: 0.6, bone: 'RightHand', placed: true }])
    expect(r.changes.some(x => x.includes('keys on Wing dropped'))).toBe(true)
    expect(r.changes.some(x => x.includes('Tail'))).toBe(true)
  })
})

describe('slot names the game plays apart', () => {
  const c = (): Character => makeCharacter({ clips: [makeSlot({ id: 'a', name: 'Attack' }), makeSlot({ id: 'a2', name: 'Attack 2' })] })

  it('refuses a slot that would export as another does, by add, copy, rename, fill or replace', () => {
    expect(status(() => applyCommand(c(), { type: 'slot.add', slot: makeSlot({ id: 'n', name: 'Attack_2' }) }))).toBe(409)
    expect(status(() => applyCommand(c(), { type: 'slot.copy', from: 'a', name: 'Attack_2', newId: 'n' }))).toBe(409)
    expect(status(() => applyCommand(c(), { type: 'slot.update', id: 'a', patch: { name: 'Attack_2' } }))).toBe(409)
    expect(status(() => applyCommand(c(), { type: 'slot.fill', name: 'Attack_2', newId: 'n', clip: { id: 'x' } }))).toBe(409)
    expect(status(() => applyCommand(c(), { type: 'clips.replace', slots: [makeSlot({ id: 'p', name: 'Die 3' }), makeSlot({ id: 'q', name: 'Die_3' })] }))).toBe(409)
  })

  it('lets a slot keep or take a name nothing else plays as', () => {
    expect(status(() => applyCommand(c(), { type: 'slot.update', id: 'a2', patch: { name: 'Attack_2' } }))).toBe(200)
    expect(status(() => applyCommand(c(), { type: 'slot.copy', from: 'a', name: 'Attack 3', newId: 'n' }))).toBe(200)
  })
})
