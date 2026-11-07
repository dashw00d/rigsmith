// The Wardrobe's state (the swatch pickers, the drawer, the pieces list, the keys): per character, the unit shown
// (Randomize draws a new one from the pick engine, the locked slots fixed), the drawer's tab and filters, the open
// sections and groups, the piece selected; remembered in this browser (localStorage, every access guarded). Browsing
// goes through the dress state (src/state/dress.svelte.ts): nothing here is a command but the pieces list's edits.
//
// The dress state has a setter per slot and none for a whole dress: dressUp sets them in turn (the outfit first, as
// it takes off what it leaves no room for). A hover preview keeps the dress before it and puts it back on leave.
import { untrack } from 'svelte'
import type { Command } from '../../model/command-types.ts'
import type { Character } from '../../state/api.ts'
import { app as appState } from '../../state/app.svelte.ts'
import { dress } from '../../state/dress.svelte.ts'
import { DRESS_FIELDS, type Dress, type DressField, type Dressed } from '../../state/dressing.ts'
import { pick, worldOf, type FolkWorld } from '../../engine/folkpick.ts'
import { mark } from '../../engine/perf.ts'
import { choicesFor, dressedFromPick, newUid, NO_FILTER, stepChoice, type Filter, type Tab } from './wardrobe.ts'

const KEY = 'rigsmith.wardrobe.'

/** What is remembered per character. */
export interface ViewState {
  tab?: Tab
  /** The unit shown last (Randomize's or typed) and the dress it gave (to tell when it was changed by hand). */
  uid?: number
  unit?: Dressed
  /** Sections closed in the panel, groups collapsed in the pieces list. */
  closed?: string[]
  collapsed?: string[]
  selected?: string | null
  crowd?: number
}

function read (id: string): ViewState {
  try {
    const v = JSON.parse(localStorage.getItem(KEY + id) ?? 'null') as ViewState | null
    return v !== null && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function write (id: string, v: ViewState): void {
  try { localStorage.setItem(KEY + id, JSON.stringify(v)) } catch { /* storage unavailable: it lasts this page */ }
}

// (one world per character copy: the copy is replaced whole on every change)
const worlds = new WeakMap<Character, FolkWorld>()
export function worldFor (c: Character): FolkWorld {
  let w = worlds.get(c)
  if (w === undefined) { w = worldOf(c); worlds.set(c, w) }
  return w
}

// (the newest copy of the character: the caller's may be older than the one a setter before saw)
const app = (c: Character): Character => appState.byId(c.id) ?? c

const setter: Record<Exclude<DressField, 'outfit'>, (c: Character, v: string | null) => void> = {
  skin: (c, v) => { dress.setSkin(c, v) },
  clothing: (c, v) => { dress.setClothing(c, v) },
  hair: (c, v) => { dress.setHair(c, v) },
  beard: (c, v) => { dress.setBeard(c, v) },
}

class WardrobeState {
  /** Per character, what is remembered (read from storage the first time it is asked for: a plain map, so reading it
   * in a template writes no state; `beat` says when any changed). */
  private readonly views = new Map<string, ViewState>()
  private beat = $state(0)
  /** The drawer's filter (per page, not remembered: a search is for now). */
  filter = $state<Filter>({ ...NO_FILTER })
  /** The pieces list's selection (gear ids) and its anchor for Shift. */
  picked = $state.raw<string[]>([])
  anchor: string | null = null
  /** The keys sheet is open. */
  keysOpen = $state(false)
  /** The crowd view is open. */
  crowdOpen = $state(false)

  view (id: string): ViewState {
    void this.beat
    let v = this.views.get(id)
    if (v === undefined) { v = read(id); this.views.set(id, v) }
    return v
  }

  update (id: string, patch: Partial<ViewState>): void {
    const v = { ...(this.views.get(id) ?? read(id)), ...patch }
    this.views.set(id, v)
    write(id, v)
    this.beat++
  }

  tab (id: string): Tab { return this.view(id).tab ?? 'sets' }
  setTab (id: string, tab: Tab): void { this.update(id, { tab }) }

  isClosed (id: string, section: string): boolean { return this.view(id).closed?.includes(section) === true }
  toggleSection (id: string, section: string): void {
    const closed = new Set(this.view(id).closed ?? [])
    if (closed.has(section)) closed.delete(section); else closed.add(section)
    this.update(id, { closed: [...closed] })
  }

  isCollapsed (id: string, group: string): boolean { return this.view(id).collapsed?.includes(group) === true }
  toggleGroup (id: string, group: string): void {
    const collapsed = new Set(this.view(id).collapsed ?? [])
    if (collapsed.has(group)) collapsed.delete(group); else collapsed.add(group)
    this.update(id, { collapsed: [...collapsed] })
  }
  setCollapsed (id: string, groups: string[]): void { this.update(id, { collapsed: groups }) }

  // ---- edits ----------------------------------------------------------------------------------------------------------

  /** Commands sent as one batch (one journal entry, one undo), with a toast that takes it back. False when refused. */
  async run (c: Character, commands: Command[], text: string): Promise<boolean> {
    if (commands.length === 0) return true
    const entry = await appState.do(c.id, commands, 'wardrobe')
    if (entry === null) return false
    appState.toast('ok', `${text}.`, 6000, { label: 'Undo', run: () => { void appState.undo(c.id, entry.seq) } })
    return true
  }

  // ---- the dress ------------------------------------------------------------------------------------------------------

  /** The dress on stage set to `d` (each slot left out of it untouched). */
  dressUp (c: Character, d: Partial<Dressed>): void {
    const done = mark('wardrobe.dressUp')
    if (d.outfit !== undefined && d.outfit !== dress.worn(c).outfit) dress.wearOutfit(c, d.outfit)
    for (const f of DRESS_FIELDS) {
      if (f === 'outfit' || d[f] === undefined) continue
      const now = app(c)
      if (dress.worn(now)[f] !== d[f]) setter[f](now, d[f])
    }
    done()
  }

  /** A slot of the dress set by hand. */
  set (c: Character, field: DressField, value: string | null): void {
    this.dressUp(c, { [field]: value })
  }

  /** Randomize: a new unit drawn by the pick engine, the locked slots kept. */
  randomize (c: Character): void {
    const uid = newUid()
    const unit = dress.randomize(c, uid, worldFor(c))
    this.update(c.id, { uid, unit })
  }

  /** Exactly unit `uid` as the game would dress it (no lock applies). */
  showUnit (c: Character, uid: number): void {
    const unit = dressedFromPick(c, pick(worldFor(c), uid))
    this.update(c.id, { uid, unit })
    this.dressUp(c, unit)
  }

  /** The unit shown, and whether the dress was changed since. */
  unit (c: Character): { uid: number, changed: boolean } | null {
    const v = this.view(c.id)
    if (v.uid === undefined) return null
    const worn = dress.worn(c)
    return { uid: v.uid, changed: v.unit === undefined || DRESS_FIELDS.some(f => v.unit![f] !== worn[f]) }
  }

  /** The next (or previous) choice of a slot (the keys: [ ] sets, Shift+[ ] skins, , . clothes). */
  step (c: Character, field: DressField, dir: 1 | -1): void {
    const worn = dress.worn(c)
    const choices = choicesFor(c, worldFor(c), worn, field)
    const next = stepChoice(choices, worn[field], dir, field !== 'outfit')
    if (next !== worn[field]) this.set(c, field, next)
  }

  // ---- hover previews -------------------------------------------------------------------------------------------------

  private before = $state.raw<{ id: string, d: Dress | undefined, worn: Dressed } | null>(null)
  private timer: ReturnType<typeof setTimeout> | undefined

  /** Show `d` while the pointer rests on a tile (after `delay` ms: a sweep across the tiles fits nothing); unpreview
   * puts the dress back, pin keeps it. */
  preview (c: Character, d: Partial<Dressed>, delay = 160): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const now = app(c)
      if (untrack(() => this.before)?.id !== now.id) this.before = { id: now.id, d: dress.of(now.id), worn: dress.worn(now) }
      this.dressUp(now, d)
    }, delay)
  }

  unpreview (c: Character): void {
    clearTimeout(this.timer)
    const b = this.before
    this.before = null
    if (b === null || b.id !== c.id) return
    this.dressUp(app(c), b.worn)
  }

  /** What the hover shows is kept (a click). */
  pin (c: Character, d: Partial<Dressed>): void {
    clearTimeout(this.timer)
    this.before = null
    this.dressUp(app(c), d)
  }

  /** The dress before a preview, when one shows (the tile that is worn for good). */
  pinned (c: Character): Dressed { return this.before !== null && this.before.id === c.id ? this.before.worn : dress.worn(c) }
}

export const wardrobe = new WardrobeState()
