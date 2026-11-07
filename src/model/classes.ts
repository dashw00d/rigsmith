import { cultureOf } from '../app/gear/wardrobe.ts'
import { kindsOf, kindSets, setsOf, type Folkish } from './folk.ts'
import type { UnitKind } from './types.ts'

export function kindsWearing (c: Folkish, setId: string): UnitKind[] {
  return kindsOf(c).filter(kind => kindSets(setsOf(c), kind).some(row => row.set.id === setId))
}
export function kindSetRows (c: Folkish, kind: UnitKind): Array<{ set: ReturnType<typeof setsOf>[number], weight: number, matchedBy: 'list' | 'query' }> {
  return kindSets(setsOf(c), kind).map(row => ({ ...row, matchedBy: Array.isArray(kind.sets) ? 'list' : 'query' }))
}
export function cultures (c: Folkish): Array<{ value: string, tagged: boolean }> {
  const found = new Map<string, boolean>()
  for (const set of setsOf(c)) {
    const tagged = set.tags.filter(t => t.startsWith('culture:') && t.length > 8).map(t => t.slice(8))
    if (tagged.length > 0) for (const value of tagged) found.set(value, true)
    else { const value = cultureOf(set.name); if (value !== null && !found.has(value)) found.set(value, false) }
  }
  return [...found].sort(([a], [b]) => a.localeCompare(b)).map(([value, tagged]) => ({ value, tagged }))
}
