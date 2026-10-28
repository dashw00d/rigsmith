// The Mixamo humanoid (bare bone names) as the app shows it: its hierarchy by finger level, sides, labels, the joint
// chip groups, and where a long finger's joints sit along the hand. The hierarchy and the anatomy come from
// static/templates/human-skeleton.json (through src/model/skeletons.ts), the table blender/autorig/mixamo.py reads
// too. A name's other side (LeftArm -> RightArm) is templates.ts swapSide, the one for every skeleton.
import human from '../../static/templates/human-skeleton.json' with { type: 'json' }
import { FINGER_LEVELS, FINGERS, humanHierarchy, type Hierarchy } from '../model/skeletons.ts'
import type { FingerLevel, Joints } from '../model/types.ts'

export type { FingerLevel, Hierarchy }
export { FINGER_LEVELS, FINGERS }

export type LongFinger = 'Index' | 'Middle' | 'Ring' | 'Pinky'
export const LONG_FINGERS: readonly LongFinger[] = ['Index', 'Middle', 'Ring', 'Pinky']

/** Where a long finger's joints sit along the hand (Mixamo's proportions): the knuckle's reach along the hand as a
 * fraction of the tip's, then the two middle joints as fractions of knuckle -> tip. */
export const ANATOMY: Readonly<Record<LongFinger, readonly [number, number, number]>> = Object.fromEntries(
  LONG_FINGERS.map(f => [f, human.anatomy[f] as [number, number, number]]),
) as Record<LongFinger, [number, number, number]>

/** The Mixamo humanoid at a finger level: (bone, parent), parents before children. */
export function hierarchy (fingers: FingerLevel = 'two'): Hierarchy {
  return humanHierarchy(fingers)
}

/** Bone counts by finger level, for the level picker's hints. */
export const BONES_AT: Readonly<Record<FingerLevel, number>> = {
  none: humanHierarchy('none').length,
  one: humanHierarchy('one').length,
  two: humanHierarchy('two').length,
  full: humanHierarchy('full').length,
}

export function side (name: string): 'left' | 'right' | 'center' {
  if (name.startsWith('Left')) return 'left'
  if (name.startsWith('Right')) return 'right'
  return 'center'
}

const FINGER_JOINT = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[1-4]$/

/** A finger's joint (either hand). */
export const isFingerJoint = (name: string): boolean => FINGER_JOINT.test(name)

/** Human-readable label: "LeftForeArm" -> "Forearm", with the side shown separately. */
export function prettyBone (name: string): string {
  const base = name.replace(/^(Left|Right)/, '').replace('HeadTop_End', 'Head top').replace('Toe_End', 'Toe tip')
    .replace('UpLeg', 'Thigh').replace(/^Leg$/, 'Shin').replace('ForeArm', 'Forearm').replace(/^Arm$/, 'Upper arm')
    .replace('ToeBase', 'Toes').replace(/^Shoulder$/, 'Clavicle')
  return base.replace(/Hand(Thumb|Index|Middle|Ring|Pinky)(\d)/, '$1 $2')
}

/** Joint groups for the joint chips, one side's (the other is the same names mirrored). */
export function groups (fingers: FingerLevel, prefix: 'Left' | 'Right' = 'Left'): Array<{ label: string, bones: string[] }> {
  const all = hierarchy(fingers).map(([b]) => b)
  return [
    { label: 'Spine & head', bones: all.filter(b => side(b) === 'center') },
    { label: 'Arms', bones: all.filter(b => b.startsWith(prefix) && /Shoulder|Arm|Hand$/.test(b)) },
    { label: 'Hands', bones: all.filter(b => b.startsWith(`${prefix}Hand`) && b !== `${prefix}Hand`) },
    { label: 'Legs', bones: all.filter(b => b.startsWith(prefix) && /Leg|Foot|Toe/.test(b)) },
  ].filter(g => g.bones.length > 0)
}

/** The finger level a skeleton's joints have: every finger both hands have a chain of (joints 1-3) for. */
export function fingerLevelOf (joints: Joints): FingerLevel {
  const has = (f: string): boolean => ['Left', 'Right'].every(s => [1, 2, 3].every(i => joints[`${s}Hand${f}${i}`] !== undefined))
  if (FINGERS.every(has)) return 'full'
  if (has('Thumb') && has('Index')) return 'two'
  return has('Index') ? 'one' : 'none'
}

/** The joints a converted rig needs before it can be rigged here: the spine, the head, both arms and legs. */
export const CORE_JOINTS: readonly string[] = ['Hips', 'Spine', 'Neck', 'Head', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm',
  'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot']
