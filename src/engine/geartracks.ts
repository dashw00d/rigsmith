// Who holds a gear piece and when it shows, over a slot's clip (docs/motion-plan.md §2.5, §9 C2): a sword drawn from
// the back into the hand, a javelin thrown and gone, a tool picked up. A slot's gear track says it (GearTrack.heldBy,
// .shown, in source time); the one bake (src/engine/bake.ts) resolves it on the clip as keyed and plays it as tracks on
// the piece's own node, the viewer's and the game's alike:
//   held by  the piece never changes parents. It stays under its Gear attach bone A, and while bone B holds it, its node
//            is moved, frame by frame, to A^-1 · B · R_B^-1 · place · key (R_B: B's rest frame, `place` where it sits
//            on B in rest space, `key` the slot's gear key on top), so the game's Prop_<gear> bone under A plays it as
//            a plain bone track. Where it sits on each holder: a placement given, a handle of the piece (the hand on it
//            where the handle says), its Gear placement, or else wherever it was at the switch, so nothing pops.
//   shown    a stepped scale (the placement's size, or 0 while hidden).
// The bake records what it resolved (GearHolds: phases of the final clip, every place found), so the export plays the
// same places on its Prop_ bones and tells the game (gearEvents: hide:/show:, detach:/attach: on the clip's events).
// A slot without held-by or shown entries gets nothing from here: it bakes and exports exactly as before.
import * as THREE from 'three'
import type { Character, ClipKey, Gear, Handle, HeldBy, Placement, Quat, Slot, Vec3 } from '../model/types.ts'
import { isMuted } from '../model/select.ts'
import type { TimeMap } from '../model/timemap.ts'
import { frameTimes, sampleKeys } from './keys.ts'
import { meshNameOf } from './contract.ts'
import { gearNode } from './geom.ts'
import { placementMatrix } from './placement.ts'
import type { RestSkeleton } from './retarget.ts'

/** Where a piece sits on its holder: a position and turn in the character's rest space (where it would be at rest,
 * held by that bone). Rigid: the piece keeps its Gear size. */
export interface RestPlace { position: Vec3, quaternion: Quat }

/** How a holder's place was found: 'gear' its Gear placement on its attach bone (before any switch); 'place' given;
 * 'handle' from one of its handles; 'placed' its Gear placement again; 'free' where it was at the switch (no pop). */
export type HoldHow = 'gear' | 'place' | 'handle' | 'placed' | 'free'

/** One holder from phase `t` of the final clip on, its place resolved. */
export interface PlayedHold { t: number, bone: string, place: RestPlace, how: HoldHow, handle?: string }
export interface PlayedShow { t: number, shown: boolean }

/** A piece's holders and shown spans over the final clip: `holds` starts at 0 with whoever holds it then, every later
 * entry a switch; `shown` is empty when it is shown all through, else starts at 0, every later entry a change. */
export interface GearHolds { holds: PlayedHold[], shown: PlayedShow[] }

/** Where a piece's held-by and shown tracks go: its node (the viewer's place node or the game's Prop_ bone), its Gear
 * attach bone and placement, and what its node's parent is: 'rest' the viewer's frame group (the attach bone's rest
 * frame undone: the node's rest local is the placement), 'bone' the attach bone itself (the export's Prop_ bone).
 * `unit`: what a move is multiplied by on the way out (1; the export's game scale). `size`: the node's scale while
 * shown (the placement's in the viewer; 1 for the export's bone, its mesh already placed). */
export interface HoldTarget { gear: Gear, node: string, bone: string, place: Placement, parent: 'rest' | 'bone', unit: number, size: number }

/** The skeleton the bake poses: the character's rest and a posable copy (bake.ts BakeContext). */
export interface PoseContext { rest: RestSkeleton, posable: THREE.Object3D }

/** A moment a switch happens at, seconds before it: the old holder's (or shown state's) last key. */
const EPS = 1e-4

// ---- the slot's tracks as played -------------------------------------------------------------------------------

/** A slot's held-by and shown entries as played (phases of the final clip), by gear id: the pieces whose gear track
 * plays (not muted) and has some. */
export function playedGear (slot: Slot, map: Pick<TimeMap, 'toPlayed'>): Record<string, { heldBy: Array<HeldBy & { t: number }>, shown: Array<{ t: number, shown: boolean }> }> {
  const out: Record<string, { heldBy: Array<HeldBy & { t: number }>, shown: Array<{ t: number, shown: boolean }> }> = {}
  for (const [id, track] of Object.entries(slot.gear ?? {})) {
    if (isMuted(slot, 'gear', id)) continue
    const heldBy = (track.heldBy ?? []).map(x => ({ ...x, t: map.toPlayed(x.u) })).sort((a, b) => a.t - b.t)
    const shown = (track.shown ?? []).map(x => ({ t: map.toPlayed(x.u), shown: x.shown })).sort((a, b) => a.t - b.t)
    if (heldBy.length > 0 || shown.length > 0) out[id] = { heldBy, shown }
  }
  return out
}

/** Whether any slot of the character hides a piece somewhere: every clip then keys its size, so a clip that hid it
 * never leaves it hidden in the next. */
export function hiddenSomewhere (c: Pick<Character, 'clips'>, gear: string): boolean {
  return c.clips.some(s => (s.gear?.[gear]?.shown ?? []).some(x => !x.shown))
}

// ---- resolving --------------------------------------------------------------------------------------------------

/** Each piece's holders and shown spans over `clip` (the slot's clip as keyed, its length the played one), every
 * holder's place resolved: a no-pop switch measured on the clip at its moment. Bone gear only; a holder bone the
 * skeleton lacks is left out (and said in `report`). */
export function resolveHolds (c: Pick<Character, 'gear'>, played: ReturnType<typeof playedGear>, clip: THREE.AnimationClip, ctx: PoseContext,
  report: Record<string, unknown> = {}): Record<string, GearHolds> {
  const out: Record<string, GearHolds> = {}
  const pieces = Object.entries(played).flatMap(([id, p]) => {
    const g = c.gear.find(x => x.id === id)
    return g !== undefined && g.attach.kind === 'bone' ? [{ g, bone: g.attach.bone, place: g.attach.place, p }] : []
  })
  if (pieces.length === 0) return out
  const poser = needsPoses(pieces.map(x => x.p)) ? new Poser(clip, ctx) : null
  try {
    for (const { g, bone, place, p } of pieces) {
      if (!ctx.rest.bones.has(bone)) { report[g.name] = { missing: bone }; continue }
      const gearPlace = restPlace(place)
      const holds: PlayedHold[] = [{ t: 0, bone, place: gearPlace, how: 'gear' }]
      const lines: string[] = []
      for (const x of p.heldBy) {
        if (x.t > 1 + 1e-9) continue
        if (!ctx.rest.bones.has(x.bone)) { lines.push(`${x.bone}: not in the skeleton`); continue }
        const t = Math.max(0, x.t)
        const prev = holds[holds.length - 1]
        let found: { place: RestPlace, how: HoldHow, handle?: string } | null = null
        if (x.place !== undefined) found = { place: restPlace(x.place), how: 'place' }
        else if (x.placed === true && x.bone === bone) found = { place: gearPlace, how: 'placed' }
        else if (x.handle !== undefined) {
          const h = g.handles.find(y => y.id === x.handle)
          const at = h === undefined ? null : handlePlace(g, h, x.bone, ctx.rest)
          if (at !== null) found = { place: at, how: 'handle', handle: h!.id }
          else lines.push(`${x.bone}: no handle ${x.handle} for it (where it was instead)`)
        }
        // (where it was at the switch: its old holder's place carried over onto the new one)
        found ??= { place: moved(prev, x.bone, t * clip.duration, poser!, ctx.rest), how: 'free' }
        const hold: PlayedHold = { t, bone: x.bone, ...found }
        if (t - prev.t < 1e-9) holds[holds.length - 1] = hold
        else holds.push(hold)
        lines.push(`${x.bone} from ${t.toFixed(3)} (${found.how})`)
      }
      const shown = shownSpans(p.shown)
      if (holds.length > 1 || holds[0].how !== 'gear' || shown.length > 0) {
        out[g.id] = { holds, shown }
        report[g.name] = { held: lines.length > 0 ? lines : undefined, hidden: shown.length > 0 ? hiddenSpans(shown) : undefined }
      }
    }
  } finally {
    poser?.done()
  }
  return out
}

/** The tracks that play each piece's holds on its node: position and turn (frame by frame, plus each switch) for a
 * piece that changes hands, a stepped scale for one that hides, a constant scale for a `sized` piece that doesn't hide
 * here (one hidden in another clip). `clip` is what the bones play (character units, the final clip's length); `keys`
 * the gear keys as played, by gear id. */
export function holdTracks (clip: THREE.AnimationClip, holds: Record<string, GearHolds>, keys: Record<string, ClipKey[]>, loop: boolean,
  targets: HoldTarget[], ctx: PoseContext, sized: ReadonlySet<string> = new Set()): THREE.KeyframeTrack[] {
  const d = clip.duration
  const out: THREE.KeyframeTrack[] = []
  const moving = targets.filter(t => (holds[t.gear.id]?.holds.length ?? 0) > 1 || (holds[t.gear.id]?.holds[0]?.how ?? 'gear') !== 'gear')
  const poser = moving.length > 0 ? new Poser(clip, ctx) : null
  try {
    for (const t of targets) {
      const h = holds[t.gear.id]
      if (h !== undefined && poser !== null && moving.includes(t)) out.push(...moveTracks(t, h.holds, keys[t.gear.id], loop, d, poser, ctx.rest))
      if (h !== undefined && h.shown.length > 0) out.push(sizeTrack(t.node, h.shown, d, t.size))
      else if (sized.has(t.gear.id)) out.push(new THREE.VectorKeyframeTrack(`${t.node}.scale`, [0, d], [t.size, t.size, t.size, t.size, t.size, t.size]))
    }
  } finally {
    poser?.done()
  }
  return out
}

/** The bake's stage (bake.ts, after the gear keys): the slot's held-by and shown entries resolved on the clip as keyed;
 * with `nodes`, the gear nodes' tracks for them put in the clip (replacing what the keys gave those nodes). Nothing to
 * do (no entries in the slot, and no piece hidden in another clip): the clip as it was, and no holds. */
export function holdGear (c: Character, slot: Slot, map: Pick<TimeMap, 'toPlayed'>, clip: THREE.AnimationClip, ctx: PoseContext,
  o: { keys: Record<string, ClipKey[]>, nodes: boolean, report?: Record<string, unknown> }): { clip: THREE.AnimationClip, holds: Record<string, GearHolds> } {
  const played = playedGear(slot, map)
  const sized = new Set(c.gear.filter(g => hiddenSomewhere(c, g.id)).map(g => g.id))
  if (Object.keys(played).length === 0 && sized.size === 0) return { clip, holds: {} }
  const report: Record<string, unknown> = {}
  const holds = resolveHolds(c, played, clip, ctx, report)
  if (Object.keys(report).length > 0 && o.report !== undefined) o.report.gear = report
  if (!o.nodes) return { clip, holds }
  const targets: HoldTarget[] = []
  for (const g of c.gear) {
    if (g.attach.kind !== 'bone' || g.attach.legacyFrame !== undefined) continue
    const node = gearNode(g)
    if (ctx.posable.getObjectByName(node) === undefined) continue
    targets.push({ gear: g, node, bone: g.attach.bone, place: g.attach.place, parent: 'rest', unit: 1, size: g.attach.place.scale })
  }
  const extra = holdTracks(clip, holds, o.keys, slot.loop, targets, ctx, sized)
  return { clip: withTracks(clip, extra), holds }
}

/** The clip with these tracks in place of any of the same names. */
export function withTracks (clip: THREE.AnimationClip, extra: THREE.KeyframeTrack[]): THREE.AnimationClip {
  if (extra.length === 0) return clip
  const names = new Set(extra.map(t => t.name))
  return new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks.filter(t => !names.has(t.name)), ...extra])
}

/** A baked slot's holds again over `cycles` cycles of a ridden clip (bake.ts bakeRide): each cycle starts as the
 * first did. Only what is inside the clip is repeated (a switch a blow cut left before the start is where the cycle
 * starts, one after the end none): repeated, it would land in a neighbouring cycle. */
export function holdsAgain (holds: Record<string, GearHolds>, cycles: number): Record<string, GearHolds> {
  if (cycles === 1) return holds
  const inside = <T extends { t: number }>(xs: T[]): T[] => {
    const start = xs.filter(x => x.t <= 0).at(-1)
    return [...(start !== undefined ? [{ ...start, t: 0 }] : []), ...xs.filter(x => x.t > 0 && x.t <= 1)]
  }
  const again = <T extends { t: number }>(xs: T[]): T[] => { const one = inside(xs); return Array.from({ length: cycles }, (_, k) => one.map(x => ({ ...x, t: (x.t + k) / cycles }))).flat() }
  return Object.fromEntries(Object.entries(holds).map(([id, h]) => [id, { holds: again(h.holds), shown: again(h.shown) }]))
}

// ---- the game's events -------------------------------------------------------------------------------------------

/** What the game hears of a clip's holds (added to its events in the events file, docs/motion-plan.md §6): per piece
 * (its mesh name, as the GLB names it), `hide:<mesh>` / `show:<mesh>` where it hides and shows again (a hide at 0 when it
 * starts hidden), `detach:<mesh>` (`bone`: who let go) and `attach:<mesh>` (`bone`: who took it) where it changes
 * bones. Only the pieces `exported` (by gear id). Sorted by t. */
export function gearEvents (c: Pick<Character, 'gear'>, holds: Record<string, GearHolds> | undefined, exported: (id: string) => boolean): Array<{ t: number, name: string, bone?: string }> {
  const out: Array<{ t: number, name: string, bone?: string }> = []
  for (const [id, h] of Object.entries(holds ?? {})) {
    const g = c.gear.find(x => x.id === id)
    if (g === undefined || !exported(id)) continue
    const mesh = meshNameOf(g)
    h.shown.forEach((x, i) => { if (i > 0 || !x.shown) out.push({ t: x.t, name: `${x.shown ? 'show' : 'hide'}:${mesh}` }) })
    for (let i = 1; i < h.holds.length; i++) {
      const was = h.holds[i - 1]; const now = h.holds[i]
      // (a cycle of a ride starting again over: its first holder back, as the clip has it)
      if (now.bone === was.bone) continue
      out.push({ t: now.t, name: `detach:${mesh}`, bone: was.bone }, { t: now.t, name: `attach:${mesh}`, bone: now.bone })
    }
  }
  return out.sort((a, b) => a.t - b.t)
}

// ---- a leading piece's keys with its origin moved -------------------------------------------------------------------

/**
 * A leading piece's keys (slot.ik.lead: world moves and turns about its origin from where it rode in the clip,
 * clipedit.ts onPath) for its origin moved by `o` (a point of its frame now), so it leads along the same path: where it
 * rode at each key (`unkeyed`, the slot's clip before keys, on its attach bone at its Gear placement) says where the
 * new origin was then, d = its turn applied to o times its size, and p' = p + q·d - d (gear.origin takes them). `toPlayed`:
 * the slot's time map (a key's source moment as a phase of `unkeyed`).
 */
export function leadKeysMoved (g: Gear, keys: readonly ClipKey[], o: Vec3, unkeyed: THREE.AnimationClip, toPlayed: (u: number) => number, ctx: PoseContext): ClipKey[] {
  if (g.attach.kind !== 'bone' || !ctx.rest.bones.has(g.attach.bone)) return keys.map(k => ({ ...k }))
  const bone = g.attach.bone
  const place = restPlace(g.attach.place)
  const under = restFrame(ctx.rest, bone).invert().multiply(matrixOf(place))
  const local = new THREE.Vector3(...o).multiplyScalar(g.attach.place.scale)
  const poser = new Poser(unkeyed, ctx)
  try {
    return keys.map(k => {
      const time = THREE.MathUtils.clamp(toPlayed(k.u), 0, 1) * unkeyed.duration
      const rode = poser.world(bone, time).multiply(under)
      const turn = new THREE.Quaternion(); rode.decompose(new THREE.Vector3(), turn, new THREE.Vector3())
      const d = local.clone().applyQuaternion(turn)
      const p = new THREE.Vector3(...(k.p ?? [0, 0, 0])).add(d.clone().applyQuaternion(new THREE.Quaternion(...k.q).normalize())).sub(d)
      return { ...k, p: p.toArray() as Vec3 }
    })
  } finally {
    poser.done()
  }
}

// ---- inside ---------------------------------------------------------------------------------------------------------

function needsPoses (pieces: Array<{ heldBy: HeldBy[] }>): boolean {
  return pieces.some(p => p.heldBy.length > 0)
}

const rigid = (position: THREE.Vector3, quaternion: THREE.Quaternion): THREE.Matrix4 => new THREE.Matrix4().compose(position, quaternion, new THREE.Vector3(1, 1, 1))
const matrixOf = (p: RestPlace): THREE.Matrix4 => rigid(new THREE.Vector3(...p.position), new THREE.Quaternion(...p.quaternion))

function placeOf (m: THREE.Matrix4): RestPlace {
  const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
  m.decompose(position, quaternion, new THREE.Vector3())
  return { position: position.toArray() as Vec3, quaternion: quaternion.normalize().toArray() as Quat }
}

/** A Gear placement's position and turn (its size left out). */
function restPlace (p: Placement): RestPlace {
  const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
  placementMatrix(p).decompose(position, quaternion, new THREE.Vector3())
  return { position: position.toArray() as Vec3, quaternion: quaternion.toArray() as Quat }
}

/** A bone's rest frame in rest space (no scale), as the viewer's frame group undoes it (garments.ts restFrame). */
function restFrame (rest: RestSkeleton, bone: string): THREE.Matrix4 {
  const b = rest.bones.get(bone)!
  return rigid(b.worldPosition, b.worldQuaternion)
}

/** Where a piece sits on `bone` held by handle `h`: its carry handle on its attach bone, its Gear placement; a hand on
 * a handle with a place (a grip; a carry handle placed for the editor), the piece where that hand's wrist is on it
 * (clipedit.ts handOn: the wrist at the handle's place in the piece's placed, sized frame). Null: no place for it. */
function handlePlace (g: Gear, h: Handle, bone: string, rest: RestSkeleton): RestPlace | null {
  if (g.attach.kind !== 'bone' || h.kind === 'pull') return null
  if (h.kind === 'carry' && bone === g.attach.bone) return restPlace(g.attach.place)
  if (h.place === undefined) return null
  const s = g.attach.place.scale
  const wrist = rigid(new THREE.Vector3(...h.place.position).multiplyScalar(s), new THREE.Quaternion(...h.place.rotation).normalize())
  return placeOf(restFrame(rest, bone).multiply(wrist.invert()))
}

/** The place on `bone` that keeps the piece where `prev` had it at `time` (seconds): R_B · B^-1 · P · R_P^-1 · place. */
function moved (prev: PlayedHold, bone: string, time: number, poser: Poser, rest: RestSkeleton): RestPlace {
  const was = poser.world(prev.bone, time).multiply(restFrame(rest, prev.bone).invert()).multiply(matrixOf(prev.place))
  return placeOf(restFrame(rest, bone).multiply(poser.world(bone, time).invert()).multiply(was))
}

/** The shown entries as spans from 0: the state at 0 (shown, unless an entry at or before 0 hides it), then each change;
 * none when it never hides. */
function shownSpans (shown: Array<{ t: number, shown: boolean }>): PlayedShow[] {
  const out: PlayedShow[] = [{ t: 0, shown: true }]
  for (const x of shown) {
    if (x.t > 1 + 1e-9) continue
    const t = Math.max(0, x.t)
    const last = out[out.length - 1]
    if (t - last.t < 1e-9) last.shown = x.shown
    else if (x.shown !== last.shown) out.push({ t, shown: x.shown })
  }
  // (an entry at 0 that changed nothing leaves two the same: merged)
  const merged = out.filter((x, i) => i === 0 || x.shown !== out[i - 1].shown)
  return merged.every(x => x.shown) ? [] : merged
}

function hiddenSpans (shown: PlayedShow[]): Array<[number, number]> {
  return shown.flatMap((x, i) => (x.shown ? [] : [[+x.t.toFixed(4), +(shown[i + 1]?.t ?? 1).toFixed(4)] as [number, number]]))
}

/** The node's position and turn over the clip: on each frame (and each switch, and just before a switch that jumps),
 * A^-1 · B · R_B^-1 · place · key, under its parent (the viewer's frame group: R_A first). */
function moveTracks (t: HoldTarget, holds: PlayedHold[], keys: ClipKey[] | undefined, loop: boolean, d: number, poser: Poser, rest: RestSkeleton): THREE.KeyframeTrack[] {
  const times = new Set(frameTimes(d))
  for (const h of holds.slice(1)) {
    times.add(h.t * d)
    if (h.how !== 'free' && h.t * d - EPS > 0) times.add(h.t * d - EPS)
  }
  const sorted = [...times].sort((a, b) => a - b).filter((x, i, xs) => i === 0 || x - xs[i - 1] > 1e-7)
  const under = t.parent === 'rest' ? restFrame(rest, t.bone) : new THREE.Matrix4()
  const toB = new Map(holds.map(h => [h, restFrame(rest, h.bone).invert().multiply(matrixOf(h.place))]))
  const ps: number[] = []; const qs: number[] = []
  const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const was = new THREE.Quaternion()
  for (const time of sorted) {
    const v = d > 0 ? time / d : 0
    const h = holds.findLast(x => x.t * d <= time + 1e-9) ?? holds[0]
    const k = sampleKeys(keys ?? [], v, loop)
    const key = rigid(k.p.multiplyScalar(t.place.scale), k.q)
    const local = under.clone().multiply(poser.world(t.bone, time).invert()).multiply(poser.world(h.bone, time)).multiply(toB.get(h)!).multiply(key)
    local.decompose(p, q, new THREE.Vector3())
    // (the same hemisphere as the frame before: the turn tweens the short way)
    if (q.dot(was) < 0) q.set(-q.x, -q.y, -q.z, -q.w)
    was.copy(q)
    ps.push(p.x * t.unit, p.y * t.unit, p.z * t.unit)
    qs.push(q.x, q.y, q.z, q.w)
  }
  return [new THREE.VectorKeyframeTrack(`${t.node}.position`, sorted, ps), new THREE.QuaternionKeyframeTrack(`${t.node}.quaternion`, sorted, qs)]
}

/** The node's size: `size` while shown, 0 while hidden, switching at each change (a key just before it holds the old
 * size, so the step survives anything that tweens linearly between keys, a ride's repeat included). */
function sizeTrack (node: string, shown: PlayedShow[], d: number, size: number): THREE.KeyframeTrack {
  const times: number[] = []; const values: number[] = []
  const put = (time: number, on: boolean): void => { const s = on ? size : 0; times.push(time); values.push(s, s, s) }
  put(0, shown[0].shown)
  for (let i = 1; i < shown.length; i++) {
    const time = Math.min(d, shown[i].t * d)
    if (time - EPS > times[times.length - 1] + 1e-7) put(time - EPS, shown[i - 1].shown)
    put(time, shown[i].shown)
  }
  if (d > times[times.length - 1] + 1e-7) put(d, shown[shown.length - 1].shown)
  return new THREE.VectorKeyframeTrack(`${node}.scale`, times, values)
}

/** The skeleton posed by a clip at any moment (its bones' tracks evaluated directly: no mixer, so moments can come in
 * any order), each bone's world matrix read; the bones put back by done(). */
class Poser {
  private readonly bones = new Map<string, THREE.Object3D>()
  private readonly tracks: Array<{ target: THREE.Object3D, prop: 'position' | 'quaternion' | 'scale', at: THREE.Interpolant }> = []
  private readonly saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  private readonly cache = new Map<number, Map<string, THREE.Matrix4>>()
  private readonly root: THREE.Object3D

  constructor (clip: THREE.AnimationClip, ctx: PoseContext) {
    this.root = ctx.posable
    this.root.traverse(o => {
      if ((o as THREE.Bone).isBone !== true) return
      this.bones.set(o.name, o)
      this.saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()])
    })
    for (const track of clip.tracks) {
      const dot = track.name.lastIndexOf('.')
      const target = this.bones.get(track.name.slice(0, dot))
      const prop = track.name.slice(dot + 1)
      if (target === undefined || (prop !== 'position' && prop !== 'quaternion' && prop !== 'scale')) continue
      this.tracks.push({ target, prop, at: (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant() })
    }
  }

  private posedAt = Number.NaN

  /** `bone`'s world matrix at `time` seconds of the clip (a copy). */
  world (bone: string, time: number): THREE.Matrix4 {
    let at = this.cache.get(time)
    if (at === undefined) { at = new Map(); this.cache.set(time, at) }
    let m = at.get(bone)
    if (m === undefined) {
      const o = this.bones.get(bone)
      if (o === undefined) throw new Error(`no bone ${bone} to hold gear`)
      if (this.posedAt !== time) this.pose(time)
      m = o.matrixWorld.clone()
      at.set(bone, m)
    }
    return m.clone()
  }

  private pose (time: number): void {
    for (const [o, p, q, s] of this.saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    for (const t of this.tracks) {
      const v = t.at.evaluate(time) as ArrayLike<number>
      if (t.prop === 'quaternion') t.target.quaternion.set(v[0], v[1], v[2], v[3]).normalize()
      else t.target[t.prop].set(v[0], v[1], v[2])
    }
    this.root.updateMatrixWorld(true)
    this.posedAt = time
  }

  /** The bones as they were. */
  done (): void {
    for (const [o, p, q, s] of this.saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    this.root.updateMatrixWorld(true)
  }
}
