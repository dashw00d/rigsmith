// How a dynamic character (src/engine/folk.ts) is dressed on stage: browsing outfits, skins, clothes, hair and beards
// is view state (src/state/dress.svelte.ts keeps it per character), not an edit of the document; the document keeps
// the default the game and the thumbnail use, and "Make default" writes the dress into it (defaultCommands). Pure, so
// it is tested and the gear on stage (gear.svelte.ts) and the Folk panel agree.
//
// Set membership is read here only (setsOf, setsWith): the model's sets and pools (src/model/folk.ts on dress/model)
// replace Gear.outfit, and these two are the one place that changes.
import type { Command } from '../model/command-types.ts'
import type { Character, ClothSlot, Gear } from '../model/types.ts'
import { BRACERS, COVERS_FACE, COVERS_HAIR, setsOf as modelSetsOf, setsWith as modelSetsWith } from '../model/folk.ts'
import { longSleeves } from '../engine/folk.ts'
import { pick, worldOf, type FolkWorld } from '../engine/folkpick.ts'
import { dressedFromPick, fixedFor } from '../app/gear/wardrobe.ts'

/** A set of pieces worn together (today: an outfit). */
export interface DressSet { name: string, pieces: readonly string[] }

type Gearing = Pick<Character, 'id' | 'gear' | 'look' | 'folk'>

/** The sets a piece is in, by name ([]: none): the model's sets (src/model/folk.ts, one source; a schema 4 document's
 * are derived from Gear.outfit there). */
export function setsWith (c: Gearing, g: Pick<Gear, 'id'>): string[] {
  return modelSetsWith(c, g.id).map(s => s.name)
}

/** The character's sets, by name, each with its pieces (gear ids) in the set's order. */
export function setsOf (c: Gearing): DressSet[] {
  return modelSetsOf(c).map(s => ({ name: s.name, pieces: s.pieces })).sort((a, b) => a.name.localeCompare(b.name))
}

/** The fields a dress has; each one left out follows the document. */
export type DressField = 'outfit' | 'skin' | 'clothing' | 'hair' | 'beard'
export const DRESS_FIELDS: readonly DressField[] = ['outfit', 'skin', 'clothing', 'hair', 'beard']

/** The dress on stage for one character: what browsing picked (null: none of it; left out: the document's), the fields
 * Randomize keeps, and its last roll. */
export interface Dress {
  /** Stable set id for previews of migrated characters; outfit is kept as a legacy name for old storage. */
  outfitId?: string | null
  outfit?: string | null
  skin?: string | null
  clothing?: string | null
  /** A hair piece's gear id. */
  hair?: string | null
  /** A beard piece's gear id. */
  beard?: string | null
  /** Cloth layer ids by occupied slot; null leaves that slot with the skin's paint. */
  layers?: Partial<Record<ClothSlot, string | null>>
  /** Preview the selected skin's bare image even when no layer has a cut. */
  bare?: boolean
  /** Per-piece preview overrides; neither is written by Make default. */
  off?: string[]
  on?: string[]
  /** Kept by Randomize. */
  locks?: DressField[]
  seed?: number
}

export type Dressed = Record<DressField, string | null> & Pick<Dress, 'layers' | 'bare'>

/** The document's own look: the set with a piece shown, its skin and clothes, the hair and beard shown. */
export function documentDress (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>): Dressed {
  const shownSet = c.gear.find(g => g.hidden !== true && setsWith(c, g).length > 0)
  const shownRole = (role: 'hair' | 'beard'): string | null => c.gear.find(g => g.role === role && g.hidden !== true)?.id ?? null
  return {
    outfit: shownSet === undefined ? null : setsWith(c, shownSet)[0],
    skin: c.look.skin ?? null,
    clothing: c.look.clothing ?? null,
    hair: shownRole('hair'),
    beard: shownRole('beard'),
  }
}

/** What is worn: the dress over the document's own look, a pick that no longer exists falling back to it. */
export function resolve (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined): Dressed {
  const own = documentDress(c)
  if (d === undefined) return own
  const sets = new Set(setsOf(c).map(s => s.name))
  const skins = new Set((c.look.skins ?? []).map(s => s.name))
  const clothes = new Set((c.look.clothes ?? []).map(s => s.name))
  const piece = (role: 'hair' | 'beard', id: string | null): boolean => id === null || c.gear.some(g => g.id === id && g.role === role)
  const pick = <K extends DressField>(k: K, ok: (v: string | null) => boolean): string | null => {
    const v = d[k]
    return v !== undefined && ok(v) ? v : own[k]
  }
  const result: Dressed = {
    outfit: d.outfitId !== undefined ? (d.outfitId === null ? null : modelSetsOf(c).find(s => s.id === d.outfitId)?.name ?? own.outfit) : pick('outfit', v => v === null || sets.has(v)),
    skin: pick('skin', v => v === null || skins.has(v)),
    clothing: pick('clothing', v => v === null || clothes.has(v)),
    hair: pick('hair', v => piece('hair', v)),
    beard: pick('beard', v => piece('beard', v)),
  }
  if (d.layers !== undefined) {
    const layers: NonNullable<Dress['layers']> = {}
    for (const slot of ['bottom', 'top', 'over'] as const) {
      const id = d.layers[slot]
      if (id === null || (id !== undefined && (c.look.cloth ?? []).some(l => l.id === id && l.slots.includes(slot)))) layers[slot] = id
    }
    result.layers = layers
  }
  if (d.bare !== undefined) result.bare = d.bare
  return result
}

/** Whether a piece of `c` shows under the dress: a set's pieces with their set (the document's own set as the document
 * shows its pieces, `own`), hair and beard as picked, the rest as the document has them. */
export function shows (c: Gearing, g: Gear, d: Dressed, own?: Dressed, preview?: Dress): boolean {
  if (preview?.off?.includes(g.id) === true) return false
  const sets = setsWith(c, g)
  if (sets.length > 0) return d.outfit !== null && sets.includes(d.outfit) && (preview?.on?.includes(g.id) === true || own?.outfit !== d.outfit || g.hidden !== true)
  if (g.role === 'hair') return g.id === d.hair
  if (g.role === 'beard') return g.id === d.beard
  return g.hidden !== true
}

/** The dress with an outfit put on, and what it leaves no room for taken off as the game does (hair under headwear,
 * a beard under a great helm, long sleeves under bracers). */
export function wearOutfit (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined, outfit: string | null): Dress {
  const now = resolve(c, d)
  const next: Dress = { ...d, outfit }
  if (c.folk !== undefined && outfit === null) next.outfitId = null
  else {
    const set = c.folk === undefined ? undefined : modelSetsOf(c).find(s => s.name === outfit)
    if (set === undefined) delete next.outfitId
    else next.outfitId = set.id
  }
  delete next.off
  delete next.on
  const grants = modelSetsOf(c).find(s => s.name === outfit)?.grants ?? []
  if (grants.includes(COVERS_HAIR)) next.hair = null
  if (grants.includes(COVERS_FACE)) next.beard = null
  const allowed = (c.look.clothes ?? []).filter(k => !grants.includes(BRACERS) || !longSleeves(k))
  if (now.clothing !== null && !allowed.some(k => k.name === now.clothing)) next.clothing = allowed[0]?.name ?? null
  return next
}

/** Upgrade old browser-stored outfit names while the original name still exists. */
export function anchorOutfit (c: Gearing, d: Dress | undefined): Dress | undefined {
  if (c.folk === undefined || d === undefined || d.outfitId !== undefined || d.outfit === undefined) return d
  if (d.outfit === null) return { ...d, outfitId: null }
  const set = modelSetsOf(c).find(s => s.name === d.outfit)
  return set === undefined ? d : { ...d, outfitId: set.id }
}

/** The game's pick for a unit, with locked slots fixed to the current dress. */
export function randomize (c: Character, d: Dress | undefined, seed: number, world: FolkWorld = worldOf(c)): Dress {
  const now = resolve(c, d)
  const fixed = fixedFor(c, now, d?.locks ?? [])
  if (d?.locks?.includes('clothing') === true && now.layers !== undefined) {
    for (const slot of ['bottom', 'top', 'over'] as const) fixed[slot] = now.layers[slot] ?? null
  }
  const picked = pick(world, seed, { fixed })
  const unit = dressedFromPick(c, picked)
  if (c.look.cloth !== undefined) {
    const layers: NonNullable<Dress['layers']> = {}
    for (const id of picked.layers) for (const slot of world.layers.find(l => l.id === id)?.slots ?? []) layers[slot] = id
    unit.layers = layers
  }
  const next: Dress = { ...d, ...unit, seed }
  if (c.folk !== undefined) next.outfitId = picked.picks.set ?? null
  else delete next.outfitId
  if (unit.outfit !== now.outfit) { delete next.off; delete next.on }
  return next
}

/** Whether the dress differs from the document's own look. */
export function differs (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined): boolean {
  const a = resolve(c, d)
  const b = documentDress(c)
  return DRESS_FIELDS.some(k => a[k] !== b[k])
}

/** The commands that make the dress the document's own look ("Make default": the thumbnail and the game's unset
 * look follow it). [] when it is already. */
export function defaultCommands (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined): Command[] {
  const want = resolve(c, d)
  const own = documentDress(c)
  const out: Command[] = []
  const outfitShown = (name: string | null): boolean => c.gear.every(g => {
    const sets = setsWith(c, g)
    return sets.length === 0 || (name !== null && sets.includes(name)) === (g.hidden !== true)
  })
  if (want.outfit !== own.outfit || !outfitShown(want.outfit)) {
    if (c.folk === undefined) out.push({ type: 'gear.outfit.show', outfit: want.outfit })
    else {
      for (const g of c.gear) {
        const sets = setsWith(c, g)
        if (sets.length === 0) continue
        const hidden = want.outfit === null || !sets.includes(want.outfit)
        if (hidden !== (g.hidden === true)) out.push({ type: 'gear.update', id: g.id, patch: { hidden } })
      }
    }
  }
  if (want.skin !== own.skin) out.push({ type: 'look.skin.show', name: want.skin })
  if (want.clothing !== own.clothing) out.push({ type: 'look.clothing.show', name: want.clothing })
  for (const role of ['hair', 'beard'] as const) {
    for (const g of c.gear) {
      if (g.role !== role) continue
      const hidden = g.id !== want[role]
      if (hidden !== (g.hidden === true)) out.push({ type: 'gear.update', id: g.id, patch: { hidden } })
    }
  }
  return out
}

/** The dress after its picks reached the document: the fields it now matches dropped (they follow the document
 * again), the locks and the roll kept. */
export function settled (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined): Dress | undefined {
  if (d === undefined) return undefined
  const own = documentDress(c)
  const next: Dress = { ...d }
  for (const k of DRESS_FIELDS) if (next[k] !== undefined && next[k] === own[k]) delete next[k]
  if (next.outfitId !== undefined && resolve(c, next).outfit === own.outfit) { delete next.outfitId; delete next.outfit }
  return next
}

/** The sets after `name` in order (cyclic), `n` of them: what to fit ahead while idle. */
export function setsAfter (sets: readonly DressSet[], name: string | null, n: number): DressSet[] {
  if (sets.length === 0) return []
  const at = name === null ? -1 : sets.findIndex(s => s.name === name)
  const out: DressSet[] = []
  for (let k = 1; k <= Math.min(n, sets.length - (at >= 0 ? 1 : 0)); k++) out.push(sets[(at + k + sets.length) % sets.length])
  return out
}
