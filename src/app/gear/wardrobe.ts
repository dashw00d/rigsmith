// The Wardrobe's rules (pure, so they are tested): what a set, a skin, a cloth layer, a hair or beard piece is called
// and filed under (culture, category, body part), what the pick engine (src/engine/folkpick.ts) allows for each slot
// of the dress on stage and why it rules the rest out, a unit's pick as a dress, and the locked slots as the engine's
// fixed choices. The dress (src/state/dressing.ts) names a set by its name and clothes by the old look.clothes name;
// the engine names a set by its id and clothes by the cloth layer's id: the two meet here only.
import type { DressField, Dressed } from '../../state/dressing.ts'
import { candidates, clothOf, setsOf, tagsAfter, type FolkInputs, type FolkPick, type FolkWorld } from '../../engine/folkpick.ts'
import { setsWith, type Folkish } from '../../model/folk.ts'
import type { Gear } from '../../model/types.ts'

// ---- names -----------------------------------------------------------------------------------------------------------

/** The cultures the game's set names start with (a set's own `culture:` tag wins). */
export const CULTURES = ['norse', 'gael', 'wagon', 'order', 'swiss', 'barrow'] as const
export type Category = 'outfit' | 'armour' | 'hat' | 'hood' | 'coif' | 'hair'
export const CATEGORIES: readonly Category[] = ['outfit', 'armour', 'hat', 'hood', 'coif', 'hair']
const CATEGORY_PREFIX: Record<string, Category> = { arm: 'armour', armour: 'armour', armor: 'armour', hat: 'hat', hood: 'hood', coif: 'coif', hair: 'hair' }

/** The words of a name: `Outfit_norse_a_forearm_L` -> ['outfit', 'norse', 'a', 'forearm', 'l']. */
const words = (name: string): string[] => name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w !== '')

/** A set's or piece's culture: its `culture:` tag, else a culture word in its name. */
export function cultureOf (name: string, tags: readonly string[] = []): string | null {
  const tagged = tags.find(t => t.startsWith('culture:'))
  if (tagged !== undefined) return tagged.slice('culture:'.length)
  return words(name).find(w => (CULTURES as readonly string[]).includes(w)) ?? null
}

/** What kind of set it is: its `category:` tag, else its name's first word (arm_, hat_...), else a culture's outfit. */
export function categoryOf (set: { name: string, tags?: readonly string[] }): Category {
  const tagged = set.tags?.find(t => t.startsWith('category:'))?.slice('category:'.length)
  if (tagged !== undefined && (CATEGORIES as readonly string[]).includes(tagged)) return tagged as Category
  return CATEGORY_PREFIX[words(set.name)[0] ?? ''] ?? 'outfit'
}

const PARTS: Array<[RegExp, string]> = [
  [/forearm|bracer|wrist/, 'forearm'], [/shoulder|pauldron/, 'shoulder'], [/torso|chest|body|coat|tunic/, 'torso'],
  [/leg|boot|shin|greave/, 'leg'], [/foot|shoe/, 'foot'], [/hand|glove|gauntlet/, 'hand'], [/head|helm|hat|hood|coif|cap/, 'head'],
]

/** The body part a piece is worn on, from its name (hair and beards are their own); null when the name doesn't say. */
export function partOf (g: Pick<Gear, 'name' | 'role'>): string | null {
  if (g.role !== undefined) return g.role
  const n = g.name.toLowerCase()
  if (/^hair_/.test(n)) return 'hair'
  if (/^beard_/.test(n)) return 'beard'
  return PARTS.find(([re]) => re.test(n))?.[1] ?? null
}

/** A name as words: `arm_brigandine` -> `arm brigandine`. */
export const label = (name: string): string => name.replace(/_/g, ' ')

/** A hair or beard piece's short name: `Hair_hair_mohawk` -> `mohawk`, `Beard_norse_a` -> `norse a`. */
export function pieceLabel (name: string): string {
  return label(name.replace(/^(hair|beard|outfit)_/i, '').replace(/^(hair|beard)_/i, ''))
}

/** A skin's short name: `13_asha` -> `asha`. */
export const skinLabel = (name: string): string => label(name.replace(/^\d+[_ -]*/, '')) || label(name)

// ---- the engine and the dress ----------------------------------------------------------------------------------------

const setIdByName = (c: Folkish, name: string | null): string | null => name === null ? null : setsOf(c).find(s => s.name === name)?.id ?? null
const setNameById = (c: Folkish, id: string | null): string | null => id === null ? null : setsOf(c).find(s => s.id === id)?.name ?? null
const layerIdByName = (c: Folkish, name: string | null): string | null => name === null ? null : clothOf(c).find(l => l.name === name)?.id ?? null
const layerNameById = (c: Folkish, id: string | null | undefined): string | null => id == null ? null : clothOf(c).find(l => l.id === id)?.name ?? null

/** A unit's pick as the dress on stage. The clothes are the first layer it wears (today's dress shows one). */
export function dressedFromPick (c: Folkish, p: Pick<FolkPick, 'picks' | 'layers'>): Dressed {
  const clothing = layerNameById(c, p.layers[0] ?? p.picks.bottom ?? p.picks.top)
  return {
    outfit: setNameById(c, p.picks.set ?? null),
    skin: p.picks.skin ?? null,
    clothing: clothing !== null && (c.look.clothes ?? []).some(k => k.name === clothing) ? clothing : null,
    hair: p.picks.hair ?? null,
    beard: p.picks.beard ?? null,
  }
}

/** The locked slots of the dress as the engine's fixed choices (step id -> ref, null for none). */
export function fixedFor (c: Folkish, worn: Dressed, locks: Iterable<DressField>): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const f of locks) {
    if (f === 'outfit') out.set = setIdByName(c, worn.outfit)
    else if (f === 'skin') out.skin = worn.skin
    else if (f === 'hair') out.hair = worn.hair
    else if (f === 'beard') out.beard = worn.beard
    else {
      const id = layerIdByName(c, worn.clothing)
      // (a layer fills its own slots, so the later cloth steps skip them; none: none at all)
      if (id !== null) out.bottom = id
      else { out.bottom = null; out.top = null; out.over = null }
    }
  }
  return out
}

/** One choice of a slot: the dress's value for it, and whether the engine would pick it for the dress as it is. */
export interface Choice {
  /** The dress's value: a set's name, a skin's name, a clothes name, a gear id. */
  value: string
  label: string
  ok: boolean
  /** Why it is ruled out (the engine's words). */
  why?: string
  /** How often it is picked among the allowed (its weight's share), 0..1. */
  share: number
}

/** Every choice of a slot, in the character's order, each marked with what the engine says of it under the dress worn
 * (the set's grants and the skin's tags: a fem hair needs a female skin, no hair under a hat, no long sleeves under
 * bracers). An item no pool lists is ruled out "in no pool". */
export function choicesFor (c: Folkish, w: FolkWorld, worn: Dressed, field: DressField, ctx: Omit<FolkInputs, 'fixed'> = {}): Choice[] {
  const set = setIdByName(c, worn.outfit)
  const step = field === 'outfit' ? 'set' : field === 'clothing' ? 'bottom' : field
  const tags = field === 'outfit' || field === 'skin' ? tagsAfter(w, { kind: ctx.kind, inputs: ctx.tags, set: field === 'skin' ? set : null }) : tagsAfter(w, { kind: ctx.kind, inputs: ctx.tags, set, skin: worn.skin })
  const found = new Map(candidates(w, step, tags, { kind: ctx.kind }).map(x => [x.ref, x]))
  const total = [...found.values()].reduce((t, x) => t + (x.ok ? x.weight : 0), 0)
  const of = (ref: string | null, value: string, name: string): Choice => {
    const x = ref === null ? undefined : found.get(ref)
    if (x === undefined) return { value, label: name, ok: false, why: 'in no pool', share: 0 }
    return { value, label: name, ok: x.ok, ...(x.why !== undefined ? { why: x.why } : {}), share: x.ok && total > 0 ? x.weight / total : 0 }
  }
  if (field === 'outfit') return setsOf(c).map(s => of(s.id, s.name, label(s.name)))
  if (field === 'skin') return (c.look.skins ?? []).map(k => of(k.name, k.name, skinLabel(k.name)))
  if (field === 'clothing') return (c.look.clothes ?? []).map(k => of(layerIdByName(c, k.name), k.name, label(k.name)))
  return c.gear.filter(g => g.role === field).map(g => of(g.id, g.id, pieceLabel(g.name)))
}

/** The choice after (or before) the current one, round the list; `allowed` skips the ruled out. */
export function stepChoice (choices: readonly Choice[], current: string | null, dir: 1 | -1, allowed = false): string | null {
  const list = allowed ? choices.filter(x => x.ok || x.value === current) : choices
  if (list.length === 0) return current
  const at = current === null ? -1 : list.findIndex(x => x.value === current)
  const next = at < 0 ? (dir > 0 ? 0 : list.length - 1) : (at + dir + list.length) % list.length
  return list[next].value
}

/** A new unit number for Randomize (1..99999). */
export const newUid = (rand: () => number = Math.random): number => 1 + Math.floor(rand() * 99999)

// ---- the drawer's filters ------------------------------------------------------------------------------------------

export type Tab = 'sets' | 'skins' | 'clothes' | 'hair' | 'beards' | 'pieces' | 'props'
export const TABS: ReadonlyArray<{ id: Tab, label: string }> = [
  { id: 'sets', label: 'Sets' }, { id: 'skins', label: 'Skins' }, { id: 'clothes', label: 'Clothes' },
  { id: 'hair', label: 'Hair' }, { id: 'beards', label: 'Beards' }, { id: 'pieces', label: 'Pieces' }, { id: 'props', label: 'Props' },
]

export const tabsFor = (folk: boolean): typeof TABS => folk ? TABS : TABS.filter(t => t.id === 'pieces' || t.id === 'props')

/** A tile of the drawer: what it shows and what its filters match. */
export interface Tile {
  /** The dress's value (a set's name, a skin's name, a clothes name, a gear id). */
  value: string
  label: string
  /** Searched: its name, label, tags. */
  text: string
  culture: string | null
  category: Category | null
  parts: string[]
  tags: string[]
  badges: string[]
  /** Its pieces (sets) or itself (pieces): what its thumbnail is made of. */
  pieces: string[]
}

/** The tiles of a tab. */
export function tilesOf (c: Folkish, tab: Tab): Tile[] {
  const byId = new Map(c.gear.map(g => [g.id, g]))
  const tile = (o: Omit<Tile, 'text'>, name: string): Tile => ({ ...o, text: [name, o.label, ...o.tags, o.culture ?? '', o.category ?? '', ...o.parts].join(' ').toLowerCase() })
  if (tab === 'sets') {
    return setsOf(c).map(s => {
      const pieces = s.pieces.map(id => byId.get(id)).filter((g): g is Gear => g !== undefined)
      const badges = [
        ...(s.grants.includes('covers-hair') ? ['covers hair'] : []),
        ...(s.grants.includes('covers-face') ? ['covers face'] : []),
        ...(s.grants.includes('bracers') ? ['no long sleeves'] : []),
        `${pieces.length} piece${pieces.length === 1 ? '' : 's'}`,
      ]
      return tile({
        value: s.name, label: label(s.name), culture: cultureOf(s.name, s.tags), category: categoryOf(s),
        parts: [...new Set(pieces.map(g => partOf(g)).filter((p): p is string => p !== null))], tags: [...s.tags, ...s.grants], badges, pieces: s.pieces,
      }, s.name)
    })
  }
  if (tab === 'skins') {
    return (c.look.skins ?? []).map(k => tile({
      value: k.name, label: skinLabel(k.name), culture: cultureOf(k.name, k.tags), category: null, parts: [], tags: k.tags ?? [],
      badges: (k.tags ?? []).filter(t => t === 'female' || t === 'elderly' || t === 'beardless'), pieces: [],
    }, k.name))
  }
  if (tab === 'clothes') {
    const layers = clothOf(c)
    return (c.look.clothes ?? []).map(k => {
      const l = layers.find(x => x.name === k.name)
      const tags = [...new Set([...(k.tags ?? []), ...(l?.tags ?? [])])]
      return tile({
        value: k.name, label: label(k.name), culture: cultureOf(k.name, tags), category: null, parts: l?.slots ?? [], tags,
        badges: [...(tags.includes('long-sleeves') ? ['long sleeves'] : []), ...(l?.slots ?? [])], pieces: [],
      }, k.name)
    })
  }
  const pieces = tab === 'pieces' ? c.gear.filter(g => g.role === undefined) : c.gear.filter(g => g.role === (tab === 'hair' ? 'hair' : 'beard'))
  return pieces.map(g => {
    const sets = setsWith(c, g.id).map(s => s.name)
    const part = partOf(g)
    return tile({
      value: g.id, label: tab === 'pieces' ? g.name : pieceLabel(g.name), culture: cultureOf(g.name, g.tags),
      category: sets.length > 0 ? categoryOf({ name: sets[0] }) : null, parts: part === null ? [] : [part], tags: g.tags ?? [],
      badges: [...(g.tags ?? []).filter(t => t === 'covers-hair' || t === 'covers-face' || t === 'fem' || t === 'masc'), ...(g.attach.kind === 'skin' && g.attach.hideBody === true ? ['hides body'] : [])]
        .map(t => t.replace('-', ' ')),
      pieces: [g.id],
    }, `${g.name} ${sets.join(' ')}`)
  })
}

/** The drawer's filter: a search and chips (a chip group's chips are or-ed, the groups and-ed). */
export interface Filter { search: string, cultures: string[], categories: string[], parts: string[], tags: string[] }
export const NO_FILTER: Filter = { search: '', cultures: [], categories: [], parts: [], tags: [] }

export function matches (t: Tile, f: Filter): boolean {
  const any = (picked: readonly string[], have: ReadonlyArray<string | null>): boolean => picked.length === 0 || picked.some(p => have.includes(p))
  if (!any(f.cultures, [t.culture])) return false
  if (!any(f.categories, [t.category])) return false
  if (!any(f.parts, t.parts)) return false
  if (!any(f.tags, t.tags)) return false
  const q = f.search.trim().toLowerCase()
  return q === '' || q.split(/\s+/).every(w => t.text.includes(w))
}

/** The chips a tab's tiles offer, each with how many tiles carry it. */
export function chipsOf (tiles: readonly Tile[]): { cultures: Array<[string, number]>, categories: Array<[string, number]>, parts: Array<[string, number]>, tags: Array<[string, number]> } {
  const count = (pick: (t: Tile) => ReadonlyArray<string | null>): Array<[string, number]> => {
    const m = new Map<string, number>()
    for (const t of tiles) for (const v of new Set(pick(t))) if (v !== null && v !== '') m.set(v, (m.get(v) ?? 0) + 1)
    return [...m].sort((a, b) => a[0].localeCompare(b[0]))
  }
  return { cultures: count(t => [t.culture]), categories: count(t => [t.category]), parts: count(t => t.parts), tags: count(t => t.tags) }
}

// ---- the pieces list ---------------------------------------------------------------------------------------------------

/** The pieces grouped by set (a piece in several sets in each; the rest under null), sets in order, pieces as the set
 * lists them, and the search applied (a set whose name matches shows all its pieces). */
export function pieceGroups (c: Folkish, search = ''): Array<{ set: string | null, setId: string | null, pieces: Gear[] }> {
  const q = search.trim().toLowerCase()
  const byId = new Map(c.gear.map(g => [g.id, g]))
  const hit = (g: Gear): boolean => q === '' || q.split(/\s+/).every(w => `${g.name} ${(g.tags ?? []).join(' ')}`.toLowerCase().includes(w))
  const out: Array<{ set: string | null, setId: string | null, pieces: Gear[] }> = []
  const inSets = new Set<string>()
  for (const s of [...setsOf(c)].sort((a, b) => a.name.localeCompare(b.name))) {
    const all = s.pieces.map(id => byId.get(id)).filter((g): g is Gear => g !== undefined)
    for (const g of all) inSets.add(g.id)
    const pieces = q !== '' && s.name.toLowerCase().includes(q) ? all : all.filter(hit)
    if (pieces.length > 0 || q === '') out.push({ set: s.name, setId: s.id, pieces })
  }
  const rest = c.gear.filter(g => !inSets.has(g.id) && hit(g))
  if (rest.length > 0) out.push({ set: null, setId: null, pieces: rest })
  return out
}

/** The selection after a click on `id` in `order` (the pieces as listed): plain picks it alone, ctrl toggles it, shift
 * takes the run from the anchor (the last plain or ctrl click). */
export function selectClick (selected: readonly string[], anchor: string | null, order: readonly string[], id: string, how: { shift?: boolean, toggle?: boolean }): { selected: string[], anchor: string | null } {
  if (how.shift === true && anchor !== null) {
    const a = order.indexOf(anchor)
    const b = order.indexOf(id)
    if (a >= 0 && b >= 0) {
      const run = order.slice(Math.min(a, b), Math.max(a, b) + 1)
      return { selected: how.toggle === true ? [...new Set([...selected, ...run])] : run, anchor }
    }
  }
  if (how.toggle === true) return { selected: selected.includes(id) ? selected.filter(x => x !== id) : [...selected, id], anchor: id }
  return { selected: [id], anchor: id }
}

/** The commands that move pieces into a set: out of every other set they are in, into `to` (its pieces after its
 * own). One batch: one undo. */
export function moveCommands (c: Folkish, ids: readonly string[], toSetId: string): Array<{ type: 'folk.set.pieces', id: string, pieces: string[] }> {
  const moving = new Set(ids)
  const out: Array<{ type: 'folk.set.pieces', id: string, pieces: string[] }> = []
  for (const s of setsOf(c)) {
    if (s.id === toSetId) {
      const pieces = [...s.pieces, ...ids.filter(id => !s.pieces.includes(id))]
      if (pieces.length !== s.pieces.length) out.push({ type: 'folk.set.pieces', id: s.id, pieces })
    } else if (s.pieces.some(id => moving.has(id))) {
      out.push({ type: 'folk.set.pieces', id: s.id, pieces: s.pieces.filter(id => !moving.has(id)) })
    }
  }
  return out
}

/** A piece's tag as the model takes it (commands/gear.ts tagsOf: a short lower-case word). Null when it can't be one. */
export function cleanTag (raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/\s+/g, '-')
  return /^[a-z0-9-]{1,32}$/.test(t) ? t : null
}
