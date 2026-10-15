// Map any imported skeleton onto the canonical Mixamo bone set, so library animations can drive it
// without re-rigging. Known rigs (Unreal, Rigify, VRM, Daz, Mixamo...) resolve automatically through the
// canonical-slot auto-mapper; anything else can be fixed by hand and saved as a preset.
import type * as THREE from 'three'
import { hierarchy } from '../mixamo.ts'
import { BoneAutoMapper } from './automap/BoneAutoMapper.ts'
import { BoneChainResolver, type RawBoneRecord } from './automap/BoneChainResolver.ts'

/** Mixamo bone -> the character's bone name. */
export type BoneMap = Record<string, string>

export const MAP_GROUPS: Array<{ label: string, bones: string[] }> = [
  { label: 'Body', bones: ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head'] },
  { label: 'Left arm', bones: ['LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand'] },
  { label: 'Right arm', bones: ['RightShoulder', 'RightArm', 'RightForeArm', 'RightHand'] },
  { label: 'Left leg', bones: ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase'] },
  { label: 'Right leg', bones: ['RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'] },
]

export const CORE_BONES = MAP_GROUPS.flatMap(g => g.bones)

export function skeletonRecords (root: THREE.Object3D): RawBoneRecord[] {
  const out: RawBoneRecord[] = []
  root.traverse(o => {
    if ((o as THREE.Bone).isBone) out.push({ name: o.name, parent_name: (o.parent as THREE.Bone | null)?.isBone === true ? o.parent!.name : null })
  })
  return out
}

export function autoMapToMixamo (target: RawBoneRecord[]): BoneMap {
  const source = hierarchy('full').map(([name, parent]) => ({ name, parent_name: parent }))
  const mapping = BoneAutoMapper.map_by_canonical_slots(BoneChainResolver.build_metadata(source), BoneChainResolver.build_metadata(target))
  const out: BoneMap = {}
  for (const [targetBone, mixamoBone] of mapping) out[mixamoBone] = targetBone
  return out
}

export function coverage (map: BoneMap): { mapped: number, total: number, missing: string[] } {
  const missing = CORE_BONES.filter(b => map[b] === undefined || map[b] === '')
  return { mapped: CORE_BONES.length - missing.length, total: CORE_BONES.length, missing }
}

/** Node-name -> canonical-name function for captureRest, from a Mixamo -> character map. */
export function renamer (map: BoneMap | undefined): ((name: string) => string | null) | undefined {
  if (map === undefined) return undefined
  const inverse = new Map(Object.entries(map).filter(([, t]) => t !== '').map(([m, t]) => [t, m]))
  return name => inverse.get(name) ?? null
}
