// A character's game slots: the clip names the game plays for it (the game's spec, settings.gameSpec), each filled
// with a library clip in its animation set under that name. A slot can be armed, so the library's + fills it.
import type { AnimationEntry, Character, ClipKey } from './api.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'

export interface GameSide { unit: string, role: 'unit' | 'companion', clips: string[], height: number | null, spec: string }

class Slots {
  game = $state<GameSide | null>(null)
  /** The slot the library's + fills (null: + adds a trial). */
  armed = $state<string | null>(null)
  private loadedFor = ''
  private loadedBeat = -1

  /** Load `id`'s game side, and again whenever the game's units change (app.gameBeat: read here, so a calling effect
   *  runs again on it). */
  async load (id: string | null): Promise<void> {
    const beat = app.gameBeat
    if (id === this.loadedFor && beat === this.loadedBeat) return
    const other = id !== this.loadedFor
    this.loadedFor = id ?? ''
    this.loadedBeat = beat
    if (other) { this.armed = null; this.game = null }
    if (id === null) { this.game = null; return }
    try {
      const res = await fetch(`/api/characters/${id}/game`)
      const game = res.ok ? await res.json() as GameSide | null : null
      if (this.loadedFor === id && this.loadedBeat === beat) this.game = game
    } catch { /* no game side */ }
  }

  isSlot (name: string): boolean {
    return this.game?.clips.includes(name) === true
  }

  /** Fill `slot` with a library clip (replacing what was there: its loop, in place and speed, its tweaks, stay; a clip
   * made with a prop leading brings that prop's path). */
  async fill (slot: string, clip: { clipId: string, url?: string, inPlace: boolean, loop: boolean, propPaths?: Record<string, ClipKey[]> }): Promise<void> {
    const c = app.selected
    if (c === null) return
    const was = c.animations.find(a => a.name === slot)
    const entry: AnimationEntry = withPropPaths(was !== undefined
      ? { ...was, clipId: clip.clipId, url: clip.url, note: undefined }
      : { clipId: clip.clipId, url: clip.url, name: slot, inPlace: clip.inPlace, loop: clip.loop, speed: 1 }, clip.propPaths, c)
    if (entry.url === undefined) delete entry.url
    if (entry.note === undefined) delete entry.note
    const next = was !== undefined ? c.animations.map(a => (a === was ? entry : a)) : [...c.animations, entry]
    await app.update(c.id, { animations: next })
    this.armed = null
    const index = next.indexOf(entry)
    animator.playEntry(entry, index)
  }

  /** Empty a slot (its entry leaves the set). */
  async clear (slot: string): Promise<void> {
    const c = app.selected
    if (c === null) return
    await app.update(c.id, { animations: c.animations.filter(a => a.name !== slot) })
    if (animator.current?.name === slot) animator.stop()
  }
}

export const slots = new Slots()

/** `entry` with a clip's prop paths as its prop keys (each for a prop `c` has, by name; the entry's own keys for any
 * other prop stay). */
export function withPropPaths (entry: AnimationEntry, paths: Record<string, ClipKey[]> | undefined, c: Character): AnimationEntry {
  const mine = Object.entries(paths ?? {}).filter(([name]) => (c.garments ?? []).some(g => g.name === name && g.mode === 'rigid'))
  if (mine.length === 0) return entry
  return { ...entry, keys: { ...entry.keys, props: { ...entry.keys?.props, ...Object.fromEntries(mine) } } }
}
