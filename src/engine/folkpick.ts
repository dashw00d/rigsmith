// The one pick engine of a dynamic character (docs/dressing-plan.md Phase 1): a small interpreter over data. A unit's
// look is a program of steps run in order,
//
//   set (of its kind) -> skin -> bottom -> top -> over -> hair -> beard -> accessory
//
// each drawing one item (or none) from a pool (types.ts Pool) by weight among those its running tags allow. The
// running tags start as the kind's tags and the game's inputs (`culture:norse`), and every pick adds its own: the set's
// tags and grants (covers-hair...), the skin's (female, beardless), a cloth layer's tags and `shape:<shape>`, a piece's
// tags. An item is allowed when its pool's and its own `requires` are all present and their `excludes` none. A cloth
// step is skipped when an earlier layer fills its slot (a tunic-and-trousers layer fills top and bottom). Each step
// draws with its own salt: draw(uid, salt, k) = fmix32(fnv1a32("<uid>|<salt>|<k>")) / 2^32, k 0 the step's chance, 1
// its pick; so a villager who becomes a spearman keeps his skin, and his hair when the new set doesn't cover it.
//
// Rigsmith (the Wardrobe, the crowd, "unit #1234"), the export's golden picks and the game's C# FolkProgram run the same
// data through the same steps: the manifest (tools/lib/unit_export.ts) carries `program`, the world and ~32 goldens.
import { fnv1a } from '../model/ids.ts'
import { clothOf, folkOf, FEMALE_TAG, kindSets } from '../model/folk.ts'
import type { Character, ClothSlot, OutfitSet, Pool, PoolItem, PoolKind, UnitKind } from '../model/types.ts'

export { clothOf, folkOf, kindsOf, poolsOf, setsOf, setsWith, piecesOf } from '../model/folk.ts'

/** One step of the program. */
export interface FolkStep {
  /** Its name: what a kind's `pools` maps, a pick reports and a fixed choice names. */
  id: string
  /** What it picks: a set of the unit's kind, or an item of a pool of this kind. */
  kind: 'set' | PoolKind
  /** cloth: the slot it fills. */
  slot?: ClothSlot
  /** The chance it picks at all when its pool says none (default 1). */
  chance?: number
  /** Its draws' salt. */
  salt: string
  /** set: tag namespaces a set must agree with the running tags on: a set tagged `culture:gael` is not picked for a
   * unit whose tags say `culture:norse` (one that names no culture is picked for any). When no set agrees, any of the
   * kind's is. */
  match?: string[]
}

export const PROGRAM: readonly FolkStep[] = [
  { id: 'set', kind: 'set', salt: 'set', match: ['culture'] },
  { id: 'skin', kind: 'skin', salt: 'skin' },
  { id: 'bottom', kind: 'cloth', slot: 'bottom', salt: 'bottom' },
  { id: 'top', kind: 'cloth', slot: 'top', salt: 'top' },
  { id: 'over', kind: 'cloth', slot: 'over', salt: 'over', chance: 0.5 },
  { id: 'hair', kind: 'hair', salt: 'hair' },
  { id: 'beard', kind: 'beard', salt: 'beard', chance: 0.5 },
  { id: 'accessory', kind: 'accessory', salt: 'accessory', chance: 0.5 },
]

/** Running tags that turn a body shape on (the skin's female: the female shape). */
export const SHAPE_TAGS: Readonly<Record<string, string>> = { [FEMALE_TAG]: 'female' }
/** The tag a cloth layer's shape adds. */
export const shapeTag = (shape: string): string => `shape:${shape}`

/** What the engine runs on: the program and the character's dressing, its items by ref with their tags. The manifest
 * carries exactly this (gear refs as mesh names). Items a pool names that aren't here are never picked. */
export interface FolkWorld {
  program: readonly FolkStep[]
  sets: ReadonlyArray<Pick<OutfitSet, 'id' | 'tags' | 'grants'> & { weight?: number, stance?: string }>
  kinds: readonly UnitKind[]
  pools: readonly Pool[]
  skins: ReadonlyArray<{ name: string, tags?: string[] }>
  layers: ReadonlyArray<{ id: string, slots: ClothSlot[], tags?: string[], shapes?: string[] }>
  /** Hair, beards, accessories (by gear id; in the manifest by mesh name). */
  pieces: ReadonlyArray<{ id: string, tags?: string[] }>
}

export interface FolkInputs {
  /** The unit kind (unset: the first). */
  kind?: string
  /** The game's inputs: 'culture:norse'... */
  tags?: readonly string[]
  /** Choices made already (a lock in the Wardrobe, the set shown): step id -> ref, null for none. Taken as given (their
   * tags still join), not checked. */
  fixed?: Readonly<Record<string, string | null>>
}

export interface FolkPick {
  kind: string | null
  /** Step id -> what it picked (a set id, a skin name, a layer id, a gear id), null for none. */
  picks: Record<string, string | null>
  /** The cloth layers worn, bottom to top (each once). */
  layers: string[]
  /** The stance: the set's, else the kind's. */
  stance: string | null
  /** The body shapes on: 'female', 'long_sleeve'. Sorted. */
  shapes: string[]
  /** The running tags at the end, sorted. */
  tags: string[]
}

/** An item a step could pick, and why not when it can't. */
export interface Candidate { ref: string, weight: number, ok: boolean, why?: string }

// ---- the draws -------------------------------------------------------------------------------------------------

/** murmur3's finaliser: spreads FNV-1a's last bytes over every bit. */
export function fmix32 (h: number): number {
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A unit's k-th draw of a step: [0, 1). */
export const draw = (uid: string | number, salt: string, k: number): number => fmix32(fnv1a(`${uid}|${salt}|${k}`)) / 4294967296

/** How the manifest says the draws are made (the game's C# reproduces it). */
export const RNG = {
  key: '<uid>|<salt>|<k>', hash: 'fnv1a32 over the key\'s UTF-8 bytes, then murmur3 fmix32', scale: 'divided by 2^32',
  draws: 'k 0: the step\'s chance (picks when below it); k 1: the pick (r * total weight, the first item whose running sum passes it)',
} as const

/** The item at `r` of a weighted list (weights > 0), or null. */
export function weighted<T extends { weight: number }> (items: readonly T[], r: number): T | null {
  const total = items.reduce((t, x) => t + x.weight, 0)
  if (!(total > 0)) return null
  const at = r * total
  let sum = 0
  for (const x of items) { sum += x.weight; if (at < sum) return x }
  return items[items.length - 1]
}

// ---- the rules ---------------------------------------------------------------------------------------------------

/** Why a rule rules something out under `tags` (null: it allows it). */
export function ruleOut (rule: { requires?: readonly string[], excludes?: readonly string[] }, tags: ReadonlySet<string>): string | null {
  const lacking = (rule.requires ?? []).filter(t => !tags.has(t))
  if (lacking.length > 0) return `needs ${lacking.join(', ')}`
  const clash = (rule.excludes ?? []).filter(t => tags.has(t))
  if (clash.length > 0) return `not with ${clash.join(', ')}`
  return null
}

/** The pool a step draws from for a kind: the kind's choice, else the first of the step's kind (and slot). */
export function poolFor (w: FolkWorld, step: FolkStep, kind: UnitKind | undefined): Pool | null {
  const named = kind?.pools?.[step.id]
  if (named !== undefined) return w.pools.find(p => p.id === named) ?? null
  return w.pools.find(p => p.kind === step.kind && (step.kind !== 'cloth' || p.slot === undefined || p.slot === step.slot)) ?? null
}

const kindOf = (w: FolkWorld, id: string | undefined): UnitKind | undefined => id === undefined ? w.kinds[0] : w.kinds.find(k => k.id === id)

/** The tags an item adds when picked. */
function itemTags (w: FolkWorld, kind: PoolKind, ref: string): string[] | null {
  if (kind === 'skin') { const k = w.skins.find(x => x.name === ref); return k === undefined ? null : [...(k.tags ?? [])] }
  if (kind === 'cloth') { const l = w.layers.find(x => x.id === ref); return l === undefined ? null : [...(l.tags ?? []), ...(l.shapes ?? []).map(shapeTag)] }
  const g = w.pieces.find(x => x.id === ref)
  return g === undefined ? null : [...(g.tags ?? [])]
}

/** What a step may pick under `tags` (the set step: the kind's sets; a pool step: its pool's items), each with its weight
 * and whether it is allowed (why not). `filled`: the cloth slots earlier layers fill. */
export function candidates (w: FolkWorld, stepId: string, tags: Iterable<string>, o: { kind?: string, filled?: Iterable<ClothSlot> } = {}): Candidate[] {
  const step = w.program.find(s => s.id === stepId)
  if (step === undefined) return []
  const have = new Set(tags)
  const kind = kindOf(w, o.kind)
  if (step.kind === 'set') {
    const listed = kindSets(w.sets as OutfitSet[], kind)
    const out = listed.map(({ set, weight }): Candidate => {
      const why = disagrees(set.tags, have, step.match ?? [])
      return { ref: set.id, weight, ok: weight > 0 && why === null, ...(why !== null ? { why } : weight > 0 ? {} : { why: 'weight 0' }) }
    })
    // (no set agrees: any of the kind's will do, so a unit is never left with none)
    if (!out.some(x => x.ok)) for (const x of out) if (x.weight > 0) { x.ok = true; delete x.why }
    return out
  }
  const pool = poolFor(w, step, kind)
  if (pool === null) return []
  const filled = new Set(o.filled ?? [])
  const poolWhy = ruleOut(pool, have)
  return pool.items.flatMap((item: PoolItem): Candidate[] => {
    if (itemTags(w, pool.kind, item.ref) === null) return []
    const weight = item.weight ?? 1
    let why = poolWhy ?? ruleOut(item, have)
    if (why === null && pool.kind === 'cloth') {
      const l = w.layers.find(x => x.id === item.ref)!
      if (step.slot !== undefined && !l.slots.includes(step.slot)) why = `fills no ${step.slot}`
      else if (l.slots.some(s => filled.has(s))) why = `its ${l.slots.filter(s => filled.has(s)).join(', ')} filled already`
    }
    if (why === null && !(weight > 0)) why = 'weight 0'
    return [{ ref: item.ref, weight, ok: why === null, ...(why !== null ? { why } : {}) }]
  })
}

/** Why a set's tags disagree with the running tags on a namespace (null: they don't). */
function disagrees (setTags: readonly string[], have: ReadonlySet<string>, namespaces: readonly string[]): string | null {
  for (const ns of namespaces) {
    const mine = setTags.filter(t => t.startsWith(`${ns}:`))
    const theirs = [...have].filter(t => t.startsWith(`${ns}:`))
    if (mine.length > 0 && theirs.length > 0 && !mine.some(t => have.has(t))) return `not ${theirs.join(', ')}`
  }
  return null
}

// ---- the run -----------------------------------------------------------------------------------------------------

/** A unit's look: the program run for `uid` (the game's unit id; any string or number). */
export function pick (w: FolkWorld, uid: string | number, inputs: FolkInputs = {}): FolkPick {
  const kind = kindOf(w, inputs.kind)
  const tags = new Set<string>([...(kind?.tags ?? []), ...(inputs.tags ?? [])])
  const picks: Record<string, string | null> = {}
  const filled = new Set<ClothSlot>()
  const layers: string[] = []
  let stance = kind?.stance ?? null
  for (const step of w.program) {
    const fixed = inputs.fixed !== undefined && Object.hasOwn(inputs.fixed, step.id) ? inputs.fixed[step.id] : undefined
    let ref: string | null
    if (fixed !== undefined) ref = fixed
    else if (step.kind === 'cloth' && step.slot !== undefined && filled.has(step.slot)) ref = null
    else {
      const allowed = candidates(w, step.id, tags, { kind: kind?.id, filled }).filter(x => x.ok)
      const chance = step.kind === 'set' ? 1 : (poolFor(w, step, kind)?.chance ?? step.chance ?? 1)
      ref = allowed.length === 0 || !(draw(uid, step.salt, 0) < chance) ? null : weighted(allowed, draw(uid, step.salt, 1))?.ref ?? null
    }
    picks[step.id] = ref
    if (ref === null) continue
    if (step.kind === 'set') {
      const set = w.sets.find(s => s.id === ref)
      for (const t of [...(set?.tags ?? []), ...(set?.grants ?? [])]) tags.add(t)
      if (set?.stance !== undefined) stance = set.stance
      continue
    }
    for (const t of itemTags(w, step.kind, ref) ?? []) tags.add(t)
    if (step.kind === 'cloth') {
      const l = w.layers.find(x => x.id === ref)
      for (const s of l?.slots ?? (step.slot !== undefined ? [step.slot] : [])) filled.add(s)
      if (!layers.includes(ref)) layers.push(ref)
    }
  }
  const shapes = new Set<string>()
  for (const [tag, shape] of Object.entries(SHAPE_TAGS)) if (tags.has(tag)) shapes.add(shape)
  for (const id of layers) for (const s of w.layers.find(x => x.id === id)?.shapes ?? []) shapes.add(s)
  return { kind: kind?.id ?? null, picks, layers, stance, shapes: [...shapes].sort(), tags: [...tags].sort() }
}

// ---- a character's world ---------------------------------------------------------------------------------------

/** A character's dressing as the engine reads it: its folk section (or what its old fields say), its skins, its cloth
 * layers, and its ready gear as pieces (a piece still importing or failed is never picked). */
export function worldOf (c: Character, program: readonly FolkStep[] = PROGRAM): FolkWorld {
  const f = folkOf(c)
  return {
    program,
    sets: f.sets,
    kinds: f.kinds,
    pools: f.pools,
    skins: (c.look.skins ?? []).map(k => ({ name: k.name, ...(k.tags !== undefined ? { tags: k.tags } : {}) })),
    layers: clothOf(c).map(l => ({ id: l.id, slots: l.slots, ...(l.tags !== undefined ? { tags: l.tags } : {}), ...(l.shapes !== undefined ? { shapes: l.shapes } : {}) })),
    pieces: c.gear.filter(g => g.status === 'ready').map(g => ({ id: g.id, ...(g.tags !== undefined ? { tags: g.tags } : {}) })),
  }
}

/** The running tags after the set and skin (what the later steps' rules see), for a kind, a set and a skin given. */
export function tagsAfter (w: FolkWorld, o: { kind?: string, set?: string | null, skin?: string | null, inputs?: readonly string[] }): Set<string> {
  const kind = kindOf(w, o.kind)
  const tags = new Set<string>([...(kind?.tags ?? []), ...(o.inputs ?? [])])
  const set = o.set == null ? undefined : w.sets.find(s => s.id === o.set)
  for (const t of [...(set?.tags ?? []), ...(set?.grants ?? [])]) tags.add(t)
  for (const t of (o.skin == null ? undefined : w.skins.find(k => k.name === o.skin))?.tags ?? []) tags.add(t)
  return tags
}

/** Golden picks for the manifest: `n` units (uids 1, 7, 13...: spread, and the same every export) of every kind, with
 * and without each culture its sets name, so the game's interpreter can be checked against this one. */
export function goldens (w: FolkWorld, n = 32): Array<{ uid: number, inputs: { kind: string | null, tags: string[] }, pick: FolkPick }> {
  const cultures = [...new Set(w.sets.flatMap(s => s.tags.filter(t => t.startsWith('culture:'))))].sort()
  const inputs: Array<{ kind: string | null, tags: string[] }> = []
  for (const k of w.kinds.length > 0 ? w.kinds : [undefined]) {
    inputs.push({ kind: k?.id ?? null, tags: [] })
    for (const c of cultures) inputs.push({ kind: k?.id ?? null, tags: [c] })
  }
  return Array.from({ length: n }, (_, i) => {
    const uid = 1 + i * 6
    const input = inputs[i % inputs.length]
    return { uid, inputs: input, pick: pick(w, uid, { kind: input.kind ?? undefined, tags: input.tags }) }
  })
}
