import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import { clipSlots, dressedCharacter } from './stances.ts'

describe('stance clip slots', () => {
  it('uses ordered overrides and falls back to the base and numbered variants', () => {
    const c = makeCharacter({ clips: [makeSlot({ id: 'base', name: 'Idle' }), makeSlot({ id: 'trial', name: 'Trial' }), makeSlot({ id: 'v3', name: 'Idle 3' }), makeSlot({ id: 'v2', name: 'Idle 2' })] })
    c.folk = { sets: [], pools: [], kinds: [], stances: [{ id: 'shield', name: 'Shield', clips: { Idle: ['trial'] } }] }
    expect(clipSlots(c, 'shield', 'Idle').map(x => x.id)).toEqual(['trial'])
    expect(clipSlots(c, null, 'Idle').map(x => x.id)).toEqual(['base', 'v2', 'v3'])
    expect(clipSlots(c, 'shield', 'Missing')).toEqual([])
  })
})

it('previews no set without hiding gear outside sets', () => {
  const c = makeCharacter({ gear: [makeGear({ id: 'shield' }), makeGear({ id: 'spear' }), makeGear({ id: 'amulet' })] })
  c.folk = { sets: [{ id: 'guard', name: 'Guard', pieces: ['shield'], tags: [], grants: [] }, { id: 'scout', name: 'Scout', pieces: ['spear'], tags: [], grants: [] }], pools: [], kinds: [], stances: [] }
  const none = dressedCharacter(c, null)
  expect(none.gear.map(g => g.hidden ?? false)).toEqual([true, true, false])
  const guard = dressedCharacter(c, 'guard')
  expect(guard.gear.map(g => g.hidden ?? false)).toEqual([false, true, false])
  expect(c.gear.every(g => !g.hidden)).toBe(true)
})

it('uses stage visibility for the document set, preview overrides, and roles', () => {
  const c = makeCharacter({ gear: [
    makeGear({ id: 'vest' }), makeGear({ id: 'shield', hidden: true }),
    makeGear({ id: 'hair-old', role: 'hair' }), makeGear({ id: 'hair-new', role: 'hair', hidden: true }),
    makeGear({ id: 'other' }),
  ], folk: { sets: [{ id: 'guard', name: 'Guard', pieces: ['vest', 'shield'], tags: [], grants: [] }], pools: [], kinds: [], stances: [] } })
  const hidden = (preview?: Parameters<typeof dressedCharacter>[2]): boolean[] =>
    dressedCharacter(c, 'guard', preview).gear.map(g => g.hidden === true)
  expect(hidden()).toEqual([false, true, false, true, false])
  expect(hidden({ off: ['vest'], on: ['shield'], hair: 'hair-new' })).toEqual([true, false, true, false, false])
})
