// folk.*: a dynamic character's dressing (types.ts FolkSection): its outfit sets, the pools a unit's pick draws from,
// the unit kinds and the stances. look.cloth.* (its cloth layers) is read here too and reduced by commands/look.ts.
// The first set, pool, kind or stance added makes the section. What points at a thing removed goes with it (a kind's
// set or pool, a set's or kind's stance) and comes back with an undo; gear and slots removed elsewhere are taken out by
// pruneGear and pruneSlots (commands/gear.ts, commands/clips.ts call them).
import type { Command, KindPatch, PoolPatch, SetPatch } from '../command-types.ts'
import { grantsOf, piecesOf, regrant } from '../folk.ts'
import type { Character, ClothCut, ClothLayer, ClothSlot, FolkSection, Gear, OutfitSet, Pool, PoolItem, PoolKind, Stance, UnitKind } from '../types.ts'
import { CLOTH_SLOTS } from '../types.ts'
import {
  bad, conflict, id, isObj, list, missing, name, names, note, num, obj, oneOf, opt, patchOf, plural, reorder, same, str, under, uniqueName, unknown,
} from './common.ts'

export type FolkCommand = Extract<Command, { type: `folk.${string}` }>

const POOL_KINDS: readonly PoolKind[] = ['skin', 'cloth', 'hair', 'beard', 'accessory']

// ---- checks ------------------------------------------------------------------------------------------------------

/** A folk tag: a word, or namespace:word ('culture:norse', 'covers-hair', 'shape:long_sleeve'). */
export function folkTags (v: unknown, what: string): string[] {
  return [...new Set(list(v, what, (x, w) => {
    const t = typeof x === 'string' ? x.trim() : ''
    return /^[a-z0-9_-]{1,32}(:[a-z0-9_-]{1,32})?$/.test(t) ? t : bad(`${w} must be a short lower-case word or namespace:word`)
  }))]
}

/** Ids, none twice. */
function ids (v: unknown, what: string): string[] {
  const out = list(v, what, id)
  if (new Set(out).size !== out.length) bad(`${what} repeat`)
  return out
}

const weightOf = (v: unknown, what: string): number => num(v, what, { min: 0 })
const chanceOf = (v: unknown, what: string): number => num(v, what, { min: 0, max: 1 })

const section = (c: Character): FolkSection => (c.folk ??= { sets: [], pools: [], kinds: [], stances: [] })
const folkOrMissing = (c: Character): FolkSection => c.folk ?? missing('Not a dynamic character (no sets, pools or kinds)')

const setById = (c: Character, sid: string): OutfitSet => c.folk?.sets.find(s => s.id === sid) ?? missing(`No set ${sid}`)
const poolById = (c: Character, pid: string): Pool => c.folk?.pools.find(p => p.id === pid) ?? missing(`No pool ${pid}`)
const kindById = (c: Character, kid: string): UnitKind => c.folk?.kinds.find(k => k.id === kid) ?? missing(`No kind ${kid}`)
const stanceById = (c: Character, sid: string): Stance => c.folk?.stances.find(s => s.id === sid) ?? missing(`No stance ${sid}`)

function gearRefs (c: Character, v: unknown, what: string): string[] {
  const out = ids(v, what)
  for (const g of out) if (!c.gear.some(x => x.id === g)) missing(`No gear ${g}`)
  return out
}

/** Whether a pool of this kind can name `ref`: a skin by name, a cloth layer by id, gear by id. */
export function refExists (c: Character, kind: PoolKind, ref: string): boolean {
  if (kind === 'skin') return (c.look.skins ?? []).some(k => k.name === ref)
  if (kind === 'cloth') return (c.look.cloth ?? []).some(l => l.id === ref)
  return c.gear.some(g => g.id === ref)
}

function ruleOf (o: Record<string, unknown>, what: string): { requires?: string[], excludes?: string[] } {
  const requires = opt(o.requires, x => folkTags(x, `${what}.requires`))
  const excludes = opt(o.excludes, x => folkTags(x, `${what}.excludes`))
  return { ...(requires !== undefined && requires.length > 0 ? { requires } : {}), ...(excludes !== undefined && excludes.length > 0 ? { excludes } : {}) }
}

function itemsOf (c: Character, kind: PoolKind, v: unknown, what: string): PoolItem[] {
  const items = list(v, what, (x, w): PoolItem => {
    const o = obj(x, w)
    const ref = str(o.ref, `${w}.ref`)
    if (!refExists(c, kind, ref)) missing(`No ${kind === 'skin' ? 'skin' : kind === 'cloth' ? 'cloth layer' : 'gear'} ${ref}`)
    const weight = opt(o.weight, y => weightOf(y, `${w}.weight`))
    return { ref, ...(weight !== undefined && weight !== 1 ? { weight } : {}), ...ruleOf(o, w) }
  })
  if (new Set(items.map(i => i.ref)).size !== items.length) bad(`${what}: an item is named twice`)
  return items
}

function stanceRef (c: Character, v: unknown, what: string): string {
  const s = id(v, what)
  return c.folk?.stances.some(x => x.id === s) === true ? s : missing(`No stance ${s}`)
}

function setOf (c: Character, v: unknown, what: string): OutfitSet {
  const o = obj(v, what)
  const pieces = gearRefs(c, o.pieces ?? [], `${what}.pieces`)
  const grants = opt(o.grants, x => folkTags(x, `${what}.grants`))
  const stance = opt(o.stance, x => stanceRef(c, x, `${what}.stance`))
  const weight = opt(o.weight, x => weightOf(x, `${what}.weight`))
  const n = note(o.note, `${what}.note`)
  return {
    id: id(o.id, `${what}.id`), name: name(o.name, `${what}.name`), pieces,
    tags: o.tags === undefined ? [] : folkTags(o.tags, `${what}.tags`),
    grants: grants ?? grantsOf(piecesOf(c, { pieces })),
    ...(stance !== undefined ? { stance } : {}), ...(weight !== undefined && weight !== 1 ? { weight } : {}), ...(n !== undefined ? { note: n } : {}),
  }
}

function poolOf (c: Character, v: unknown, what: string): Pool {
  const o = obj(v, what)
  const kind = oneOf(o.kind, POOL_KINDS, `${what}.kind`)
  const slot = opt(o.slot, x => oneOf(x, CLOTH_SLOTS, `${what}.slot`))
  if (slot !== undefined && kind !== 'cloth') bad(`${what}: only a cloth pool has a slot`)
  const chance = opt(o.chance, x => chanceOf(x, `${what}.chance`))
  return {
    id: id(o.id, `${what}.id`), name: name(o.name, `${what}.name`), kind,
    ...(slot !== undefined ? { slot } : {}), ...(chance !== undefined ? { chance } : {}), ...ruleOf(o, what),
    items: itemsOf(c, kind, o.items ?? [], `${what}.items`),
  }
}

function kindSetsOf (c: Character, v: unknown, what: string): UnitKind['sets'] {
  if (isObj(v) && 'query' in v) {
    if (Object.keys(v).length !== 1) bad(`${what} must be a list of sets or {query}`)
    return { query: folkTags(v.query, `${what}.query`) }
  }
  const out = list(v, what, (x, w) => {
    const o = obj(x, w)
    const set = id(o.set, `${w}.set`)
    if (c.folk?.sets.some(s => s.id === set) !== true) missing(`No set ${set}`)
    const weight = opt(o.weight, y => weightOf(y, `${w}.weight`))
    return { set, ...(weight !== undefined ? { weight } : {}) }
  })
  if (new Set(out.map(x => x.set)).size !== out.length) bad(`${what}: a set is named twice`)
  return out
}

function kindPoolsOf (c: Character, v: unknown, what: string): Record<string, string> {
  const o = obj(v, what)
  const out: Record<string, string> = {}
  for (const [step, pid] of Object.entries(o)) {
    if (pid === undefined || pid === null) continue
    if (!/^[a-z]{1,32}$/.test(step)) bad(`${what}: ${step} isn't a step`)
    const p = id(pid, `${what}.${step}`)
    if (c.folk?.pools.some(x => x.id === p) !== true) missing(`No pool ${p}`)
    out[step] = p
  }
  return out
}

function kindOf (c: Character, v: unknown, what: string): UnitKind {
  const o = obj(v, what)
  const pools = opt(o.pools, x => kindPoolsOf(c, x, `${what}.pools`))
  const stance = opt(o.stance, x => stanceRef(c, x, `${what}.stance`))
  return {
    id: id(o.id, `${what}.id`), name: name(o.name, `${what}.name`),
    tags: o.tags === undefined ? [] : folkTags(o.tags, `${what}.tags`),
    sets: kindSetsOf(c, o.sets ?? { query: [] }, `${what}.sets`),
    ...(pools !== undefined && Object.keys(pools).length > 0 ? { pools } : {}), ...(stance !== undefined ? { stance } : {}),
  }
}

function slotRefs (c: Character, v: unknown, what: string): string[] {
  const out = ids(v, what)
  for (const s of out) if (!c.clips.some(x => x.id === s)) missing(`No clip slot ${s}`)
  return out
}

function stanceOf (c: Character, v: unknown, what: string): Stance {
  const o = obj(v, what)
  const clips: Record<string, string[]> = {}
  for (const [clip, slots] of Object.entries(obj(o.clips ?? {}, `${what}.clips`))) {
    if (slots === undefined || slots === null) continue
    const list = slotRefs(c, slots, `${what}.clips.${clip}`)
    if (list.length > 0) clips[str(clip, `${what}.clips key`)] = list
  }
  const overlay = opt(o.overlay, x => slotRefs(c, [x], `${what}.overlay`)[0])
  return { id: id(o.id, `${what}.id`), name: name(o.name, `${what}.name`), clips, ...(overlay !== undefined ? { overlay } : {}) }
}

function intList (v: unknown, what: string): number[] {
  return list(v, what, (x, w) => (Number.isInteger(x) && (x as number) >= 0 ? x as number : bad(`${w} must be a region (0 or more)`)))
}

function cutOf (v: unknown, what: string): ClothCut {
  const o = obj(v, what)
  for (const k of Object.keys(o)) if (!['below', 'drop', 'mask'].includes(k)) bad(`${what} has no ${k}`)
  const below = opt(o.below, x => list(x, `${what}.below`, (b, w) => {
    const p = obj(b, w)
    return { regions: intList(p.regions, `${w}.regions`), y: num(p.y, `${w}.y`), feather: num(p.feather ?? 0, `${w}.feather`, { min: 0 }) }
  }))
  const drop = opt(o.drop, x => intList(x, `${what}.drop`))
  const mask = opt(o.mask, x => under(x, '', `${what}.mask`))
  return { ...(below !== undefined && below.length > 0 ? { below } : {}), ...(drop !== undefined && drop.length > 0 ? { drop } : {}), ...(mask !== undefined ? { mask } : {}) }
}

function slotsOf (v: unknown, what: string): ClothSlot[] {
  const out = list(v, what, (x, w) => oneOf(x, CLOTH_SLOTS, w))
  if (out.length === 0) bad(`${what}: a layer fills at least one slot`)
  if (new Set(out).size !== out.length) bad(`${what} repeat`)
  return out
}

const shapesOf = (v: unknown, what: string): string[] =>
  [...new Set(list(v, what, (x, w) => (typeof x === 'string' && /^[a-z0-9_]{1,32}$/.test(x) ? x : bad(`${w} must be a shape key name`))))]

const coverageOf = (v: unknown, what: string): number[] => list(v, what, (x, w) => num(x, w, { min: 0, max: 1 }))

/** A cloth layer from a command (look.cloth.add). */
export function clothLayerOf (v: unknown, what: string): ClothLayer {
  const o = obj(v, what)
  const cut = opt(o.cut, x => cutOf(x, `${what}.cut`))
  const trim = opt(o.trim, x => under(x, '', `${what}.trim`))
  const shapes = opt(o.shapes, x => shapesOf(x, `${what}.shapes`))
  const tags = opt(o.tags, x => folkTags(x, `${what}.tags`))
  const from = opt(o.from, x => str(x, `${what}.from`))
  const coverage = opt(o.coverage, x => coverageOf(x, `${what}.coverage`))
  return {
    id: id(o.id, `${what}.id`), name: name(o.name, `${what}.name`), slots: slotsOf(o.slots, `${what}.slots`), file: under(o.file, '', `${what}.file`),
    ...(cut !== undefined && Object.keys(cut).length > 0 ? { cut } : {}), ...(trim !== undefined ? { trim } : {}),
    ...(shapes !== undefined && shapes.length > 0 ? { shapes } : {}), ...(tags !== undefined && tags.length > 0 ? { tags } : {}),
    ...(from !== undefined ? { from } : {}), ...(coverage !== undefined ? { coverage } : {}),
  }
}

/** A cloth layer patched (look.cloth.update): what changed, in words. */
export function patchCloth (l: ClothLayer, v: unknown): string[] {
  const p = patchOf(v, ['name', 'slots', 'file', 'cut', 'trim', 'shapes', 'tags', 'from', 'coverage'])
  const out: string[] = []
  const was = l.name
  const set = <K extends keyof ClothLayer>(k: K, next: ClothLayer[K] | undefined, words: string): void => {
    if (same(next, l[k])) return
    if (next === undefined) delete l[k]
    else l[k] = next
    out.push(`cloth ${was}: ${words}`)
  }
  if (p.name !== undefined) set('name', name(p.name, 'name'), `renamed ${String(p.name).trim()}`)
  if (p.slots !== undefined) { const s = slotsOf(p.slots, 'slots'); set('slots', s, `fills ${s.join(', ')}`) }
  if (p.file !== undefined) set('file', under(p.file, '', 'file'), 'new image')
  if (p.cut !== undefined) { const cut = p.cut === null ? undefined : cutOf(p.cut, 'cut'); set('cut', cut !== undefined && Object.keys(cut).length > 0 ? cut : undefined, cut === undefined ? 'uncut' : 'cut changed') }
  if (p.trim !== undefined) { const t = opt(p.trim, x => under(x, '', 'trim')); set('trim', t, t === undefined ? 'no trim' : 'trim mask changed') }
  if (p.shapes !== undefined) { const s = p.shapes === null ? [] : shapesOf(p.shapes, 'shapes'); set('shapes', s.length > 0 ? s : undefined, s.length > 0 ? `shapes ${s.join(', ')}` : 'no shapes') }
  if (p.tags !== undefined) { const t = p.tags === null ? [] : folkTags(p.tags, 'tags'); set('tags', t.length > 0 ? t : undefined, t.length > 0 ? `tagged ${t.join(', ')}` : 'no tags') }
  if (p.from !== undefined) { const f = opt(p.from, x => str(x, 'from')); set('from', f, f === undefined ? 'its source forgotten' : `from ${f}`) }
  if (p.coverage !== undefined) { const cv = opt(p.coverage, x => coverageOf(x, 'coverage')); set('coverage', cv, cv === undefined ? 'coverage cleared' : 'coverage measured') }
  return out
}

const insertAt = <T>(items: T[], item: T, index: unknown): void => {
  const at = index === undefined ? items.length : num(index, 'index', { min: 0 })
  items.splice(Math.min(Math.floor(at), items.length), 0, item)
}

// ---- what removing something elsewhere takes along ---------------------------------------------------------------

/** A removed gear piece (gone from c.gear already) out of every set (their grants following) and pool. */
export function pruneGear (c: Character, g: Gear): string[] {
  const f = c.folk
  if (f === undefined) return []
  const gearId = g.id
  const out: string[] = []
  for (const s of f.sets) {
    if (!s.pieces.includes(gearId)) continue
    const rest = piecesOf(c, s).filter(x => x.id !== gearId)
    s.pieces = s.pieces.filter(p => p !== gearId)
    s.grants = regrant(s.grants, [...rest, g], rest)
    out.push(`set ${s.name}: ${g.name} taken out`)
  }
  for (const p of f.pools) {
    if (p.kind === 'skin' || p.kind === 'cloth' || !p.items.some(i => i.ref === gearId)) continue
    p.items = p.items.filter(i => i.ref !== gearId)
    out.push(`pool ${p.name}: ${g.name} taken out`)
  }
  return out
}

/** Slots that no longer exist out of every stance. */
export function pruneSlots (c: Character): string[] {
  const f = c.folk
  if (f === undefined) return []
  const there = new Set(c.clips.map(s => s.id))
  const out: string[] = []
  for (const st of f.stances) {
    for (const [clip, slots] of Object.entries(st.clips)) {
      const kept = slots.filter(s => there.has(s))
      if (kept.length === slots.length) continue
      if (kept.length > 0) st.clips[clip] = kept
      else delete st.clips[clip]
      out.push(`stance ${st.name}: ${clip} ${kept.length > 0 ? `plays ${plural(kept.length, 'slot')}` : 'out of it'} (a slot is gone)`)
    }
    if (st.overlay !== undefined && !there.has(st.overlay)) { delete st.overlay; out.push(`stance ${st.name}: no overlay (its slot is gone)`) }
  }
  return out
}

/** A removed cloth layer out of every cloth pool. */
export function pruneCloth (c: Character, layerId: string): string[] {
  const out: string[] = []
  for (const p of c.folk?.pools ?? []) {
    if (p.kind !== 'cloth' || !p.items.some(i => i.ref === layerId)) continue
    p.items = p.items.filter(i => i.ref !== layerId)
    out.push(`pool ${p.name}: the layer taken out`)
  }
  return out
}

// ---- the reducer -------------------------------------------------------------------------------------------------

export function reduceFolk (c: Character, cmd: FolkCommand): string[] {
  switch (cmd.type) {
    case 'folk.set.add': {
      const s = setOf(c, cmd.set, 'set')
      if (c.folk?.sets.some(x => x.id === s.id) === true) conflict(`Set id ${s.id} is taken`)
      if (c.folk?.sets.some(x => x.name === s.name) === true) conflict(`A set named ${s.name} already exists`)
      insertAt(section(c).sets, s, cmd.index)
      return [`set ${s.name}: added (${plural(s.pieces.length, 'piece')}${s.grants.length > 0 ? `; ${s.grants.join(', ')}` : ''})`]
    }
    case 'folk.set.update': {
      const s = setById(c, cmd.id)
      const p = patchOf(cmd.patch, ['name', 'tags', 'grants', 'stance', 'weight', 'note'] satisfies Array<keyof SetPatch>)
      const out: string[] = []
      const was = s.name
      if (p.name !== undefined) { const n = name(p.name, 'name'); if (n !== s.name) { if (c.folk!.sets.some(other => other.id !== s.id && other.name === n)) conflict(`A set named ${n} already exists`); s.name = n; out.push(`set ${was}: renamed ${n}`) } }
      if (p.tags !== undefined) { const t = folkTags(p.tags ?? [], 'tags'); if (!same(t, s.tags)) { s.tags = t; out.push(`set ${s.name}: ${t.length > 0 ? `tagged ${t.join(', ')}` : 'no tags'}`) } }
      if (p.grants !== undefined) { const g = folkTags(p.grants ?? [], 'grants').sort(); if (!same(g, s.grants)) { s.grants = g; out.push(`set ${s.name}: ${g.length > 0 ? `grants ${g.join(', ')}` : 'grants nothing'}`) } }
      if (p.stance !== undefined) {
        const st = p.stance === null ? undefined : stanceRef(c, p.stance, 'stance')
        if (st !== s.stance) { if (st === undefined) delete s.stance; else s.stance = st; out.push(`set ${s.name}: ${st === undefined ? 'its kind\'s stance' : `stance ${stanceById(c, st).name}`}`) }
      }
      if (p.weight !== undefined) {
        const w = p.weight === null ? 1 : weightOf(p.weight, 'weight')
        if (w !== (s.weight ?? 1)) { if (w === 1) delete s.weight; else s.weight = w; out.push(`set ${s.name}: weight ${w}`) }
      }
      if (p.note !== undefined) {
        const n = note(p.note, 'note')
        if (n !== s.note) { if (n === undefined) delete s.note; else s.note = n; out.push(`set ${s.name}: note ${n === undefined ? 'cleared' : 'changed'}`) }
      }
      return out
    }
    case 'folk.set.pieces': {
      const s = setById(c, cmd.id)
      const pieces = gearRefs(c, cmd.pieces, 'pieces')
      if (same(pieces, s.pieces)) return []
      const added = pieces.filter(p => !s.pieces.includes(p)); const removed = s.pieces.filter(p => !pieces.includes(p))
      const grants = s.grants
      const before = piecesOf(c, s)
      s.pieces = pieces
      s.grants = regrant(grants, before, piecesOf(c, s))
      const nameOf = (gid: string): string => c.gear.find(g => g.id === gid)?.name ?? gid
      const out = [`set ${s.name}: ${[
        ...(added.length > 0 ? [`${names(added.map(nameOf))} in`] : []),
        ...(removed.length > 0 ? [`${names(removed.map(nameOf))} out`] : []),
        ...(added.length === 0 && removed.length === 0 ? ['pieces reordered'] : []),
      ].join('; ')}`]
      if (!same(grants, s.grants)) out.push(`set ${s.name}: ${s.grants.length > 0 ? `grants ${s.grants.join(', ')}` : 'grants nothing'}`)
      return out
    }
    case 'folk.set.duplicate': {
      const s = setById(c, cmd.id)
      const newId = id(cmd.newId, 'newId')
      if (c.folk!.sets.some(x => x.id === newId)) conflict(`Set id ${newId} is taken`)
      const n = cmd.name === undefined ? uniqueName(`${s.name} copy`, x => c.folk!.sets.some(o => o.name === x)) : name(cmd.name, 'name')
      if (c.folk!.sets.some(other => other.name === n)) conflict(`A set named ${n} already exists`)
      const copy: OutfitSet = { ...structuredClone(s), id: newId, name: n }
      c.folk!.sets.splice(c.folk!.sets.indexOf(s) + 1, 0, copy)
      return [`set ${n}: a copy of ${s.name}`]
    }
    case 'folk.set.remove': {
      const s = setById(c, cmd.id)
      const f = c.folk!
      f.sets = f.sets.filter(x => x !== s)
      const out = [`set ${s.name}: removed`]
      for (const k of f.kinds) {
        if (!Array.isArray(k.sets) || !k.sets.some(e => e.set === s.id)) continue
        k.sets = k.sets.filter(e => e.set !== s.id)
        out.push(`kind ${k.name}: no longer wears ${s.name}`)
      }
      return out
    }
    case 'folk.set.reorder': {
      const f = folkOrMissing(c)
      const next = reorder(f.sets, cmd.ids, 'set')
      if (next.every((s, i) => s === f.sets[i])) return []
      f.sets = next
      return ['sets reordered']
    }
    case 'folk.pool.add': {
      const p = poolOf(c, cmd.pool, 'pool')
      if (c.folk?.pools.some(x => x.id === p.id) === true) conflict(`Pool id ${p.id} is taken`)
      insertAt(section(c).pools, p, cmd.index)
      return [`pool ${p.name}: added (${p.kind}${p.slot !== undefined ? ` for the ${p.slot}` : ''}, ${plural(p.items.length, 'item')})`]
    }
    case 'folk.pool.update': {
      const p = poolById(c, cmd.id)
      const patch = patchOf(cmd.patch, ['name', 'slot', 'chance', 'requires', 'excludes'] satisfies Array<keyof PoolPatch>)
      const out: string[] = []
      const was = p.name
      if (patch.name !== undefined) { const n = name(patch.name, 'name'); if (n !== p.name) { p.name = n; out.push(`pool ${was}: renamed ${n}`) } }
      if (patch.slot !== undefined) {
        const slot = patch.slot === null ? undefined : oneOf(patch.slot, CLOTH_SLOTS, 'slot')
        if (slot !== undefined && p.kind !== 'cloth') bad('Only a cloth pool has a slot')
        if (slot !== p.slot) { if (slot === undefined) delete p.slot; else p.slot = slot; out.push(`pool ${p.name}: ${slot === undefined ? 'for every cloth step' : `for the ${slot}`}`) }
      }
      if (patch.chance !== undefined) {
        const ch = patch.chance === null ? undefined : chanceOf(patch.chance, 'chance')
        if (ch !== p.chance) { if (ch === undefined) delete p.chance; else p.chance = ch; out.push(`pool ${p.name}: ${ch === undefined ? 'the step\'s chance' : `drawn ${Math.round(ch * 100)}% of the time`}`) }
      }
      for (const k of ['requires', 'excludes'] as const) {
        if (patch[k] === undefined) continue
        const t = patch[k] === null ? [] : folkTags(patch[k], k)
        if (same(t, p[k] ?? [])) continue
        if (t.length === 0) delete p[k]
        else p[k] = t
        out.push(`pool ${p.name}: ${t.length > 0 ? `${k} ${t.join(', ')}` : `${k} nothing`}`)
      }
      return out
    }
    case 'folk.pool.items': {
      const p = poolById(c, cmd.id)
      const items = itemsOf(c, p.kind, cmd.items, 'items')
      if (same(items, p.items)) return []
      p.items = items
      return [`pool ${p.name}: ${plural(items.length, 'item')}`]
    }
    case 'folk.pool.remove': {
      const p = poolById(c, cmd.id)
      const f = c.folk!
      f.pools = f.pools.filter(x => x !== p)
      const out = [`pool ${p.name}: removed`]
      for (const k of f.kinds) {
        const steps = Object.entries(k.pools ?? {}).filter(([, pid]) => pid === p.id).map(([step]) => step)
        if (steps.length === 0) continue
        for (const step of steps) delete k.pools![step]
        if (Object.keys(k.pools!).length === 0) delete k.pools
        out.push(`kind ${k.name}: its ${steps.join(', ')} from the default pool`)
      }
      return out
    }
    case 'folk.kind.add': {
      const k = kindOf(c, cmd.kind, 'kind')
      if (c.folk?.kinds.some(x => x.id === k.id) === true) conflict(`Kind id ${k.id} is taken`)
      insertAt(section(c).kinds, k, cmd.index)
      return [`kind ${k.name}: added`]
    }
    case 'folk.kind.update': {
      const k = kindById(c, cmd.id)
      const p = patchOf(cmd.patch, ['name', 'tags', 'pools', 'stance'] satisfies Array<keyof KindPatch>)
      const out: string[] = []
      const was = k.name
      if (p.name !== undefined) { const n = name(p.name, 'name'); if (n !== k.name) { k.name = n; out.push(`kind ${was}: renamed ${n}`) } }
      if (p.tags !== undefined) { const t = folkTags(p.tags ?? [], 'tags'); if (!same(t, k.tags)) { k.tags = t; out.push(`kind ${k.name}: ${t.length > 0 ? `tagged ${t.join(', ')}` : 'no tags'}`) } }
      if (p.pools !== undefined) {
        const pools = p.pools === null ? {} : kindPoolsOf(c, p.pools, 'pools')
        if (!same(pools, k.pools ?? {})) {
          if (Object.keys(pools).length === 0) delete k.pools
          else k.pools = pools
          out.push(`kind ${k.name}: ${Object.keys(pools).length > 0 ? `draws ${Object.entries(pools).map(([s, pid]) => `${s} from ${poolById(c, pid).name}`).join(', ')}` : 'draws from the default pools'}`)
        }
      }
      if (p.stance !== undefined) {
        const st = p.stance === null ? undefined : stanceRef(c, p.stance, 'stance')
        if (st !== k.stance) { if (st === undefined) delete k.stance; else k.stance = st; out.push(`kind ${k.name}: ${st === undefined ? 'no stance' : `stance ${stanceById(c, st).name}`}`) }
      }
      return out
    }
    case 'folk.kind.sets': {
      const k = kindById(c, cmd.id)
      const sets = kindSetsOf(c, cmd.sets, 'sets')
      if (same(sets, k.sets)) return []
      k.sets = sets
      const setName = (sid: string): string => c.folk!.sets.find(s => s.id === sid)?.name ?? sid
      return [`kind ${k.name}: wears ${Array.isArray(sets) ? (sets.length > 0 ? names(sets.map(e => setName(e.set))) : 'no set') : sets.query.length > 0 ? `every set tagged ${sets.query.join(', ')}` : 'every set'}`]
    }
    case 'folk.kind.remove': {
      const k = kindById(c, cmd.id)
      c.folk!.kinds = c.folk!.kinds.filter(x => x !== k)
      return [`kind ${k.name}: removed`]
    }
    case 'folk.stance.add': {
      const s = stanceOf(c, cmd.stance, 'stance')
      if (c.folk?.stances.some(x => x.id === s.id) === true) conflict(`Stance id ${s.id} is taken`)
      insertAt(section(c).stances, s, cmd.index)
      return [`stance ${s.name}: added`]
    }
    case 'folk.stance.update': {
      const s = stanceById(c, cmd.id)
      const p = patchOf(cmd.patch, ['name', 'overlay'])
      const out: string[] = []
      const was = s.name
      if (p.name !== undefined) { const n = name(p.name, 'name'); if (n !== s.name) { s.name = n; out.push(`stance ${was}: renamed ${n}`) } }
      if (p.overlay !== undefined) {
        const o = p.overlay === null ? undefined : slotRefs(c, [p.overlay], 'overlay')[0]
        if (o !== s.overlay) {
          if (o === undefined) delete s.overlay
          else s.overlay = o
          out.push(`stance ${s.name}: ${o === undefined ? 'no overlay' : `overlay ${c.clips.find(x => x.id === o)!.name}`}`)
        }
      }
      return out
    }
    case 'folk.stance.clip': {
      const s = stanceById(c, cmd.id)
      const clip = str(cmd.clip, 'clip')
      const slots = cmd.slots === null ? [] : slotRefs(c, cmd.slots, 'slots')
      if (same(slots, s.clips[clip] ?? [])) return []
      if (slots.length === 0) delete s.clips[clip]
      else s.clips[clip] = slots
      return [`stance ${s.name}: ${clip} ${slots.length > 0 ? `plays ${names(slots.map(x => c.clips.find(o => o.id === x)!.name))}` : 'out of it'}`]
    }
    case 'folk.stance.remove': {
      const s = stanceById(c, cmd.id)
      const f = c.folk!
      f.stances = f.stances.filter(x => x !== s)
      const out = [`stance ${s.name}: removed`]
      for (const x of [...f.sets, ...f.kinds]) {
        if (x.stance !== s.id) continue
        delete x.stance
        out.push(`${'pieces' in x ? 'set' : 'kind'} ${x.name}: no stance`)
      }
      return out
    }
  }
  return unknown(cmd)
}
