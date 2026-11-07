import { folkOf, kindSets, setById } from './folk.ts'
import type { Character, Slot } from './types.ts'
import { variantsOf } from './variants.ts'
import { documentDress, resolve, shows, type Dress } from '../state/dressing.ts'

/** A set's explicit stance, otherwise the first kind that includes it. */
export function stanceOf (c: Character, setId: string): string | null {
  const set = setById(c, setId)
  if (set === undefined) return null
  if (set.stance !== undefined) return set.stance
  const folk = folkOf(c)
  return folk.kinds.find(k => kindSets(folk.sets, k).some(x => x.set.id === setId))?.stance ?? null
}

/** Stance overrides are slot ids; otherwise use the base slot followed by numbered variants. */
export function clipSlots (c: Character, stanceId: string | null, clip: string): Slot[] {
  const override = folkOf(c).stances.find(s => s.id === stanceId)?.clips[clip]
  if (override !== undefined) return override.flatMap(id => c.clips.find(s => s.id === id) ?? [])
  const base = c.clips.find(s => s.name === clip)
  return base === undefined ? [] : [base, ...variantsOf(c, clip, [clip])]
}

/** The same piece visibility the stage uses, copied for animation baking. */
export function dressedCharacter (c: Character, setId: string | null, preview?: Dress): Character {
  const copy = structuredClone(c)
  const set = folkOf(c).sets.find(s => s.id === setId)
  if (setId !== null && set === undefined) return copy
  const own = documentDress(c)
  const chosen: Dress = { ...preview, outfit: set?.name ?? null, outfitId: set?.id ?? null }
  const worn = resolve(c, chosen)
  const assigned = new Set(folkOf(c).sets.flatMap(s => s.pieces))
  for (let i = 0; i < c.gear.length; i++) {
    const gear = c.gear[i]
    if (assigned.has(gear.id) || gear.role !== undefined) copy.gear[i].hidden = !shows(c, gear, worn, own, chosen)
  }
  return copy
}
