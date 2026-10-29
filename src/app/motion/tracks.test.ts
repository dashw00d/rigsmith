// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { bodyGroups } from './tracks.ts'

describe('the Body track\'s limb groups', () => {
  it('put each bone in its limb, the forearms in the arms (not the head, for the "ear" in them)', () => {
    const groups = Object.fromEntries(bodyGroups([
      'Hips', 'Spine', 'Neck', 'Head', 'HeadTop_End', 'LeftEye', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'LeftHandIndex1',
      'RightForeArm', 'RightHand', 'RightUpLeg', 'LeftFoot', 'ear_l', 'jaw', 'tail_01',
    ]).map(g => [g.id, g.bones]))
    expect(groups.head).toEqual(['Neck', 'Head', 'HeadTop_End', 'LeftEye', 'ear_l', 'jaw'])
    expect(groups.armL).toEqual(['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'])
    expect(groups.armR).toEqual(['RightForeArm', 'RightHand'])
    expect(groups.handL).toEqual(['LeftHandIndex1'])
    expect(groups.legL).toEqual(['LeftFoot'])
    expect(groups.tail).toEqual(['tail_01'])
  })
})
