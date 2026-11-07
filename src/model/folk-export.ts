// Shared unit scope and stance export planning for Ship and the exporter.
import { folkOf, kindSets } from './folk.ts'
import type { Character, Gear, OutfitSet, Pool, Slot, UnitKind } from './types.ts'
import type { UnitSpec } from './unit.ts'

/** The sets, kinds, pools and swapped gear a unit's file carries. */
export interface FolkScope {
  sets: OutfitSet[]
  kinds: UnitKind[]
  pools: Pool[]
  /** Gear ids of every swapped piece (in a set or a gear pool) of the character. */
  swapped: Set<string>
  /** Of those, the ones this file carries (its scope's, and exportable). */
  carried: Set<string>
  /** Gear ids in a hair pool (hair hides no body region). */
  hair: Set<string>
}

const GEAR_POOLS = new Set(['hair', 'beard', 'accessory'])

/** What a unit's file carries of a dynamic character: its kind's sets (spec.folk.kind; schema 4's folk.outfits by name;
 * neither: all), the kinds of those, its pools (spec.folk.pools by id or kind; hair: false leaves out hair and beards),
 * and the gear in them that can be exported (`exportable`: the unit export's contract, shown or not). */
export function folkScope (c: Character, spec: Pick<UnitSpec, 'folk'>, exportable: (g: Gear) => boolean = () => true): FolkScope {
  const f = folkOf(c)
  const want = spec.folk
  let sets = f.sets
  let kinds = f.kinds
  if (want?.kind !== undefined) {
    const kind = f.kinds.find(k => k.id === want.kind)
    if (kind === undefined) throw new Error(`folk kind ${want.kind} is not one of ${c.name}'s (${f.kinds.map(k => k.id).join(', ') || 'none'})`)
    const mine = new Set(kindSets(f.sets, kind).map(x => x.set.id))
    sets = f.sets.filter(s => mine.has(s.id))
    kinds = [kind]
  } else if (want?.outfits !== undefined) {
    sets = f.sets.filter(s => want.outfits!.includes(s.name))
    const ids = new Set(sets.map(s => s.id))
    kinds = f.kinds.filter(k => !Array.isArray(k.sets) || k.sets.some(e => ids.has(e.set)))
  }
  const pools = f.pools.filter(p => want?.pools !== undefined ? (want.pools.includes(p.id) || want.pools.includes(p.kind))
    : !(want?.hair === false && (p.kind === 'hair' || p.kind === 'beard')))
  const gearIn = (ps: readonly Pool[]): string[] => ps.filter(p => GEAR_POOLS.has(p.kind)).flatMap(p => p.items.map(i => i.ref))
  return {
    sets, kinds, pools,
    swapped: new Set([...f.sets.flatMap(s => s.pieces), ...gearIn(f.pools)]),
    carried: new Set([...sets.flatMap(s => s.pieces), ...gearIn(pools)].filter(id => { const g = c.gear.find(x => x.id === id); return g !== undefined && exportable(g) })),
    hair: new Set(gearIn(f.pools.filter(p => p.kind === 'hair'))),
  }
}

export interface StanceExportPlan { id: string, setId: string | null, slots: Slot[], clips: Record<string, string[]>, overlay?: Slot }

/** Resolve the stances actually reachable by this unit, and refuse a shared stance with different held pieces. */
export function stanceExportPlan (c: Character, spec: Pick<UnitSpec, 'folk'>, gameClips: readonly string[], baseNames: readonly string[]): StanceExportPlan[] {
  const folk = folkOf(c); const scope = folkScope(c, spec)
  const setsByStance = new Map<string, OutfitSet[]>()
  const withoutSet = new Map<string, string>()
  const add = (id: string, set: OutfitSet): void => {
    const sets = setsByStance.get(id) ?? []
    if (!sets.some(s => s.id === set.id)) sets.push(set)
    setsByStance.set(id, sets)
  }
  for (const set of scope.sets) {
    if (set.stance !== undefined) add(set.stance, set)
    else for (const kind of scope.kinds) if (kind.stance !== undefined && kindSets(scope.sets, kind).some(x => x.set.id === set.id)) add(kind.stance, set)
  }
  for (const kind of scope.kinds) if (kind.stance !== undefined && kindSets(scope.sets, kind).length === 0) {
    if (!setsByStance.has(kind.stance)) setsByStance.set(kind.stance, [])
    withoutSet.set(kind.stance, kind.name)
  }
  const names = new Set(baseNames); const result: StanceExportPlan[] = []
  for (const [id, sets] of setsByStance) {
    const stance = folk.stances.find(s => s.id === id)
    if (stance === undefined) throw new Error(`stance ${id} referenced by ${sets.map(s => s.name).join(', ') || withoutSet.get(id) || 'a kind'} is missing`)
    const held = (set: OutfitSet): string => JSON.stringify(set.pieces.filter(piece => c.gear.some(g => g.id === piece && g.attach.kind === 'bone')).sort())
    const first = sets.length === 0 ? '[]' : held(sets[0])
    const conflict = sets.find(s => held(s) !== first)
    if (conflict !== undefined) throw new Error(`stance ${id}: sets ${sets[0].name} and ${conflict.name} hold different bone-attached pieces`)
    if (withoutSet.has(id) && first !== '[]') throw new Error(`stance ${id}: kind ${withoutSet.get(id)} without a set and set ${sets[0].name} hold different bone-attached pieces`)
    const slots: Slot[] = []; const clips: Record<string, string[]> = {}
    for (const clip of gameClips) {
      const ids = stance.clips[clip]
      if (ids === undefined || ids.length === 0) continue
      clips[clip] = ids.map((slotId, index) => {
        const original = c.clips.find(s => s.id === slotId)
        if (original === undefined) throw new Error(`stance ${id}: ${clip} names missing slot ${slotId}`)
        const name = `${clip}${index === 0 ? '' : `_${index + 1}`}@${id}`
        if (names.has(name)) throw new Error(`stance ${id}: exported clip name ${name} clashes`)
        names.add(name); slots.push({ ...original, name })
        return name
      })
    }
    const overlay = stance.overlay === undefined ? undefined : c.clips.find(s => s.id === stance.overlay)
    if (stance.overlay !== undefined && overlay === undefined) throw new Error(`stance ${id}: missing overlay slot ${stance.overlay}`)
    if (slots.length > 0) result.push({ id, setId: sets[0]?.id ?? null, slots, clips, ...(overlay !== undefined ? { overlay } : {}) })
  }
  return result
}

