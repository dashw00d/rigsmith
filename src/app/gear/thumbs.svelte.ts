// The Wardrobe's tile pictures: a set worn on the body, a skin's face, clothes on the torso, a hair or beard piece on
// the head, a piece alone (src/engine/OutfitThumbs.ts draws them offscreen). Each is keyed by a hash of what it is made
// of: the body's, skin's and models' file hashes (src/state/assets.svelte.ts) and the pieces' placements, so a change to
// any makes a new key and an old picture is never shown for it. Kept in IndexedDB across visits (every access guarded:
// without it they last the page) and as object URLs while the page is open. Drawn one at a time while the page is idle,
// the newest asked first (the tiles in view), off the critical path.
import { SvelteMap } from 'svelte/reactivity'
import type { Character, Gear } from '../../state/api.ts'
import { assets } from '../../state/assets.svelte.ts'
import { fnv1a, hex8 } from '../../model/ids.ts'
import { setsOf } from '../../model/folk.ts'
import { OutfitThumbs, type Framing, type ThumbSpec } from '../../engine/OutfitThumbs.ts'

/** Bumped when the pictures change how they are drawn (every old key let go). */
const VERSION = 1
const DB = 'rigsmith-thumbs'
const STORE = 'thumbs'
/** The hair colour hair and beard tiles are shown in. */
const NEUTRAL_HAIR = '#5a3a24'

export type ThumbAsk =
  | { kind: 'set', name: string }
  | { kind: 'skin', name: string }
  | { kind: 'clothes', name: string }
  | { kind: 'hair' | 'beard' | 'piece', id: string }

let db: Promise<IDBDatabase | null> | null = null
function open (): Promise<IDBDatabase | null> {
  db ??= new Promise(resolve => {
    try {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
      req.onsuccess = () => { resolve(req.result) }
      req.onerror = () => { resolve(null) }
      req.onblocked = () => { resolve(null) }
    } catch { resolve(null) }
  })
  return db
}

async function stored (key: string): Promise<Blob | null> {
  const d = await open()
  if (d === null) return null
  return await new Promise(resolve => {
    try {
      const req = d.transaction(STORE, 'readonly').objectStore(STORE).get(key)
      req.onsuccess = () => { resolve(req.result instanceof Blob ? req.result : null) }
      req.onerror = () => { resolve(null) }
    } catch { resolve(null) }
  })
}

async function store (key: string, blob: Blob): Promise<void> {
  const d = await open()
  if (d === null) return
  try { d.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key) } catch { /* full or closed: it lasts the page */ }
}

const idle = (fn: () => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 1500 })
  else setTimeout(fn, 30)
}

interface Made { key: string, spec: ThumbSpec }

class Thumbs {
  /** key -> object URL (reactive: a tile shows its picture the moment it is made). */
  private readonly urls = new SvelteMap<string, string>()
  /** What is waiting, by key, newest last. */
  private readonly waiting = new Map<string, () => Made | null>()
  private readonly failed = new Set<string>()
  private running = false
  private renderer: OutfitThumbs | null = null

  /** The tile's picture, or null while it is being made (asked for then). */
  get (c: Character, ask: ThumbAsk): string | null {
    const made = this.made(c, ask)
    if (made === null) return null
    const url = this.urls.get(made.key)
    if (url !== undefined) return url
    if (!this.failed.has(made.key)) {
      // (asked again: to the back of the line, which goes first)
      this.waiting.delete(made.key)
      this.waiting.set(made.key, () => this.made(c, ask))
      this.pump()
    }
    return null
  }

  /** What the picture is made of and its key (null: nothing to draw, or the character's files not in yet). */
  private made (c: Character, ask: ThumbAsk): Made | null {
    const m = assets.manifestOf(c.id)
    const bodyFile = c.files.rigged ?? c.files.model
    if (m === undefined || bodyFile === undefined) return null
    const body = assets.asset(c, bodyFile)
    if (body === null) return null
    const byId = new Map(c.gear.map(g => [g.id, g]))
    const skins = c.look.skins ?? []
    const own = skins.find(k => k.name === c.look.skin) ?? skins.find(k => !(k.tags ?? []).includes('female')) ?? skins[0]
    let gear: Gear[] = []
    let skin: typeof own | undefined = own
    let clothes: { file: string, tags?: string[] } | undefined
    let framing: Framing = 'body'
    let hair: string | null | undefined
    if (ask.kind === 'set') {
      const set = setsOf(c).find(s => s.name === ask.name)
      if (set === undefined) return null
      gear = set.pieces.map(id => byId.get(id)).filter((g): g is Gear => g !== undefined)
    } else if (ask.kind === 'skin') {
      skin = skins.find(k => k.name === ask.name)
      if (skin === undefined) return null
      framing = 'head'
    } else if (ask.kind === 'clothes') {
      clothes = (c.look.clothes ?? []).find(k => k.name === ask.name)
      if (clothes === undefined) return null
      framing = 'torso'
    } else {
      const g = byId.get(ask.id)
      if (g === undefined) return null
      gear = [g]
      framing = ask.kind === 'piece' ? 'piece' : 'head'
      if (ask.kind !== 'piece') hair = NEUTRAL_HAIR
    }
    const ready = gear.filter(g => g.status === 'ready' && g.model !== undefined)
    if (ready.length === 0 && gear.length > 0) return null
    const pieces = ready.map(g => ({ gear: g, url: assets.asset(c, g.model)!, place: g.attach.place }))
    const id = JSON.stringify([
      VERSION, framing, m[bodyFile] ?? body, skin === undefined ? null : m[skin.file] ?? skin.file, clothes === undefined ? null : m[clothes.file] ?? clothes.file, hair ?? null,
      ready.map(g => [g.id, m[g.model!] ?? g.model, g.attach, g.origin ?? null]),
    ])
    const key = `${hex8(fnv1a(id))}${hex8(fnv1a(`${id}#`))}`
    return {
      key,
      spec: {
        body, pieces, framing,
        skin: skin === undefined ? null : assets.asset(c, skin.file),
        clothes: clothes === undefined ? null : assets.asset(c, clothes.file),
        long: (clothes?.tags ?? []).includes('long-sleeves'),
        ...(hair !== undefined ? { hair } : {}),
      },
    }
  }

  private pump (): void {
    if (this.running) return
    this.running = true
    idle(() => { void this.next() })
  }

  private async next (): Promise<void> {
    const last = [...this.waiting].at(-1)
    if (last === undefined) { this.running = false; return }
    const [key, made] = last
    this.waiting.delete(key)
    try {
      if (!this.urls.has(key)) {
        const blob = await stored(key) ?? await this.draw(made())
        if (blob !== null) this.urls.set(key, URL.createObjectURL(blob))
      }
    } catch (error) {
      // (cosmetic: the tile keeps its plain face; not tried again this page)
      this.failed.add(key)
      console.warn('wardrobe: a picture failed', error)
    }
    idle(() => { void this.next() })
  }

  private async draw (made: Made | null): Promise<Blob | null> {
    if (made === null) return null
    this.renderer ??= new OutfitThumbs()
    const blob = await this.renderer.render(made.spec)
    void store(made.key, blob)
    return blob
  }

  /** Everything waiting dropped (the drawer closed, another character). */
  drop (): void {
    this.waiting.clear()
  }
}

export const thumbs = new Thumbs()

/** `use:inview={fn}`: `fn` once the element is first scrolled into view (a tile asks for its picture then). */
export function inview (node: HTMLElement, fn: () => void) {
  let cb = fn
  if (typeof IntersectionObserver !== 'function') { cb(); return {} }
  const io = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) { io.disconnect(); cb() }
  }, { rootMargin: '120px' })
  io.observe(node)
  return {
    update (next: () => void) { cb = next },
    destroy () { io.disconnect() },
  }
}
