// Small hand-built schema 2 characters for tests (the model's and other areas'). Every default is plain and valid: a
// human 1.8 tall at the full finger level, detected joints for its whole hierarchy, nothing placed, worn or clipped.
import { hierarchyOf, humanHierarchy } from './skeletons.ts'
import type {
  Character, FingerLevel, Gear, HandsSection, Joints, LookSection, SkeletonSection, SkinSection, Slot, SourceSection, Vec3,
} from './types.ts'

export type CharacterPatch = Partial<Omit<Character, 'source' | 'skeleton' | 'skin' | 'hands' | 'look'>> & {
  source?: Partial<SourceSection>
  skeleton?: Partial<SkeletonSection>
  skin?: Partial<SkinSection>
  hands?: Partial<HandsSection>
  look?: Partial<LookSection>
}

const FINGER_Z: Record<string, number> = { Thumb: 0.04, Index: 0.02, Middle: 0, Ring: -0.02, Pinky: -0.04 }
const BODY: Record<string, Vec3> = {
  Hips: [0, 1, 0], Spine: [0, 1.1, 0], Spine1: [0, 1.2, 0], Spine2: [0, 1.3, 0], Neck: [0, 1.5, 0], Head: [0, 1.6, 0], HeadTop_End: [0, 1.8, 0],
  Shoulder: [0.05, 1.45, 0], Arm: [0.15, 1.45, 0], ForeArm: [0.4, 1.45, 0], Hand: [0.65, 1.45, 0],
  UpLeg: [0.1, 0.95, 0], Leg: [0.1, 0.5, 0], Foot: [0.1, 0.08, 0], ToeBase: [0.1, 0.02, 0.1], Toe_End: [0.1, 0.02, 0.18],
}

/** A T-posed human's joints at a finger level (glTF space: Y up, +Z forward, its left at +X). */
export function humanJoints (level: FingerLevel = 'full'): Joints {
  const out: Joints = {}
  for (const [bone] of humanHierarchy(level)) {
    const m = /^(Left|Right)(.*)$/.exec(bone)
    const x = m?.[1] === 'Right' ? -1 : 1
    const finger = /^Hand(Thumb|Index|Middle|Ring|Pinky)([1-4])$/.exec(m?.[2] ?? '')
    if (finger !== null) out[bone] = [x * (0.69 + 0.025 * (Number(finger[2]) - 1)), 1.45, FINGER_Z[finger[1]]]
    else {
      const p = BODY[m?.[2] ?? bone]
      out[bone] = [x * p[0], p[1], p[2]]
    }
  }
  return out
}

export function makeCharacter (over: CharacterPatch = {}): Character {
  const { source, skeleton, skin, hands, look, ...rest } = over
  const template = skeleton?.template ?? 'human'
  const fingerLevel = skeleton?.fingerLevel ?? 'full'
  const detected = template === 'human' ? humanJoints(fingerLevel)
    : Object.fromEntries(hierarchyOf({ skeleton: { template, fingerLevel, overrides: {} } }).map(([j], i): [string, Vec3] => [j, [0, i * 0.01, 0]]))
  return {
    schema: 4, id: 'tester-000001', name: 'Tester', createdAt: 0, updatedAt: 0, version: 1, revision: 0,
    files: { model: 'model.glb' }, status: 'ready',
    gear: [], clips: [],
    ...rest,
    source: {
      file: 'source/original.glb', originalName: 'tester.glb', bytes: 1000, kind: 'mesh', scale: 1,
      stats: { vertices: 1000, triangles: 2000, height: 1.8, meshes: 1, bones: 0 }, warnings: [], ...source,
    },
    skeleton: { template, fingerLevel, detected, overrides: {}, ...skeleton },
    skin: { locked: false, ...skin },
    hands: { poses: [], ...hands },
    look: { layers: [], ...look },
  }
}

/** A character as a finished rig leaves it: rigged, the rig built for its hierarchy. */
export function makeRigged (over: CharacterPatch = {}): Character {
  const c = makeCharacter({ status: 'rigged', files: { model: 'model.glb', rigged: 'rigged.glb' }, ...over })
  if (c.skin.rigJoints === undefined) {
    const all = { ...c.skeleton.detected, ...c.skeleton.overrides }
    c.skin.rigJoints = Object.fromEntries(hierarchyOf(c).map(([j]): [string, Vec3] => [j, all[j] ?? [0, 0, 0]]))
  }
  return c
}

/** A ready piece on Spine2 (no hand, so no carry handle). */
export function makeGear (over: Partial<Gear> = {}): Gear {
  return {
    id: 'g1', name: 'Axe', status: 'ready',
    attach: { kind: 'bone', bone: 'Spine2', place: { position: [0, 1.3, -0.1], rotation: [0, 0, 0], scale: 1 } }, handles: [],
    ...over,
  }
}

export function makeSlot (over: Partial<Slot> = {}): Slot {
  return { id: 's1', name: 'Idle', clip: { id: 'mixamo-Idle' }, speed: 1, loop: true, inPlace: true, adjustments: [], ...over }
}
