// The canonical Mixamo skeleton (bare bone names). Mirrors blender/autorig/mixamo.py.
export type FingerLevel = 'none' | 'one' | 'two' | 'full'

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']
export const FINGER_LEVELS: Record<FingerLevel, string[]> = {
  none: [],
  one: ['Index'],
  two: ['Thumb', 'Index'],
  full: FINGERS,
}

export function hierarchy (fingers: FingerLevel = 'two'): Array<[string, string | null]> {
  const bones: Array<[string, string | null]> = [
    ['Hips', null], ['Spine', 'Hips'], ['Spine1', 'Spine'], ['Spine2', 'Spine1'],
    ['Neck', 'Spine2'], ['Head', 'Neck'], ['HeadTop_End', 'Head'],
  ]
  for (const side of ['Left', 'Right']) {
    bones.push([`${side}Shoulder`, 'Spine2'], [`${side}Arm`, `${side}Shoulder`], [`${side}ForeArm`, `${side}Arm`], [`${side}Hand`, `${side}ForeArm`])
    for (const finger of FINGER_LEVELS[fingers]) {
      let parent = `${side}Hand`
      for (let i = 1; i <= 4; i++) {
        const name = `${side}Hand${finger}${i}`
        bones.push([name, parent])
        parent = name
      }
    }
  }
  for (const side of ['Left', 'Right']) {
    bones.push([`${side}UpLeg`, 'Hips'], [`${side}Leg`, `${side}UpLeg`], [`${side}Foot`, `${side}Leg`], [`${side}ToeBase`, `${side}Foot`], [`${side}Toe_End`, `${side}ToeBase`])
  }
  return bones
}

export function side (name: string): 'left' | 'right' | 'center' {
  if (name.startsWith('Left')) return 'left'
  if (name.startsWith('Right')) return 'right'
  return 'center'
}

export function mirrorName (name: string): string {
  if (name.startsWith('Left')) return 'Right' + name.slice(4)
  if (name.startsWith('Right')) return 'Left' + name.slice(5)
  return name
}

/** Human-readable label: "LeftForeArm" -> "Forearm", with the side shown separately. */
export function prettyBone (name: string): string {
  const base = name.replace(/^(Left|Right)/, '').replace('HeadTop_End', 'Head top').replace('Toe_End', 'Toe tip')
    .replace('UpLeg', 'Thigh').replace(/^Leg$/, 'Shin').replace('ForeArm', 'Forearm').replace(/^Arm$/, 'Upper arm')
    .replace('ToeBase', 'Toes').replace(/^Shoulder$/, 'Clavicle')
  return base.replace(/Hand(Thumb|Index|Middle|Ring|Pinky)(\d)/, '$1 $2')
}

/** Joint groups for the rig panel. */
export function groups (fingers: FingerLevel): Array<{ label: string, bones: string[] }> {
  const all = hierarchy(fingers).map(([b]) => b)
  return [
    { label: 'Spine & head', bones: all.filter(b => side(b) === 'center') },
    { label: 'Arms', bones: all.filter(b => b.startsWith('Left') && /Shoulder|Arm|Hand$/.test(b)) },
    { label: 'Hands', bones: all.filter(b => b.startsWith('LeftHand') && b !== 'LeftHand') },
    { label: 'Legs', bones: all.filter(b => b.startsWith('Left') && /Leg|Foot|Toe/.test(b)) },
  ].filter(g => g.bones.length > 0)
}
