import { cultureOf } from '../gear/wardrobe.ts'
import { freeId, kindsOf, kindSets, poolsOf, setsOf, type Folkish } from '../../model/folk.ts'
import type { Command } from '../../model/command-types.ts'
import type { UnitKind } from '../../model/types.ts'

export function addClass (c: Folkish, name: string): Command[] {
  const id = freeId(name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'class', kindsOf(c))
  return [{ type: 'folk.kind.add', kind: { id, name: name.trim(), tags: [], sets: { query: [] } } }]
}
export function toList (c: Folkish, kind: UnitKind): UnitKind['sets'] {
  return kindSets(setsOf(c), kind).map(({ set, weight }) => ({ set: set.id, weight }))
}
export function toQuery (tags: string[]): UnitKind['sets'] { return { query: tags } }
export function weigh (c: Folkish, kind: UnitKind, setId: string, weight: number): Command[] {
  const list = toList(c, kind) as Array<{ set: string, weight?: number }>
  return [{ type: 'folk.kind.sets', id: kind.id, sets: list.map(row => row.set === setId ? { ...row, weight } : row) }]
}
export function listSet (c: Folkish, kind: UnitKind, setId: string): Command[] {
  const list = toList(c, kind) as Array<{ set: string, weight?: number }>
  return [{ type: 'folk.kind.sets', id: kind.id, sets: list.some(row => row.set === setId) ? list : [...list, { set: setId }] }]
}
export function unlistSet (c: Folkish, kind: UnitKind, setId: string): Command[] {
  return [{ type: 'folk.kind.sets', id: kind.id, sets: (toList(c, kind) as Array<{ set: string }>).filter(row => row.set !== setId) }]
}
export function usePool (kind: UnitKind, step: string, poolId: string | null): Command[] {
  const pools = { ...kind.pools }; if (poolId === null) delete pools[step]; else pools[step] = poolId
  return [{ type: 'folk.kind.update', id: kind.id, patch: { pools } }]
}
export function copyPoolFor (c: Folkish, kind: UnitKind, poolId: string): Command[] {
  const pool = poolsOf(c).find(p => p.id === poolId)
  if (pool === undefined) return []
  const id = freeId(`${pool.id}-copy`, poolsOf(c))
  const pools = Object.fromEntries(Object.entries(kind.pools ?? {}).map(([step, value]) => [step, value === poolId ? id : value]))
  return [{ type: 'folk.pool.add', pool: { ...structuredClone(pool), id, name: `${pool.name} copy` } }, { type: 'folk.kind.update', id: kind.id, patch: { pools } }]
}
export function tagSetsByCulture (c: Folkish): Command[] {
  return setsOf(c).flatMap(set => { const culture = cultureOf(set.name); return culture === null || set.tags.some(t => t.startsWith('culture:')) ? [] : [{ type: 'folk.set.update' as const, id: set.id, patch: { tags: [...set.tags, `culture:${culture}`] } }] })
}
