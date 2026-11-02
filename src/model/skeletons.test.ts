// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { makeCharacter } from './fixtures.ts'
import { FINGER_LEVELS, hierarchyOf, humanHierarchy, TEMPLATE_PARENTS } from './skeletons.ts'
import type { FingerLevel } from './types.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const LEVELS: FingerLevel[] = ['none', 'one', 'two', 'three', 'full']

/** v1's hierarchy (src/engine/mixamo.ts before it read the data file), which the data file was made from. */
function v1Hierarchy (fingers: FingerLevel): Array<[string, string | null]> {
  const chains: Record<FingerLevel, string[]> = { none: [], one: ['Index'], two: ['Thumb', 'Index'], three: ['Thumb', 'Index', 'Middle'], full: ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] }
  const bones: Array<[string, string | null]> = [
    ['Hips', null], ['Spine', 'Hips'], ['Spine1', 'Spine'], ['Spine2', 'Spine1'], ['Neck', 'Spine2'], ['Head', 'Neck'], ['HeadTop_End', 'Head'],
  ]
  for (const side of ['Left', 'Right']) {
    bones.push([`${side}Shoulder`, 'Spine2'], [`${side}Arm`, `${side}Shoulder`], [`${side}ForeArm`, `${side}Arm`], [`${side}Hand`, `${side}ForeArm`])
    for (const finger of chains[fingers]) {
      let parent = `${side}Hand`
      for (let i = 1; i <= 4; i++) { bones.push([`${side}Hand${finger}${i}`, parent]); parent = `${side}Hand${finger}${i}` }
    }
  }
  for (const side of ['Left', 'Right']) {
    bones.push([`${side}UpLeg`, 'Hips'], [`${side}Leg`, `${side}UpLeg`], [`${side}Foot`, `${side}Leg`], [`${side}ToeBase`, `${side}Foot`], [`${side}Toe_End`, `${side}ToeBase`])
  }
  return bones
}

describe('the human hierarchy', () => {
  it('is v1 Mixamo at every finger level', () => {
    for (const level of LEVELS) expect(humanHierarchy(level)).toEqual(v1Hierarchy(level))
    expect(LEVELS.map(l => humanHierarchy(l).length)).toEqual([25, 33, 41, 49, 65])
    expect(FINGER_LEVELS.two).toEqual(['Thumb', 'Index'])
  })

  it('lists every parent before its children', () => {
    const seen = new Set<string>()
    for (const [bone, parent] of humanHierarchy('full')) {
      if (parent !== null) expect(seen.has(parent)).toBe(true)
      seen.add(bone)
    }
  })
})

describe('TEMPLATE_PARENTS', () => {
  it('matches every creature template (node src/model/template-parents.gen.ts after changing one)', () => {
    const dir = path.join(ROOT, 'static', 'templates')
    const creatures: Record<string, Array<[string, string | null]>> = {}
    for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const t = JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as { order?: string[], parents?: Record<string, string | null> }
      if (t.order !== undefined && t.parents !== undefined) creatures[path.basename(file, '.json')] = t.order.map(j => [j, t.parents![j]])
    }
    expect(Object.keys(creatures)).toContain('horse')
    expect(Object.keys(TEMPLATE_PARENTS).sort()).toEqual(Object.keys(creatures).sort())
    for (const [id, pairs] of Object.entries(creatures)) expect(Object.entries(TEMPLATE_PARENTS[id])).toEqual(pairs)
  })
})

describe('hierarchyOf', () => {
  it('gives a person the Mixamo skeleton at its finger level', () => {
    expect(hierarchyOf(makeCharacter({ skeleton: { fingerLevel: 'two' } }))).toEqual(humanHierarchy('two'))
  })

  it("gives a known creature its template's joints, whatever the finger level", () => {
    const horse = makeCharacter({ skeleton: { template: 'horse', fingerLevel: 'none' } })
    expect(hierarchyOf(horse)).toEqual(Object.entries(TEMPLATE_PARENTS.horse))
    expect(hierarchyOf(horse)[0]).toEqual(['root', null])
  })

  it('gives an unknown template the joints it has, detected and placed', () => {
    const c = makeCharacter({ skeleton: { template: 'octopus', detected: { body: [0, 0, 0], arm1: [1, 0, 0] }, overrides: { arm1: [1, 1, 0], arm2: [2, 0, 0] } } })
    expect(hierarchyOf(c)).toEqual([['body', null], ['arm1', null], ['arm2', null]])
  })
})
