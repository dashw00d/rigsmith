// The dress on stage, per character (docs/dressing-plan.md Phase 0 §3): the outfit, skin, clothes, hair and beard
// being looked at, the fields Randomize keeps and its roll. View state: kept in this browser (localStorage), never a
// command, a journal entry or an undo step; the document keeps the default (the thumbnail, the game's unset look)
// until "Make default" writes the dress into it. The rules are src/state/dressing.ts.
//
// Snappy browsing: the sets worn lately stay fitted on stage, hidden (gear.svelte.ts keeps what `kept` says), so going
// back to one shows it at once; while the page is idle the next set is fitted ahead a piece at a time, and the next
// sets' models and every skin's and clothes' image are fetched.
import { SvelteMap } from 'svelte/reactivity'
import type { Character, ClothSlot, Gear } from '../model/types.ts'
import { preloadModel } from '../engine/garments.ts'
import type { FolkWorld } from '../engine/folkpick.ts'
import { setsOf as modelSetsOf, setsWith as modelSetsWith } from '../model/folk.ts'
import { newUid } from '../app/gear/wardrobe.ts'
import { app } from './app.svelte.ts'
import { asset } from './assets.svelte.ts'
import { anchorOutfit, defaultCommands, differs, randomize, resolve, settled, setsAfter, setsOf, wearOutfit, type Dress, type DressField, type Dressed } from './dressing.ts'

const KEY = 'rigsmith.dress.'
/** Sets (and hair and beard pieces) worn lately, kept fitted. */
const RECENT = 6
/** Sets fitted ahead while idle, and sets whose models are fetched ahead. */
const AHEAD_FIT = 1
const AHEAD_FETCH = 2

function stored (): Array<[string, Dress]> {
  const out: Array<[string, Dress]> = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k === null || !k.startsWith(KEY)) continue
      const d = JSON.parse(localStorage.getItem(k) ?? 'null') as Dress | null
      if (d !== null && typeof d === 'object') out.push([k.slice(KEY.length), d])
    }
  } catch { /* storage unavailable or unreadable: every dress follows its document */ }
  return out
}

function keep (id: string, d: Dress | undefined): void {
  try {
    if (d === undefined || Object.keys(d).length === 0) localStorage.removeItem(KEY + id)
    else localStorage.setItem(KEY + id, JSON.stringify(d))
  } catch { /* storage unavailable: the dress lasts this page */ }
}

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 })
  else setTimeout(fn, 200)
}

class DressState {
  private readonly dresses = new SvelteMap<string, Dress>(stored())
  /** Per character: the sets and the hair and beard pieces worn lately (newest first), kept fitted. */
  private readonly recent = new SvelteMap<string, { sets: string[], pieces: string[] }>()
  /** Per character: pieces fitted ahead while idle (hidden until shown). */
  private readonly ahead = new SvelteMap<string, string[]>()
  private planned = new Map<string, string>()
  private fetched = new Set<string>()

  /** The dress kept for a character (undefined: it follows its document). */
  of (id: string): Dress | undefined {
    return this.dresses.get(id)
  }

  /** What the character wears on stage. */
  worn (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>): Dressed {
    return resolve(c, this.dresses.get(c.id))
  }

  /** Whether the stage shows other than the document's own look ("Make default" has something to do). */
  differs (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>): boolean {
    return differs(c, this.dresses.get(c.id))
  }

  locked (id: string, field: DressField): boolean {
    return this.dresses.get(id)?.locks?.includes(field) === true
  }

  /** What `kept` goes by for a character, read so an effect follows it (gear.svelte.ts's sync). */
  keeping (id: string): unknown {
    return [this.recent.get(id), this.ahead.get(id)]
  }

  /** Whether a piece stays fitted while hidden: its set (or itself) worn lately, or fitted ahead. */
  kept (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, g: Gear): boolean {
    const r = this.recent.get(c.id)
    if (r !== undefined && modelSetsWith(c, g.id).some(s => r.sets.includes(s.id))) return true
    if (r?.pieces.includes(g.id) === true) return true
    return this.ahead.get(c.id)?.includes(g.id) === true
  }

  // ---- browsing ----------------------------------------------------------------------------------------------------

  wearOutfit (c: Character, outfit: string | null): void { this.put(c, wearOutfit(c, this.of(c.id), outfit)) }
  setSkin (c: Character, name: string | null): void { this.put(c, { ...this.of(c.id), skin: name }) }
  setClothing (c: Character, name: string | null): void {
    const next = { ...this.of(c.id), clothing: name }
    delete next.layers
    this.put(c, next)
  }
  /** Browse layers without changing the document; a layer filling several slots is worn once. */
  setLayer (c: Character, slot: ClothSlot, id: string | null): void {
    const layer = id === null ? undefined : c.look.cloth?.find(l => l.id === id && l.slots.includes(slot))
    if (id !== null && layer === undefined) return
    const layers = { ...this.of(c.id)?.layers }
    const displaced = new Set((layer?.slots ?? [slot]).map(s => layers[s]).filter((v): v is string => typeof v === 'string'))
    for (const s of ['bottom', 'top', 'over'] as const) if (layers[s] !== null && layers[s] !== undefined && displaced.has(layers[s]!)) delete layers[s]
    if (layer === undefined) layers[slot] = null
    else for (const s of layer.slots) layers[s] = layer.id
    this.put(c, { ...this.of(c.id), layers })
  }
  setBare (c: Character, on: boolean): void { this.put(c, { ...this.of(c.id), bare: on }) }
  setHair (c: Character, id: string | null): void { this.put(c, { ...this.of(c.id), hair: id }) }
  setBeard (c: Character, id: string | null): void { this.put(c, { ...this.of(c.id), beard: id }) }

  /** Show or hide one folk piece for this preview, without changing the document. */
  setShown (c: Character, id: string, on: boolean): void {
    const d = this.of(c.id) ?? {}
    const off = new Set(d.off ?? [])
    const shown = new Set(d.on ?? [])
    if (on) { off.delete(id); shown.add(id) } else { off.add(id); shown.delete(id) }
    const next: Dress = { ...d }
    if (off.size > 0) next.off = [...off]; else delete next.off
    if (shown.size > 0) next.on = [...shown]; else delete next.on
    this.put(c, next)
  }

  /** Randomize keeps this field (or stops keeping it). */
  toggleLock (c: Character, field: DressField): void {
    const d = this.of(c.id) ?? {}
    const locks = new Set(d.locks ?? [])
    if (locks.has(field)) locks.delete(field)
    else locks.add(field)
    this.put(c, { ...d, locks: [...locks] })
  }

  /** One game-engine pick, with the locked fields kept. Returns the unit actually shown. */
  randomize (c: Character, uid = newUid(), world?: FolkWorld): Dressed {
    this.put(c, randomize(c, this.of(c.id), uid, world))
    return this.worn(c)
  }

  /** Back to the document's own look (locks kept). */
  reset (c: Character): void {
    const locks = this.of(c.id)?.locks
    this.put(c, locks === undefined || locks.length === 0 ? undefined : { locks })
  }

  /** Restore an exact preview snapshot after a temporary hover. */
  restore (c: Character, snapshot: Dress | undefined): void { this.put(c, snapshot) }

  /** The dress written into the document as its own look (today's commands: one undoable entry), then followed again.
   * False when the server refused. */
  async makeDefault (c: Character): Promise<boolean> {
    const d = this.of(c.id)
    const commands = defaultCommands(c, d)
    if (commands.length > 0 && await app.do(c.id, commands, 'dress.default') === null) return false
    const now = app.byId(c.id)
    if (now !== null) this.put(now, settled(now, d))
    return true
  }

  // ---- keeping it ---------------------------------------------------------------------------------------------------

  private put (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, d: Dress | undefined): void {
    const was = this.worn(c)
    if (d === undefined) this.dresses.delete(c.id)
    else this.dresses.set(c.id, d)
    keep(c.id, d)
    this.remember(c, was, this.worn(c))
    this.plan(c)
  }

  /** What was worn before a change stays fitted (newest first, RECENT of each). */
  private remember (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>, was: Dressed, now: Dressed): void {
    const r = this.recent.get(c.id) ?? { sets: [], pieces: [] }
    const byName = new Map(modelSetsOf(c).map(s => [s.name, s.id]))
    const sets = [now.outfit, was.outfit].flatMap(s => s === null ? [] : byName.get(s) ?? [])
    const pieces = [now.hair, now.beard, was.hair, was.beard].filter((s): s is string => s !== null)
    const next = {
      sets: [...new Set([...sets, ...r.sets])].slice(0, RECENT),
      pieces: [...new Set([...pieces, ...r.pieces])].slice(0, RECENT * 2),
    }
    if (next.sets.join() !== r.sets.join() || next.pieces.join() !== r.pieces.join()) this.recent.set(c.id, next)
  }

  /** While idle: the next sets' models fetched, the next set fitted ahead a piece at a time, every skin's and
   * clothes' image fetched (once each). Planned again when the dress changes. */
  plan (c: Pick<Character, 'id' | 'gear' | 'look' | 'folk'>): void {
    const before = this.of(c.id)
    const anchored = anchorOutfit(c, before)
    if (anchored !== before && anchored !== undefined) { this.dresses.set(c.id, anchored); keep(c.id, anchored) }
    const sets = setsOf(c)
    const current = this.worn(c).outfit
    const token = `${current ?? ''}|${Date.now()}`
    this.planned.set(c.id, token)
    const live = (): boolean => this.planned.get(c.id) === token
    const fit = setsAfter(sets, current, AHEAD_FIT).flatMap(s => s.pieces)
    const fetch = setsAfter(sets, current, AHEAD_FETCH).flatMap(s => s.pieces)
    const byId = new Map(c.gear.map(g => [g.id, g]))
    const urls = fetch.flatMap(id => { const g = byId.get(id); const u = g?.model === undefined ? null : asset(c.id, g.model); return u === null ? [] : [u] })
    const images = [...(c.look.skins ?? []), ...(c.look.clothes ?? [])].flatMap(s => { const u = asset(c.id, s.file); return u === null ? [] : [u] })
    const fetchNext = (): void => {
      if (!live()) return
      const url = urls.shift() ?? images.shift()
      if (url === undefined) { fitNext(); return }
      if (this.fetched.has(url)) { fetchNext(); return }
      this.fetched.add(url)
      const done = (): void => { idle(fetchNext) }
      // (models parsed, ready to wear; images only fetched into the browser's cache: decoded when shown, off the
      // main thread)
      void (url.includes('/garments/') ? preloadModel(url) : fetchBytes(url)).then(done, done)
    }
    const fitNext = (): void => {
      if (!live()) return
      const have = this.ahead.get(c.id) ?? []
      const next = fit.find(id => !have.includes(id) && byId.get(id)?.status === 'ready')
      if (next === undefined) return
      this.ahead.set(c.id, [...have.filter(id => fit.includes(id)), next])
      idle(fitNext)
    }
    // (what was fitted ahead for another set is let go)
    const have = this.ahead.get(c.id)
    if (have !== undefined && have.some(id => !fit.includes(id))) this.ahead.set(c.id, have.filter(id => fit.includes(id)))
    idle(fetchNext)
  }
}

async function fetchBytes (url: string): Promise<void> {
  const res = await fetch(url)
  await res.arrayBuffer()
}

export const dress = new DressState()
