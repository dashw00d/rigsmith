// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { checkEdit, checkMaking, checkPropPaths, editName, othersUsing, usesOf, usesText, type SavedEdit } from './clipedits.ts'
import { makeCharacter, makeSlot } from '../src/model/fixtures.ts'

const edit = (base: string): SavedEdit => ({
  name: 'Named edit', base, frames: { fps: 30, bones: ['Hips'], rotations: [[[0, 0, 0, 1]]], hips: [[0, 1, 0]] },
})

describe('edited clip validation', () => {
  it('accepts the catalog IDs containing periods without accepting paths', () => {
    for (const id of ['mixamo-Standing_Idle_Looking_Ver._1', 'mixamo-Standing_Melee_Combo_Attack_Ver._3', 'custom-My_Clip']) {
      expect(() => checkEdit(edit(id))).not.toThrow()
    }
    for (const id of ['../clip', 'folder/clip', 'folder\\clip', 'clip\u0000']) expect(() => checkEdit(edit(id))).toThrow('Which clip was edited?')
  })

  it('checks the gear paths and the record kept to open it again', () => {
    expect(() => checkPropPaths({ GearAxe: [{ u: 0, q: [0, 0, 0, 1], p: [0, 0, 0] }] })).not.toThrow()
    expect(() => checkPropPaths({ GearAxe: [{ u: 0, q: [0, 0, 1] }] })).toThrow('Bad gear paths')
    expect(() => checkMaking({ mode: 'plays', slot: 'Attack', keys: { Spine: [{ u: 0.5, q: [0, 0, 0, 1] }] }, gear: { GearAxe: { locked: true, keys: [] } } })).not.toThrow()
    expect(() => checkMaking({ mode: 'sideways' })).toThrow('Bad edit mode')
    expect(() => checkMaking({ gear: { GearAxe: { keys: [] } } })).toThrow('Bad gear paths')
    expect(() => checkMaking({ length: -1 })).toThrow('Bad length')
  })
})

describe('edit names', () => {
  it('never grows a second "edit"', () => {
    expect(editName('Attack edit')).toBe('Attack edit')
    expect(editName('Attack edit edit')).toBe('Attack edit')
    expect(editName('  Attack   edit  Edit ')).toBe('Attack edit')
    expect(editName('Attack edit 2 edit')).toBe('Attack edit')
    expect(editName('Credit')).toBe('Credit')
  })
})

describe('who plays a clip', () => {
  const a = makeCharacter({ id: 'scout-1', name: 'Scout' })
  a.clips = [makeSlot({ id: 's1', name: 'Attack', clip: { id: 'custom-Slash' } }), makeSlot({ id: 's2', name: 'Idle', clip: { id: 'mixamo-Idle' } })]
  const b = makeCharacter({ id: 'villager-1', name: 'Villager' })
  b.clips = [makeSlot({ id: 's9', name: 'Attack', clip: { id: 'custom-Slash' } })]

  it('lists every slot of every character playing it', () => {
    expect(usesOf([a, b], 'custom-Slash')).toEqual([
      { character: 'scout-1', characterName: 'Scout', slot: 's1', slotName: 'Attack' },
      { character: 'villager-1', characterName: 'Villager', slot: 's9', slotName: 'Attack' },
    ])
    expect(usesOf([a, b], 'custom-Nothing')).toEqual([])
  })

  it('sees what a save over it would change besides the slot saving', () => {
    const uses = usesOf([a, b], 'custom-Slash')
    expect(othersUsing(uses, 'scout-1', 's1').map(u => u.character)).toEqual(['villager-1'])
    expect(othersUsing(usesOf([a], 'custom-Slash'), 'scout-1', 's1')).toEqual([])
    // (no slot named: every use is another's)
    expect(othersUsing(uses, 'scout-1', undefined)).toHaveLength(2)
  })

  it('says who in words', () => {
    const uses = usesOf([a, b], 'custom-Slash')
    expect(usesText(uses)).toBe("Scout's Attack and Villager's Attack")
    const many = [...uses, ...uses, ...uses]
    expect(usesText(many)).toBe("Scout's Attack, Villager's Attack, Scout's Attack and 3 more")
  })
})
