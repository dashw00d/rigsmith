import { kindsWearing } from '../../model/classes.ts'
import { setsOf, type Folkish } from '../../model/folk.ts'
import type { Command } from '../../model/command-types.ts'
import type { OutfitSet, UnitKind } from '../../model/types.ts'

export const GRANTS = ['covers-hair', 'covers-face', 'bracers', 'heavy'] as const
export interface SetGroup { culture: string | null, sets: OutfitSet[] }

/** A set with several culture tags appears in each named culture; untagged sets follow them. */
export function setsByCulture (c: Folkish): SetGroup[] {
  const groups = new Map<string | null, OutfitSet[]>()
  for (const set of setsOf(c)) {
    const cultures = [...new Set(set.tags.filter(t => t.startsWith('culture:') && t.length > 8).map(t => t.slice(8)))]
    for (const culture of cultures.length === 0 ? [null] : cultures) {
      const group = groups.get(culture) ?? []
      group.push(set)
      groups.set(culture, group)
    }
  }
  return [...groups].sort(([a], [b]) => a === null ? 1 : b === null ? -1 : a.localeCompare(b))
    .map(([culture, sets]) => ({ culture, sets: [...sets].sort((a, b) => a.name.localeCompare(b.name)) }))
}

export function wornBy (c: Folkish, set: OutfitSet): UnitKind[] { return kindsWearing(c, set.id) }

/** Add valid pieces once, without removing them from any other set. The reducer regrants on membership changes. */
export function addPiecesCommands (c: Folkish, setId: string, ids: readonly string[]): Command[] {
  const set = setsOf(c).find(s => s.id === setId)
  if (set === undefined) return []
  const valid = new Set(c.gear.map(g => g.id))
  const pieces = [...new Set([...set.pieces, ...ids.filter(id => valid.has(id))])]
  return pieces.length === set.pieces.length ? [] : [{ type: 'folk.set.pieces', id: set.id, pieces }]
}
