// A character's set of clips (DESIGN.md §2, slots): the clip names its game unit plays (its slots, filled from the
// library) and the trials kept beside them. Every change is a command (app.do); slots are named by their stable id, so
// renaming or reordering never loses which is which. A slot (or a game clip name with no slot yet) can be armed: a
// library card's round button then fills it.
import type { Adjustment, Character, CharacterGame, LibraryClip, Slot } from './api.ts'
import { app } from './app.svelte.ts'
import { animator } from './animator.svelte.ts'
import { api } from './api.ts'
import { newId } from '../model/ids.ts'
import { freshSet, gearKeysFromPaths, slotById } from '../model/select.ts'
import { clipRefOf, defaultInPlace, isTrial, moveBefore, nameProblem, resolveTarget, trialName, type Target } from '../app/motion/rules.ts'

class Slots {
  /** The game's side of the selected character: the unit it is (or is the companion of) and the clip names played. */
  game = $state.raw<CharacterGame | null>(null)
  /** What a library card's round button fills (null: it adds a trial). */
  armed = $state.raw<Target | null>(null)
  /** The slot whose adjustments show. */
  selectedId = $state<string | null>(null)
  private loadedFor: string | null = null
  private loadedBeat = -1

  /** The clip names the game plays for the selected character. */
  get names (): string[] { return this.game?.clips ?? [] }

  /** Load `id`'s game side, and again whenever the game's units change (app.gameBeat: read here, so a calling effect
   * runs again on it). Another character: nothing armed or selected. */
  async load (id: string | null): Promise<void> {
    const beat = app.gameBeat
    if (id === this.loadedFor && beat === this.loadedBeat) return
    const other = id !== this.loadedFor
    this.loadedFor = id
    this.loadedBeat = beat
    if (other) { this.armed = null; this.selectedId = null; this.game = null }
    if (id === null) return
    try {
      const game = await api.characterGame(id)
      if (this.loadedFor === id && this.loadedBeat === beat) this.game = game
    } catch {
      if (this.loadedFor === id && this.loadedBeat === beat) this.game = null
    }
  }

  isTrial (s: Pick<Slot, 'name'>): boolean { return isTrial(s, this.names) }

  arm (target: Target | null): void {
    const a = this.armed
    this.armed = target !== null && a !== null && a.name === target.name && a.slotId === target.slotId ? null : target
  }

  isArmed (slotId: string | null, name: string): boolean {
    const a = this.armed
    return a !== null && (slotId !== null ? a.slotId === slotId : a.slotId === null && a.name === name)
  }

  select (slotId: string | null): void { this.selectedId = slotId }

  /** Play a slot (and show its adjustments). */
  async play (c: Character, slotId: string): Promise<void> {
    this.selectedId = slotId
    await animator.playSlot(c, slotId)
  }

  /** Fill an armed target (a slot, or a game clip name not filled yet) with a library clip: stood on the floor by its
   * feet as its preview was (a ground adjustment), with the gear paths it was made with (keys on this character's gear
   * of those names). A slot's own loop and in place stay; a new one takes the clip's (or `o.inPlace`: as it was
   * previewed). Its old adjustments go (they were for the clip it had). */
  async fill (c: Character, target: Target, clip: LibraryClip, o: { inPlace?: boolean } = {}): Promise<boolean> {
    const { slot, name } = resolveTarget(c, target)
    const ref = clipRefOf(clip)
    const loop = slot?.loop ?? clip.loop
    const inPlace = slot?.inPlace ?? o.inPlace ?? defaultInPlace(clip)
    app.setBusy('slots', `Filling ${name}`)
    let adjustments: Adjustment[]
    try {
      adjustments = await this.madeFor(c, { id: 'probe', name, clip: ref, speed: 1, loop, inPlace, adjustments: [] }, clip)
    } finally {
      app.setBusy('slots', null)
    }
    const id = slot?.id ?? newId()
    const entry = await app.do(c.id, slot !== null
      ? { type: 'slot.fill', id: slot.id, clip: ref, adjustments, note: null }
      : { type: 'slot.fill', name, newId: id, clip: ref, loop, inPlace, adjustments }, `fill ${name}`)
    if (entry === null) return false
    this.armed = null
    await this.play(app.byId(c.id) ?? c, id)
    return true
  }

  /** A library clip kept as a trial, beside the slots (a fresh id; a name no slot or game clip has). */
  async addTrial (c: Character, clip: LibraryClip): Promise<boolean> {
    const name = trialName(c, this.names, clip)
    const slot: Slot = { id: newId(), name, clip: clipRefOf(clip), speed: 1, loop: clip.loop, inPlace: defaultInPlace(clip), adjustments: [] }
    app.setBusy('slots', `Adding ${name}`)
    try {
      slot.adjustments = await this.madeFor(c, slot, clip)
    } finally {
      app.setBusy('slots', null)
    }
    return await app.do(c.id, { type: 'slot.add', slot }) !== null
  }

  /** Take out a library clip's trials (asked first). A slot the game plays is never taken out this way. */
  async removeTrials (c: Character, trials: Slot[], clipName: string): Promise<boolean> {
    if (trials.length === 0) return false
    const ok = await app.confirm({
      title: trials.length === 1 ? `Remove the trial ${trials[0].name}?` : `Remove ${trials.length} trials of ${clipName}?`,
      body: trials.length === 1 ? 'Its adjustments go with it (Undo in Activity brings it back).' : `${trials.map(s => s.name).join(', ')}, and their adjustments (Undo in Activity brings them back).`,
      confirm: 'Remove',
      danger: true,
    })
    if (!ok) return false
    return await app.do(c.id, trials.map(s => ({ type: 'slot.remove', id: s.id })), 'remove trials') !== null
  }

  async remove (c: Character, slotId: string): Promise<boolean> {
    if (this.selectedId === slotId) this.selectedId = null
    return await app.do(c.id, { type: 'slot.remove', id: slotId }) !== null
  }

  /** Every clip taken out (asked first). */
  async clear (c: Character): Promise<boolean> {
    if (c.clips.length === 0) return false
    const ok = await app.confirm({
      title: `Remove all ${c.clips.length} clips?`, body: 'Their adjustments go with them (Undo in Activity brings them back).', confirm: 'Remove all', danger: true,
    })
    if (!ok) return false
    this.selectedId = null
    return await app.do(c.id, c.clips.map(s => ({ type: 'slot.remove', id: s.id })), 'clear the clips') !== null
  }

  /** A saved setting of a slot (speed, loop, in place). */
  async update (c: Character, slotId: string, patch: { speed?: number, loop?: boolean, inPlace?: boolean }): Promise<boolean> {
    return await app.do(c.id, { type: 'slot.update', id: slotId, patch }) !== null
  }

  /** Rename a slot; the reason it can't take the name (nothing sent), or null. A trial named as a clip the game plays
   * becomes that clip (asked first). */
  async rename (c: Character, slotId: string, name: string): Promise<string | null> {
    const s = slotById(c, slotId)
    const next = name.trim()
    if (s === undefined || next === s.name) return null
    const problem = nameProblem(c, slotId, next)
    if (problem !== null) return problem
    if (this.names.includes(next) && !this.names.includes(s.name)) {
      const ok = await app.confirm({ title: `Make it ${next}?`, body: `${next} is a clip the game plays: the game will get this one under that name.`, confirm: `Make it ${next}` })
      if (!ok) return null
    }
    return await app.do(c.id, { type: 'slot.update', id: slotId, patch: { name: next } }) === null ? 'Not renamed' : null
  }

  /** Move a slot before another (null: to the end). */
  async reorder (c: Character, moved: string, before: string | null): Promise<void> {
    const ids = c.clips.map(s => s.id)
    const next = moveBefore(ids, moved, before)
    if (next.every((id, i) => id === ids[i])) return
    await app.do(c.id, { type: 'slot.reorder', ids: next })
  }

  /** This character's whole set copied onto others (asked first): fresh ids, adjustments that name gear mapped onto
   * their gear of the same name (what has no match there is dropped and journaled on them). */
  async copyTo (c: Character, targets: Character[]): Promise<number> {
    if (targets.length === 0 || c.clips.length === 0) return 0
    const ok = await app.confirm({
      title: `Replace the clips of ${targets.length === 1 ? targets[0].name : `${targets.length} characters`}?`,
      body: `${targets.map(t => t.name).join(', ')} will play ${c.name}'s ${c.clips.length} clips, adjustments included, instead of their own (Undo in each one's Activity brings theirs back).`,
      confirm: 'Replace',
      danger: true,
    })
    if (!ok) return 0
    const gearNames = Object.fromEntries(c.gear.map(g => [g.id, g.name]))
    const handleNames = Object.fromEntries(c.gear.flatMap(g => g.handles.map(h => [`${g.id}/${h.id}`, h.name])))
    let done = 0
    for (const t of targets) {
      const entry = await app.do(t.id, { type: 'clips.replace', slots: freshSet(c.clips, newId), gearNames, handleNames }, `copy ${c.name}'s clips`)
      if (entry !== null) done++
    }
    if (done > 0) app.toast('ok', `Copied ${c.clips.length} clips to ${done} character${done === 1 ? '' : 's'}`)
    return done
  }

  /** What a slot of a library clip starts with: its gear paths as keys, and the ground its feet stand on (not a
   * rider's: he sits on his horse). */
  private async madeFor (c: Character, slot: Slot, clip: LibraryClip): Promise<Adjustment[]> {
    const out: Adjustment[] = []
    const gear = gearKeysFromPaths(c, clip.propPaths ?? {})
    if (Object.keys(gear).length > 0) out.push({ id: newId(), kind: 'keys', enabled: true, gear })
    if (c.mount !== undefined) return out
    try {
      const baked = await animator.bake(c, { ...slot, adjustments: out }, { autoGround: true })
      const lift = baked === null ? 0 : Math.round(baked.lift * 1e4) / 1e4
      if (Math.abs(lift) >= 1e-4) out.unshift({ id: newId(), kind: 'ground', enabled: true, lift })
    } catch (error) {
      // (a clip that doesn't bake here keeps no ground: it says why when it plays)
      console.warn('Ground fit failed', error)
    }
    return out
  }
}

export const slots = new Slots()
