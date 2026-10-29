// A slot's adjustments as the Motion step's stack shows them (src/app/motion/rules.ts rowsOf: its settings, and its
// blow fit and pace as rows) and changes them: added with sensible starts, switched on and off, edited, removed;
// every change a command (app.do) on what the row stands for (slot.adjust.*, slot.time, slot.event.*, slot.keys.set),
// which plays the slot again as it now bakes (the animator replays what changed under it). A slot stores its times
// against its source clip (docs/motion-plan.md §1); what the stack and the timeline show is the clip as it plays, so
// every time read or written here goes through the playing slot's time map (BakedSlot.time; as stored when it isn't
// playing). Also the tools that read the slot as it plays: the playhead's frame
// (one numbering: frames of the clip as it plays, 30 a second, within one ridden cycle), the ground stood on the floor
// by the feet (src/engine/ground.ts through the bake), the blow set to the frame shown, a pull's holds found by playing
// it. Keys are the timeline's (src/state/timeline.svelte.ts) and the posing's (src/state/pose.svelte.ts).
import type { Adjustment, Character, Side, Slot, Window } from './api.ts'
import type { Command } from '../model/command-types.ts'
import { IDENTITY, sourceAt, windowsToPlayed, windowsToSource, type TimeMap } from '../model/timemap.ts'
import { app } from './app.svelte.ts'
import { animator, type NowPlaying } from './animator.svelte.ts'
import { newId } from '../model/ids.ts'
import { carriedBy, hitOf, slotById } from '../model/select.ts'
import {
  BLOW_EDGE, cycleAt, FIT, framesOf, freeWindows, handWindows, KEYS, PACE, rowsOf, snapPhase, timeAt, type Row, type RowKind,
} from '../app/motion/rules.ts'

type Of<K extends Adjustment['kind']> = Extract<Adjustment, { kind: K }>

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

class Adjust {
  /** The adjustment open in the stack (its editor shown). */
  open = $state<string | null>(null)
  /** What it is working on (null: idle). */
  busy = $state<string | null>(null)

  // ---- the playhead --------------------------------------------------------------------------------------------

  /** What plays when it is `slotId` as it bakes (not the editor's edit of it, not still baking). */
  playingSlot (slotId: string): NowPlaying | null {
    const now = animator.playing
    return now !== null && now.kind === 'slot' && now.slotId === slotId && now.baked !== null ? now : null
  }

  /** Frames of `slotId`'s clip as it plays (per ridden cycle), or null when it isn't playing. */
  frames (slotId: string): number | null {
    const now = this.playingSlot(slotId)
    return now === null || animator.duration <= 0 ? null : framesOf(animator.duration, now.cycles)
  }

  /** The phase of `slotId`'s clip shown, on its nearest frame; null when it isn't playing. */
  playhead (slotId: string): number | null {
    const now = this.playingSlot(slotId)
    const frames = this.frames(slotId)
    return now === null || frames === null ? null : snapPhase(now.phase, frames)
  }

  /** The time map `slotId` plays by (identity when it isn't playing: times shown as stored). */
  timeOf (slotId: string): TimeMap {
    return this.playingSlot(slotId)?.baked?.time ?? IDENTITY
  }

  /** Source windows as the clip plays them (what the window editors show). */
  shown (slotId: string, windows: readonly Window[]): Window[] {
    return windowsToPlayed(this.timeOf(slotId), windows)
  }

  /** A source moment as a phase of the clip as it plays. */
  played (slotId: string, u: number): number {
    return this.timeOf(slotId).toPlayed(u)
  }

  /** Show phase `u` of the clip playing (in the ridden cycle shown), paused there. */
  seekPhase (u: number): void {
    const now = animator.playing
    if (now === null || animator.duration <= 0) return
    animator.setPlaying(false)
    animator.seek(timeAt(u, cycleAt(animator.time / animator.duration, now.cycles), now.cycles, animator.duration))
  }

  // ---- the stack ---------------------------------------------------------------------------------------------------

  async add (c: Character, slotId: string, kind: RowKind): Promise<void> {
    const slot = slotById(c, slotId)
    if (slot === undefined) return
    if (kind === 'ground') {
      if (await this.autoGround(c, slotId, true)) this.open = find(slotById(app.byId(c.id) ?? c, slotId), 'ground')?.id ?? null
      return
    }
    if (kind === 'keys') { this.open = KEYS; return }
    if (kind === 'blowTiming') {
      if (await app.do(c.id, { type: 'slot.time', slot: slotId, patch: { fit: { enabled: true, at: 0.45, hand: 'RightHand' } } }) !== null) this.open = FIT
      return
    }
    if (kind === 'pace') {
      const others = c.clips.filter(s => s.id !== slot.id)
      const like = others.find(s => s.name === 'Walk') ?? others[0]
      if (like === undefined) { app.toast('error', 'A pace follows another clip: add one first'); return }
      if (await app.do(c.id, { type: 'slot.time', slot: slotId, patch: { pace: { enabled: true, like: like.id } } }) !== null) this.open = PACE
      return
    }
    const made = this.made(c, slot, kind)
    if (made === null) return
    if (await app.do(c.id, { type: 'slot.adjust.add', slot: slotId, adjustment: made }) === null) return
    this.open = made.id
    if (made.kind === 'handleHold') await this.findHolds(c, slotId, made.id)
  }

  /** A row changed. Windows given are as the clip plays (the editors show them so) and stored as source time. */
  async update (c: Character, slotId: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
    const slot = slotById(c, slotId)
    if (slot === undefined) return false
    const cmds = this.commandsFor(c, slot, id, patch)
    return cmds.length === 0 || await app.do(c.id, cmds) !== null
  }

  private commandsFor (c: Character, slot: Slot, id: string, patch: Record<string, unknown>): Command[] {
    const merge = <T extends object>(was: T, p: Record<string, unknown>): T => {
      const out = { ...was } as Record<string, unknown>
      for (const [k, v] of Object.entries(p)) { if (v === null) delete out[k]; else if (v !== undefined) out[k] = v }
      return out as T
    }
    if (id === FIT) {
      const fit = slot.time?.fit
      if (fit === undefined) return []
      const { blowU, ...rest } = patch
      const out: Command[] = []
      if (Object.keys(rest).length > 0) out.push({ type: 'slot.time', slot: slot.id, patch: { fit: merge(fit, rest) } })
      // (the blow picked by hand is the slot's hit event; "Find it" takes it out, the fit measures it again)
      const hit = hitOf(slot)
      if (blowU === null && hit !== undefined) out.push({ type: 'slot.event.remove', slot: slot.id, id: hit.id })
      if (typeof blowU === 'number') {
        out.push(hit === undefined
          ? { type: 'slot.event.add', slot: slot.id, event: { id: newId(), name: 'hit', u: blowU } }
          : { type: 'slot.event.update', slot: slot.id, id: hit.id, patch: { u: blowU } })
      }
      return out
    }
    if (id === PACE) {
      const pace = slot.time?.pace
      return pace === undefined ? [] : [{ type: 'slot.time', slot: slot.id, patch: { pace: merge(pace, patch) } }]
    }
    if (id === KEYS) {
      if (typeof patch.enabled !== 'boolean') return []
      const muted = (slot.muted ?? []).filter(m => m !== 'bones' && m !== 'gear')
      return [{ type: 'slot.update', id: slot.id, patch: { muted: patch.enabled ? muted : [...muted, 'bones', 'gear'] } }]
    }
    const p = Array.isArray(patch.windows) ? { ...patch, windows: windowsToSource(this.timeOf(slot.id), patch.windows as Window[]) } : patch
    return [{ type: 'slot.adjust.update', slot: slot.id, id, patch: p }]
  }

  async setEnabled (c: Character, slotId: string, id: string, on: boolean): Promise<boolean> {
    return await this.update(c, slotId, id, { enabled: on })
  }

  async remove (c: Character, slotId: string, id: string): Promise<boolean> {
    if (this.open === id) this.open = null
    const slot = slotById(c, slotId)
    if (slot === undefined) return false
    let cmds: Command[]
    if (id === FIT) cmds = [{ type: 'slot.time', slot: slotId, patch: { fit: null } }]
    else if (id === PACE) cmds = [{ type: 'slot.time', slot: slotId, patch: { pace: null } }]
    else if (id === KEYS) {
      cmds = [{ type: 'slot.keys.set', slot: slotId, tracks: [
        ...Object.keys(slot.bones ?? {}).map(bone => ({ bone, keys: [] })),
        ...Object.keys(slot.gear ?? {}).map(gear => ({ gear, keys: [] })),
      ] }]
    } else cmds = [{ type: 'slot.adjust.remove', slot: slotId, id }]
    return await app.do(c.id, cmds) !== null
  }

  /** The slot's row `id` (its rules.ts rowsOf). */
  row (slot: Slot | undefined, id: string): Row | undefined {
    return slot === undefined ? undefined : rowsOf(slot).find(r => r.id === id)
  }

  /** A new adjustment of `kind` for `slot`, as it most likely starts; null (said why) when there is no room for it. */
  private made (c: Character, slot: Slot, kind: 'handPose' | 'handleHold'): Adjustment | null {
    const id = newId()
    switch (kind) {
      case 'handPose': {
        for (const hand of ['Right', 'Left'] as Side[]) {
          const windows = freeWindows(handWindows(slot, hand))
          if (windows === null) continue
          // (a hand carrying gear most often lets go of it: open, only while it carries it)
          const carried = carriedBy(c, hand)
          return {
            id, kind, enabled: true, hand, pose: carried !== undefined ? 'clip' : 'default',
            ...(windows !== undefined ? { windows } : {}), ...(carried !== undefined ? { gear: carried.id } : {}),
          }
        }
        app.toast('error', `Both hands are posed through all of ${slot.name}: shorten one first`)
        return null
      }
      case 'handleHold': {
        const held = new Set(slot.adjustments.flatMap(a => (a.kind === 'handleHold' ? [`${a.gear}/${a.handle}`] : [])))
        const free = pullHandles(c).find(p => !held.has(`${p.gear}/${p.handle}`))
        if (free === undefined) { app.toast('error', 'No pull handle is left to hold (add one to gear in Gear)'); return null }
        return { id, kind, enabled: true, gear: free.gear, handle: free.handle, windows: [] }
      }
    }
  }

  // ---- ground --------------------------------------------------------------------------------------------------------

  /** Set the slot's lift (adding its ground adjustment when it has none). */
  async setLift (c: Character, slotId: string, lift: number): Promise<boolean> {
    const cmd = this.liftCommand(c, slotId, round(lift, 4))
    return cmd !== null && await app.do(c.id, cmd) !== null
  }

  /** Stand the slot on the floor by its flat feet (measured on it as it bakes without its own lift; its lowest point
   * when it never plants one). `adding`: it had no ground adjustment and gets one even when the fit is nil. */
  async autoGround (c: Character, slotId: string, adding = false): Promise<boolean> {
    if (c.mount !== undefined) {
      if (adding) return await this.setLift(c, slotId, 0)
      app.toast('info', `${c.name} sits on his horse: his feet don't stand on the floor`)
      return false
    }
    const lift = await this.fit(c, slotId)
    // (one that didn't bake still gets its ground when asked for one: the lift can be typed)
    if (lift === null) return adding && await this.setLift(c, slotId, 0)
    return await this.setLift(c, slotId, lift)
  }

  /** Every slot of `slotIds` stood on the floor by its flat feet, as one change. */
  async autoGroundAll (c: Character, slotIds: string[]): Promise<number> {
    if (c.mount !== undefined) { app.toast('info', `${c.name} sits on his horse: his feet don't stand on the floor`); return 0 }
    const commands: Command[] = []
    for (const id of slotIds) {
      const lift = await this.fit(c, id)
      const cmd = lift === null ? null : this.liftCommand(app.byId(c.id) ?? c, id, round(lift, 4))
      if (cmd !== null) commands.push(cmd)
    }
    if (commands.length === 0) return 0
    if (await app.do(c.id, commands, 'stand the clips on the floor') === null) return 0
    app.toast('ok', `Stood ${commands.length} clip${commands.length === 1 ? '' : 's'} on the floor by their flat feet`)
    return commands.length
  }

  private async fit (c: Character, slotId: string): Promise<number | null> {
    const slot = slotById(c, slotId)
    if (slot === undefined) return null
    this.busy = `Standing ${slot.name} on the floor`
    app.setBusy('adjust', this.busy)
    try {
      const baked = await animator.bake(c, slot, { skip: ['ground'], autoGround: true })
      if (baked === null) { app.toast('error', `${c.name} isn't on stage`); return null }
      return baked.lift
    } catch (error) {
      app.toast('error', `${slot.name} didn't bake: ${reason(error)}`)
      return null
    } finally {
      this.busy = null
      app.setBusy('adjust', null)
    }
  }

  private liftCommand (c: Character, slotId: string, lift: number): Command | null {
    const slot = slotById(c, slotId)
    if (slot === undefined) return null
    const ground = find(slot, 'ground')
    if (ground === undefined) return { type: 'slot.adjust.add', slot: slotId, adjustment: { id: newId(), kind: 'ground', enabled: true, lift } }
    return ground.lift === lift && ground.enabled ? null : { type: 'slot.adjust.update', slot: slotId, id: ground.id, patch: { lift, enabled: true } }
  }

  // ---- blow timing ---------------------------------------------------------------------------------------------------

  /** The blow is the frame shown of the slot playing: the moment of its source there becomes its hit. */
  async blowHere (c: Character, slotId: string, id: string): Promise<boolean> {
    const now = this.playingSlot(slotId)
    if (now === null || now.baked === null) { app.toast('error', 'Play this clip and pause on its blow first'); return false }
    const phase = this.playhead(slotId) ?? now.phase
    const u = sourceAt(now.baked.time, phase)
    // (a frame inside the source: on its first or last the fit would cut the attack down to nothing)
    const edge = BLOW_EDGE / Math.max(now.baked.raw.duration, 1e-9)
    if (u < edge - 1e-9 || u > 1 - edge + 1e-9) { app.toast('error', 'The blow can\'t be the first or last frame: pick a frame inside the clip'); return false }
    return await this.update(c, slotId, id, { blowU: Math.round(u * 1e4) / 1e4, enabled: true })
  }

  // ---- handle holds --------------------------------------------------------------------------------------------------

  /** When the slot holds its pull, found by playing it (gear's findHolds). */
  async findHolds (c: Character, slotId: string, id: string): Promise<boolean> {
    const a = find(slotById(c, slotId), 'handleHold', id)
    if (a === undefined) return false
    this.busy = 'Finding when it holds the pull'
    try {
      // (loaded when first needed: gear's state reaches back to the animator, which shows the timeline that uses this)
      const { gear } = await import('./gear.svelte.ts')
      const windows = await gear.findHolds(app.byId(c.id) ?? c, a.gear, a.handle, slotId)
      if (windows.length === 0) { app.toast('info', 'The hand never comes to the pull in this clip: set when it holds it by hand'); return false }
      return await this.update(app.byId(c.id) ?? c, slotId, id, { windows })
    } catch (error) {
      app.toast('error', `Holds not found: ${reason(error)}`)
      return false
    } finally {
      this.busy = null
    }
  }
}

/** The pull handles of the character's ready gear, as a hold names them. */
export function pullHandles (c: Character): Array<{ gear: string, handle: string, label: string }> {
  return c.gear.flatMap(g => g.handles.filter(h => h.kind === 'pull').map(h => ({ gear: g.id, handle: h.id, label: `${g.name} · ${h.name}` })))
}

function find<K extends Adjustment['kind']> (slot: Slot | undefined, kind: K, id?: string): Of<K> | undefined {
  return slot?.adjustments.find((a): a is Of<K> => a.kind === kind && (id === undefined || a.id === id))
}

export const adjust = new Adjust()
