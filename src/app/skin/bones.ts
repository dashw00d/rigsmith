// What the Skin step says about a skeleton's bones: their names for people, and which of them carry skin (the weight
// view's chips, the painting's bone list). Pure.
import { jointLabel, sideOf } from '../../engine/templates.ts'
import type { Character } from '../../model/types.ts'
import { jointChips } from '../skeleton/joints.ts'

// (an end marker carries no skin: the head's top, a toe's tip, a creature's leaf bones)
const END = /(_End|end|leaf|tip)$/i

/** A bone that can carry skin (not an end marker). */
export const carriesSkin = (bone: string): boolean => !END.test(bone)

/** A bone's name for people, its side after it: "Forearm · left", "Hips", "Front leg upper · right". `names`: the
 * skeleton's bones, which tell a bone of the middle line from one with a partner. */
export function boneLabel (bone: string, names: ReadonlySet<string>): string {
  const side = sideOf(bone, names)
  return side === 'center' ? jointLabel(bone) : `${jointLabel(bone)} · ${side}`
}

/** The weight view's chips: the skeleton's bones that carry skin, a person's by part of the body and a creature's by
 * limb, one side's (`side`; the other is the same bones mirrored). */
export function weightChips (c: Pick<Character, 'skeleton'>, side: 'left' | 'right' = 'left'): Array<{ label: string, bones: string[] }> {
  return jointChips(c, side)
    .map(g => ({ label: g.label, bones: g.bones.filter(carriesSkin) }))
    .filter(g => g.bones.length > 0)
}
