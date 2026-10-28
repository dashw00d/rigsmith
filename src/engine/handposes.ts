// Hand poses: a character's named finger poses (a fist round a shaft, a bow grip, a drawstring pinch), the Rig step's
// Hand poses tool; sockets close their hands into them (src/engine/scripts.ts handScripts).
//
// A pose keeps each finger joint's turn from rest in that joint's own frame, made from the finger itself at rest: along
// the joint's bone (y), off the back of the hand (z), and across (x). So it survives a re-rig that moves
// the joints (the frames are made again from where they now are), a curl is a turn about x and a spread about z, and the
// other hand takes it mirrored. It can be taken from any frame of any clip (the drawstring hand of a shot) or made by
// hand from rest.
import * as THREE from 'three'
import type { HandPose } from '../../server/workspace.ts'

export type { HandPose }
export type Side = 'Left' | 'Right'

export const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'] as const
export type Finger = typeof FINGERS[number]

interface JointRest {
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

/** Each joint's rest and its own frame, for one hand (null: no hand, or no fingers to make a palm from). */
export function handRest (rest: Map<string, { world: THREE.Matrix4, local: THREE.Quaternion }>, side: Side): Map<string, JointRest> | null {
  const at = (n: string): THREE.Vector3 | null => { const r = rest.get(n); return r === undefined ? null : new THREE.Vector3().setFromMatrixPosition(r.world) }
  const wrist = at(`${side}Hand`)
  const index = at(`${side}HandIndex1`); const little = at(`${side}HandPinky1`) ?? at(`${side}HandRing1`) ?? at(`${side}HandMiddle1`)
  const middle = at(`${side}HandMiddle1`) ?? index
  const thumb = at(`${side}HandThumb1`)
  if (wrist === null || index === null || middle === null || (little === null && thumb === null)) return null
  const forward = middle.clone().sub(wrist).normalize()
  // (across the knuckles, toward the thumb; a hand of index and thumb only takes it from the thumb)
  const across = little !== null ? index.clone().sub(little) : thumb!.clone().sub(index)
  if (across.lengthSq() < 1e-12) return null
  // (the back of the hand: the same side of either hand, so the two hands' frames mirror each other)
  const palm = forward.clone().cross(across).normalize().multiplyScalar(side === 'Left' ? -1 : 1)
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
  return { id: Math.random().toString(36).slice(2, 10), name, side, joints, ...(from === undefined ? {} : { from }) }
}

/** The local turns a pose gives a hand (mirrored if it was made on the other): what a fist script holds. */
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

// ---- curl and spread (the sliders) ----------------------------------------------------------------

// A joint's turn read as curl (about x, toward the palm: the whole circle, so a fist's knuckles read past 90), spread
// (about z, sideways) and a twist about its own bone (y), in that order: turn = curl · spread · twist.
const ORDER = 'XZY'

/** A joint's curl and spread, in degrees, from its turn. */
export function bendOf (q: [number, number, number, number] | undefined): { curl: number, spread: number } {
  const e = new THREE.Euler().setFromQuaternion(q === undefined ? new THREE.Quaternion() : new THREE.Quaternion(...q), ORDER)
  // (a finger closes turning back about x: curl reads that positive, a fist's joints from 0 up past 90)
  return { curl: -THREE.MathUtils.radToDeg(e.x), spread: THREE.MathUtils.radToDeg(e.z) }
}

/** A joint's turn with its curl or spread set to `degrees` (its other bend and its twist kept). */
export function setBend (q: [number, number, number, number] | undefined, what: 'curl' | 'spread', degrees: number): [number, number, number, number] {
  const e = new THREE.Euler().setFromQuaternion(q === undefined ? new THREE.Quaternion() : new THREE.Quaternion(...q), ORDER)
  if (what === 'curl') e.x = -THREE.MathUtils.degToRad(degrees); else e.z = THREE.MathUtils.degToRad(degrees)
  return new THREE.Quaternion().setFromEuler(e).normalize().toArray().map(v => Math.round(v * 1e6) / 1e6) as [number, number, number, number]
}

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
