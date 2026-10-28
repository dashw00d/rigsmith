import { describe, expect, it } from 'vitest'
import { makeCharacter } from '../../model/fixtures.ts'
import { hierarchyOf } from '../../model/skeletons.ts'
import { boneLabel, carriesSkin, weightChips } from './bones.ts'

describe('bones in the Skin step', () => {
  it('names a bone for people, with its side', () => {
    const names = new Set(hierarchyOf(makeCharacter()).map(([b]) => b))
    expect(boneLabel('LeftForeArm', names)).toBe('Forearm · left')
    expect(boneLabel('Hips', names)).toBe('Hips')
    const horse = new Set(hierarchyOf(makeCharacter({ skeleton: { template: 'horse' } })).map(([b]) => b))
    const sided = [...horse].find(b => b.endsWith('_l'))!
    expect(boneLabel(sided, horse)).toMatch(/ · left$/)
  })

  it('leaves end markers out: they carry no skin', () => {
    expect(carriesSkin('HeadTop_End')).toBe(false)
    expect(carriesSkin('LeftToe_End')).toBe(false)
    expect(carriesSkin('LeftForeArm')).toBe(true)
  })

  it('offers weight chips from the skeleton itself, a person\'s and a creature\'s', () => {
    const person = weightChips(makeCharacter())
    expect(person.map(g => g.label)).toEqual(['Spine & head', 'Arms', 'Hands', 'Legs'])
    const bones = person.flatMap(g => g.bones)
    expect(bones).toContain('Spine2')
    expect(bones).toContain('LeftHandIndex1')
    expect(bones.some(b => /_End$/.test(b))).toBe(false)
    expect(weightChips(makeCharacter(), 'right').flatMap(g => g.bones)).toContain('RightForeArm')
    const horse = weightChips(makeCharacter({ skeleton: { template: 'horse' } }))
    expect(horse.length).toBeGreaterThan(1)
    expect(horse.flatMap(g => g.bones).every(b => !/_r$/.test(b))).toBe(true)
  })
})
