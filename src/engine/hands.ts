// The one hand pose resolver: what each hand does at every moment of a slot's clip, and why. A hand's pose is a stack
// of layers, bottom to top:
//   carry  the gear it carries closes it round the carry handle (its pose; 'clip' adds no layer)
//   hold   hands.hold: posed in every clip, whatever it carries
//   pull   a pull handle it draws, posed while the slot holds it (the handle's pose, in its handleHold windows)
//   slot   the slot's own handPose adjustments (in their windows, else the whole clip)
// At a phase the topmost active layer wins, eased in over EASE of the clip before a window and let go over a third of
// that after it (src/engine/pulls.ts holdFactor). A layer turns the finger joints its pose has ('clip': every finger,
// back to the clip's own hand); joints a pose leaves out keep what is under it. Windows are phases of the clip after
// its timing (speed, blow timing, pace): the bake (src/engine/bake.ts) lays hands on after those.
import * as THREE from 'three'
import type { Adjustment, Character, HandPose, HandPoseRef, Side, Slot, Window } from '../model/types.ts'
import { carriedBy, carryHandle, DEFAULT_FIST, gearById, handSide } from '../model/select.ts'
import type { ClipSource } from './clips.ts'
import { handPose } from './handposes.ts'
import { frameTimes } from './keys.ts'
import { holdFactor } from './pulls.ts'
import { fistPose } from './timing.ts'

export { DEFAULT_FIST }

/** The fists offered in pickers: the best of a scan of the library's held-object clips (their fingers round a spear's
 * shaft), and the old default. Library clip id, name. */
export const FISTS: Array<[string, string]> = [['mixamo-Great_Sword_Crouching_6', 'Great sword'], ['mixamo-Golf_Post-Swing_2', 'Golf club'],
  ['mixamo-Holding_Turn_Right', 'Holding'], ['mixamo-Walk_With_Rifle_3', 'Rifle'], ['mixamo-2hand_Idle', '2hand idle']]

/** How far before a window a layer starts closing in (a phase of the clip). */
export const EASE = 0.06

export interface HandLayer {
  source: 'carry' | 'hold' | 'pull' | 'slot'
  ref: HandPoseRef
  /** Phases of the clip after its timing; unset: the whole clip. */
  windows?: Window[]
  /** In words: "carries GearAxe", "drawing GearBow · Draw", "held in every clip", "this slot: open". */
  reason: string
  gear?: string
  handle?: string
  adjustment?: string
}

type Turns = Map<string, THREE.Quaternion> | 'clip'

const SIDES = ['Left', 'Right'] as const

/** A pose reference in words: "default fist", "open", a hand pose's name, a fist clip's. */
export function refLabel (c: Character, ref: HandPoseRef, shared?: HandPose[]): string {
  if (ref === 'default') return 'default fist'
  if (ref === 'clip') return 'open'
  if ('pose' in ref) return [...c.hands.poses, ...(shared ?? [])].find(p => p.id === ref.pose)?.name ?? 'a hand pose'
  return FISTS.find(([id]) => id === ref.fist)?.[1] ?? ref.fist.replace(/^mixamo-/, '')
}

/** A hand's layers in `slot` (null: at rest, no slot playing), bottom to top. */
export function handLayers (c: Character, slot: Slot | null, side: Side): HandLayer[] {
  const layers: HandLayer[] = []
  const carried = carriedBy(c, side)
  const carry = carried === undefined ? undefined : carryHandle(carried)
  if (carried !== undefined && carry !== undefined && carry.pose !== 'clip') {
    layers.push({ source: 'carry', ref: carry.pose ?? 'default', reason: `carries ${carried.name}`, gear: carried.id, handle: carry.id })
  }
  const hold = c.hands.hold?.[side]
  if (hold !== undefined) layers.push({ source: 'hold', ref: hold, reason: 'held in every clip' })
  if (slot === null) return layers
  const on = slot.adjustments.filter(a => a.enabled)
  for (const g of c.gear) {
    // (a pull only exists on bone gear; the carry above is bone gear already, select.carriedBy)
    if (g.status !== 'ready' || g.hidden === true || g.attach.kind !== 'bone') continue
    for (const h of g.handles) {
      // (a pull without a pose leaves the hand as the layers below have it)
      if (h.kind !== 'pull' || h.pose === undefined || (h.hand ?? handSide(h.pull?.bone ?? '')) !== side) continue
      const held = on.find((a): a is Extract<Adjustment, { kind: 'handleHold' }> => a.kind === 'handleHold' && a.gear === g.id && a.handle === h.id)
      if (held === undefined || held.windows.length === 0) continue
      layers.push({ source: 'pull', ref: h.pose, windows: held.windows, reason: `drawing ${g.name} · ${h.name}`, gear: g.id, handle: h.id, adjustment: held.id })
    }
  }
  for (const a of on) {
    if (a.kind !== 'handPose' || a.hand !== side || a.windows?.length === 0) continue
    // (a pose that belongs to a carry handle: only while that gear is in this hand)
    if (a.gear !== undefined && carried?.id !== a.gear) continue
    layers.push({ source: 'slot', ref: a.pose, windows: a.windows, reason: `this slot: ${refLabel(c, a.pose)}`, gear: a.gear, adjustment: a.id })
  }
  return layers
}

/** The pose `side`'s hand takes on handle `handleId` of gear `gearId` when it holds it the whole clip (what the editor
 * closes the hand to round it), in the order the layers stack (types.ts Handle.pose, HandsSection.hold): the slot's own
 * handPose for that hand over the whole clip (no windows; one that belongs to a carry handle only while that gear is in
 * this hand), then a grip handle's pose when set, then hands.hold[side], then a carry handle's pose when set (a hold
 * wins over a carry, as it does when the clip plays), then the default fist. 'clip' (the clip's own hand) is returned
 * like any other answer. `slot` null: at rest. */
export function handleRef (c: Character, slot: Slot | null, side: Side, gearId: string, handleId: string): HandPoseRef {
  const carried = carriedBy(c, side)
  const whole = slot?.adjustments.findLast((a): a is Extract<Adjustment, { kind: 'handPose' }> => a.enabled && a.kind === 'handPose' &&
    a.hand === side && a.windows === undefined && (a.gear === undefined || carried?.id === a.gear))
  if (whole !== undefined) return whole.pose
  const handle = gearById(c, gearId)?.handles.find(h => h.id === handleId)
  if (handle?.kind === 'grip' && handle.pose !== undefined) return handle.pose
  const hold = c.hands.hold?.[side]
  if (hold !== undefined) return hold
  if (handle?.kind === 'carry' && handle.pose !== undefined) return handle.pose
  return 'default'
}

/** The layer that wins at phase `u` (the topmost active one) and how far it is in (0..1). */
export function handAt (layers: HandLayer[], u: number): { layer: HandLayer | null, weight: number } {
  for (let i = layers.length - 1; i >= 0; i--) {
    const weight = weightAt(layers[i], u)
    if (weight > 0) return { layer: layers[i], weight }
  }
  return { layer: null, weight: 0 }
}

/** The local turns `ref` gives `side`'s fingers on `root` (a posable copy of the character; left as it was), or 'clip'
 * (the clip's own hand). A fist is the most closed moment of its clip; a hand pose missing from the character and the
 * shared ones falls back to the default fist. */
export async function poseOfRef (root: THREE.Object3D, side: Side, ref: HandPoseRef, c: Character, clips: ClipSource, shared?: HandPose[]): Promise<Turns> {
  if (ref === 'clip') return 'clip'
  if (typeof ref === 'object' && 'pose' in ref) {
    const pose = c.hands.poses.find(p => p.id === ref.pose) ?? shared?.find(p => p.id === ref.pose)
    if (pose !== undefined) return handPose(root, side, pose)
  }
  const id = typeof ref === 'object' && 'fist' in ref ? ref.fist : DEFAULT_FIST
  return fistPose(root, await clips.get({ id }, { inPlace: true }), side).pose
}

/** `clip` with both hands laid as their layers in `slot` say. `root`: a posable copy of the character. */
export async function applyHands (root: THREE.Object3D, clip: THREE.AnimationClip, c: Character, slot: Slot | null, clips: ClipSource,
  shared?: HandPose[]): Promise<{ clip: THREE.AnimationClip, report: Record<string, unknown> }> {
  let out = clip
  const report: Record<string, unknown> = {}
  for (const side of SIDES) {
    const layers = handLayers(c, slot, side)
    if (layers.length === 0) continue
    // (a fist is measured once a side, however many layers use it)
    const known = new Map<string, Turns>()
    const turns: Turns[] = []
    for (const l of layers) {
      const key = JSON.stringify(l.ref)
      let t = known.get(key)
      if (t === undefined) { t = await poseOfRef(root, side, l.ref, c, clips, shared); known.set(key, t) }
      turns.push(t)
    }
    out = layHand(out, layers, turns)
    report[side] = layers.map(l => ({ source: l.source, reason: l.reason, ...(l.windows === undefined ? {} : { windows: l.windows }) }))
  }
  return { clip: out, report }
}

// ---- inside ---------------------------------------------------------------------------------------------------------

function weightAt (layer: HandLayer, u: number): number {
  return layer.windows === undefined ? 1 : holdFactor(layer.windows, u, EASE)
}

/** `clip` with one hand's fingers laid in `layers` (bottom to top; `turns[i]` what layer i gives). A finger whose
 * layers all span the whole clip is held still in the top one (or keeps its own track under a top 'clip'); otherwise it
 * is baked frame by frame: from the clip's own turn, each layer over it as far as it is in. A finger the clip doesn't
 * move takes the first pose laid on it as it is (there is no own hand to ease back to). */
function layHand (clip: THREE.AnimationClip, layers: HandLayer[], turns: Turns[]): THREE.AnimationClip {
  const bones = new Set<string>()
  for (const t of turns) if (t !== 'clip') for (const n of t.keys()) bones.add(n)
  if (bones.size === 0) return clip
  const own = new Map(clip.tracks.map(t => [t.name, t]))
  const tracks = clip.tracks.filter(t => !bones.has(t.name.replace(/\.quaternion$/, '')))
  const times = frameTimes(clip.duration)
  for (const bone of bones) {
    const name = `${bone}.quaternion`
    const track = own.get(name)
    // (the layers that turn this finger, with its turn in each: null for 'clip')
    const mine: Array<{ layer: HandLayer, q: THREE.Quaternion | null }> = []
    layers.forEach((layer, i) => {
      const t = turns[i]
      if (t === 'clip') mine.push({ layer, q: null })
      else if (t.has(bone)) mine.push({ layer, q: t.get(bone)! })
    })
    if (mine.every(x => x.layer.windows === undefined)) {
      const top = [...mine].reverse().find(x => x.q !== null || track !== undefined)!
      if (top.q === null) tracks.push(track!)
      else tracks.push(new THREE.QuaternionKeyframeTrack(name, [0, clip.duration], [...top.q.toArray(), ...top.q.toArray()]))
      continue
    }
    const at = track === undefined ? null : (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    const raw = new THREE.Quaternion()
    const values: number[] = []
    for (const t of times) {
      const u = clip.duration > 0 ? t / clip.duration : 0
      if (at !== null) raw.fromArray(at.evaluate(t) as unknown as number[])
      let v = at === null ? null : raw.clone()
      for (const { layer, q } of mine) {
        const target = q ?? (at === null ? null : raw)
        if (target === null) continue
        if (v === null) { v = target.clone(); continue }
        const w = weightAt(layer, u)
        if (w > 0) v.slerp(target, w)
      }
      values.push(...v!.toArray())
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(name, times, values))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}
