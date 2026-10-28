// Hand poses: a character's named finger poses (a fist round a shaft, a bow grip, a drawstring pinch), made in the Hands
// panel (src/app/hands); carry and pull handles, a slot's handPose adjustments and hands.hold close a hand into them
// (src/engine/hands.ts, the one resolver).
//
// A pose keeps each finger joint's turn from rest in that joint's own frame, made from the finger itself at rest: along
// the joint's bone (y), off the back of the hand (z), and across (x). So it survives a re-rig that moves
// the joints (the frames are made again from where they now are), a curl is a turn about x and a spread about z, and the
// other hand takes it mirrored. It can be taken from any frame of any clip (the drawstring hand of a shot) or made by
// hand from rest.
import * as THREE from 'three'
import { newId } from '../model/ids.ts'
import type { HandPose, Side } from '../model/types.ts'

export type { HandPose, Side }

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const
export type Finger = typeof FINGERS[number]

export interface JointRest {
  /** the bone's local turn at rest */
  local: THREE.Quaternion
  /** its world turn at rest */
  world: THREE.Quaternion
  /** its own frame at rest (world): x across, y along the bone, z off the back of the hand */
  frame: THREE.Quaternion
}

/** The bones a hand's pose turns: `<Side>Hand<Finger><1..3>` (a finger's tip, 4, is never turned). */
export function handJoints (side: Side, has: (name: string) => boolean): string[] {
  return FINGERS.flatMap(f => [1, 2, 3].map(i => `${side}Hand${f}${i}`)).filter(has)
}

/** The rest pose of a character's bones, from its skin's bind (whatever pose it stands in now): world and local turns,
 * and world positions. */
export function bindRest (root: THREE.Object3D): Map<string, { world: THREE.Matrix4, local: THREE.Quaternion }> {
  const out = new Map<string, { world: THREE.Matrix4, local: THREE.Quaternion }>()
  let skeleton: THREE.Skeleton | null = null
  root.traverse(o => { if (skeleton === null && (o as THREE.SkinnedMesh).isSkinnedMesh) skeleton = (o as THREE.SkinnedMesh).skeleton })
  if (skeleton === null) return out
  const sk = skeleton as THREE.Skeleton
  const world = new Map<THREE.Bone, THREE.Matrix4>()
  sk.bones.forEach((b, i) => world.set(b, new THREE.Matrix4().copy(sk.boneInverses[i]).invert()))
  for (const [b, w] of world) {
    const parent = world.get(b.parent as THREE.Bone)
    const local = parent === undefined ? new THREE.Matrix4().copy(w) : parent.clone().invert().multiply(w)
    const q = new THREE.Quaternion(); local.decompose(new THREE.Vector3(), q, new THREE.Vector3())
    out.set(b.name, { world: w, local: q })
  }
  return out
}

/** A hand's frame, from where its joints are. Unit vectors: `forward` from the wrist to the middle finger's knuckle (the
 * index's without one), `across` the knuckles toward the thumb's side, and `back`, the way the back of the hand faces
 * (the same side of either hand, so the two hands' frames mirror each other). */
export interface HandFrame { wrist: THREE.Vector3, forward: THREE.Vector3, across: THREE.Vector3, back: THREE.Vector3 }

/** `side`'s hand frame from its joints (`at`: a joint's position, in any one space: rest, world, the skeleton's joints);
 * null without a wrist, an index knuckle, and a little finger's or a thumb's knuckle to measure across by. */
export function handFrame (at: (joint: string) => THREE.Vector3 | null, side: Side): HandFrame | null {
  const wrist = at(`${side}Hand`)
  const index = at(`${side}HandIndex1`); const little = at(`${side}HandPinky1`) ?? at(`${side}HandRing1`) ?? at(`${side}HandMiddle1`)
  const middle = at(`${side}HandMiddle1`) ?? index
  const thumb = at(`${side}HandThumb1`)
  if (wrist === null || index === null || middle === null || (little === null && thumb === null)) return null
  const forward = middle.clone().sub(wrist).normalize()
  // (across the knuckles, toward the thumb; a hand of index and thumb only takes it from the thumb)
  const across = little !== null ? index.clone().sub(little) : thumb!.clone().sub(index)
  if (across.lengthSq() < 1e-12) return null
  const back = forward.clone().cross(across).normalize().multiplyScalar(side === 'Left' ? -1 : 1)
  return { wrist, forward, across: across.normalize(), back }
}

/** Each joint's rest and its own frame, for one hand (null: no hand, or no fingers to make a palm from). */
export function handRest (rest: Map<string, { world: THREE.Matrix4, local: THREE.Quaternion }>, side: Side): Map<string, JointRest> | null {
  const at = (n: string): THREE.Vector3 | null => { const r = rest.get(n); return r === undefined ? null : new THREE.Vector3().setFromMatrixPosition(r.world) }
  const hand = handFrame(at, side)
  if (hand === null) return null
  const { forward, across, back: palm } = hand
  const out = new Map<string, JointRest>()
  for (const name of handJoints(side, n => rest.has(n))) {
    const r = rest.get(name)!
    const here = new THREE.Vector3().setFromMatrixPosition(r.world)
    const next = at(name.replace(/\d$/, d => String(Number(d) + 1)))
    const y = (next === null || next.distanceToSquared(here) < 1e-12 ? forward.clone() : next.clone().sub(here)).normalize()
    const z = palm.clone().addScaledVector(y, -palm.dot(y))
    if (z.lengthSq() < 1e-9) z.copy(across).addScaledVector(y, -across.dot(y))
    z.normalize()
    const x = y.clone().cross(z).normalize()
    const frame = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
    const world = new THREE.Quaternion(); r.world.decompose(new THREE.Vector3(), world, new THREE.Vector3())
    out.set(name, { local: r.local.clone(), world, frame })
  }
  return out
}

/** A turn mirrored onto the other hand (its frames are the mirror of this one's across x). */
export const mirrorTurn = (q: THREE.Quaternion): THREE.Quaternion => new THREE.Quaternion(q.x, -q.y, -q.z, q.w)

const key = (name: string): string => name.replace(/^(Left|Right)Hand/, '')

/** A hand's fingers as they stand now (their local turns), kept as a pose (`side`: the hand they are on). */
export function poseFrom (rest: Map<string, JointRest>, side: Side, locals: Map<string, THREE.Quaternion>, name: string, from?: HandPose['from']): HandPose {
  const joints: HandPose['joints'] = {}
  for (const [bone, r] of rest) {
    const now = locals.get(bone)
    if (now === undefined) continue
    // the local turn from rest, as a world turn at rest, in the joint's own frame
    const d = r.local.clone().invert().multiply(now)
    const dw = r.world.clone().multiply(d).multiply(r.world.clone().invert())
    const df = r.frame.clone().invert().multiply(dw).multiply(r.frame).normalize()
    joints[key(bone)] = df.toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number]
  }
  return { id: newId(), name, side, joints, ...(from === undefined ? {} : { from }) }
}

/** The local turns a pose gives a hand (mirrored if it was made on the other): what a hand layer holds. */
export function poseLocals (rest: Map<string, JointRest>, side: Side, pose: HandPose): Map<string, THREE.Quaternion> {
  const out = new Map<string, THREE.Quaternion>()
  for (const [bone, r] of rest) {
    const j = pose.joints[key(bone)]
    if (j === undefined) continue
    let df = new THREE.Quaternion(...j)
    if (pose.side !== side) df = mirrorTurn(df)
    const dw = r.frame.clone().multiply(df).multiply(r.frame.clone().invert())
    const d = r.world.clone().invert().multiply(dw).multiply(r.world)
    out.set(bone, r.local.clone().multiply(d).normalize())
  }
  return out
}

/** A posed character's hand, as a pose (the clip playing on it, at the frame shown). */
export function capturePose (root: THREE.Object3D, side: Side, name: string, from?: HandPose['from']): HandPose | null {
  const rest = handRest(bindRest(root), side)
  if (rest === null) return null
  const locals = new Map<string, THREE.Quaternion>()
  root.traverse(o => { if (rest.has(o.name)) locals.set(o.name, (o as THREE.Bone).quaternion.clone()) })
  return poseFrom(rest, side, locals, name, from)
}

/** The local turns `pose` gives `side`'s fingers on `root` (its bind as rest); empty without a hand. */
export function handPose (root: THREE.Object3D, side: Side, pose: HandPose): Map<string, THREE.Quaternion> {
  const rest = handRest(bindRest(root), side)
  return rest === null ? new Map() : poseLocals(rest, side, pose)
}

/** `side`'s hand as `clip` (retargeted onto `root`) has it at `time`, kept as a pose. A finger joint the clip doesn't
 * turn is taken as it is at rest. Null without a hand. `root` itself isn't posed. */
export function poseAt (root: THREE.Object3D, side: Side, clip: THREE.AnimationClip, time: number, name: string, from?: HandPose['from']): HandPose | null {
  const rest = handRest(bindRest(root), side)
  if (rest === null) return null
  const tracks = new Map(clip.tracks.map(t => [t.name, t]))
  const locals = new Map<string, THREE.Quaternion>()
  for (const [bone, r] of rest) {
    const track = tracks.get(`${bone}.quaternion`)
    if (track === undefined) { locals.set(bone, r.local.clone()); continue }
    const at = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    locals.set(bone, new THREE.Quaternion().fromArray(at.evaluate(time) as unknown as number[]).normalize())
  }
  return poseFrom(rest, side, locals, name, from)
}

/** A one-second clip holding `side`'s fingers in `pose` (on `root`, its bind as rest), the rest of the body untouched:
 * how a pose is shown on the character. */
export function poseClip (root: THREE.Object3D, side: Side, pose: HandPose, name = `Hand pose: ${pose.name}`): THREE.AnimationClip {
  const tracks = [...handPose(root, side, pose)].map(([bone, q]) =>
    new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, [0, 1], [...q.toArray(), ...q.toArray()]))
  return new THREE.AnimationClip(name, 1, tracks)
}

/** `pose` with one joint of `side`'s hand turned to `local` (a ring dragged on that hand): made over as a pose on that
 * hand. Joints the pose leaves out stay out. */
export function withJoint (rest: Map<string, JointRest>, side: Side, pose: HandPose, bone: string, local: THREE.Quaternion): HandPose {
  const locals = poseLocals(rest, side, pose)
  locals.set(bone, local)
  return { ...pose, side, joints: poseFrom(rest, side, locals, pose.name).joints }
}

/** What holds a joint within reach: src/engine/limits.ts JointLimits (a person's fingers, measured on motion captures). */
export interface Reach {
  has: (bone: string) => boolean
  clamp: (bone: string, local: THREE.Quaternion) => THREE.Quaternion
}

/** `pose` with each joint it turns put back within `reach`, on the hand it was made on (`rest`: that hand's). The joints
 * it leaves out stay out. */
export function withinReach (rest: Map<string, JointRest>, pose: HandPose, reach: Reach): HandPose {
  const locals = poseLocals(rest, pose.side, pose)
  for (const [bone, q] of locals) if (reach.has(bone)) locals.set(bone, reach.clamp(bone, q))
  const held = poseFrom(rest, pose.side, locals, pose.name).joints
  return { ...pose, joints: Object.fromEntries(Object.entries(pose.joints).map(([k, q]) => [k, held[k] ?? q])) }
}

// ---- the sliders ----------------------------------------------------------------------------------

/** A finger's joints (`<Finger><1..3>`) blended from straight (0) toward `ref`'s (1; past 1, further the same way):
 * how a hand closes, its joints together as the reference closes them. */
export function closeFinger (pose: HandPose, ref: HandPose, finger: Finger, t: number): HandPose {
  const joints = { ...pose.joints }
  for (const i of [1, 2, 3]) {
    const k = `${finger}${i}`
    const r = ref.joints[k]
    if (r === undefined) continue
    let q = new THREE.Quaternion(...r)
    if (ref.side !== pose.side) q = mirrorTurn(q)
    // (slerp from straight past the reference goes on turning the same way)
    const out = t <= 1 ? new THREE.Quaternion().slerp(q, t) : new THREE.Quaternion().slerp(q, 1).multiply(new THREE.Quaternion().slerp(q, t - 1))
    joints[k] = out.normalize().toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number]
  }
  return { ...pose, joints }
}

/** How far a finger is closed, against the reference (0 straight, 1 as closed as it): its joints' curl over the
 * reference's. */
export function closedness (pose: HandPose, ref: HandPose, finger: Finger): number {
  let mine = 0; let theirs = 0
  for (const i of [1, 2, 3]) {
    const r = ref.joints[`${finger}${i}`]
    if (r === undefined) continue
    theirs += Math.abs(new THREE.Quaternion(...r).angleTo(new THREE.Quaternion()))
    const m = pose.joints[`${finger}${i}`]
    if (m !== undefined) mine += Math.abs(new THREE.Quaternion(...m).angleTo(new THREE.Quaternion()))
  }
  return theirs > 1e-6 ? mine / theirs : 0
}
