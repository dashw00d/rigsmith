// What a dynamic character's unit file carries and the manifest the game dresses its units by (<unit>.folk.json,
// schema 2), as pure functions of the character and the unit spec: tools/lib/unit_export.ts builds the meshes and copies
// the images, these say which parts are the unit's and write the data (tested in folk_export.test.ts).
//
// Schema 2 carries the pick engine's whole input (src/engine/folkpick.ts FolkWorld: the program, sets, kinds, pools,
// skins, layers, pieces; gear named by its mesh) and ~32 golden picks the game's interpreter must reproduce, beside the
// schema 1 view the current game reads (`outfits`, `clothes`, `hair`, `beard`, `rules`).
import { candidates, goldens, PROGRAM, RNG, tagsAfter, type FolkWorld } from '../../src/engine/folkpick.ts'
import { gearLeftOut, meshNameOf } from '../../src/engine/contract.ts'
import { clothOf, folkOf, kindSets, LONG_SLEEVE_SHAPE } from '../../src/model/folk.ts'
import { safeName } from '../../src/model/select.ts'
import type { Character, ClothLayer, Gear, OutfitSet, Pool, Skin, Slot, UnitKind } from '../../src/model/types.ts'
import type { UnitSpec } from '../../src/model/unit.ts'

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

/** Whether a piece is swapped per unit (a set's or a pool's: the game shows it on the units that pick it). */
export const isSwapped = (scope: FolkScope, g: Gear): boolean => scope.swapped.has(g.id) || g.outfit !== undefined || g.role !== undefined

/** Swapped pieces in the exported scope are worn by picks even if hidden in the character's document. */
export function scopedGearLeftOut (g: Gear, scope: FolkScope | null): string | null {
  return gearLeftOut(scope?.carried.has(g.id) === true ? { ...g, hidden: false } : g)
}

/** Why a swapped piece of this file's scope isn't in it for its kind or pools (null: it is in scope, or it isn't
 * swapped; the contract's own reasons are gearLeftOut's). */
export function folkLeftOut (scope: FolkScope, g: Gear): string | null {
  if (!isSwapped(scope, g) || scope.carried.has(g.id) || inScope(scope, g)) return null
  return scope.hair.has(g.id) || g.role !== undefined ? 'hair and beards are another unit\'s file\'s' : 'another kind\'s outfit'
}

const inScope = (scope: FolkScope, g: Gear): boolean => scope.sets.some(s => s.pieces.includes(g.id)) || scope.pools.some(p => GEAR_POOLS.has(p.kind) && p.items.some(i => i.ref === g.id))

/** A swapped piece's atlas group: its schema 4 outfit or role (the names the game's maps have), else its first set's
 * name, else its pool's kind. */
export function atlasGroupOf (c: Character, g: Gear): string | undefined {
  if (g.outfit !== undefined || g.role !== undefined) return g.outfit ?? g.role
  const f = folkOf(c)
  return f.sets.find(s => s.pieces.includes(g.id))?.name ?? f.pools.find(p => GEAR_POOLS.has(p.kind) && p.items.some(i => i.ref === g.id))?.kind
}

/** A swapped piece as the manifest has it. */
export interface ManifestPiece { mesh: string, hides: number[], mask: number, tags: string[] }

export interface FolkFiles {
  /** Where each skin's image (and bare image) went, by skin name; each cloth layer's (and trim's), by layer id. */
  skins: Record<string, { file: string, bare?: string }>
  layers: Record<string, { file: string, trim?: string, mask?: string, baked?: boolean }>
  /** Schema 4's clothes (look.clothes) by name. */
  clothes: Record<string, string>
}

export interface FolkBody { mesh: string, shapes: string[] }

/** Distinct layer files even when names collide; validated ids retain their hyphens and underscores. */
export function clothExportBase (layer: Pick<ClothLayer, 'id' | 'name'>): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(layer.id)) throw new Error(`Invalid cloth layer id ${layer.id}`)
  return `clothes/${safeName(layer.name)}-${layer.id}`
}

/** The world the game runs (folkpick FolkWorld) as this file carries it: gear named by mesh. */
export function manifestWorld (c: Character, scope: FolkScope, meshOf: (g: Gear) => string = meshNameOf): FolkWorld {
  const byId = new Map(c.gear.map(g => [g.id, g]))
  const mesh = (gid: string): string | null => { const g = byId.get(gid); return g === undefined ? null : meshOf(g) }
  const ready = new Set(c.gear.filter(g => g.status === 'ready').map(g => g.id))
  return {
    program: PROGRAM,
    sets: scope.sets.map(s => ({ id: s.id, tags: s.tags, grants: s.grants, ...(s.weight !== undefined ? { weight: s.weight } : {}), ...(s.stance !== undefined ? { stance: s.stance } : {}) })),
    kinds: scope.kinds,
    pools: scope.pools.map(p => !GEAR_POOLS.has(p.kind) ? p : {
      ...p, items: p.items.flatMap(i => { const m = ready.has(i.ref) && scope.carried.has(i.ref) ? mesh(i.ref) : null; return m === null ? [] : [{ ...i, ref: m }] }),
    }),
    skins: (c.look.skins ?? []).map(k => ({ name: k.name, ...(k.tags !== undefined ? { tags: k.tags } : {}) })),
    layers: clothOf(c).map(l => ({ id: l.id, slots: l.slots, ...(l.tags !== undefined ? { tags: l.tags } : {}), ...(l.shapes !== undefined ? { shapes: l.shapes } : {}) })),
    pieces: c.gear.filter(g => ready.has(g.id) && scope.carried.has(g.id) && scope.pools.some(p => GEAR_POOLS.has(p.kind) && p.items.some(i => i.ref === g.id)))
      .map(g => ({ id: meshOf(g), ...(g.tags !== undefined ? { tags: g.tags } : {}) })),
  }
}

/** The manifest (<unit>.folk.json), schema 2. `pieceOf` a swapped piece's mesh, the regions it hides and their mask;
 * `regions` the body's (unit_export.ts); `files` where the images were copied; `bodies` the body meshes and the shapes
 * each has baked in. */
export function folkManifestData (c: Character, spec: Pick<UnitSpec, 'folk'>, o: {
  exportable?: (g: Gear) => boolean
  pieceOf: (g: Gear) => ManifestPiece
  regionMask: (hides: number[]) => number
  regions: Record<string, unknown>
  files: FolkFiles
  bodies: FolkBody[]
  hairGreyMean: number
  femaleShape: string
  meshOf?: (g: Gear) => string
}): Record<string, unknown> {
  const scope = folkScope(c, spec, o.exportable)
  const meshOf = o.meshOf ?? meshNameOf
  const world = manifestWorld(c, scope, meshOf)
  const byId = new Map(c.gear.map(g => [g.id, g]))
  const exported = (g: Gear | undefined): g is Gear => g !== undefined && scope.carried.has(g.id)
  const setPieces = (s: OutfitSet): ManifestPiece[] => s.pieces.map(id => byId.get(id)).filter(exported).map(o.pieceOf)
  const hidesOf = (pieces: ManifestPiece[]): number[] => [...new Set(pieces.flatMap(p => p.hides))].sort((a, b) => a - b)
  const layers = clothOf(c)
  const slotNames = new Map(c.clips.map(s => [s.id, s.name]))
  const sets = scope.sets.map(s => {
    const pieces = setPieces(s)
    const hides = hidesOf(pieces)
    return { id: s.id, name: s.name, tags: s.tags, grants: s.grants, ...(s.weight !== undefined ? { weight: s.weight } : {}), ...(s.stance !== undefined ? { stance: s.stance } : {}), pieces, hides, mask: o.regionMask(hides) }
  })
  // (the schema 1 view the current game reads: each set as an outfit by name, its clothes the ones the engine allows it)
  const outfits: Record<string, unknown> = {}
  for (const s of scope.sets) {
    const pieces = setPieces(s)
    const hides = hidesOf(pieces)
    const tags = tagsAfter(world, { set: s.id })
    const wear = new Set(candidates(world, 'bottom', tags).filter(x => x.ok).map(x => x.ref))
    outfits[s.name] = {
      pieces, hides, mask: o.regionMask(hides), coversHair: s.grants.includes('covers-hair'), coversFace: s.grants.includes('covers-face'),
      clothes: (c.look.clothes ?? []).filter(k => layers.some(l => l.name === k.name && wear.has(l.id))).map(k => k.name),
    }
  }
  const gearPool = (kind: 'hair' | 'beard'): ManifestPiece[] =>
    scope.pools.filter(p => p.kind === kind).flatMap(p => p.items.map(i => byId.get(i.ref))).filter(exported).map(o.pieceOf)
  const skin = (k: Skin): Record<string, unknown> => ({
    name: k.name, file: o.files.skins[k.name]?.file ?? k.file, ...(o.files.skins[k.name]?.bare !== undefined ? { bare: o.files.skins[k.name].bare } : {}), hair: k.hair ?? null, tags: k.tags ?? [],
  })
  const layer = (l: ClothLayer, i: number): Record<string, unknown> => ({
    id: l.id, name: l.name, index: i, file: o.files.layers[l.id]?.file ?? l.file, slots: l.slots, tags: l.tags ?? [], shapes: l.shapes ?? [],
    ...(o.files.layers[l.id]?.trim !== undefined ? { trim: o.files.layers[l.id].trim } : {}),
    ...(l.cut !== undefined ? { cut: { ...l.cut, ...(o.files.layers[l.id]?.mask !== undefined ? { mask: o.files.layers[l.id].mask } : {}), ...(o.files.layers[l.id]?.baked === true ? { baked: true } : {}) } } : {}),
  })
  return {
    schema: 2,
    about: 'A dynamic character (Rigsmith src/engine/folkpick.ts): every unit is dressed by running `program` over this file\'s sets, kinds, pools, skins, layers and pieces with its uid and the game\'s input tags (culture:<id>); `golden` holds picks the game\'s interpreter must reproduce exactly. The body\'s UV2 holds each vertex\'s region (x) and material class (y); a unit hides the regions in its set\'s mask (bit r = region r) by collapsing those vertices. Schema 1\'s view (outfits, clothes, hair, beard, rules) is kept for readers that don\'t run the program.',
    rng: RNG,
    program: PROGRAM,
    regions: o.regions,
    bodies: o.bodies,
    packing: {
      x: 'skin', y: 'top|bottom<<8|over<<16', z: 'mask', w: 'hair',
      note: 'per unit instance: x the skin\'s index in skins; y each slot\'s layer as its index in layers + 1 (0 none; a layer filling two slots is in the first only); z its set\'s region mask; w its skin\'s hair colour (0xRRGGBB, drawn divided by hairGreyMean)',
    },
    skins: (c.look.skins ?? []).map(skin),
    layers: layers.map(layer),
    sets,
    kinds: world.kinds,
    pools: world.pools,
    pieces: world.pieces,
    stances: folkOf(c).stances.map(s => ({
      id: s.id, name: s.name,
      clips: Object.fromEntries(Object.entries(s.clips).map(([clip, slots]) => [clip, slots.map(id => slotNames.get(id) ?? id)])),
      ...(s.overlay !== undefined ? { overlay: slotNames.get(s.overlay) ?? s.overlay } : {}),
    })),
    golden: goldens(world),
    hairGreyMean: o.hairGreyMean,
    femaleShape: o.femaleShape,
    longSleeveShape: LONG_SLEEVE_SHAPE,
    // ---- schema 1's view ----
    rules: [
      'hair or beard tagged fem: only on a skin tagged female; tagged masc: only on a skin not tagged female',
      'a skin tagged beardless takes no beard; a beard is worn about half the time otherwise',
      'an outfit with coversHair takes no hair; with coversFace, no beard; its clothes are the ones it lists (no long sleeves under bracers)',
      'hair and beard textures are grey: draw them with the skin\'s hair colour divided by hairGreyMean',
      'clothes (one per unit) are laid over the skin by their alpha; longSleeves: the body\'s longSleeveShape at 1',
      'a skin tagged female: femaleShape at 1 on the body and every piece (the gear carries the same shape)',
    ],
    clothes: (c.look.clothes ?? []).map(k => ({ name: k.name, file: o.files.clothes[k.name] ?? k.file, longSleeves: (k.tags ?? []).includes('long-sleeves'), tags: k.tags ?? [] })),
    outfits,
    hair: gearPool('hair'),
    beard: gearPool('beard'),
  }
}
