// The dress on stage, per character (docs/dressing-plan.md Phase 0 §3): the outfit, skin, clothes, hair and beard
// being looked at, the fields Randomize keeps and its roll. View state: kept in this browser (localStorage), never a
// command, a journal entry or an undo step; the document keeps the default (the thumbnail, the game's unset look)
// until "Make default" writes the dress into it. The rules are src/state/dressing.ts.
//
// Snappy browsing: the sets worn lately stay fitted on stage, hidden (gear.svelte.ts keeps what `kept` says), so going
// back to one shows it at once; while the page is idle the next set is fitted ahead a piece at a time, and the next
// sets' models and every skin's and clothes' image are fetched.
import { SvelteMap } from 'svelte/reactivity'
import type { Character, Gear } from '../model/types.ts'
import { preloadModel } from '../engine/garments.ts'
import { app } from './app.svelte.ts'
import { asset } from './assets.svelte.ts'
import { defaultCommands, differs, randomize, resolve, settled, setsAfter, setsOf, setsWith, wearOutfit, type Dress, type DressField, type Dressed } from './dressing.ts'

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
  worn (c: Pick<Character, 'id' | 'gear' | 'look'>): Dressed {
    return resolve(c, this.dresses.get(c.id))
  }

  /** Whether the stage shows other than the document's own look ("Make default" has something to do). */
  differs (c: Pick<Character, 'id' | 'gear' | 'look'>): boolean {
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
  kept (c: Pick<Character, 'id' | 'gear'>, g: Gear): boolean {
    const r = this.recent.get(c.id)
    if (r !== undefined && setsWith(c, g).some(s => r.sets.includes(s))) return true
    if (r?.pieces.includes(g.id) === true) return true
    return this.ahead.get(c.id)?.includes(g.id) === true
  }

  // ---- browsing ----------------------------------------------------------------------------------------------------

  wearOutfit (c: Character, outfit: string | null): void { this.put(c, wearOutfit(c, this.of(c.id), outfit)) }
  setSkin (c: Character, name: string | null): void { this.put(c, { ...this.of(c.id), skin: name }) }
  setClothing (c: Character, name: string | null): void { this.put(c, { ...this.of(c.id), clothing: name }) }
  setHair (c: Character, id: string | null): void { this.put(c, { ...this.of(c.id), hair: id }) }
  setBeard (c: Character, id: string | null): void { this.put(c, { ...this.of(c.id), beard: id }) }

  /** Randomize keeps this field (or stops keeping it). */
  toggleLock (c: Character, field: DressField): void {
    const d = this.of(c.id) ?? {}
    const locks = new Set(d.locks ?? [])
    if (locks.has(field)) locks.delete(field)
    else locks.add(field)
    this.put(c, { ...d, locks: [...locks] })
  }

  private rolls = 0
  /** A unit's look as the game would pick one, the locked fields kept. */
  randomize (c: Character): void {
    const seed = (Date.now() + ++this.rolls * 7919) >>> 0
    this.put(c, randomize(c, this.of(c.id), seed))
  }

  /** Back to the document's own look (locks kept). */
  reset (c: Character): void {
    const locks = this.of(c.id)?.locks
    this.put(c, locks === undefined || locks.length === 0 ? undefined : { locks })
  }

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

  private put (c: Pick<Character, 'id' | 'gear' | 'look'>, d: Dress | undefined): void {
    const was = this.worn(c)
    if (d === undefined) this.dresses.delete(c.id)
    else this.dresses.set(c.id, d)
    keep(c.id, d)
    this.remember(c.id, was, this.worn(c))
    this.plan(c)
  }

  /** What was worn before a change stays fitted (newest first, RECENT of each). */
  private remember (id: string, was: Dressed, now: Dressed): void {
    const r = this.recent.get(id) ?? { sets: [], pieces: [] }
    const sets = [now.outfit, was.outfit].filter((s): s is string => s !== null)
    const pieces = [now.hair, now.beard, was.hair, was.beard].filter((s): s is string => s !== null)
    const next = {
      sets: [...new Set([...sets, ...r.sets])].slice(0, RECENT),
      pieces: [...new Set([...pieces, ...r.pieces])].slice(0, RECENT * 2),
    }
    if (next.sets.join() !== r.sets.join() || next.pieces.join() !== r.pieces.join()) this.recent.set(id, next)
  }

  /** While idle: the next sets' models fetched, the next set fitted ahead a piece at a time, every skin's and
   * clothes' image fetched (once each). Planned again when the dress changes. */
  plan (c: Pick<Character, 'id' | 'gear' | 'look'>): void {
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
