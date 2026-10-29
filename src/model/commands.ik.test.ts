// @vitest-environment node
// slot.ik (docs/motion-plan.md §2.6): hands kept on handles by the bake's build, leading gear, the floor; its rules, its
// journal lines, and what other commands do to it (a fill drops it, a copy carries it, a set copied in maps it by name,
// gear and handles removed take their references with them).
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommand, applyCommands, CommandError } from './commands.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import type { Character, Gear, Placement } from './types.ts'

function failure (f: () => unknown): { status: number, message: string } {
  try { f() } catch (e) {
    if (e instanceof CommandError) return { status: e.status, message: e.message }
    throw e
  }
  throw new Error('it did not fail')
}

const place: Placement = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
const spear = (over: Partial<Gear> = {}): Gear => makeGear({
  id: 'spear', name: 'Spear', attach: { kind: 'bone', bone: 'RightHand', place },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' },
    { id: 'grip', name: 'grip L', kind: 'grip', hand: 'Left', place: { position: [0, 0.3, 0], rotation: [0, 0, 0, 1] } },
    { id: 'pull', name: 'Pull', kind: 'pull', pull: { bone: 'LeftHand', grip: [0, 0, 0], rest: [0, 0, 0] } },
  ],
  ...over,
})
const atk = makeSlot({ id: 'atk', name: 'Attack', loop: false })
const base = (): Character => makeCharacter({ gear: [spear(), makeGear({ id: 'cape', name: 'Cape', attach: { kind: 'skin' } as Gear['attach'] })], clips: [atk, makeSlot({ id: 'walk', name: 'Walk' })] })
const ik = (patch: Extract<Command, { type: 'slot.ik' }>['patch']): Command => ({ type: 'slot.ik', slot: 'atk', patch })

describe('slot.ik', () => {
  it('puts hands on handles and makes gear lead, each part whole, in plain words', () => {
    const r = applyCommand(base(), ik({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip', windows: [[0.2, 0.8]] }], lead: ['spear'] }))
    expect(r.character.clips[0].ik).toEqual({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip', windows: [[0.2, 0.8]] }], lead: ['spear'] })
    expect(r.changes).toEqual(['clip Attack: Left hand on Spear · grip L in 20%-80% and Spear leads'])
    const floor = applyCommand(r.character, ik({ floor: false, lead: null }))
    expect(floor.character.clips[0].ik).toEqual({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip', windows: [[0.2, 0.8]] }], floor: false })
    expect(floor.changes).toEqual(['clip Attack: Spear no longer leads', 'clip Attack: a foot the build sinks left under the floor'])
    const gone = applyCommand(floor.character, ik({ hands: null }))
    expect(gone.character.clips[0].ik).toBeUndefined()
    expect(gone.changes).toEqual(['clip Attack: Left hand off Spear · grip L in 20%-80%'])
    // (the same again changes nothing)
    expect(applyCommand(r.character, ik({ lead: ['spear'] })).changes).toEqual([])
  })

  it('refuses what no hand can hold', () => {
    const bad = (patch: Extract<Command, { type: 'slot.ik' }>['patch']): number => failure(() => applyCommand(base(), ik(patch))).status
    expect(bad({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip' }, { hand: 'Left', gear: 'spear', handle: 'carry' }] })).toBe(400)
    expect(bad({ hands: [{ hand: 'Left', gear: 'spear', handle: 'pull' }] })).toBe(400)
    expect(bad({ hands: [{ hand: 'Left', gear: 'spear', handle: 'nope' }] })).toBe(404)
    expect(bad({ hands: [{ hand: 'Left', gear: 'nope', handle: 'grip' }] })).toBe(404)
    expect(bad({ lead: ['cape'] })).toBe(400)
    expect(bad({ lead: ['spear', 'spear'] })).toBe(400)
    expect(bad({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip', windows: [[0.5, 0.2]] }] })).toBe(400)
    expect(bad({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip', windows: [[0.1, 0.5], [0.4, 0.6]] }] })).toBe(400)
    expect(bad({ hands: [{ hand: 'Middle' as 'Left', gear: 'spear', handle: 'grip' }] })).toBe(400)
    expect(failure(() => applyCommand(base(), { type: 'slot.ik', slot: 'atk', patch: { wings: true } as never })).status).toBe(400)
  })

  it('goes with a fill, comes with a copy, and is mapped by name when a set is copied in', () => {
    const held = applyCommand(base(), ik({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip' }], lead: ['spear'] })).character
    const filled = applyCommand(held, { type: 'slot.fill', id: 'atk', clip: { id: 'other' } })
    expect(filled.character.clips[0].ik).toBeUndefined()
    expect(filled.changes.some(x => x.includes('hands on gear'))).toBe(true)
    expect(applyCommand(held, { type: 'slot.fill', id: 'atk', clip: { id: 'other' }, keepAdjustments: true }).character.clips[0].ik).toBeDefined()
    const copied = applyCommand(held, { type: 'slot.copy', from: 'atk', to: 'walk' })
    expect(copied.character.clips[1].ik).toEqual(held.clips[0].ik)
    // (another character's set: its spear by name, its grip by name)
    const other = makeCharacter({ gear: [spear({ id: 'sp2', handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' }, { id: 'g9', name: 'grip L', kind: 'grip', hand: 'Left', place: { position: [0, 0, 0], rotation: [0, 0, 0, 1] } }] })] })
    const replaced = applyCommand(other, { type: 'clips.replace', slots: [held.clips[0]], gearNames: { spear: 'Spear' }, handleNames: { 'spear/grip': 'grip L' } })
    expect(replaced.character.clips[0].ik).toEqual({ hands: [{ hand: 'Left', gear: 'sp2', handle: 'g9' }], lead: ['sp2'] })
    const none = applyCommand(makeCharacter(), { type: 'clips.replace', slots: [held.clips[0]], gearNames: { spear: 'Spear' } })
    expect(none.character.clips[0].ik).toBeUndefined()
    expect(none.changes).toContain('clip Attack: Left hand on Spear dropped (no such gear here)')
  })

  it('loses what pointed at gear or a handle that went', () => {
    const held = applyCommand(base(), ik({ hands: [{ hand: 'Left', gear: 'spear', handle: 'grip' }], lead: ['spear'] })).character
    const handle = applyCommand(held, { type: 'gear.handle.remove', gear: 'spear', id: 'grip' })
    expect(handle.character.clips[0].ik).toEqual({ hands: [], lead: ['spear'] })
    expect(handle.changes).toContain('clip Attack: Left hand off Spear (its handle went)')
    const removed = applyCommands(held, [{ type: 'gear.remove', id: 'spear' }])
    expect(removed.character.clips[0].ik).toBeUndefined()
    const off = applyCommand(held, { type: 'gear.attach', id: 'spear', attach: { kind: 'skin', policy: 'body', place } as never })
    expect(off.character.clips[0].ik).toBeUndefined()
  })
})
