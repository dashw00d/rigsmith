// A dynamic character's dressing as data (types.ts FolkSection, ClothLayer): the one place that reads it, so every
// reader (the app's Wardrobe and dress state, the export, the migration) asks these functions and never Gear.outfit,
// Gear.role or look.clothes directly. Schema 5 documents carry `folk` and `look.cloth`; until the UI is ported the old
// fields stay beside them and the old commands keep both in step (commands/gear.ts and look.ts call syncLegacy*). A
// character without `folk` (one never migrated, a test fixture) reads as what its old fields say (folkFromLegacy).
//
// The rules of a pick as data (src/engine/folkpick.ts runs them):
//   hair or beard tagged 'fem'   requires 'female' (a skin tagged female)
//   hair or beard tagged 'masc'  excludes 'female'
//   the beard pool               excludes 'beardless' (the skin's), 'covers-face' (the set's grant); chance 0.5
//   the hair pool                excludes 'covers-hair' (the set's grant)
//   a long-sleeved cloth layer   excludes 'bracers' (the set's grant: the cuff would show through)
import { stableId } from './ids.ts'
import type { GameSpec } from './unit.ts'
import type { Character, ClothLayer, FolkSection, Gear, OutfitSet, Pool, PoolItem, PoolKind, Skin, UnitKind } from './types.ts'

/** A set's grants and where they come from (grantsOf). */
export const COVERS_HAIR = 'covers-hair'
export const COVERS_FACE = 'covers-face'
export const BRACERS = 'bracers'
export const HEAVY = 'heavy'
/** Piece tags that are grants of every set the piece is in. */
const GRANT_TAGS = [COVERS_HAIR, COVERS_FACE, BRACERS, HEAVY]
/** A forearm piece (by the game's piece names) is a bracer. */
const FOREARM = /forearm/i

/** The skin tag a 'fem' piece needs and a 'masc' one refuses (and the body's female shape follows). */
export const FEMALE_TAG = 'female'
export const BEARDLESS_TAG = 'beardless'
/** A schema 4 clothes layer's tag for long sleeves; the cloth layer's shape for them. */
export const LONG_SLEEVES_TAG = 'long-sleeves'
export const LONG_SLEEVE_SHAPE = 'long_sleeve'
/** The chance a unit wears a beard when one fits. */
export const BEARD_CHANCE = 0.5

/** What a set's pieces grant: covers-hair, covers-face, heavy from their tags; bracers from a forearm piece (or the tag).
 * Sorted. (What folk.ts coversHair, coversFace and hasBracers asked of an outfit.) */
export function grantsOf (pieces: ReadonlyArray<Pick<Gear, 'name' | 'tags'>>): string[] {
  const out = new Set<string>()
  for (const g of pieces) {
    for (const t of g.tags ?? []) if (GRANT_TAGS.includes(t)) out.add(t)
    if (FOREARM.test(g.name)) out.add(BRACERS)
  }
  return [...out].sort()
}

/** A set's grants after its pieces changed: what the old pieces granted and the new ones don't goes, what the new ones
 * grant comes; a grant given by hand (none of the pieces grants it) stays, and one taken off by hand stays off unless a
 * piece newly brings it. */
export function regrant (grants: readonly string[], before: ReadonlyArray<Pick<Gear, 'name' | 'tags'>>, after: ReadonlyArray<Pick<Gear, 'name' | 'tags'>>): string[] {
  const was = new Set(grantsOf(before))
  const now = new Set(grantsOf(after))
  const out = new Set(grants.filter(g => !(was.has(g) && !now.has(g))))
  for (const g of now) if (!was.has(g)) out.add(g)
  return [...out].sort()
}

/** A hair or beard item's rule from the piece's tags (fem: requires female; masc: excludes it). */
export function itemRule (g: Pick<Gear, 'tags'>): Pick<PoolItem, 'requires' | 'excludes'> {
  const tags = g.tags ?? []
  return {
    ...(tags.includes('fem') ? { requires: [FEMALE_TAG] } : {}),
    ...(tags.includes('masc') ? { excludes: [FEMALE_TAG] } : {}),
  }
}

/** A cloth layer's item rule: long sleeves don't go under bracers. */
export const layerRule = (l: Pick<ClothLayer, 'shapes'>): Pick<PoolItem, 'excludes'> =>
  (l.shapes ?? []).includes(LONG_SLEEVE_SHAPE) ? { excludes: [BRACERS] } : {}

// ---- reading (every reader goes through these) ----------------------------------------------------------------------

/** Whether it is a dynamic character: its folk section, or (not migrated) gear with an outfit or a role. */
export const isFolkCharacter = (c: Pick<Character, 'gear' | 'folk'>): boolean =>
  c.folk !== undefined || c.gear.some(g => g.outfit !== undefined || g.role !== undefined)

/** Its dressing: the folk section, or what its old fields say. */
export function folkOf (c: Character): FolkSection {
  return c.folk ?? folkFromLegacy(c)?.folk ?? { sets: [], pools: [], kinds: [], stances: [] }
}

export const setsOf = (c: Character): OutfitSet[] => folkOf(c).sets
export const poolsOf = (c: Character, kind?: PoolKind): Pool[] => folkOf(c).pools.filter(p => kind === undefined || p.kind === kind)
export const kindsOf = (c: Character): UnitKind[] => folkOf(c).kinds
export const setById = (c: Character, id: string): OutfitSet | undefined => setsOf(c).find(s => s.id === id)

/** Its cloth layers: look.cloth, or what look.clothes says. */
export function clothOf (c: Pick<Character, 'id' | 'look'>): ClothLayer[] {
  return c.look.cloth ?? (c.look.clothes ?? []).map(k => layerFromClothes(c.id, k))
}

/** The sets a piece is in (outfit membership: what replaces Gear.outfit). */
export const setsWith = (c: Character, gearId: string): OutfitSet[] => setsOf(c).filter(s => s.pieces.includes(gearId))

/** A set's pieces (gear that exists, in the set's order). */
export function piecesOf (c: Pick<Character, 'gear'>, set: Pick<OutfitSet, 'pieces'>): Gear[] {
  const byId = new Map(c.gear.map(g => [g.id, g]))
  return set.pieces.flatMap(id => byId.get(id) ?? [])
}

/** Every gear id in a set or a gear pool (what the folk export swaps per unit). */
export function folkGearIds (c: Character): Set<string> {
  const f = folkOf(c)
  return new Set([...f.sets.flatMap(s => s.pieces), ...f.pools.filter(p => p.kind === 'hair' || p.kind === 'beard' || p.kind === 'accessory').flatMap(p => p.items.map(i => i.ref))])
}

/** The sets a kind wears (its list, or its query over the sets' tags), each with its weight. */
export function kindSets (sets: readonly OutfitSet[], kind: Pick<UnitKind, 'sets'> | undefined): Array<{ set: OutfitSet, weight: number }> {
  if (kind === undefined) return sets.map(set => ({ set, weight: set.weight ?? 1 }))
  if (!Array.isArray(kind.sets)) {
    const q = kind.sets.query
    return sets.filter(s => q.every(t => s.tags.includes(t))).map(set => ({ set, weight: set.weight ?? 1 }))
  }
  const byId = new Map(sets.map(s => [s.id, s]))
  return kind.sets.flatMap(e => { const set = byId.get(e.set); return set === undefined ? [] : [{ set, weight: e.weight ?? set.weight ?? 1 }] })
}

// ---- schema 4 -> 5 ------------------------------------------------------------------------------------------------

/** The stable ids the migration (and the old commands keeping step) give what they make. */
export const setIdOf = (characterId: string, outfit: string): string => stableId(`${characterId}:set:${outfit}`)
export const poolIdOf = (characterId: string, what: string): string => stableId(`${characterId}:pool:${what}`)
export const layerIdOf = (characterId: string, name: string): string => stableId(`${characterId}:cloth:${name}`)

export const POOL_NAMES: Record<string, string> = { skin: 'Skins', cloth: 'Clothes', hair: 'Hair', beard: 'Beards' }

/** A schema 4 clothes layer as a cloth layer: top and bottom (it covers both areas), long sleeves its shape. */
export function layerFromClothes (characterId: string, k: Skin): ClothLayer {
  const long = (k.tags ?? []).includes(LONG_SLEEVES_TAG)
  return {
    id: layerIdOf(characterId, k.name), name: k.name, slots: ['top', 'bottom'], file: k.file,
    ...(long ? { shapes: [LONG_SLEEVE_SHAPE] } : {}),
    ...((k.tags ?? []).length > 0 ? { tags: [...k.tags!] } : {}),
  }
}

const poolOf = (characterId: string, kind: PoolKind, extra: Partial<Pool>, items: PoolItem[]): Pool =>
  ({ id: poolIdOf(characterId, kind), name: POOL_NAMES[kind] ?? kind, kind, ...extra, items })

export const hairPool = (characterId: string, items: PoolItem[]): Pool => poolOf(characterId, 'hair', { excludes: [COVERS_HAIR] }, items)
export const beardPool = (characterId: string, items: PoolItem[]): Pool => poolOf(characterId, 'beard', { chance: BEARD_CHANCE, excludes: [BEARDLESS_TAG, COVERS_FACE] }, items)
export const skinPool = (characterId: string, skins: readonly Skin[]): Pool => poolOf(characterId, 'skin', {}, skins.map(k => ({ ref: k.name })))
export const clothPool = (characterId: string, layers: readonly ClothLayer[]): Pool =>
  poolOf(characterId, 'cloth', { slot: 'bottom' }, layers.map(l => ({ ref: l.id, ...layerRule(l) })))

/** An outfit (schema 4's Gear.outfit) as a set. */
export function setFromOutfit (characterId: string, gear: readonly Gear[], outfit: string): OutfitSet {
  const pieces = gear.filter(g => g.outfit === outfit)
  return { id: setIdOf(characterId, outfit), name: outfit, pieces: pieces.map(g => g.id), tags: [], grants: grantsOf(pieces) }
}

/** What a schema 4 dynamic character's old fields say as schema 5 data (null: it isn't one): each distinct outfit a set,
 * the hair and beard roles pools with today's rules, the skins the skin pool, each clothes layer a cloth layer (top and
 * bottom) in the cloth pool, and the kinds of the game's units of it (their folk.outfits; none: one kind 'folk' that
 * wears every set). Pure and deterministic (stable ids). */
export function folkFromLegacy (c: Pick<Character, 'id' | 'gear' | 'look'>, units?: GameSpec): { folk: FolkSection, cloth: ClothLayer[] } | null {
  if (!c.gear.some(g => g.outfit !== undefined || g.role !== undefined)) return null
  const outfits = [...new Set(c.gear.flatMap(g => (g.outfit !== undefined ? [g.outfit] : [])))].sort()
  const sets = outfits.map(o => setFromOutfit(c.id, c.gear, o))
  const cloth = (c.look.clothes ?? []).map(k => layerFromClothes(c.id, k))
  const role = (r: 'hair' | 'beard'): PoolItem[] => c.gear.filter(g => g.role === r).map(g => ({ ref: g.id, ...itemRule(g) }))
  const pools: Pool[] = []
  if ((c.look.skins ?? []).length > 0) pools.push(skinPool(c.id, c.look.skins!))
  if (cloth.length > 0) pools.push(clothPool(c.id, cloth))
  const hair = role('hair'); const beard = role('beard')
  if (hair.length > 0) pools.push(hairPool(c.id, hair))
  if (beard.length > 0) pools.push(beardPool(c.id, beard))
  const kinds: UnitKind[] = Object.entries(units?.units ?? {})
    .filter(([, u]) => u.character === c.id && u.folk?.outfits !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([unit, u]) => ({ id: unit, name: unit, tags: [], sets: u.folk!.outfits!.filter(o => outfits.includes(o)).map(o => ({ set: setIdOf(c.id, o) })) }))
  if (kinds.length === 0) kinds.push({ id: 'folk', name: 'Folk', tags: [], sets: { query: [] } })
  return { folk: { sets, pools, kinds, stances: [] }, cloth }
}

// ---- the old commands kept in step (until the UI is ported) ----------------------------------------------------------

/** After a piece's old fields changed (gear.add, gear.update's outfit, role or tags): its sets and pools follow. A
 * character without `folk` is left as it is (its old fields are what it reads). Returns the journal's lines. */
export function syncLegacyPiece (c: Character, g: Gear, before: Pick<Gear, 'outfit' | 'role' | 'tags' | 'name'> | null): string[] {
  const f = c.folk
  if (f === undefined) return []
  const out: string[] = []
  const was: Partial<Pick<Gear, 'outfit' | 'role' | 'tags' | 'name'>> = before ?? {}
  // (its outfit: out of the set named after the old one, into the one named after the new, made when there is none)
  if (was.outfit !== g.outfit) {
    if (was.outfit !== undefined) {
      const old = f.sets.find(s => s.name === was.outfit && s.pieces.includes(g.id))
      if (old !== undefined) setPieces(c, old, old.pieces.filter(p => p !== g.id))
    }
    if (g.outfit !== undefined) {
      let set = f.sets.find(s => s.name === g.outfit)
      if (set === undefined) {
        set = { id: freeId(setIdOf(c.id, g.outfit), f.sets), name: g.outfit, pieces: [], tags: [], grants: [] }
        f.sets.push(set)
        out.push(`set ${set.name}: added`)
      }
      if (!set.pieces.includes(g.id)) setPieces(c, set, [...set.pieces, g.id])
    }
  } else if (before !== null && (was.name !== g.name || (was.tags ?? []).join(' ') !== (g.tags ?? []).join(' '))) {
    // (a tag or name that grants something: every set it is in re-derives)
    for (const set of f.sets.filter(s => s.pieces.includes(g.id))) {
      const others = piecesOf(c, set).filter(p => p.id !== g.id)
      set.grants = regrant(set.grants, [...others, { name: was.name ?? g.name, tags: was.tags }], [...others, g])
    }
  }
  // (its role: out of the other role's pools, into the first pool of its role, made when there is none)
  if (was.role !== g.role || before === null) {
    for (const p of f.pools) {
      if ((p.kind === 'hair' || p.kind === 'beard') && p.kind !== g.role) p.items = p.items.filter(i => i.ref !== g.id)
    }
    if (g.role !== undefined) {
      let pool = f.pools.find(p => p.kind === g.role)
      if (pool === undefined) {
        pool = (g.role === 'hair' ? hairPool : beardPool)(c.id, [])
        pool.id = freeId(pool.id, f.pools)
        f.pools.push(pool)
        out.push(`pool ${pool.name}: added`)
      }
      if (!pool.items.some(i => i.ref === g.id)) pool.items.push({ ref: g.id, ...itemRule(g) })
    }
  }
  // (fem and masc: its items' rule follows the tags, as the old rule read them)
  if (before !== null && (was.tags ?? []).join(' ') !== (g.tags ?? []).join(' ')) {
    const rule = itemRule(g)
    for (const p of f.pools.filter(x => x.kind === 'hair' || x.kind === 'beard')) {
      for (const i of p.items.filter(x => x.ref === g.id)) {
        const keep = (xs: string[] | undefined): string[] => (xs ?? []).filter(t => t !== FEMALE_TAG)
        const requires = [...keep(i.requires), ...(rule.requires ?? [])]
        const excludes = [...keep(i.excludes), ...(rule.excludes ?? [])]
        if (requires.length > 0) i.requires = requires
        else delete i.requires
        if (excludes.length > 0) i.excludes = excludes
        else delete i.excludes
      }
    }
  }
  return out
}

/** A set's pieces replaced, its grants following (regrant). */
export function setPieces (c: Pick<Character, 'gear'>, set: OutfitSet, pieces: string[]): void {
  const before = piecesOf(c, set)
  set.pieces = pieces
  set.grants = regrant(set.grants, before, piecesOf(c, set))
}

/** After look.skins.set: the skin pools keep the skins still there (in their order) and the first one takes the new. */
export function syncLegacySkins (c: Character): void {
  const f = c.folk
  if (f === undefined) return
  const names = (c.look.skins ?? []).map(k => k.name)
  const pools = f.pools.filter(p => p.kind === 'skin')
  for (const p of pools) p.items = p.items.filter(i => names.includes(i.ref))
  const listed = new Set(pools.flatMap(p => p.items.map(i => i.ref)))
  const fresh = names.filter(n => !listed.has(n))
  if (fresh.length === 0) return
  let pool = pools[0]
  if (pool === undefined) { pool = skinPool(c.id, []); pool.id = freeId(pool.id, f.pools); f.pools.unshift(pool) }
  pool.items.push(...fresh.map(ref => ({ ref })))
}

/** After look.clothes.set: look.cloth follows by name (a layer kept keeps its cut, trim and the rest; its file and long
 * sleeves follow), new ones in the first cloth pool, gone ones out of every pool. */
export function syncLegacyClothes (c: Character): void {
  const f = c.folk
  if (f === undefined && c.look.cloth === undefined) return
  const old = new Map((c.look.cloth ?? []).map(l => [l.name, l]))
  const next = (c.look.clothes ?? []).map(k => {
    const made = layerFromClothes(c.id, k)
    const was = old.get(k.name)
    if (was === undefined) return { ...made, id: freeId(made.id, c.look.cloth ?? []) }
    const l: ClothLayer = { ...was, file: k.file }
    const shapes = [...(was.shapes ?? []).filter(s => s !== LONG_SLEEVE_SHAPE), ...(made.shapes ?? [])]
    if (shapes.length > 0) l.shapes = shapes
    else delete l.shapes
    if (made.tags !== undefined) l.tags = made.tags
    else delete l.tags
    return l
  })
  if (next.length > 0) c.look.cloth = next
  else delete c.look.cloth
  if (f === undefined) return
  const ids = new Set(next.map(l => l.id))
  const pools = f.pools.filter(p => p.kind === 'cloth')
  for (const p of pools) p.items = p.items.filter(i => ids.has(i.ref))
  const listed = new Set(pools.flatMap(p => p.items.map(i => i.ref)))
  const fresh = next.filter(l => !listed.has(l.id))
  if (fresh.length > 0) {
    let pool = pools[0]
    if (pool === undefined) { pool = clothPool(c.id, []); pool.id = freeId(pool.id, f.pools); f.pools.push(pool) }
    pool.items.push(...fresh.map(l => ({ ref: l.id, ...layerRule(l) })))
  }
  // (a long-sleeve rule follows the layer's shape)
  for (const p of pools) {
    for (const i of p.items) {
      const l = next.find(x => x.id === i.ref)
      if (l === undefined) continue
      const excludes = [...(i.excludes ?? []).filter(t => t !== BRACERS), ...(layerRule(l).excludes ?? [])]
      if (excludes.length > 0) i.excludes = excludes
      else delete i.excludes
    }
  }
}

/** `id`, or `id-2`, `id-3`... when an item has it already. */
export function freeId (id: string, items: ReadonlyArray<{ id: string }>): string {
  if (!items.some(x => x.id === id)) return id
  for (let i = 2; ; i++) if (!items.some(x => x.id === `${id}-${i}`)) return `${id}-${i}`
}
