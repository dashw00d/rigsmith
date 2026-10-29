// The one bake: a slot's clip as the game plays it, the same in the viewer, the timeline and the unit export
// (tools/lib/unit_export.ts), so what plays here is what the game gets (docs/motion-plan.md §3). In a fixed order:
//   source -> time (markers and holds, speed, blow fit, pace) -> hands (src/engine/hands.ts) -> ground -> keys on
//   bones -> gear tracks -> events
// A slot stores every time against its source clip; once its time map is resolved (src/model/timemap.ts: the blow
// measured, the pace found), everything it stores is mapped to phases of the clip as it finally plays, and the stages
// after the timing run on those, as they always did: their windows, a pull's and the gear keys' are played phases.
// Everything measured on the clip (the blow, the stride, a fist, the feet) is measured on ctx.posable, a posable copy of
// the character, whose bones are left as they were.
import * as THREE from 'three'
import type { Adjustment, AdjustmentKind, Character, ClipEvent, ClipKey, Gear, HandPose, Mount, Side, Slot, Window } from '../model/types.ts'
import { eventsOf, gearById, heightOf, hitOf, isMuted, slotById, slotByName } from '../model/select.ts'
import { eventToPlayed, keysToPlayed, phaseBeforeFit, resolveTime, windowsToPlayed, type TimeMap } from '../model/timemap.ts'
import type { ClipSource } from './clips.ts'
import { holdGear, holdsAgain, type GearHolds } from './geartracks.ts'
import { firstSkinned, gearNode } from './geom.ts'
import { groundFit } from './ground.ts'
import { applyHands, handLayers, type HandLayer } from './hands.ts'
import { applyBoneKeys, applyLift, propTracks } from './keys.ts'
import { fitRide, freezeClip } from './mount.ts'
import { garmentMatrix } from './placement.ts'
import { pelvisName, restUpOf, type RestSkeleton } from './retarget.ts'
import { blowCut, paceTo, retime, warpClip } from './timing.ts'

export interface BakeContext {
  /** The character's rest skeleton (CharacterView.rest): bone keys and the ground lift start from it. */
  rest: RestSkeleton
  /** A posable copy of the character (with its gear nodes): clips are measured on it, gear tracks bound to it. */
  posable: THREE.Object3D
  clips: ClipSource
  fps?: number
  /** Hand poses shared by every character (settings), for {pose} refs the character doesn't have. */
  sharedPoses?: HandPose[]
}

export interface BakedSlot {
  /** Everything. */
  clip: THREE.AnimationClip
  /** Retargeted with slot.inPlace: speed 1, no hands, no adjustments (the clip source's own copy: read only). */
  raw: THREE.AnimationClip
  /** Before keys. */
  unkeyed: THREE.AnimationClip
  /** How its blow fit cut it: seconds of the clip at its speed (and markers and holds), before the cut. */
  cut?: { start: number, end: number, uncut: number, blow: number }
  /** The total ground lift applied (the ground adjustment, plus autoGround's fit). */
  lift: number
  /** The slot's time map as this bake resolved it (the blow it measured, the pace it found): source time <-> played
   * phases. Whoever shows or writes a slot's times converts with it. */
  time: TimeMap
  /** The keys on bones as played (phases of the final clip): the build record's keyData. */
  boneKeys: Record<string, ClipKey[]>
  /** The keys on gear as played (gear id -> keys), phases of the final clip. */
  gearKeys: Record<string, ClipKey[]>
  /** Windows are phases of the final clip. */
  pulls: PullPlan[]
  hands: Record<Side, HandLayer[]>
  /** The slot's events as played (phases of the final clip), sorted; the blow the fit measured among them as `hit`. */
  events: BakedEvent[]
  /** Who holds each piece and when it shows, as played (src/engine/geartracks.ts), by gear id: the pieces whose gear
   * track has held-by or shown entries (unset: none). */
  gearHolds?: Record<string, GearHolds>
  /** What each stage did: 'fit', 'pace', 'keys', the ground adjustment's id, `hands` and `autoGround`. */
  report: Record<string, unknown>
}

/** An event where the final clip plays it: `t` (and a span's `to`) phases of it. */
export interface BakedEvent { id: string, name: string, t: number, to?: number, sound?: string, bone?: string }

/** A pull handle held in the slot: gear's pulls.ts tickPulls draws it toward `bone` in these windows. */
export interface PullPlan { gear: string, handle: string, bone: string, windows: Window[] }

/** Where a gear piece's tracks go: its node, its placement there (bone-local), its placement's scale (a key's move is
 * in its placed, scaled frame) and the units a move is in (1; the export's game scale). */
export interface GearTrackTarget {
  gear: Gear
  node: string
  rest: { position: THREE.Vector3, quaternion: THREE.Quaternion }
  placeScale: number
  moveScale: number
}

/** What a bake may leave out: adjustment kinds, 'speed', 'time' (fit, pace, markers, holds), 'fit', 'pace', 'hands'
 * (every hand layer), 'keys' (bones' and gear's), 'events'; or 'all' (the clip alone: speed 1, no time, no hands, no
 * adjustments, no tracks). */
export type BakeSkip = Array<AdjustmentKind | 'speed' | 'time' | 'fit' | 'pace' | 'hands' | 'keys' | 'events'> | 'all'

/** A slot's clip baked as the game plays it. `autoGround`: a ground fit by the feet added on top (library previews).
 * `gearNodes: false`: no gear tracks (the export keys its own gear bones). */
export async function bakeSlot (c: Character, slot: Slot, ctx: BakeContext, o: { mirror?: boolean, skip?: BakeSkip, autoGround?: boolean, gearNodes?: boolean } = {}): Promise<BakedSlot> {
  const all = o.skip === 'all'
  const skip = new Set<string>(all ? ['speed', 'time', 'hands', 'keys', 'events'] : o.skip ?? [])
  const report: Record<string, unknown> = {}

  const raw = await ctx.clips.get(slot.clip, { inPlace: slot.inPlace, mirror: o.mirror, fps: ctx.fps })
  const timed = await timeSlot(c, slot, raw, ctx, { mirror: o.mirror, skip, report })
  let clip = timed.clip
  const map = timed.map

  // (the slot as it plays here: its enabled adjustments, less those left out, their windows as played)
  const on = all ? [] : slot.adjustments.filter(a => a.enabled && !skip.has(a.kind)).map(a => playedAdjustment(a, map))
  const played: Slot = { ...slot, adjustments: on }

  const hands: Record<Side, HandLayer[]> = { Left: [], Right: [] }
  if (!skip.has('hands')) {
    hands.Left = handLayers(c, played, 'Left')
    hands.Right = handLayers(c, played, 'Right')
    const r = await applyHands(ctx.posable, clip, c, played, ctx.clips, ctx.sharedPoses)
    clip = r.clip
    if (Object.keys(r.report).length > 0) report.hands = r.report
  }

  // the ground: the Hips (the bone carrying the body's moves) raised straight up
  const pelvis = pelvisName(ctx.rest)
  const hips = ctx.rest.bones.get(pelvis)
  const lifted = (x: THREE.AnimationClip, dy: number): THREE.AnimationClip =>
    hips === undefined ? x : applyLift(x, hips.node.name, dy, hips.localPosition, restUpOf(ctx.rest, pelvis))
  const ground = find(on, 'ground')
  let lift = ground?.lift ?? 0
  if (ground !== undefined) report[ground.id] = { kind: 'ground', lift: ground.lift }
  const body = o.autoGround === true && hips !== undefined ? firstSkinned(ctx.posable) : null
  if (body !== null) {
    const fit = groundFit(ctx.posable, body, lifted(clip, lift), heightOf(c))
    lift += fit.lift
    report.autoGround = { lift: +fit.lift.toFixed(4), method: fit.method, flatFrames: fit.flatFrames }
  }
  if (hips === undefined) lift = 0
  clip = lifted(clip, lift)

  const unkeyed = clip
  const keys = skip.has('keys') ? { bones: {}, gear: {} } : playedKeys(slot, map)
  clip = applyBoneKeys(clip, keys.bones, slot.loop, boneRest(ctx.rest))
  const gearKeys = keys.gear
  if (Object.keys(keys.bones).length > 0 || Object.keys(gearKeys).length > 0) report.keys = { kind: 'keys', bones: counts(keys.bones), gear: counts(gearKeys) }

  // every placed gear piece gets tracks, keyed or not, so a clip played before never leaves one moved
  if (o.gearNodes !== false) {
    const targets: GearTrackTarget[] = []
    for (const g of c.gear) {
      // (catalog gear still in the old grip frame is placed by the gear area, not by its placement here)
      if (g.attach.kind !== 'bone' || g.attach.legacyFrame !== undefined) continue
      const node = gearNode(g)
      if (ctx.posable.getObjectByName(node) === undefined) continue
      const position = new THREE.Vector3(); const quaternion = new THREE.Quaternion()
      garmentMatrix(g.attach.place).decompose(position, quaternion, new THREE.Vector3())
      targets.push({ gear: g, node, rest: { position, quaternion }, placeScale: g.attach.place.scale, moveScale: 1 })
    }
    const extra = gearTracks(clip.duration, gearKeys, slot.loop, targets)
    const names = new Set(extra.map(t => t.name))
    clip = new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks.filter(t => !names.has(t.name)), ...extra])
  }
  // who holds each piece and when it shows (geartracks.ts): resolved on the clip as keyed, played on the gear nodes
  const held = skip.has('keys') ? null : holdGear(c, slot, map, clip, ctx, { keys: gearKeys, nodes: o.gearNodes !== false, report })
  if (held !== null) clip = held.clip

  const events = skip.has('events') ? [] : playedEvents(slot, map, timed.cut)
  return {
    clip: named(clip, slot.name), raw, unkeyed: named(unkeyed, slot.name), cut: timed.cut, lift, time: map,
    boneKeys: keys.bones, gearKeys, pulls: pullPlans(c, played), hands, events, report,
    ...(held !== null && Object.keys(held.holds).length > 0 ? { gearHolds: held.holds } : {}),
  }
}

/** A slot's clip through its time map (markers and holds, speed, the blow fit, pace), and the map as resolved. `skip`
 * as bakeSlot's; `noPace`: the clip another slot's pace measures (its own pace left out, as it always was). */
export async function timeSlot (c: Character, slot: Slot, raw: THREE.AnimationClip, ctx: BakeContext,
  o: { mirror?: boolean, skip?: Set<string>, noPace?: boolean, report?: Record<string, unknown> } = {}): Promise<{ clip: THREE.AnimationClip, cut?: BakedSlot['cut'], map: TimeMap }> {
  const skip = o.skip ?? new Set<string>()
  const report = o.report ?? {}
  const speed = skip.has('speed') ? 1 : slot.speed
  const time = skip.has('time') ? undefined : slot.time
  let clip = retime(warpClip(raw, time), speed)

  let cut: BakedSlot['cut']
  const fit = time?.fit?.enabled === true && !skip.has('fit') ? time.fit : undefined
  if (fit !== undefined) {
    const uncut = clip.duration
    const hit = hitOf(slot)
    const blowU = hit === undefined ? undefined : phaseBeforeFit(hit.u, { seconds: raw.duration, speed, time })
    const r = blowCut(ctx.posable, clip, { at: fit.at, late: fit.late, hand: fit.hand, window: fit.window, blowU })
    clip = r.clip
    cut = { start: r.kept[0], end: r.kept[1], uncut, blow: r.blow }
    report.fit = { kind: 'blow', clip: slot.name, at: fit.at, window: fit.window, blowU, blow: +r.blow.toFixed(3), kept: r.kept.map(x => +x.toFixed(3)), uncut: +uncut.toFixed(4) }
  }

  let factor: number | undefined
  const pace = time?.pace?.enabled === true && !skip.has('pace') && o.noPace !== true ? time.pace : undefined
  if (pace !== undefined) {
    const like = slotById(c, pace.like)
    if (like === undefined || like.id === slot.id) report.pace = { kind: 'pace', clip: slot.name, like: pace.like, missing: true }
    else {
      const likeRaw = await ctx.clips.get(like.clip, { inPlace: like.inPlace, mirror: o.mirror, fps: ctx.fps })
      const r = paceTo(ctx.posable, clip, (await timeSlot(c, like, likeRaw, ctx, { mirror: o.mirror, noPace: true })).clip)
      clip = r.clip
      factor = r.factor
      report.pace = { kind: 'pace', clip: slot.name, like: like.name, retimed: +r.factor.toFixed(3) }
    }
  }
  const map = resolveTime({ seconds: raw.duration, speed, time, kept: cut === undefined ? undefined : [cut.start, cut.end], pace: factor })
  return { clip, cut, map }
}

/** An adjustment with its windows as played. */
function playedAdjustment (a: Adjustment, map: TimeMap): Adjustment {
  if (a.kind === 'handleHold') return { ...a, windows: windowsToPlayed(map, a.windows) }
  if (a.kind === 'handPose' && a.windows !== undefined) return { ...a, windows: windowsToPlayed(map, a.windows) }
  return a
}

/** The slot's keys that play (not muted), at their played phases. */
function playedKeys (slot: Slot, map: TimeMap): { bones: Record<string, ClipKey[]>, gear: Record<string, ClipKey[]> } {
  const bones: Record<string, ClipKey[]> = {}
  for (const [b, ks] of Object.entries(slot.bones ?? {})) if (ks.length > 0 && !isMuted(slot, 'bones', b)) bones[b] = keysToPlayed(map, ks)
  const gear: Record<string, ClipKey[]> = {}
  for (const [g, t] of Object.entries(slot.gear ?? {})) if ((t.keys?.length ?? 0) > 0 && !isMuted(slot, 'gear', g)) gear[g] = keysToPlayed(map, t.keys!)
  return { bones, gear }
}

/** The slot's events as played, sorted; a fit with no hit event adds the blow it measured. */
function playedEvents (slot: Slot, map: TimeMap, cut: BakedSlot['cut']): BakedEvent[] {
  if (isMuted(slot, 'events')) return []
  const hit = hitOf(slot)
  const out: BakedEvent[] = eventsOf(slot).map(e => {
    // (the hit where the fit landed it: a blow picked at a clip's very edge is kept a frame inside it)
    const at = e === hit && cut !== undefined ? { t: (cut.blow - cut.start) / Math.max(cut.end - cut.start, 1e-12) } : eventToPlayed(map, e)
    return baked(e, at)
  })
  if (hit === undefined && cut !== undefined) out.push({ id: 'hit', name: 'hit', t: (cut.blow - cut.start) / Math.max(cut.end - cut.start, 1e-12) })
  return out.sort((a, b) => a.t - b.t)
}

function baked (e: ClipEvent, at: { t: number, to?: number }): BakedEvent {
  return {
    id: e.id, name: e.name, t: at.t, ...(at.to !== undefined ? { to: at.to } : {}),
    ...(e.sound !== undefined ? { sound: e.sound } : {}), ...(e.bone !== undefined ? { bone: e.bone } : {}),
  }
}

/** The pull handles a slot holds (its enabled handleHold adjustments on pull handles that exist on bone gear), with
 * their windows. */
export function pullPlans (c: Character, slot: Slot): PullPlan[] {
  const out: PullPlan[] = []
  for (const a of slot.adjustments) {
    if (!a.enabled || a.kind !== 'handleHold' || a.windows.length === 0) continue
    const g = gearById(c, a.gear)
    // (a pull only exists on bone gear)
    if (g === undefined || g.attach.kind !== 'bone') continue
    const h = g.handles.find(x => x.id === a.handle)
    if (h?.kind !== 'pull' || h.pull === undefined) continue
    out.push({ gear: a.gear, handle: a.handle, bone: h.pull.bone, windows: a.windows.map(w => [w[0], w[1]]) })
  }
  return out
}

/** A rider's baked slot seated on his horse: his held bones in their seated pose, and the horse's slot of the same name
 * (else its Idle) baked and fitted to it as the game plays them (src/engine/mount.ts fitRide: a loop by whole cycles,
 * the horse's gait leading; an attack's horse stretched to his). His pull windows, keys and events are repeated over his
 * cycles (they stay phases of his clip); his hand layers and time map keep the slot's (one cycle's). `rest`: the rider's
 * rest skeleton. `horse` null: the horse has no such slot and no Idle. */
export async function bakeRide (rider: BakedSlot, horse: { c: Character, ctx: BakeContext, slotName: string }, mount: Mount,
  o: { loop: boolean, attack: boolean, rest: RestSkeleton, mirror?: boolean }): Promise<{ rider: BakedSlot, horse: THREE.AnimationClip | null, cycles: number, report: Record<string, unknown> }> {
  const rest = boneRest(o.rest)
  const clip = freezeClip(rider.clip, mount, rest)
  const unkeyed = freezeClip(rider.unkeyed, mount, rest)
  const hs = slotByName(horse.c, horse.slotName) ?? slotByName(horse.c, 'Idle')
  if (hs === undefined) return { rider: { ...rider, clip, unkeyed }, horse: null, cycles: 1, report: { horse: null } }
  const hb = (await bakeSlot(horse.c, hs, horse.ctx, { mirror: o.mirror })).clip
  const fit = fitRide(clip, hb, o.loop, o.attack)
  const cycles = Array.isArray(fit.report.cycles) ? (fit.report.cycles as number[])[0] : 1
  const again = (w: Window[]): Window[] => Array.from({ length: cycles }, (_, k) => w.map(([a, b]): Window => [(a + k) / cycles, (b + k) / cycles])).flat()
  const keysAgain = (ks: ClipKey[]): ClipKey[] => Array.from({ length: cycles }, (_, k) => ks.map(x => ({ ...x, u: (x.u + k) / cycles }))).flat()
  const eventsAgain = (es: BakedEvent[]): BakedEvent[] => Array.from({ length: cycles }, (_, k) => es.map(e => ({ ...e, t: (e.t + k) / cycles, ...(e.to !== undefined ? { to: (e.to + k) / cycles } : {}) }))).flat()
  return {
    rider: {
      ...rider,
      clip: fit.rider,
      unkeyed: fitRide(unkeyed, hb, o.loop, o.attack).rider,
      pulls: cycles === 1 ? rider.pulls : rider.pulls.map(p => ({ ...p, windows: again(p.windows) })),
      gearKeys: cycles === 1 ? rider.gearKeys : Object.fromEntries(Object.entries(rider.gearKeys).map(([id, ks]) => [id, keysAgain(ks)])),
      boneKeys: cycles === 1 ? rider.boneKeys : Object.fromEntries(Object.entries(rider.boneKeys).map(([b, ks]) => [b, keysAgain(ks)])),
      events: cycles === 1 ? rider.events : eventsAgain(rider.events),
      ...(rider.gearHolds !== undefined ? { gearHolds: holdsAgain(rider.gearHolds, cycles) } : {}),
    },
    horse: fit.horse,
    cycles,
    report: { horse: hs.name, ...fit.report },
  }
}

/** Each gear piece's place over a clip, its keys (by gear id) on top (keys.ts propTracks). */
export function gearTracks (duration: number, keys: Record<string, ClipKey[]>, loop: boolean, targets: GearTrackTarget[]): THREE.KeyframeTrack[] {
  return targets.flatMap(t => propTracks(t.node, duration, keys[t.gear.id], loop, t.rest, t.placeScale, t.moveScale))
}

/** A bone's rest local transform, for keys and held bones on a bone the clip doesn't move (null: no such bone). */
export function boneRest (rest: RestSkeleton): (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null {
  return bone => {
    const b = rest.bones.get(bone)
    return b === undefined ? null : { q: b.localQuaternion.clone(), p: b.localPosition.clone() }
  }
}

// ---- inside ---------------------------------------------------------------------------------------------------------

function find<K extends AdjustmentKind> (on: Adjustment[], kind: K): Extract<Adjustment, { kind: K }> | undefined {
  return on.find((a): a is Extract<Adjustment, { kind: K }> => a.kind === kind)
}

function named (clip: THREE.AnimationClip, name: string): THREE.AnimationClip {
  return clip.name === name ? clip : new THREE.AnimationClip(name, clip.duration, clip.tracks)
}

function counts (keys: Record<string, ClipKey[]> | undefined): Record<string, number> | undefined {
  const on = Object.entries(keys ?? {}).filter(([, k]) => k.length > 0)
  return on.length === 0 ? undefined : Object.fromEntries(on.map(([n, k]) => [n, k.length]))
}

