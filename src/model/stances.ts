import { folkOf, kindSets, setById } from './folk.ts'
import type { Character, Slot } from './types.ts'
import { variantsOf } from './variants.ts'

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

/** Show the set's pieces and hide pieces of other sets, leaving unrelated gear alone. */
export function dressedCharacter (c: Character, setId: string | null): Character {
  const copy = structuredClone(c)
  const sets = folkOf(c).sets; const set = sets.find(s => s.id === setId)
  if (setId !== null && set === undefined) return copy
  const assigned = new Set(sets.flatMap(s => s.pieces)); const shown = new Set(set?.pieces ?? [])
  for (const g of copy.gear) if (assigned.has(g.id)) g.hidden = !shown.has(g.id)
  return copy
}
