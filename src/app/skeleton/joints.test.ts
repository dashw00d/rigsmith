import { describe, expect, it } from 'vitest'
import { hierarchy } from '../../engine/mixamo.ts'
import { humanJoints, makeCharacter, makeRigged } from '../../model/fixtures.ts'
import { hierarchyOf } from '../../model/skeletons.ts'
import { changedSinceRig, convertJoints, jointChips, placedJoints } from './joints.ts'

describe('the skeleton since the last rig', () => {
  it('has nothing to say without a rig', () => {
    expect(changedSinceRig(makeCharacter())).toBeNull()
  })

  it('sees joints placed since, but not a hair of difference', () => {
    const c = makeRigged()
    expect(changedSinceRig(c)).toEqual({ moved: [], added: [], removed: [] })
    c.skeleton.overrides.LeftHand = [0.7, 1.45, 0]
    c.skeleton.overrides.RightHand = [-0.65, 1.45 + 5e-5, 0]
    expect(changedSinceRig(c)).toEqual({ moved: ['LeftHand'], added: [], removed: [] })
  })

  it('sees a finger level the rig was not built for', () => {
    const c = makeRigged()
    c.skeleton.fingerLevel = 'two'
    c.skeleton.detected = humanJoints('two')
    const d = changedSinceRig(c)!
    expect(d.added).toEqual([])
    expect(d.removed.sort()).toEqual(['Middle', 'Ring', 'Pinky'].flatMap(f => ['Left', 'Right'].flatMap(s => [1, 2, 3, 4].map(i => `${s}Hand${f}${i}`))).sort())
  })
})

describe('the joint chips', () => {
  it('lists one side of a person by part of the body', () => {
    const chips = jointChips(makeCharacter())
    expect(chips.map(g => g.label)).toEqual(['Spine & head', 'Arms', 'Hands', 'Legs'])
    expect(chips.flatMap(g => g.bones).every(b => !b.startsWith('Right'))).toBe(true)
    expect(jointChips(makeCharacter(), 'right').find(g => g.label === 'Arms')!.bones).toEqual(['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'])
  })

  it('gives a creature chips too: its middle line and one side of each limb', () => {
    const horse = makeCharacter({ skeleton: { template: 'horse' } })
    const chips = jointChips(horse)
    expect(chips[0].label).toBe('Body')
    const all = chips.flatMap(g => g.bones)
    expect(new Set(all).size).toBe(all.length)
    const names = hierarchyOf(horse).map(([j]) => j)
    // every joint but the root is a chip, on one side or its mirror
    for (const j of names.filter(n => n !== 'root')) expect(all.includes(j) || all.includes(j.replace(/_r$/, '_l'))).toBe(true)
  })
})

describe('a rigged import converted', () => {
  it('reads its joints and its finger level, rounded', () => {
    const J = humanJoints('two')
    const { joints, fingers, missing } = convertJoints(b => (J[b] === undefined ? null : [J[b][0] + 1e-7, J[b][1], J[b][2]]))
    expect(fingers).toBe('two')
    expect(missing).toEqual([])
    expect(Object.keys(joints).sort()).toEqual(hierarchy('two').map(([b]) => b).sort())
    expect(joints.LeftHand).toEqual(J.LeftHand)
  })

  it('drops a stray finger bone and names the core joints it lacks', () => {
    const J = humanJoints('none')
    delete J.LeftForeArm
    const extra: Record<string, [number, number, number]> = { ...J, LeftHandMiddle1: [0.7, 1.45, 0] }
    const { joints, fingers, missing } = convertJoints(b => extra[b] ?? null)
    expect(fingers).toBe('none')
    expect(joints.LeftHandMiddle1).toBeUndefined()
    expect(missing).toEqual(['LeftForeArm'])
  })
})

describe('placed joints', () => {
  it('counts only joints the skeleton has', () => {
    const c = makeCharacter({ skeleton: { fingerLevel: 'none', overrides: { Hips: [0, 1.1, 0], LeftHandIndex1: [0, 0, 0] } } })
    expect(placedJoints(c)).toEqual(['Hips'])
  })
})
