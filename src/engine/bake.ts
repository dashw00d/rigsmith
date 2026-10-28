// The one bake: a slot's clip as the game plays it, the same in the viewer, the editor and the unit export
// (tools/lib/unit_export.ts), so what plays here is what the game gets. In a fixed order, whatever the order of the
// slot's adjustments:
//   speed -> blow timing -> pace -> hands (src/engine/hands.ts) -> ground -> keys on bones -> gear tracks
// Hands come after the timing, so their windows, a pull's and the gear keys' are phases of the clip as it finally plays.
// Everything measured on the clip (the blow, the stride, a fist, the feet) is measured on ctx.posable, a posable copy of
// the character, whose bones are left as they were.
import * as THREE from 'three'
import type { Adjustment, AdjustmentKind, Character, ClipKey, Gear, HandPose, Mount, Side, Slot, Window } from '../model/types.ts'
import { gearById, heightOf, slotById, slotByName } from '../model/select.ts'
import type { ClipSource } from './clips.ts'
import { firstSkinned, gearNode } from './geom.ts'
import { groundFit } from './ground.ts'
import { applyHands, handLayers, type HandLayer } from './hands.ts'
import { applyBoneKeys, applyLift, propTracks } from './keys.ts'
import { fitRide, freezeClip } from './mount.ts'
import { garmentMatrix } from './placement.ts'
import { pelvisName, restUpOf, type RestSkeleton } from './retarget.ts'
import { blowCut, paceTo, retime } from './timing.ts'

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
  /** How its blow timing cut it: seconds of the clip at its speed, before the cut. */
  cut?: { start: number, end: number, uncut: number, blow: number }
  /** The total ground lift applied (the ground adjustment, plus autoGround's fit). */
  lift: number
  /** The enabled keys on gear (gear id -> keys), phases of the final clip. */
  gearKeys: Record<string, ClipKey[]>
  /** Windows are phases of the final clip. */
  pulls: PullPlan[]
  hands: Record<Side, HandLayer[]>
  /** What each stage did, by adjustment id (blow, pace, ground, keys), plus `hands` and `autoGround`. */
  report: Record<string, unknown>
}

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

export type BakeSkip = Array<AdjustmentKind | 'speed' | 'hands'> | 'all'

/** A slot's clip baked as the game plays it. `skip`: adjustment kinds to leave out, plus 'speed' and 'hands' (every
 * hand layer); 'all' = the clip alone (speed 1, no hands, no adjustments). `autoGround`: a ground fit by the feet added
 * on top (library previews). `gearNodes: false`: no gear tracks (the export keys its own gear bones). */
export async function bakeSlot (c: Character, slot: Slot, ctx: BakeContext, o: { mirror?: boolean, skip?: BakeSkip, autoGround?: boolean, gearNodes?: boolean } = {}): Promise<BakedSlot> {
  const all = o.skip === 'all'
  const skip = new Set<string>(all ? ['speed', 'hands'] : o.skip ?? [])
  // (the slot as it plays here: its enabled adjustments, less those left out)
  const on = all ? [] : slot.adjustments.filter(a => a.enabled && !skip.has(a.kind))
  const played: Slot = { ...slot, adjustments: on }
  const report: Record<string, unknown> = {}

  const raw = await ctx.clips.get(slot.clip, { inPlace: slot.inPlace, mirror: o.mirror, fps: ctx.fps })
  let clip = skip.has('speed') ? raw : retime(raw, slot.speed)

  let cut: BakedSlot['cut']
  const blow = find(on, 'blowTiming')
  if (blow !== undefined) {
    const uncut = clip.duration
    const r = blowCut(ctx.posable, clip, blow)
    clip = r.clip
    cut = { start: r.kept[0], end: r.kept[1], uncut, blow: r.blow }
    report[blow.id] = { kind: 'blow', clip: slot.name, at: blow.at, window: blow.window, blowU: blow.blowU, blow: +r.blow.toFixed(3), kept: r.kept.map(x => +x.toFixed(3)), uncut: +uncut.toFixed(4) }
  }

  const pace = find(on, 'pace')
  if (pace !== undefined) {
    const like = slotById(c, pace.like)
    if (like === undefined || like.id === slot.id) report[pace.id] = { kind: 'pace', clip: slot.name, like: pace.like, missing: true }
    else {
      const r = paceTo(ctx.posable, clip, await timed(like, ctx, o.mirror))
      clip = r.clip
      report[pace.id] = { kind: 'pace', clip: slot.name, like: like.name, retimed: +r.factor.toFixed(3) }
    }
  }

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
  const keys = find(on, 'keys')
  clip = applyBoneKeys(clip, keys?.bones, slot.loop, boneRest(ctx.rest))
  const gearKeys = Object.fromEntries(Object.entries(keys?.gear ?? {}).filter(([, k]) => k.length > 0))
  if (keys !== undefined) report[keys.id] = { kind: 'keys', bones: counts(keys.bones), gear: counts(keys.gear) }

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

  return { clip: named(clip, slot.name), raw, unkeyed: named(unkeyed, slot.name), cut, lift, gearKeys, pulls: pullPlans(c, played), hands, report }
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
 * the horse's gait leading; an attack's horse stretched to his). His pull windows and gear keys are repeated over his
 * cycles (they stay phases of his clip); his hand layers keep the slot's (one cycle's) windows. `rest`: the rider's
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
  return {
    rider: {
      ...rider,
      clip: fit.rider,
      unkeyed: fitRide(unkeyed, hb, o.loop, o.attack).rider,
      pulls: cycles === 1 ? rider.pulls : rider.pulls.map(p => ({ ...p, windows: again(p.windows) })),
      gearKeys: cycles === 1 ? rider.gearKeys : Object.fromEntries(Object.entries(rider.gearKeys).map(([id, ks]) => [id, keysAgain(ks)])),
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

/** Another slot's clip as it plays (its speed and its blow timing), what a pace measures its stride on. */
async function timed (s: Slot, ctx: BakeContext, mirror?: boolean): Promise<THREE.AnimationClip> {
  const clip = retime(await ctx.clips.get(s.clip, { inPlace: s.inPlace, mirror, fps: ctx.fps }), s.speed)
  const blow = s.adjustments.find((a): a is Extract<Adjustment, { kind: 'blowTiming' }> => a.enabled && a.kind === 'blowTiming')
  return blow === undefined ? clip : blowCut(ctx.posable, clip, blow).clip
}

function named (clip: THREE.AnimationClip, name: string): THREE.AnimationClip {
  return clip.name === name ? clip : new THREE.AnimationClip(name, clip.duration, clip.tracks)
}

function counts (keys: Record<string, ClipKey[]> | undefined): Record<string, number> | undefined {
  const on = Object.entries(keys ?? {}).filter(([, k]) => k.length > 0)
  return on.length === 0 ? undefined : Object.fromEntries(on.map(([n, k]) => [n, k.length]))
}

