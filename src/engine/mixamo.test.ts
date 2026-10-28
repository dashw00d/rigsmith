// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { humanJoints } from '../model/fixtures.ts'
import { humanHierarchy } from '../model/skeletons.ts'
import { ANATOMY, BONES_AT, fingerLevelOf, groups, hierarchy, isFingerJoint, prettyBone } from './mixamo.ts'
import { swapSide } from './templates.ts'

const ROOT = path.resolve(import.meta.dirname, '..', '..')

describe('the Mixamo humanoid', () => {
  it('is the model\'s hierarchy, from the one data file', () => {
    for (const level of ['none', 'one', 'two', 'full'] as const) expect(hierarchy(level)).toEqual(humanHierarchy(level))
    expect(BONES_AT).toEqual({ none: 25, one: 33, two: 41, full: 65 })
  })

  it('lays fingers by the anatomy table the finger trace reads too', () => {
    const file = JSON.parse(readFileSync(path.join(ROOT, 'static', 'templates', 'human-skeleton.json'), 'utf8')) as { anatomy: Record<string, number[]> }
    expect(ANATOMY).toEqual(file.anatomy)
    // (blender/autorig/mixamo.py reads the same key)
    expect(readFileSync(path.join(ROOT, 'blender', 'autorig', 'mixamo.py'), 'utf8')).toContain("_HUMAN['anatomy']")
  })

  it('tells finger levels from the joints', () => {
    for (const level of ['none', 'one', 'two', 'full'] as const) expect(fingerLevelOf(humanJoints(level))).toBe(level)
    const one = humanJoints('full')
    delete one.RightHandMiddle2
    expect(fingerLevelOf(one)).toBe('two')
  })

  it('names, mirrors and groups its joints', () => {
    expect(prettyBone('LeftUpLeg')).toBe('Thigh')
    expect(prettyBone('RightHandPinky3')).toBe('Pinky 3')
    expect(swapSide('LeftShoulder')).toBe('RightShoulder')
    expect(isFingerJoint('LeftHandThumb4')).toBe(true)
    expect(isFingerJoint('LeftHand')).toBe(false)
    expect(groups('none').map(g => g.label)).toEqual(['Spine & head', 'Arms', 'Legs'])
  })
})
