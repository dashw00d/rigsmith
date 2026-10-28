// The joints a character's skeleton has, synchronously, for the server, the app and the tools alike: the Mixamo
// humanoid by finger level (static/templates/human-skeleton.json, which src/engine/mixamo.ts and
// blender/autorig/mixamo.py read too) and each creature template's joints (template-parents.ts, generated from
// static/templates/<id>.json).
import human from '../../static/templates/human-skeleton.json' with { type: 'json' }
import { TEMPLATE_PARENTS } from './template-parents.ts'
import type { FingerLevel, SkeletonSection } from './types.ts'

export { TEMPLATE_PARENTS }

export type Hierarchy = Array<[string, string | null]>

export const FINGERS: readonly string[] = human.fingers
export const FINGER_LEVELS: Readonly<Record<FingerLevel, readonly string[]>> = human.fingerLevels

/** [bone, parent, finger?] at the full level, parents first. */
const BONES = human.bones as Array<[string, string | null] | [string, string, string]>

/** The Mixamo humanoid at a finger level: (bone, parent), parents before children. */
export function humanHierarchy (level: FingerLevel): Hierarchy {
  const fingers = FINGER_LEVELS[level]
  return BONES.filter(b => b.length < 3 || fingers.includes(b[2]!)).map(([bone, parent]) => [bone, parent])
}

/** The skeleton a character is built on: the human at its finger level, a known creature's joints (finger level
 * ignored), or for a template this build doesn't know, whatever joints it has (their parents unknown). */
export function hierarchyOf (c: { skeleton: Pick<SkeletonSection, 'template' | 'fingerLevel' | 'detected' | 'overrides'> }): Hierarchy {
  const { template, fingerLevel, detected, overrides } = c.skeleton
  if (template === 'human') return humanHierarchy(fingerLevel)
  const parents = TEMPLATE_PARENTS[template]
  if (parents !== undefined) return Object.entries(parents)
  return [...new Set([...Object.keys(detected ?? {}), ...Object.keys(overrides)])].map(j => [j, null])
}
