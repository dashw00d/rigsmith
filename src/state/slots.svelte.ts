// A character's game slots: the clip names the game plays for it (the game's spec, settings.gameSpec), each filled
// with a library clip in its animation set under that name. A slot can be armed, so the library's + fills it.
import type { AnimationEntry } from './api.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'

export interface GameSide { unit: string, role: 'unit' | 'companion', clips: string[], height: number | null, spec: string }

class Slots {
  game = $state<GameSide | null>(null)
  /** The slot the library's + fills (null: + adds a trial). */
  armed = $state<string | null>(null)
  private loadedFor = ''

  async load (id: string | null): Promise<void> {
    if (id === this.loadedFor) return
    this.loadedFor = id ?? ''
    this.armed = null
    this.game = null
    if (id === null) return
    try {
      const res = await fetch(`/api/characters/${id}/game`)
      const game = res.ok ? await res.json() as GameSide | null : null
      if (this.loadedFor === id) this.game = game
    } catch { /* no game side */ }
  }

  isSlot (name: string): boolean {
    return this.game?.clips.includes(name) === true
  }

  /** Fill `slot` with a library clip (replacing what was there: its loop, in place and speed, its tweaks, stay). */
  async fill (slot: string, clip: { clipId: string, url?: string, inPlace: boolean, loop: boolean }): Promise<void> {
    const c = app.selected
    if (c === null) return
    const was = c.animations.find(a => a.name === slot)
    const entry: AnimationEntry = was !== undefined
      ? { ...was, clipId: clip.clipId, url: clip.url, note: undefined }
      : { clipId: clip.clipId, url: clip.url, name: slot, inPlace: clip.inPlace, loop: clip.loop, speed: 1 }
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
