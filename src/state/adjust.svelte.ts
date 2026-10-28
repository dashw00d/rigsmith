// A slot's adjustments (DESIGN.md §2, Slot.adjustments) as the Motion step changes them: added with sensible starts,
// switched on and off, edited, removed; every change a command (app.do), which plays the slot again as it now bakes
// (the animator replays what changed under it). Also the tools that read the slot as it plays: the playhead's frame
// (one numbering: frames of the clip as it plays, 30 a second, within one ridden cycle), the ground stood on the floor
// by the feet (src/engine/ground.ts through the bake), the blow set to the frame shown, a pull's holds found by playing
// it, and keys made with the gizmo (a bone's turn, or the pelvis's and gear's moves): letting go keys the change there,
// against the clip as it plays before its keys (src/engine/keys.ts).
import * as THREE from 'three'
import type { Adjustment, AdjustmentKind, Character, ClipKey, Side, Slot } from './api.ts'
import type { Command } from '../model/command-types.ts'
import { app } from './app.svelte.ts'
import { animator, type NowPlaying } from './animator.svelte.ts'
import { gizmo } from './gizmo.svelte.ts'
import { newId } from '../model/ids.ts'
import { carriedBy, gearById, slotById } from '../model/select.ts'
import { gearNode } from '../engine/geom.ts'
import { garmentMatrix } from '../engine/placement.ts'
import { pelvisName } from '../engine/retarget.ts'
import {
  blowUAtPhase, cycleAt, framesOf, freeWindows, handWindows, keysOf, keysWith, snapPhase, targetOf, timeAt, withKey,
} from '../app/motion/rules.ts'

export type KeyMode = 'rotate' | 'translate'

type Of<K extends AdjustmentKind> = Extract<Adjustment, { kind: K }>

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))

class Adjust {
  /** The adjustment open in the stack (its editor shown). */
  open = $state<string | null>(null)
  /** What the keys editor keys: 'bone:<name>' or 'gear:<gear id>' (null: nothing). */
  target = $state<string | null>(null)
  mode = $state<KeyMode>('rotate')
  /** What it is working on (null: idle). */
  busy = $state<string | null>(null)
  private attached: THREE.Object3D | null = null

  // ---- the playhead --------------------------------------------------------------------------------------------

  /** What plays when it is `slotId` as it bakes (not the editor's edit of it, not still baking). */
  playingSlot (slotId: string): NowPlaying | null {
    const now = animator.playing
    return now !== null && now.kind === 'slot' && now.slotId === slotId && !now.editing && now.baked !== null ? now : null
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

  /** Show phase `u` of the clip playing (in the ridden cycle shown), paused there. */
  seekPhase (u: number): void {
    const now = animator.playing
    if (now === null || animator.duration <= 0) return
    animator.setPlaying(false)
    animator.seek(timeAt(u, cycleAt(animator.time / animator.duration, now.cycles), now.cycles, animator.duration))
  }

  // ---- the stack ---------------------------------------------------------------------------------------------------

  async add (c: Character, slotId: string, kind: AdjustmentKind): Promise<void> {
    const slot = slotById(c, slotId)
    if (slot === undefined) return
    if (kind === 'ground') {
      if (await this.autoGround(c, slotId, true)) this.open = find(slotById(app.byId(c.id) ?? c, slotId), 'ground')?.id ?? null
      return
    }
    const made = this.made(c, slot, kind)
    if (made === null) return
    if (await app.do(c.id, { type: 'slot.adjust.add', slot: slotId, adjustment: made }) === null) return
    this.open = made.id
    if (made.kind === 'handleHold') await this.findHolds(c, slotId, made.id)
  }

  async update (c: Character, slotId: string, id: string, patch: Record<string, unknown>): Promise<boolean> {
    return await app.do(c.id, { type: 'slot.adjust.update', slot: slotId, id, patch }) !== null
  }

  async setEnabled (c: Character, slotId: string, id: string, on: boolean): Promise<boolean> {
    return await this.update(c, slotId, id, { enabled: on })
  }

  async remove (c: Character, slotId: string, id: string): Promise<boolean> {
    if (this.open === id) this.open = null
    return await app.do(c.id, { type: 'slot.adjust.remove', slot: slotId, id }) !== null
  }

  /** A new adjustment of `kind` for `slot`, as it most likely starts; null (said why) when there is no room for it. */
  private made (c: Character, slot: Slot, kind: Exclude<AdjustmentKind, 'ground'>): Adjustment | null {
    const id = newId()
    switch (kind) {
      case 'blowTiming': return { id, kind, enabled: true, at: 0.45, hand: 'RightHand' }
      case 'pace': {
        const others = c.clips.filter(s => s.id !== slot.id)
        const like = others.find(s => s.name === 'Walk') ?? others[0]
        if (like === undefined) { app.toast('error', 'A pace follows another clip: add one first'); return null }
        return { id, kind, enabled: true, like: like.id }
      }
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
      case 'keys': return { id, kind, enabled: true }
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

  /** The blow is the frame shown of the slot playing (a phase of the clip before its cut). */
  async blowHere (c: Character, slotId: string, id: string): Promise<boolean> {
    const now = this.playingSlot(slotId)
    if (now === null || now.baked === null) { app.toast('error', 'Play this clip and pause on its blow first'); return false }
    const phase = this.playhead(slotId) ?? now.phase
    const u = blowUAtPhase(now.baked.cut, phase, animator.duration / Math.max(1, now.cycles))
    if (u === null) { app.toast('error', 'The blow can\'t be the first or last frame: pick a frame inside the clip'); return false }
    return await this.update(c, slotId, id, { blowU: u, enabled: true })
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

  // ---- keys ------------------------------------------------------------------------------------------------------

  /** The object a key target moves on stage. */
  object (c: Character, target: string | null): THREE.Object3D | null {
    const view = animator.view
    const t = target === null ? null : targetOf(target)
    if (t === null || view === null) return null
    if (t.kind === 'bones') return view.bones.get(t.name) ?? null
    const g = gearById(c, t.name)
    return g === undefined ? null : view.root.getObjectByName(gearNode(g)) ?? null
  }

  /** Whether a target can be moved, not only turned: gear, and the bone carrying the body's moves (the pelvis). */
  moves (target: string | null): boolean {
    const t = target === null ? null : targetOf(target)
    if (t === null) return false
    if (t.kind === 'gear') return true
    const rest = animator.view?.rest
    return rest != null && pelvisName(rest) === t.name
  }

  /** The gizmo on the target while the slot plays (paused on a frame to key); off otherwise. */
  show (c: Character, slotId: string, on: boolean): void {
    const object = on && this.playingSlot(slotId) !== null ? this.object(c, this.target) : null
    if (object === null) { this.hide(); return }
    if (!this.moves(this.target) && this.mode === 'translate') this.mode = 'rotate'
    gizmo.attach(object, { mode: this.mode, space: 'local', onCommit: () => { void this.commit(c.id, slotId) } })
    this.attached = object
  }

  hide (): void {
    if (this.attached === null) return
    gizmo.detach(this.attached)
    this.attached = null
  }

  /** Key the target where it stands now, at the frame shown (what the gizmo left, or as the clip has it). */
  async commit (characterId: string, slotId: string): Promise<boolean> {
    const c = app.byId(characterId)
    const now = this.playingSlot(slotId)
    const target = this.target
    const t = target === null ? null : targetOf(target)
    const object = c === null ? null : this.object(c, target)
    const u = this.playhead(slotId)
    if (c === null || now?.baked == null || t === null || target === null || object === null || u === null) return false
    let key: ClipKey
    if (t.kind === 'bones') {
      // (against the clip as it plays before its keys, at the time of this frame in the cycle shown)
      const time = timeAt(u, cycleAt(animator.time / Math.max(animator.duration, 1e-9), now.cycles), now.cycles, animator.duration)
      const rest = animator.view?.rest?.bones.get(t.name)
      const base = new THREE.Quaternion().fromArray(trackAt(now.baked.unkeyed, `${t.name}.quaternion`, time, rest?.localQuaternion.toArray() ?? [0, 0, 0, 1]))
      key = { u, q: rounded(base.invert().multiply(object.quaternion).normalize().toArray()) as ClipKey['q'] }
      if (this.moves(target)) {
        const p = object.position.clone().sub(new THREE.Vector3().fromArray(trackAt(now.baked.unkeyed, `${t.name}.position`, time, rest?.localPosition.toArray() ?? [0, 0, 0])))
        if (p.length() > 1e-6) key.p = p.toArray().map(v => round(v, 5)) as ClipKey['p']
      }
    } else {
      // (gear keys are moves and turns from where it is placed, in its placed, sized frame)
      const g = gearById(c, t.name)
      if (g === undefined || g.attach.kind !== 'bone') return false
      const gp = new THREE.Vector3(); const gq = new THREE.Quaternion()
      garmentMatrix(g.attach.place).decompose(gp, gq, new THREE.Vector3())
      const unturn = gq.clone().invert()
      key = { u, q: rounded(unturn.clone().multiply(object.quaternion).normalize().toArray()) as ClipKey['q'] }
      const p = object.position.clone().sub(gp).applyQuaternion(unturn).divideScalar(g.attach.place.scale || 1)
      if (p.length() > 1e-6) key.p = p.toArray().map(v => round(v, 5)) as ClipKey['p']
    }
    return await this.setKeys(c, slotId, target, keys => withKey(keys, key))
  }

  /** A key with no change at the frame shown: the clip as it is there (it keeps a tweak from spreading past it). */
  async noChangeHere (c: Character, slotId: string): Promise<boolean> {
    const u = this.playhead(slotId)
    const target = this.target
    if (u === null || target === null) return false
    return await this.setKeys(c, slotId, target, keys => withKey(keys, { u, q: [0, 0, 0, 1] }))
  }

  /** Change one target's keys on the slot (its keys adjustment made when it has none). */
  async setKeys (c: Character, slotId: string, target: string, change: (keys: ClipKey[]) => ClipKey[]): Promise<boolean> {
    const slot = slotById(c, slotId)
    if (slot === undefined) return false
    const a = find(slot, 'keys')
    const out = keysWith(a, target, change(keysOf(a, target)))
    let cmd: Command
    if (a === undefined) {
      if (out === null) return false
      const id = newId()
      cmd = { type: 'slot.adjust.add', slot: slotId, adjustment: { id, kind: 'keys', enabled: true, ...out } }
      this.open = id
    } else {
      cmd = { type: 'slot.adjust.update', slot: slotId, id: a.id, patch: { bones: out?.bones ?? null, gear: out?.gear ?? null } }
    }
    return await app.do(c.id, cmd) !== null
  }
}

/** The pull handles of the character's ready gear, as a hold names them. */
export function pullHandles (c: Character): Array<{ gear: string, handle: string, label: string }> {
  return c.gear.flatMap(g => g.handles.filter(h => h.kind === 'pull').map(h => ({ gear: g.id, handle: h.id, label: `${g.name} · ${h.name}` })))
}

function find<K extends AdjustmentKind> (slot: Slot | undefined, kind: K, id?: string): Of<K> | undefined {
  return slot?.adjustments.find((a): a is Of<K> => a.kind === kind && (id === undefined || a.id === id))
}

/** A track's value at `time` (`fallback` when the clip has no such track). */
function trackAt (clip: THREE.AnimationClip, name: string, time: number, fallback: number[]): number[] {
  const track = clip.tracks.find(x => x.name === name)
  if (track === undefined) return fallback
  const interpolant = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
  return Array.from(interpolant.evaluate(time) as ArrayLike<number>).slice(0, fallback.length)
}

const rounded = (q: number[]): number[] => q.map(v => round(v, 6))

export const adjust = new Adjust()
