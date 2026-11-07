import { describe, expect, it } from 'vitest'
import { makeCharacter, makeSlot } from './fixtures.ts'
import { clipSlots } from './stances.ts'

describe('stance clip slots', () => {
  it('uses ordered overrides and falls back to the base and numbered variants', () => {
    const c = makeCharacter({ clips: [makeSlot({ id: 'base', name: 'Idle' }), makeSlot({ id: 'trial', name: 'Trial' }), makeSlot({ id: 'v3', name: 'Idle 3' }), makeSlot({ id: 'v2', name: 'Idle 2' })] })
    c.folk = { sets: [], pools: [], kinds: [], stances: [{ id: 'shield', name: 'Shield', clips: { Idle: ['trial'] } }] }
    expect(clipSlots(c, 'shield', 'Idle').map(x => x.id)).toEqual(['trial'])
    expect(clipSlots(c, null, 'Idle').map(x => x.id)).toEqual(['base', 'v2', 'v3'])
    expect(clipSlots(c, 'shield', 'Missing')).toEqual([])
  })
})
