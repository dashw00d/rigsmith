// What the Skeleton panel says about a character's joints, worked out from the document: how its skeleton moved since
// the last rig, the joint chips, the joints a rigged import's own skeleton gives for a conversion. Pure.
import { CORE_JOINTS, fingerLevelOf, groups, hierarchy } from '../../engine/mixamo.ts'
import { creatureGroups } from '../../engine/templates.ts'
import { jointsOf } from '../../model/select.ts'
import { hierarchyOf } from '../../model/skeletons.ts'
import type { Character, FingerLevel, Joints, Vec3 } from '../../model/types.ts'

/** Closer than this to where the rig put a joint, it hasn't moved (DESIGN.md: skin.rigJoints compared at 1e-4). */
export const RIG_MOVE = 1e-4

const far = (a: Vec3, b: Vec3, d: number): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > d

/** How the skeleton differs from the one the current rig was built on: joints moved, joints it has now that the rig
 * hasn't, joints the rig has that it no longer has. Null when there is no rig to compare with. */
export function changedSinceRig (c: Pick<Character, 'files' | 'skeleton' | 'skin'>): { moved: string[], added: string[], removed: string[] } | null {
  const rig = c.skin.rigJoints
  if (c.files.rigged === undefined || rig === undefined) return null
  const now = jointsOf(c)
  const moved: string[] = []
  const added: string[] = []
  for (const [j, p] of Object.entries(now)) {
    if (rig[j] === undefined) added.push(j)
    else if (far(p, rig[j], RIG_MOVE)) moved.push(j)
  }
  const want = new Set(hierarchyOf(c).map(([j]) => j))
  const removed = Object.keys(rig).filter(j => now[j] === undefined && !want.has(j))
  return { moved, added, removed }
}

/** The joints the user placed that count (overrides of joints the skeleton has). */
export function placedJoints (c: Pick<Character, 'skeleton'>): string[] {
  const known = new Set(hierarchyOf(c).map(([j]) => j))
  return Object.keys(c.skeleton.overrides).filter(j => known.has(j))
}

/** The joint chips: a person's by part of the body, a creature's by limb; one side's (the other is the same joints
 * mirrored), `side` choosing which. */
export function jointChips (c: Pick<Character, 'skeleton'>, side: 'left' | 'right' = 'left'): Array<{ label: string, bones: string[] }> {
  const s = c.skeleton
  if (s.template === 'human') return groups(s.fingerLevel, side === 'left' ? 'Left' : 'Right')
  return creatureGroups(hierarchyOf(c), side)
}

/** A rigged import's joints for its conversion, read off its rest skeleton by Mixamo name (its own bones, through its
 * bone map): rounded to 1e-5, the finger level its hands have, and the core joints it lacks (it can't be converted
 * while any is missing: map them first). */
export function convertJoints (worldOf: (bone: string) => readonly [number, number, number] | null): { joints: Joints, fingers: FingerLevel, missing: string[] } {
  const joints: Joints = {}
  for (const [bone] of hierarchy('full')) {
    const p = worldOf(bone)
    if (p !== null) joints[bone] = [p[0], p[1], p[2]].map(v => Math.round(v * 1e5) / 1e5) as Vec3
  }
  const fingers = fingerLevelOf(joints)
  // (only the joints its finger level has: a stray finger bone without its chain is no finger)
  const kept = new Set(hierarchy(fingers).map(([b]) => b))
  for (const j of Object.keys(joints)) if (!kept.has(j)) delete joints[j]
  return { joints, fingers, missing: CORE_JOINTS.filter(b => joints[b] === undefined) }
}
