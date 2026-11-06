// A rider's seat (Ship's Mount): the horse he rides, the seat placed with the gizmo (src/state/gizmo.svelte.ts), the
// bones held still in it and their pose, the horse's skin and gear for him. Every change is a mount command. "Rides"
// writes his mount and his unit's companion together (a ridden unit's horse is the game's companion). Also the game
// heights the viewer seats him by (viewer.setHeights: his unit's height and its companion's, from Ship's units).
import * as THREE from 'three'
import type { MountPatch } from '../model/command-types.ts'
import { phaseOf } from '../model/select.ts'
import type { Character, Quat, Vec3 } from '../model/types.ts'
import type { CompanionSpec } from '../model/unit.ts'
import { CharacterView } from '../engine/CharacterView.ts'
import { companionFor, LOWER_BODY, mountHeights, riderScale, straddle } from '../engine/mount.ts'
import { animator } from './animator.svelte.ts'
import { asset, assets } from './assets.svelte.ts'
import { app } from './app.svelte.ts'
import { gizmo } from './gizmo.svelte.ts'
import { ship } from './ship.svelte.ts'
import { viewer } from './viewer.svelte.ts'

/** What the gizmo moves for a rider: his seat on the horse, or one of his held bones. */
export type SeatTarget = 'seat' | `bone:${string}`

const r = (v: number, k: number): number => Math.round(v * k) / k
const vec = (v: THREE.Vector3, k: number): Vec3 => [r(v.x, k), r(v.y, k), r(v.z, k)]
const quat = (q: THREE.Quaternion): Quat => [r(q.x, 1e6), r(q.y, 1e6), r(q.z, 1e6), r(q.w, 1e6)]
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
/** The unit's companion entry worth keeping for a horse he now rides: a horse's (its height and bones carry over), or
 * this one's; a pony he led starts afresh. */
const kept = (was: CompanionSpec | undefined, horseId: string): CompanionSpec | undefined =>
  was !== undefined && (was.ridden === true || was.character === horseId) ? was : undefined

/** How his size against the horse is worked out: from the two game heights, else the mount's own scale. */
export interface SeatSize { k: number, from: 'game' | 'scale', rider: number | null, horse: number | null }

class Seat {
  /** Seating him on a horse (its model loading), in words; null when idle. */
  busy = $state<string | null>(null)
  /** The rider's view on stage (the viewer's: the selected character). */
  rider = $state.raw<CharacterView | null>(null)
  /** The gizmo's mode for the seat (and the Hips): move or turn. Held bones only turn. */
  mode = $state<'translate' | 'rotate'>('translate')
  private target_ = $state<SeatTarget | null>(null)
  private object = $state.raw<THREE.Object3D | null>(null)
  private riderId: string | null = null

  constructor () {
    viewer.onLoad((view, c) => {
      this.rider = view
      this.riderId = c.id
      return () => {
        this.aim(null)
        if (this.rider === view) { this.rider = null; this.riderId = null }
      }
    }, 40)
    // (the seat editor is Ship's: leaving the step puts the gizmo away)
    viewer.onSync((_view, _c, step) => { if (step !== 'ship' && this.target_ !== null) this.aim(null) })
    viewer.onMountUnload(() => { if (this.target_ === 'seat') this.aim(null) })
    viewer.setHeights(async (rider, horse) => {
      await ship.load()
      return mountHeights(ship.units(), rider.id, horse.id)
    })
  }

  /** What the gizmo is on for the seat now (null: nothing, or another area took the gizmo). */
  get target (): SeatTarget | null {
    return this.object !== null && gizmo.target === this.object ? this.target_ : null
  }

  /** The horses a character can ride: rigged characters on another template than the human. */
  horses (c: Character): Character[] {
    return app.characters.filter(x => x.id !== c.id && x.skeleton.template !== 'human' && x.files.rigged !== undefined && phaseOf(x).phase === 'rigged')
  }

  /** His bones, parents first (the held list offers any of them). */
  bones (): string[] {
    const rider = this.rider
    return rider?.rest?.order.filter(b => rider.bones.has(b)) ?? []
  }

  /** The horse's bones (where the seat can hang). */
  horseBones (): string[] {
    const horse = viewer.mount?.view
    return horse?.rest?.order.filter(b => horse.bones.has(b)) ?? []
  }

  /** His size in the horse's space and where it comes from. */
  size (c: Character): SeatSize | null {
    const m = c.mount
    const rider = this.rider
    const horse = viewer.mount
    if (m === undefined || rider === null || horse === null) return null
    const h = mountHeights(ship.units(), c.id, m.character)
    const k = riderScale(m, { game: h.rider, own: rider.height }, { game: h.horse, own: horse.view.height })
    return { k, from: h.rider !== null && h.horse !== null ? 'game' : 'scale', rider: h.rider, horse: h.horse }
  }

  /** Put the gizmo on the seat or on a held bone (null: put it away). */
  aim (target: SeatTarget | null): void {
    if (this.object !== null) gizmo.detach(this.object)
    this.object = null
    this.target_ = null
    if (target === null) return
    const object = target === 'seat' ? viewer.mount?.seat ?? null : this.rider?.bones.get(target.slice(5)) ?? null
    if (object === null) return
    this.target_ = target
    this.object = object
    gizmo.attach(object, {
      mode: this.moves(target) ? this.mode : 'rotate',
      space: target === 'seat' ? 'world' : 'local',
      onCommit: () => { void this.commit(target) },
    })
  }

  setMode (mode: 'translate' | 'rotate'): void {
    this.mode = mode
    const t = this.target
    if (t !== null && this.moves(t)) gizmo.mode = mode
  }

  /** The seat and the Hips move as well as turn; other bones only turn. */
  moves (target: SeatTarget): boolean { return target === 'seat' || target === 'bone:Hips' }

  /** Ride a horse (a new seat worked out from the two bodies: src/engine/mount.ts straddle), or get off (null). His
   * unit's companion follows: the horse, ridden; on foot, a ridden companion goes. Riding the same horse again seats
   * him anew (the horse's skin and gear for him are kept). */
  async ride (c: Character, horseId: string | null): Promise<void> {
    this.aim(null)
    await ship.load()
    const units = ship.unitsOf(c.id).filter(u => u.role === 'unit')
    if (horseId === null) {
      if (c.mount !== undefined && await app.do(c.id, { type: 'mount.set', mount: null }) === null) return
      for (const u of units) if (u.ours.companion?.ridden === true) await ship.patch(u.name, { companion: undefined })
      return
    }
    const horse = app.byId(horseId)
    const rider = this.rider
    if (horse !== null) await assets.load(horse.id)
    const url = horse === null ? null : asset(horse, horse.files.rigged)
    if (horse === null || url === null || rider === null || this.riderId !== c.id) return
    this.setBusy(`Seating ${c.name} on ${horse.name}`)
    let loaded: CharacterView | null = null
    try {
      const shown = viewer.mount?.character.id === horseId ? viewer.mount.view : null
      const hv = shown ?? (loaded = await CharacterView.load(url))
      const unit = units[0]
      const companion = unit === undefined ? null : companionFor(horse, true, kept(unit.ours.companion, horseId))
      const k = riderScale(c.mount ?? {}, { game: unit?.ours.height ?? null, own: rider.height }, { game: companion?.height ?? null, own: hv.height })
      const was = c.mount?.character === horseId ? c.mount : undefined
      const keep = was === undefined ? {} : {
        ...(was.scale !== undefined ? { scale: was.scale } : {}), ...(was.skin !== undefined ? { skin: was.skin } : {}),
        ...(was.gear !== undefined ? { gear: was.gear } : {}),
      }
      const entry = await app.do(c.id, { type: 'mount.set', mount: { character: horseId, rotation: [0, 0, 0], ...straddle(hv, rider, k), ...keep } })
      if (entry === null) return
      for (const u of units) await ship.patch(u.name, { companion: companionFor(horse, true, kept(u.ours.companion, horseId)) })
    } catch (error) {
      app.toast('error', `${c.name} couldn't be seated: ${reason(error)}`)
    } finally {
      loaded?.dispose()
      this.setBusy(null)
    }
  }

  /** Something baked plays (or is paused), so the held bones can be taken from it. */
  get canTakePose (): boolean {
    return animator.playing?.baked != null
  }

  /** His held bones as the clip playing has them at the frame shown (a seated clip paused on the right frame): the
   * seat's new pose. Read from the clip before the seat holds them (what plays while he rides has them held already),
   * at the phase shown (a slot's timing adjustments aside). */
  async takePose (c: Character): Promise<void> {
    const m = c.mount
    const rest = this.rider?.rest
    const now = animator.playing
    const raw = now?.baked?.raw
    if (m === undefined || rest == null || now === null || raw == null || this.riderId !== c.id) return
    // (a stand-in for each held bone at rest, so the clip moves nothing on stage)
    const root = new THREE.Object3D()
    const stand = new Map<string, THREE.Object3D>()
    for (const b of m.freeze) {
      const r = rest.bones.get(b)
      if (r === undefined) continue
      const o = new THREE.Object3D()
      o.name = r.node.name
      o.position.copy(r.localPosition)
      o.quaternion.copy(r.localQuaternion)
      root.add(o)
      stand.set(b, o)
    }
    const nodeOf = (t: THREE.KeyframeTrack): string => t.name.slice(0, t.name.lastIndexOf('.'))
    const names = new Set([...stand.values()].map(o => o.name))
    const tracks = raw.tracks.filter(t => names.has(nodeOf(t)))
    const turned = new Set(tracks.filter(t => t.name.endsWith('.quaternion')).map(nodeOf))
    if (turned.size === 0) { app.toast('info', `The clip playing doesn't move his held bones`); return }
    const mixer = new THREE.AnimationMixer(root)
    mixer.clipAction(new THREE.AnimationClip('seat pose', raw.duration, tracks)).play()
    mixer.setTime(Math.min(now.phase, 0.9999) * raw.duration)
    mixer.stopAllAction()
    mixer.uncacheRoot(root)
    // (a held bone the clip doesn't turn keeps its seat pose)
    const pose: Record<string, Quat> = { ...m.pose }
    for (const [b, o] of stand) if (turned.has(o.name)) pose[b] = quat(o.quaternion)
    const hips = stand.get('Hips')
    const moved = hips !== undefined && tracks.some(t => nodeOf(t) === hips.name && t.name.endsWith('.position'))
    await this.update(c, hips !== undefined && moved ? { pose, hips: vec(hips.position, 1e5) } : { pose })
  }

  /** Hold a bone still in the seat, or let it play with the clip again. */
  async hold (c: Character, bone: string, on: boolean): Promise<void> {
    const m = c.mount
    if (m === undefined) return
    const freeze = on ? [...new Set([...m.freeze, bone])] : m.freeze.filter(b => b !== bone)
    if (!on && this.target === `bone:${bone}`) this.aim(null)
    await this.update(c, { freeze })
  }

  /** Hold the hips and legs (the seat's default). */
  async holdLegs (c: Character): Promise<void> {
    const m = c.mount
    if (m === undefined) return
    const have = new Set(this.bones())
    await this.update(c, { freeze: [...new Set([...m.freeze, ...LOWER_BODY.filter(b => have.has(b))])] })
  }

  /** His size on the horse when no game heights say it. */
  async setScale (c: Character, scale: number): Promise<void> {
    if (scale > 0) await this.update(c, { scale })
  }

  /** The horse's coat for him (null: its own). */
  async setSkin (c: Character, skin: string | null): Promise<void> {
    await this.update(c, { skin })
  }

  /** Whether the horse wears one of its pieces of gear for him (shown here only: the game never gets it). */
  async wear (c: Character, gearId: string, on: boolean): Promise<void> {
    const was = c.mount?.gear ?? []
    const gear = on ? [...new Set([...was, gearId])] : was.filter(g => g !== gearId)
    await this.update(c, { gear: gear.length > 0 ? gear : null })
  }

  async update (c: Character, patch: MountPatch): Promise<void> {
    const entry = await app.do(c.id, { type: 'mount.update', patch })
    // (at rest he sits in the seat's pose: seated again, as changed; what plays is baked again by the animator)
    if (entry !== null && this.riderId === c.id && animator.playing === null) void animator.stop()
  }

  /** Let go of the gizmo: what it moved is saved (the seat's place and turn, or a held bone's pose). */
  private async commit (target: SeatTarget): Promise<void> {
    const c = app.selected
    const m = c?.mount
    if (c === null || m === undefined || c.id !== this.riderId) return
    if (target === 'seat') {
      const seat = viewer.mount?.seat
      if (seat === undefined) return
      const e = new THREE.Euler().setFromQuaternion(seat.quaternion)
      const rotation: Vec3 = [e.x, e.y, e.z].map(v => r(THREE.MathUtils.radToDeg(v), 10)) as Vec3
      await this.update(c, { position: vec(seat.position, 1e4), rotation })
      return
    }
    const bone = target.slice(5)
    const o = this.rider?.bones.get(bone)
    if (o === undefined) return
    const pose = { ...m.pose, [bone]: quat(o.quaternion) }
    await this.update(c, bone === 'Hips' ? { pose, hips: vec(o.position, 1e5) } : { pose })
  }

  private setBusy (text: string | null): void {
    this.busy = text
    app.setBusy('seat', text)
  }
}

export const seat = new Seat()
