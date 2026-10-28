// The animation editor's clip (src/state/clipedit.svelte.ts): a base clip as it plays on the character, the keys made
// on it (turns on bones, and the hips' moves, at moments of the clip: src/engine/keys.ts, tweened smoothly), and the
// floor: a foot the edit put under the ground lifted back (only what the edit sank: the base plays as it was). Gear
// (bone-attached pieces, by gear id) can lead: the hands on its handles follow its path and the body the hands. Saving
// takes the edited clip back onto the base's own skeleton (the retarget undone: Qsource = Qcharacter * K^-1), for the
// library, and puts it in the slot it was made on with the slot's adjustments sorted by kind (saveToSlotCommands).
// The body follows the hands with the natural-pose solver (src/engine/posespace.ts createBodySolver) where there is a
// pose model (a person); without one (a creature, or the model not loaded) the hands reach their handles by IK alone.
import * as THREE from 'three'
import type { Command } from '../model/command-types.ts'
import type { Adjustment, Character, ClipKey, ClipRef, Handle, HandPoseRef, Quat, Side, Slot, Vec3, Window } from '../model/types.ts'
import { applyBoneKeys, frameTimes, KEY_FPS, sampleKeys } from './keys.ts'
import { keepOffFloor, reach, setWorldQuaternion, type Leg, type NameOf } from './ik.ts'
import { bodyBones, FOLLOW, knuckleGrip, type BodySolveOptions, type BodySolver, type BodyState, type HandGoal, type NaturalGoal, type SeedPose } from './posespace.ts'
import { shaftObstacles, type Obstacle } from './bodycollide.ts'
import { principalAxis } from './geom.ts'
import { handleRef } from './hands.ts'
import type { JointLimits } from './limits.ts'
import { pelvisName, retargetOffsets, type RestSkeleton } from './retarget.ts'
import type { PoseRig } from './PoseEditor.ts'

/** A track's value at time `t`, or `fallback` where the clip has none. */
export function trackAt (clip: THREE.AnimationClip, name: string, t: number, fallback: number[]): number[] {
  const track = clip.tracks.find(x => x.name === name)
  if (track === undefined) return fallback
  const i = (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
  return Array.from(i.evaluate(Math.min(Math.max(t, 0), clip.duration)) as ArrayLike<number>).slice(0, fallback.length)
}

/** The key that turns (and for the hips moves) a bone from where `base` has it at `t` to where it is now. */
export function keyFor (base: THREE.AnimationClip, bone: THREE.Bone, u: number, t: number, rest: { q: THREE.Quaternion, p: THREE.Vector3 }, moves: boolean): ClipKey {
  const q0 = new THREE.Quaternion().fromArray(trackAt(base, `${bone.name}.quaternion`, t, rest.q.toArray()))
  const q = q0.invert().multiply(bone.quaternion).normalize()
  const key: ClipKey = { u, q: q.toArray().map(v => Math.round(v * 1e6) / 1e6) as ClipKey['q'] }
  if (moves) {
    const p0 = new THREE.Vector3().fromArray(trackAt(base, `${bone.name}.position`, t, rest.p.toArray()))
    const p = bone.position.clone().sub(p0)
    if (p.length() > 1e-6) key.p = p.toArray().map(v => Math.round(v * 1e6) / 1e6) as ClipKey['p']
  }
  return key
}

export { frameTimes }

/** The bones under `root`, by name. */
export function bonesOf (root: THREE.Object3D): Map<string, THREE.Bone> {
  const out = new Map<string, THREE.Bone>()
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) out.set(o.name, o as THREE.Bone) })
  return out
}

/** Every bone's local turn and place in `clip` at time `t` on `posable` (by name). Leaves the bones as they were. */
export function bonePoseAt (clip: THREE.AnimationClip, posable: THREE.Object3D, t: number): Map<string, { q: THREE.Quaternion, p: THREE.Vector3 }> {
  const bones = bonesOf(posable)
  const saved = [...bones.values()].map(b => [b, b.position.clone(), b.quaternion.clone()] as const)
  const mixer = new THREE.AnimationMixer(posable)
  const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.play()
  mixer.setTime(Math.min(Math.max(t, 0), clip.duration))
  const out = new Map([...bones].map(([n, b]) => [n, { q: b.quaternion.clone(), p: b.position.clone() }]))
  mixer.stopAllAction(); mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  return out
}

export function legsOf (bones: Map<string, THREE.Bone>, rig: PoseRig): Leg[] {
  const b = (n: string | null): THREE.Bone | null => (n === null ? null : bones.get(n) ?? null)
  return rig.legs.filter(l => b(l.upper) !== null && b(l.lower) !== null && b(l.end) !== null)
    .map(l => ({ upper: b(l.upper)!, lower: b(l.lower)!, end: b(l.end)!, ball: b(l.ball), tip: b(l.tip) }))
}

/** How far under the floor each leg's soles go (0 above it), as `root` stands. */
function sunk (legs: Leg[], soles: number[][], floor: number): number[] {
  const v = new THREE.Vector3()
  return legs.map((l, i) => Math.max(0, ...[l.end, l.ball, l.tip].map((b, k) => (b === null || !Number.isFinite(soles[i][k]) ? 0 : floor + soles[i][k] - b.getWorldPosition(v).y))))
}

/** A handle a hand holds a piece of gear by, placed: where the wrist goes and how the hand is turned, in the gear's
 * placed frame (its `_place` node's). A grip handle, or the carry handle: where the editor placed it, else where the
 * gear's placement puts the hand (carrierGrip). `exact`: the hand is held there exactly, no give or slide. */
export type PlacedHandle = Pick<Handle, 'id' | 'name' | 'exact'> & { place: NonNullable<Handle['place']> }

/** A hand on a handle through the clip (the edit's). */
export interface Attachment { hand: Side, gear: string, handle: string }

/** Where the carrying hand holds a piece whose carry handle isn't placed: from the gear's placement on its bone and the
 * hand's rest frame (the hand holds it where the placement puts it), in the gear's placed frame. */
export function carrierGrip (placement: THREE.Matrix4, handRest: THREE.Matrix4): NonNullable<Handle['place']> {
  const local = placement.clone().invert().multiply(handRest)
  const at = new THREE.Vector3(); const turn = new THREE.Quaternion()
  local.decompose(at, turn, new THREE.Vector3())
  return { position: at.toArray(), rotation: turn.toArray() }
}

/** A gear piece's path through the clip: locked, it leads (the hands on it follow it, the body follows the hands), its
 * keys moves and turns from where it rode in the clip (in the world, about its own origin). Not locked, its keys move it
 * in the hand: moves and turns in its own placed frame from where its bone holds it (whatever holds it stays). */
export interface GearPath { locked: boolean, keys: ClipKey[] }

/** What the gear does in an edit (everything by gear id): its paths, the hands on its handles, the handles, fingers. */
export interface GearRig {
  /** By gear id: its node in the posed copy is found by this name (geom.ts gearNode). */
  node: (gear: string) => string
  paths: Record<string, GearPath>
  attachments: Attachment[]
  /** By gear id: its placed handles (an attachment names one of these). */
  handles: Record<string, PlacedHandle[]>
  /** The bone each piece rides. */
  carriers: Record<string, string>
  fingers: Partial<Record<Side, Record<string, Quat>>>
  /** By leading piece: its shaft (the end by the hand carrying it and the far end, in its node's frame) and its radius:
   * the body is kept clear of it, but where the hands hold it (gearObstacles). */
  shafts?: Record<string, { from: Vec3, to: Vec3, radius: number, /** how near two hands' holds may come along it (metres) */ gap?: number, /** the most a hand slides on it either way (metres) */ most?: number }>
  /** By gear id: its node's place on its bone as Gear places it (local position, turn). A leading piece's node is keyed
   * in the edit to where its path puts it, whatever hand holds it how; a copy posed from an edit is put back to this first. */
  rest?: Record<string, { position: Vec3, quaternion: Quat }>
  /** By hand: where it holds the shaft it is on (Grip; the carrying hand has none: its turn is held exactly). The solver
   * keeps this point on the shaft while the hand's turn gives. */
  grips?: Partial<Record<Side, Grip>>
  /** The gear drags let go (RootHold): the body's root held near where it was seen, on the frames each one moved it. */
  holds?: RootHold[]
}

/**
 * A gear drag let go at `u` (a key on `gear`'s path): on each frame the drag moved it (by frame index, frameTimes), how
 * much of the drag that frame carries (`w`, 0 to 1: the piece's move there over its move at the key), and the solve's
 * correction to the body's root there before the drag (world: the hips' move, the chest's turn, from the keyed pose). The
 * build holds the root to that correction softly, in proportion, so moving the piece away extends the arms instead of
 * bringing the body in; local in time, as the drag is, and never keyed.
 */
export interface RootHold {
  gear: string
  u: number
  frames: Record<number, { w: number, hips: Vec3, chest: Quat }>
}

/** A root hold: its weight at full (a soft goal's: as a keyed bone's in Naturalize), the chest bone it holds the turn of,
 * and the least share of the drag a frame must carry to be held. */
export const ROOT_HOLD = { weight: 4, chest: 'Spine2', min: 0.05 }

/** The soft goals that hold the body's root on frame `i` (posed in its keyed pose): the strongest hold there, if any, its
 * piece's path still keyed at its drag. */
export function rootGoals (holds: RootHold[] | undefined, paths: Record<string, GearPath>, i: number, bones: Map<string, THREE.Bone>, hips: string): NaturalGoal[] {
  const best = holdAt(holds, paths, i)
  const hb = bones.get(hips); const chest = bones.get(ROOT_HOLD.chest)
  if (best === null || hb === undefined || chest === undefined) return []
  const weight = ROOT_HOLD.weight * Math.min(1, best.w)
  return [
    { bone: hips, position: hb.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...best.hips)), weight, hard: false },
    { bone: ROOT_HOLD.chest, turn: new THREE.Quaternion(...best.chest).multiply(chest.getWorldQuaternion(new THREE.Quaternion())).normalize(), weight, hard: false },
  ]
}

/** The strongest root hold on frame `i` whose piece's path is still keyed at its drag, or null. */
export function holdAt (holds: RootHold[] | undefined, paths: Record<string, GearPath>, i: number): RootHold['frames'][number] | null {
  let best: RootHold['frames'][number] | null = null
  for (const h of holds ?? []) {
    const f = h.frames[i]
    if (f === undefined || f.w < ROOT_HOLD.min || !(paths[h.gear]?.locked === true && paths[h.gear].keys.some(k => Math.abs(k.u - h.u) < 1e-4))) continue
    if (best === null || f.w > best.w) best = f
  }
  return best
}

/** Per frame (frameTimes) of `clip` on `posable`: the hips' world place and the chest's world turn. Leaves the bones as they were. */
export function rootPath (clip: THREE.AnimationClip, posable: THREE.Object3D, hips: string): Array<{ hips: THREE.Vector3, chest: THREE.Quaternion }> {
  const bones = bonesOf(posable)
  const hb = bones.get(hips); const chest = bones.get(ROOT_HOLD.chest)
  if (hb === undefined || chest === undefined) return []
  const saved = [...bones.values()].map(b => [b, b.position.clone(), b.quaternion.clone()] as const)
  const mixer = new THREE.AnimationMixer(posable)
  const out: Array<{ hips: THREE.Vector3, chest: THREE.Quaternion }> = []
  for (const t of frameTimes(clip.duration)) {
    mixer.stopAllAction()
    const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.reset(); a.play()
    mixer.setTime(t)
    posable.updateMatrixWorld(true)
    out.push({ hips: hb.getWorldPosition(new THREE.Vector3()), chest: chest.getWorldQuaternion(new THREE.Quaternion()) })
  }
  mixer.stopAllAction(); mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  return out
}

/** Per frame (frameTimes) of `clip` on `posable`: where the node `node` is (world). */
export function nodePath (clip: THREE.AnimationClip, posable: THREE.Object3D, node: string): THREE.Matrix4[] {
  const n = posable.getObjectByName(node)
  if (n === undefined) return []
  const saved: Array<readonly [THREE.Object3D, THREE.Vector3, THREE.Quaternion]> = []
  posable.traverse(o => { if ((o as THREE.Bone).isBone === true) saved.push([o, o.position.clone(), o.quaternion.clone()]) })
  const mixer = new THREE.AnimationMixer(posable)
  const out: THREE.Matrix4[] = []
  for (const t of frameTimes(clip.duration)) {
    mixer.stopAllAction()
    const a = mixer.clipAction(clip); a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; a.reset(); a.play()
    mixer.setTime(t)
    posable.updateMatrixWorld(true)
    out.push(n.matrixWorld.clone())
  }
  mixer.stopAllAction(); mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  return out
}

/** How much of a shaft's near end, and of its far end (a spear's head), no hand slides onto (shares of its length). */
const SHAFT_END = 0.03
const SHAFT_HEAD = 0.15

/** How much of a shaft either side of a fist on it is left out of what the body must stay clear of (a share of the
 * body's height: the fist, the wrist and the forearm by it). */
export const GRIP_CLEAR = 0.07

/**
 * What the body must stay clear of on a frame: each leading piece's shaft (where `placeOf` puts it), cut where each
 * hand holds it (`margin` metres either side of its fist), the hands holding it let through.
 */
export function gearObstacles (rig: GearRig, placeOf: (gear: string) => THREE.Matrix4 | null, margin: number): Obstacle[] {
  const out: Obstacle[] = []
  for (const [gear, path] of Object.entries(rig.paths)) {
    const shaft = rig.shafts?.[gear]
    if (!path.locked || shaft === undefined) continue
    const place = placeOf(gear)
    if (place === null) continue
    const from = new THREE.Vector3(...shaft.from).applyMatrix4(place); const to = new THREE.Vector3(...shaft.to).applyMatrix4(place)
    const dir = to.clone().sub(from).normalize()
    const holding = rig.attachments.filter(a => a.gear === gear)
    const hands = [...new Set([...holding.map(a => `${a.hand}Hand`), rig.carriers[gear]].filter((h): h is string => h !== undefined && /^(Left|Right)Hand$/.test(h)))]
    // (where each hand holds it, along it: the wrist's place on the shaft's line; the collider cuts the shaft there)
    const holds = holding.map(a => rig.handles[gear]?.find(x => x.id === a.handle)).filter((x): x is PlacedHandle => x !== undefined)
      .map(h => handOn(place, h).at.sub(from).dot(dir))
    out.push(...shaftObstacles(from, to, shaft.radius, holds, margin, hands))
  }
  return out
}

/** A matrix from a handle's place (its wrist place and turn). */
export function handleMatrix (h: Pick<PlacedHandle, 'place'>): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(...h.place.position), new THREE.Quaternion(...h.place.rotation), new THREE.Vector3(1, 1, 1))
}

/** Where a hand on `handle` of a piece placed at `gear` (world) goes: its wrist and turn. */
export function handOn (gear: THREE.Matrix4, handle: Pick<PlacedHandle, 'place'>): { at: THREE.Vector3, turn: THREE.Quaternion } {
  const m = gear.clone().multiply(handleMatrix(handle))
  const at = new THREE.Vector3(); const turn = new THREE.Quaternion(); const scale = new THREE.Vector3()
  m.decompose(at, turn, scale)
  return { at, turn }
}

/** Measure the actual wrists against their handles after baking, including movement of the carrying hand and gear. */
export function handleMisses (clip: THREE.AnimationClip, root: THREE.Object3D, rig: GearRig): number[] {
  const bones = bonesOf(root)
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
  const out: number[] = []
  for (const t of frameTimes(clip.duration)) {
    mixer.setTime(t); root.updateMatrixWorld(true)
    let miss = 0
    for (const a of rig.attachments) {
      const hand = bones.get(`${a.hand}Hand`); const node = root.getObjectByName(rig.node(a.gear))
      const handle = rig.handles[a.gear]?.find(s => s.id === a.handle)
      if (hand === undefined || node === undefined || handle === undefined) continue
      miss = Math.max(miss, hand.getWorldPosition(new THREE.Vector3()).distanceTo(handOn(node.matrixWorld, handle).at))
    }
    out.push(miss)
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  root.updateMatrixWorld(true)
  return out
}

/** A piece's world place on its path at phase `u`: where it rode (`base`), then its keys' move and turn. */
export function onPath (base: THREE.Matrix4, path: GearPath, u: number, loop: boolean): THREE.Matrix4 {
  if (path.keys.length === 0) return base.clone()
  const { q, p } = sampleKeys(path.keys, u, loop)
  const at = new THREE.Vector3(); const turn = new THREE.Quaternion(); const scale = new THREE.Vector3()
  base.decompose(at, turn, scale)
  return new THREE.Matrix4().compose(at.add(p), q.multiply(turn), scale)
}

/**
 * A hand's grip, from its knuckles at rest, in the hand's own frame: the line a shaft takes through the fist (across
 * the knuckles from the little finger's to the index's, leaning 25 degrees towards the heel of the hand: out of the
 * thumb's side), and the fist's middle (by the knuckles, a little into the palm). Null for a hand without fingers.
 */
export function handGrip (rest: RestSkeleton, hand: Side): { axis: THREE.Vector3, fist: THREE.Vector3 } | null {
  const wrist = rest.bones.get(`${hand}Hand`)
  if (wrist === undefined) return null
  return knuckleGrip(n => rest.bones.get(n)?.worldPosition ?? null, hand, { position: wrist.worldPosition, turn: wrist.worldQuaternion })
}

/** A hand's grip: the line a shaft runs along (`axis`) and the point on it that the hand holds (`fist`), in the hand's own turn, from the wrist, in world units. */
export interface Grip { axis: THREE.Vector3, fist: THREE.Vector3 }

/** Where a shaft lies across the palm: this share of the way from the wrist to the middle finger's knuckle (the middle of the
 * palm, toward the knuckle line: the base of the fingers, which close round it). */
export const PALM_ALONG = 0.65
/** The shaft's skin: a gap kept between it and the palm's surface (a share of its radius). */
export const PALM_SKIN = 0.08

/**
 * How far the palm's surface is off the wrist-to-knuckle plane at `at` (world), out along `normal` (world): the first
 * surface the ray from inside the hand meets, on the meshes of `root`. Null where it meets none (a skeleton without a
 * skin).
 */
function palmDepth (root: THREE.Object3D, at: THREE.Vector3, normal: THREE.Vector3, far: number): number | null {
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh === true) meshes.push(o as THREE.SkinnedMesh) })
  if (meshes.length === 0) return null
  const originals = meshes.map(m => m.material)
  const doubled = (m: THREE.Material): THREE.Material => { const c = m.clone(); c.side = THREE.DoubleSide; return c }
  const ray = new THREE.Raycaster(at, normal, 0, far)
  let best: number | null
  try {
    // (from inside the hand: the faces seen are the inside of its skin, whichever side the material draws)
    meshes.forEach((m, i) => { const o = originals[i]; m.material = Array.isArray(o) ? o.map(doubled) : doubled(o); m.computeBoundingSphere() })
    best = ray.intersectObjects(meshes, false)[0]?.distance ?? null
  } finally {
    meshes.forEach((m, i) => { const c = m.material; m.material = originals[i]; for (const x of Array.isArray(c) ? c : [c]) x.dispose(); m.computeBoundingSphere() })
  }
  return best
}

/**
 * A hand's grip from its fist closed round a shaft of `radius` (`fingers`: the fist's local turns, on the hand of `root`).
 * The line is the one the curled fingers wrap round (through each finger's curl, the circle through its three joints,
 * little finger to index), squared to the palm (at right angles to the line from the wrist to the middle finger's
 * knuckle). The point it holds is the shaft's middle across the middle of the palm: PALM_ALONG of the way from the wrist
 * to the middle knuckle, out of the palm (toward where the fingers close) by the palm's skin (the hand's mesh, measured)
 * plus the shaft's radius. Both in the hand's own turn, from the wrist, in world units (as handGrip gives them). A shaft
 * along `axis` through `fist` lies on the palm, the thumb's side toward where `axis` points. Null when the hand hasn't
 * the fingers.
 */
export function fistGrip (root: THREE.Object3D, hand: Side, fingers: Record<string, Quat>, radius = 0): Grip | null {
  const bones = bonesOf(root)
  const wrist = bones.get(`${hand}Hand`)
  if (wrist === undefined) return null
  // (the fingers closed, to read; put back after)
  const saved = [...bones.values()].filter(b => b.name.startsWith(`${hand}Hand`) && b !== wrist).map(b => [b, b.quaternion.clone()] as const)
  for (const [name, q] of Object.entries(fingers)) bones.get(name)?.quaternion.set(...q)
  root.updateMatrixWorld(true)
  const w = wrist.getWorldPosition(new THREE.Vector3()); const turn = wrist.getWorldQuaternion(new THREE.Quaternion()); const inv = turn.clone().invert()
  const at = (n: string): THREE.Vector3 | null => { const b = bones.get(`${hand}Hand${n}`); return b === undefined ? null : b.getWorldPosition(new THREE.Vector3()).sub(w).applyQuaternion(inv) }
  const centres: THREE.Vector3[] = []
  for (const f of ['Index', 'Middle', 'Ring', 'Pinky']) {
    const a = at(`${f}1`); const b = at(`${f}2`); const c = at(`${f}3`)
    if (a === null || b === null || c === null) continue
    // (the circle through the three joints: its centre)
    const ab = b.clone().sub(a); const ac = c.clone().sub(a); const n = new THREE.Vector3().crossVectors(ab, ac)
    const nn = n.lengthSq()
    if (nn < 1e-14) continue
    const centre = new THREE.Vector3().crossVectors(n, ab).multiplyScalar(ac.lengthSq()).add(new THREE.Vector3().crossVectors(ac, n).multiplyScalar(ab.lengthSq())).divideScalar(2 * nn).add(a)
    centres.push(centre)
  }
  const index = at('Index1'); const little = at('Pinky1') ?? at('Ring1'); const middle = at('Middle1') ?? index
  if (centres.length < 2 || index === null || little === null || middle === null) { for (const [b, q] of saved) b.quaternion.copy(q); root.updateMatrixWorld(true); return null }
  const curl = centres.reduce((m, c) => m.add(c), new THREE.Vector3()).divideScalar(centres.length)
  // (the line through the curl centres: their main direction, little finger to index)
  let axis = centres[0].clone().sub(centres[centres.length - 1])
  if (centres.length > 2) axis = principalAxis(centres, axis).axis
  if (axis.dot(index.clone().sub(little)) < 0) axis.negate()
  // (square to the palm: at right angles to the wrist's line to the middle finger's knuckle)
  const palm = middle.clone().normalize()
  axis.addScaledVector(palm, -axis.dot(palm)).normalize()
  // (out of the palm: at right angles to both, to the side the fingers close to)
  const out = new THREE.Vector3().crossVectors(palm, axis).normalize()
  if (curl.clone().sub(middle).dot(out) < 0) out.negate()
  // (the shaft across the middle of the palm: the skin's depth measured on the mesh, else a share of the knuckles' width)
  const centre = middle.clone().multiplyScalar(PALM_ALONG)
  const skin = palmDepth(root, centre.clone().applyQuaternion(turn).add(w), out.clone().applyQuaternion(turn), index.distanceTo(little)) ?? 0.3 * index.distanceTo(little)
  for (const [b, q] of saved) b.quaternion.copy(q)
  root.updateMatrixWorld(true)
  return { axis, fist: centre.addScaledVector(out, skin + radius * (1 + PALM_SKIN)) }
}

/** The arm a hand belongs to. */
export function armOf (hand: Side): { upper: string, lower: string, end: string } {
  return { upper: `${hand}Arm`, lower: `${hand}ForeArm`, end: `${hand}Hand` }
}

/** The hands' goals on a frame (the body as it stands): each attached hand on its handle of its piece, the piece where
 * its path has it (locked: `base` gives where it rode before the edit, by gear id) or as it rides now; a piece's
 * carrying hand with no handle of its own keeps it where it is. */
export function handGoals (root: THREE.Object3D, bones: Map<string, THREE.Bone>, rig: GearRig, u: number, loop: boolean, base: Map<string, THREE.Matrix4> | null): HandGoal[] {
  const goals: HandGoal[] = []
  const used = new Set<string>()
  for (const [gear, path] of Object.entries(rig.paths)) {
    if (!path.locked) continue
    const node = root.getObjectByName(rig.node(gear))
    const was = base?.get(gear) ?? node?.matrixWorld
    if (node === undefined || was === undefined) continue
    const place = onPath(was, path, u, loop)
    const first = goals.length
    for (const a of rig.attachments.filter(x => x.gear === gear)) {
      const h = rig.handles[gear]?.find(x => x.id === a.handle)
      if (h === undefined || used.has(a.hand)) continue
      used.add(a.hand)
      goals.push({ hand: a.hand, ...handOn(place, h), fingers: rig.fingers[a.hand], grip: rig.grips?.[a.hand], exact: h.exact === true })
    }
    // (the hands on its shaft may slide along it at an extreme (and turn in their grips): from where each holds it, no
    // nearer another hand than the shaft's gap, off its ends)
    const shaft = rig.shafts?.[gear]
    const mine = goals.slice(first)
    if (shaft !== undefined && mine.length > 0) {
      const from = new THREE.Vector3(...shaft.from).applyMatrix4(place); const to = new THREE.Vector3(...shaft.to).applyMatrix4(place)
      const dir = to.clone().sub(from); const length = dir.length()
      if (length > 1e-6) {
        dir.divideScalar(length)
        const along = mine.map(g => (g.grip === undefined ? g.at.clone() : g.at.clone().add(g.grip.fist.clone().applyQuaternion(g.turn))).sub(from).dot(dir))
        const gap = shaft.gap ?? 0
        mine.forEach((g, i) => {
          let lo = length * SHAFT_END; let hi = length * (1 - SHAFT_HEAD)
          along.forEach((o, j) => { if (j === i) return; if (o <= along[i]) lo = Math.max(lo, o + gap); else hi = Math.min(hi, o - gap) })
          const most = shaft.most ?? Infinity
          g.slide = { dir: dir.clone(), back: Math.max(-most, Math.min(0, lo - along[i])), ahead: Math.min(most, Math.max(0, hi - along[i])) }
        })
      }
    }
  }
  for (const a of rig.attachments) {
    if (used.has(a.hand) || rig.paths[a.gear]?.locked === true) continue
    const node = root.getObjectByName(rig.node(a.gear))
    const h = rig.handles[a.gear]?.find(x => x.id === a.handle)
    if (node === undefined || h === undefined) continue
    node.updateMatrixWorld(true)
    used.add(a.hand)
    goals.push({ hand: a.hand, ...handOn(node.matrixWorld, h), fingers: rig.fingers[a.hand], grip: rig.grips?.[a.hand], exact: h.exact === true })
    // (the hand carrying a piece that doesn't lead keeps it where the clip has it, its turn exactly: the piece rides it,
    // so a turn there would carry the other hand's handle off the goal it was given)
    const side = /^(Left|Right)Hand$/.exec(rig.carriers[a.gear] ?? '')?.[1] as Side | undefined
    const carrier = side === undefined ? undefined : bones.get(`${side}Hand`)
    if (side !== undefined && carrier !== undefined && !used.has(side)) {
      used.add(side)
      goals.push({ hand: side, at: carrier.getWorldPosition(new THREE.Vector3()), turn: carrier.getWorldQuaternion(new THREE.Quaternion()), carrier: true })
    }
  }
  return goals
}

/** The hands reach their goals by IK alone (no pose model: a creature, or the model not loaded; and a live drag whose
 * solve is too slow): each arm reaches its goal's wrist, the hand takes its turn and closes its fingers. Returns the
 * worst miss left. */
export function reachGoals (bones: Map<string, THREE.Bone>, goals: readonly HandGoal[], o: { limits: JointLimits | null, nameOf: NameOf }): number {
  let miss = 0
  for (const g of goals) {
    const arm = armOf(g.hand)
    const upper = bones.get(arm.upper); const lower = bones.get(arm.lower); const end = bones.get(arm.end)
    if (upper === undefined || lower === undefined || end === undefined) continue
    miss = Math.max(miss, reach({ upper, lower, end }, g.at, { limits: o.limits ?? undefined, nameOf: o.nameOf, keepEnd: false }))
    setWorldQuaternion(end, g.turn)
    for (const [n, q] of Object.entries(g.fingers ?? {})) { const b = bones.get(n); if (b !== undefined) { b.quaternion.set(...q); b.updateMatrixWorld(true) } }
  }
  return miss
}

/** The frame at phase `u` of a clip of `frames` frames (frameTimes): its index. */
export const frameAt = (u: number, frames: number): number => Math.round(u * (frames - 1))

/** The frames a drag was let go on (by index, of `frames`): a gear drag's root hold, a key on a bone that moves it (the
 * pins at a clip's ends don't). Their solve is not pulled toward the frame before, so what was seen when it was let go
 * stays (frameSolve). */
export function letGoFrames (keys: Record<string, ClipKey[]>, holds: readonly RootHold[] | undefined, frames: number): Set<number> {
  const moves = (k: ClipKey): boolean => !(k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9)
  return new Set([...(holds ?? []).map(h => frameAt(h.u, frames)), ...Object.values(keys).flat().filter(moves).map(k => frameAt(k.u, frames))])
}

/** One frame of an edit, to solve the body on. */
export interface EditFrame {
  /** Its phase and index (frameTimes). */
  u: number
  i: number
  loop: boolean
  /** Where each leading piece rode on it before the edit (by gear id; its path is laid on that). Unset: as its node is. */
  rode?: Map<string, THREE.Matrix4> | null
  /** A live drag's: where each leading piece is now (by gear id), its path's move already in it. */
  places?: Map<string, THREE.Matrix4>
  /** It was let go on (letGoFrames): not pulled toward the frame before. */
  letGo: boolean
  /** Where the search starts (a live drag's last solve of it). */
  seed?: SeedPose
  /** The soft goals holding the body's root, instead of the root holds' (a live gear drag holds it where it was seen). */
  soft?: NaturalGoal[]
  /** A live drag: a few steps, a few ms. */
  quick?: boolean
}

/** What every frame's solve of an edit shares: the body, its legs on the floor (each leg's sole heights above it at rest),
 * the joints' ranges. */
export interface EditBody { hips: string, legs: Leg[], soles: number[][], floor: number, height: number, limits: JointLimits | null }

/**
 * One frame's body solve, as the build makes it (buildEdit) and as a live drag of that frame makes it, quickly, so that
 * letting go doesn't jump (DESIGN.md §8): the hands' goals on their handles (handGoals), the leading pieces' shafts as
 * obstacles but where the hands hold them, the body's root held where gear drags let go of it (rootGoals), the frame
 * before followed (FOLLOW) unless this one was let go on, and the seed as where the search starts. Read off `posable` as
 * it stands (the frame as keyed). The solver is then handed the state the frame before left.
 */
export function frameSolve (posable: THREE.Object3D, bones: Map<string, THREE.Bone>, gear: GearRig, f: EditFrame, body: EditBody): { goals: HandGoal[], opts: BodySolveOptions } {
  // (a live drag's places have the paths' moves in them already; the root holds still read the paths' keys)
  const rig: GearRig = f.places === undefined ? gear : { ...gear, paths: Object.fromEntries(Object.entries(gear.paths).map(([g, x]) => [g, { ...x, keys: [] }])) }
  const base = f.places ?? f.rode ?? null
  const goals = handGoals(posable, bones, rig, f.u, f.loop, base)
  const placeOf = (id: string): THREE.Matrix4 | null => {
    const was = base?.get(id) ?? posable.getObjectByName(rig.node(id))?.matrixWorld
    return was === undefined ? null : onPath(was, rig.paths[id], f.u, f.loop)
  }
  const opts: BodySolveOptions = {
    limits: body.limits, nameOf: b => b.name, legs: body.legs, height: body.height, floor: body.floor, soles: body.soles,
    obstacles: gearObstacles(rig, placeOf, GRIP_CLEAR * body.height),
    soft: f.soft ?? rootGoals(gear.holds, gear.paths, f.i, bones, body.hips),
    follow: f.letGo ? undefined : FOLLOW.weight,
  }
  if (f.seed !== undefined) opts.seed = f.seed
  if (f.quick === true) opts.quick = true
  return { goals, opts }
}

/** Where a live drag's solve left the body on the frame it was let go at (phase `u`): that frame's solve starts there. */
export interface EditSeed { u: number, pose: SeedPose }

/**
 * The edited clip: `base` with the keys; then, on each frame (on `posable`, a copy of the character to pose off
 * stage), the hands held on the gear they hold (`gear`), the body following them (`solver`; none: the arms reach by IK
 * alone), and the floor: a leg the edit sank further under it than the base had it reaches its foot back up. Each
 * frame's solve is frameSolve's. `seed`: a live drag's solve of the frame it was let go at, where that frame's solve
 * starts. `states`, when given, is filled with the state each frame's solve was handed (the frame before's: a live drag
 * of a frame follows it as the build does).
 */
export function buildEdit (base: THREE.AnimationClip, keys: Record<string, ClipKey[]>, loop: boolean, rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null,
  posable: THREE.Object3D, rig: PoseRig, floor: number, limits: JointLimits | null, gear: GearRig | null = null, height = 1,
  solver: BodySolver | null = null, o: { seed?: EditSeed | null, states?: Array<BodyState | null> } = {}): THREE.AnimationClip {
  const keyed = applyBoneKeys(base, keys, loop, rest)
  const active = gear !== null && (gear.attachments.length > 0 || Object.values(gear.paths).some(p => p.locked))
  // (gear moved in the hand is an edit too, with nothing to solve)
  const inHand = gear !== null && Object.values(gear.paths).some(p => !p.locked && p.keys.length > 0)
  if (Object.keys(keys).length === 0 && !active && !inHand) return keyed
  const bones = bonesOf(posable)
  const legs = legsOf(bones, rig)
  // (the soles' heights at rest above the floor)
  const saved = [...bones.values()].map(b => [b, b.position.clone(), b.quaternion.clone()] as const)
  for (const b of bones.values()) { const r = rest(b.name); if (r !== null) { b.quaternion.copy(r.q); b.position.copy(r.p) } }
  // (the gear nodes as Gear places them: an edit keys a leading piece's node, and a copy may carry that)
  for (const [g, r] of Object.entries(gear?.rest ?? {})) { const n = posable.getObjectByName(gear!.node(g)); if (n !== undefined) { n.position.fromArray(r.position); n.quaternion.fromArray(r.quaternion) } }
  posable.updateMatrixWorld(true)
  const v = new THREE.Vector3()
  const soles = legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : b.getWorldPosition(v).y - floor)))
  const times = frameTimes(keyed.duration)
  const mixer = new THREE.AnimationMixer(posable)
  const pose = (clip: THREE.AnimationClip, t: number): void => {
    mixer.stopAllAction()
    const a = mixer.clipAction(clip)
    // (once and held at the end: at its very end a looping action wraps round to its first frame)
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true
    a.reset(); a.play()
    mixer.setTime(t)
    posable.updateMatrixWorld(true)
  }
  const hands = active ? (['Left', 'Right'] as const).filter(h => gear!.attachments.some(a => a.hand === h) || Object.entries(gear!.paths).some(([p, x]) => x.locked && gear!.carriers[p] === `${h}Hand`)) : []
  const goalsOf = hands.map(hand => ({ hand, fingers: gear?.fingers[hand] }))
  const held = (solver !== null ? bodyBones(goalsOf, legs) : goalsOf.flatMap(g => [...Object.values(armOf(g.hand)), ...Object.keys(g.fingers ?? {})]))
    .map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined)
  // (also the carrying arms of gear that doesn't lead but a hand holds: they may be turned to keep it)
  const touched = [...new Set([...legs.flatMap(l => [l.upper, l.lower, l.end]), ...held, ...(active ? ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'].map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined) : [])])]
  const values = new Map(touched.map(b => [b.name, [] as number[]]))
  // (the body's solve may move the hips: a lunge, a drop)
  const hipsBone = bones.get(rig.hips)
  const hipsAt: number[] = []
  let changed = active
  let state: BodyState | null = null
  const nameOf = (b: THREE.Bone): string => b.name
  const seedFrame = o.seed === undefined || o.seed === null ? -1 : frameAt(o.seed.u, times.length)
  const letGo = letGoFrames(keys, gear?.holds, times.length)
  const body: EditBody = { hips: rig.hips, legs, soles, floor, height, limits }
  // (each leading piece's node keyed where its path puts it, on its bone as the solve left that: the piece is where it leads
  // to, however the hand carrying it holds it)
  const leading = active ? Object.keys(gear!.paths).filter(p => gear!.paths[p].locked && posable.getObjectByName(gear!.node(p)) !== undefined) : []
  // (a piece that doesn't lead, with keys: moved in the hand, frame by frame, the keys being moves and turns in its own
  // placed frame from where its bone holds it; whatever holds it stays, other hands on it follow)
  const moved = gear === null ? [] : Object.keys(gear.paths).filter(p => !gear.paths[p].locked && gear.paths[p].keys.length > 0 && posable.getObjectByName(gear.node(p)) !== undefined)
  if (moved.length > 0) changed = true
  const gearAt = new Map([...leading, ...moved].map(p => [p, { position: [] as number[], quaternion: [] as number[] }]))
  for (const [i, t] of times.entries()) {
    if (o.states !== undefined) o.states[i] = state
    pose(base, t)
    const was = sunk(legs, soles, floor)
    // (where each leading piece rode before the edit)
    const rode = active ? new Map(Object.keys(gear!.paths).filter(p => gear!.paths[p].locked).map(p => [p, posable.getObjectByName(gear!.node(p))?.matrixWorld.clone()]).filter((x): x is [string, THREE.Matrix4] => x[1] !== undefined)) : null
    pose(keyed, t)
    for (const g of moved) {
      const node = posable.getObjectByName(gear!.node(g))!
      const { q, p } = sampleKeys(gear!.paths[g].keys, keyed.duration > 0 ? t / keyed.duration : 0, loop)
      node.updateMatrix()
      node.matrix.multiply(new THREE.Matrix4().compose(p, q, new THREE.Vector3(1, 1, 1)))
      node.matrix.decompose(node.position, node.quaternion, node.scale)
      node.updateMatrixWorld(true)
    }
    if (active) {
      const u = keyed.duration > 0 ? t / keyed.duration : 0
      const { goals, opts } = frameSolve(posable, bones, gear!, { u, i, loop, rode, letGo: letGo.has(i), seed: i === seedFrame ? o.seed!.pose : undefined }, body)
      if (goals.length > 0 && solver === null) reachGoals(bones, goals, { limits, nameOf })
      else if (goals.length > 0 && solver !== null) state = solver(bones, goals, opts, state).state
    }
    const now = sunk(legs, soles, floor)
    // (only what the edit sank: lift the leg by that, from where it stands)
    const lift = legs.map((_, i) => now[i] - was[i])
    if (lift.some(x => x > 1e-4)) {
      changed = true
      legs.forEach((leg, i) => {
        if (lift[i] <= 1e-4) return
        keepOffFloor([leg], floor - was[i], [soles[i]], { limits: limits ?? undefined, nameOf: b => b.name })
      })
    }
    for (const b of touched) values.get(b.name)!.push(...b.quaternion.toArray())
    if (hipsBone !== undefined) hipsAt.push(...hipsBone.position.toArray())
    for (const g of moved) {
      const node = posable.getObjectByName(gear!.node(g))!
      const at = gearAt.get(g)!
      at.position.push(...node.position.toArray()); at.quaternion.push(...node.quaternion.toArray())
    }
    if (leading.length > 0) {
      posable.updateMatrixWorld(true)
      const u = keyed.duration > 0 ? t / keyed.duration : 0
      for (const g of leading) {
        const node = posable.getObjectByName(gear!.node(g))!; const was = rode?.get(g)
        const place = was === undefined ? node.matrixWorld.clone() : onPath(was, gear!.paths[g], u, loop)
        const local = (node.parent?.matrixWorld.clone().invert() ?? new THREE.Matrix4()).multiply(place)
        const pos = new THREE.Vector3(); const q = new THREE.Quaternion(); local.decompose(pos, q, new THREE.Vector3())
        const at = gearAt.get(g)!
        at.position.push(...pos.toArray()); at.quaternion.push(...q.toArray())
      }
    }
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  if (!changed) return keyed
  // (the tracks the edit replaces: the bones it solved, the hips' place, and the node of gear it moved (the clip keys
  // every placed piece: bake.ts gear tracks), which the edit keys where its path puts it)
  const gearNodes = new Set([...gearAt.keys()].map(p => gear!.node(p)))
  const tracks = keyed.tracks.filter(t => !touched.some(b => t.name === `${b.name}.quaternion`) && !(active && hipsBone !== undefined && t.name === `${hipsBone.name}.position`) &&
    !gearNodes.has(t.name.slice(0, t.name.lastIndexOf('.'))))
  for (const b of touched) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b.name)!))
  if (active && hipsBone !== undefined) tracks.push(new THREE.VectorKeyframeTrack(`${hipsBone.name}.position`, times, hipsAt))
  for (const [g, at] of gearAt) {
    const name = gear!.node(g)
    tracks.push(new THREE.VectorKeyframeTrack(`${name}.position`, times, at.position), new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, at.quaternion))
  }
  return new THREE.AnimationClip(keyed.name, keyed.duration, tracks)
}

/** A clip in the library's form: local turns of the source skeleton's bones per frame, and the hips' local position. */
export interface SourceFrames {
  fps: number
  bones: string[]
  /** Per frame, per bone: [x, y, z, w]. */
  rotations: number[][][]
  /** Per frame: the hips' local position. */
  hips: number[][]
}

/**
 * The edited clip (played on `posable`, the character) taken back onto `source` (the base's skeleton at rest): each bone's
 * world turn the character's then K^-1 (src/engine/retarget.ts retargetOffsets), local to its parent; the hips' move
 * from rest scaled back to the source's size, less `lift` (the viewer stood the clip on its floor by it). A bone the
 * character hasn't keeps `base`'s motion (the source clip), if given.
 */
export function unretarget (clip: THREE.AnimationClip, posable: THREE.Object3D, target: RestSkeleton, source: RestSkeleton, base?: THREE.AnimationClip, lift = 0): SourceFrames {
  const { offsets, scale } = retargetOffsets(source, target)
  const nodes = new Map<string, THREE.Object3D>()
  for (const [name, b] of target.bones) {
    let found: THREE.Object3D | undefined
    posable.traverse(o => { if (found === undefined && o.name === b.node.name && (o as THREE.Bone).isBone === true) found = o })
    if (found !== undefined) nodes.set(name, found)
  }
  const order = source.order
  const mixer = new THREE.AnimationMixer(posable)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()
  const times = frameTimes(clip.duration)
  const rotations: number[][][] = []
  const hips: number[][] = []
  const sHips = pelvisName(source); const tHips = pelvisName(target)
  const sh = source.bones.get(sHips)!; const th = target.bones.get(tHips)
  const q = new THREE.Quaternion()
  for (const t of times) {
    mixer.setTime(t)
    posable.updateMatrixWorld(true)
    const world = new Map<string, THREE.Quaternion>()
    const frame: number[][] = []
    for (const name of order) {
      const s = source.bones.get(name)!
      const parentWorld = s.parent !== null && world.has(s.parent) ? world.get(s.parent)! : new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(source.parentWorld.get(name) ?? new THREE.Matrix4()))
      const node = nodes.get(name); const k = offsets.get(name)
      let w: THREE.Quaternion
      if (node !== undefined && k !== undefined) w = node.getWorldQuaternion(q).clone().multiply(k.clone().invert())
      // (a bone the character hasn't, fingers it lacks: as the base clip has it, else at rest)
      else w = parentWorld.clone().multiply(base !== undefined ? new THREE.Quaternion().fromArray(trackAt(base, `${s.node.name}.quaternion`, t * base.duration / Math.max(clip.duration, 1e-9), s.localQuaternion.toArray())) : s.localQuaternion)
      world.set(name, w)
      frame.push(parentWorld.clone().invert().multiply(w).normalize().toArray())
    }
    rotations.push(frame)
    const node = nodes.get(tHips)
    if (node !== undefined && th !== undefined) {
      const move = node.getWorldPosition(new THREE.Vector3()).sub(th.worldPosition).sub(new THREE.Vector3(0, lift, 0)).divideScalar(scale)
      const at = sh.worldPosition.clone().add(move)
      // (into the hips' parent's frame: the object holding it when it is a top bone, else its parent bone as this frame
      // turns it: a horse's hips hang below a root bone, and a turn of that root is the root's alone)
      const parent = sh.parent === null ? source.parentWorld.get(sHips) : posedWorldOf(source, sh.parent, order, frame)
      hips.push((parent !== undefined ? at.applyMatrix4(parent.clone().invert()) : at).toArray())
    } else hips.push(sh.localPosition.toArray())
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  // (the frames' own rate: a clip not a whole number of frames long keeps its length)
  return { fps: clip.duration > 0 ? (times.length - 1) / clip.duration : KEY_FPS, bones: order, rotations, hips }
}

/** A source bone's world matrix in one frame of `rotations` (each bone's local turn, by `order`; a bone above the
 *  hips keeps its rest offset). */
function posedWorldOf (source: RestSkeleton, name: string, order: string[], frame: number[][]): THREE.Matrix4 {
  const b = source.bones.get(name)
  if (b === undefined) return new THREE.Matrix4()
  const i = order.indexOf(name)
  const turn = i < 0 ? b.localQuaternion : new THREE.Quaternion().fromArray(frame[i])
  const local = new THREE.Matrix4().compose(b.localPosition, turn, b.localScale)
  const above = b.parent === null ? (source.parentWorld.get(name) ?? new THREE.Matrix4()) : posedWorldOf(source, b.parent, order, frame)
  return above.clone().multiply(local)
}

// ---- windows: parts of a clip as phases, typed as text ("20–50%, 80–100%" or "0.2-0.5, 0.8-1") -------------------

/** Windows sorted, those that overlap or touch made one, empty ones dropped, each within 0..1. */
export function mergeWindows (windows: readonly Window[]): Window[] {
  const sorted = windows.map(([a, b]): Window => [Math.max(0, Math.min(a, b)), Math.min(1, Math.max(a, b))])
    .filter(([a, b]) => b - a > 1e-6).sort((x, y) => x[0] - y[0])
  const out: Window[] = []
  for (const w of sorted) {
    const last = out.at(-1)
    if (last !== undefined && w[0] <= last[1] + 1e-6) last[1] = Math.max(last[1], w[1])
    else out.push([w[0], w[1]])
  }
  return out
}

/** Windows typed as they are shown, "20–50%, 80–100%" (a hyphen does for the dash, "50%–80%" too), or as phases,
 * "0.2-0.5, 0.8-1" ("to" does too). '' (or "never") is none; null when a part can't be read, so a typo is said rather
 * than dropped. */
export function parseWindows (text: string): Window[] | null {
  const parts = text.split(/[,;]/).map(x => x.trim()).filter(x => x !== '')
  if (parts.length === 0 || (parts.length === 1 && /^never$/i.test(parts[0]))) return []
  const out: Window[] = []
  for (const part of parts) {
    const m = /^(\d*\.?\d+)\s*(%?)\s*(?:-|–|—|to)\s*(\d*\.?\d+)\s*(%?)$/i.exec(part)
    if (m === null) return null
    // (a part with a % is in percent, both ends; one without, in phases)
    const percent = m[2] === '%' || m[4] === '%'
    const most = percent ? 100 : 1
    const a = Number(m[1]); const b = Number(m[3])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a > most || b > most) return null
    out.push(percent ? [Math.round(a * 1e4) / 1e6, Math.round(b * 1e4) / 1e6] : [a, b])
  }
  return mergeWindows(out)
}

/** A phase in percent: whole, or to a tenth when it isn't (a window set from a frame keeps its place when typed back). */
const percentText = (x: number): string => String(Math.round(x * 1000) / 10)

/** Windows as they are shown everywhere, "20–50%, 80–100%" ('' for none). */
export function windowsText (windows: readonly Window[] | undefined): string {
  return (windows ?? []).map(([a, b]) => `${percentText(a)}–${percentText(b)}%`).join(', ')
}

/** From phase `u` to the clip's end added (held, or open, from the frame shown on). */
export function fromHere (windows: readonly Window[], u: number): Window[] {
  return mergeWindows([...windows, [u, 1]])
}

/** Let go at phase `u`: the windows cut there, nothing after it. */
export function toHere (windows: readonly Window[], u: number): Window[] {
  return mergeWindows(windows.filter(([a]) => a < u).map(([a, b]): Window => [a, Math.min(b, u)]))
}

// ---- hand poses -------------------------------------------------------------------------------------------------

/** A setting a hand's pose on a handle is read from: one of the slot's own hand poses (by adjustment id), the handle's
 * own pose, or the hand's hold in every clip (hands.hold). */
export type HandPoseSource = { kind: 'slot', adjustment: string } | { kind: 'handle', handle: Handle } | { kind: 'hold' }

/**
 * Which setting decides the pose `side`'s hand closes to on handle `handleId` of gear `gearId` (the one hand resolver,
 * hands.ts handleRef), so the editor's pose picker changes the one that counts. Found by asking the resolver itself,
 * so its order lives there only: each setting that is set is given, in turn, a pose no other has, and the one whose
 * pose comes back decides. Null: none is set (the default fist). Nothing is changed.
 */
export function handPoseSource (c: Character, slot: Slot | null, side: Side, gearId: string, handleId: string): HandPoseSource | null {
  const probe = { pose: '\u0000probe' }
  const decides = (cc: Character, s: Slot | null): boolean => {
    const r: HandPoseRef = handleRef(cc, s, side, gearId, handleId)
    return typeof r === 'object' && 'pose' in r && r.pose === probe.pose
  }
  for (const a of slot?.adjustments ?? []) {
    if (a.kind !== 'handPose' || a.hand !== side) continue
    if (decides(c, { ...slot!, adjustments: slot!.adjustments.map(x => (x === a ? { ...a, pose: probe } : x)) })) return { kind: 'slot', adjustment: a.id }
  }
  const handle = c.gear.find(g => g.id === gearId)?.handles.find(h => h.id === handleId)
  if (handle?.pose !== undefined) {
    const gear = c.gear.map(g => (g.id !== gearId ? g : { ...g, handles: g.handles.map(h => (h === handle ? { ...h, pose: probe } : h)) }))
    if (decides({ ...c, gear }, slot)) return { kind: 'handle', handle }
  }
  const hold = c.hands.hold
  if (hold?.[side] !== undefined && decides({ ...c, hands: { ...c.hands, hold: { ...hold, [side]: probe } } }, slot)) return { kind: 'hold' }
  return null
}

// ---- saving ------------------------------------------------------------------------------------------------------

/** The name an edit of `name` is offered under: "Attack edit", never "Attack edit edit" (an edit of an edit keeps its
 * name; the server gives a second clip of a name its own id). The editor's "(editing)" marks are taken off. */
export function editNameOf (name: string): string {
  const base = name.replace(/( \((editing|naturalized)\))+$/, '').trim() || 'Clip'
  return /\sedit(\s+\d+)?$/i.test(base) ? base : `${base} edit`
}

/** How the edit was opened: the slot's clip as it plays (its speed, timing, hands, ground and keys in it), the slot's
 * clip alone (none of them), or a new clip made from one frame. */
export type EditMode = 'plays' | 'alone' | 'held'

/**
 * The one batch that puts an edit, saved as library clip `clip`, into the slot it was made on (DESIGN.md §6 row 2).
 * Made 'as it plays' the edit has the slot's enabled adjustments in it, so by kind: the speed is baked (the slot plays
 * at 1); blow timing, pace and keys on bones are baked and go; ground stays (the saved frames had its lift taken out);
 * keys on gear are what the edit's gear does now (`gearKeys`, from the edited clip); hand poses and handle holds stay
 * (their windows are phases of the clip as it played, which is the saved clip). A disabled adjustment played no part,
 * so it stays as it is, but a disabled keys adjustment gives way to the edit's gear keys (a slot has one keys). Made on
 * 'the clip alone', the slot keeps its speed and adjustments, and gear the edit moved is keyed on top (merged per gear).
 */
export function saveToSlotCommands (slot: Slot, mode: Exclude<EditMode, 'held'>, clip: ClipRef, o: { loop: boolean, gearKeys: Record<string, ClipKey[]>, newId: () => string }): Command[] {
  const moved = Object.keys(o.gearKeys).length > 0
  if (mode === 'alone') {
    const keys: Adjustment[] = moved ? [{ id: o.newId(), kind: 'keys', enabled: true, gear: o.gearKeys }] : []
    return [{ type: 'slot.fill', id: slot.id, clip, speed: slot.speed, loop: o.loop, inPlace: slot.inPlace, keepAdjustments: true, adjustments: keys }]
  }
  const baked = (a: Adjustment): boolean => a.enabled && (a.kind === 'blowTiming' || a.kind === 'pace' || a.kind === 'keys')
  const kept = slot.adjustments.filter(a => !baked(a) && !(a.kind === 'keys' && moved))
  const was = slot.adjustments.find(a => a.kind === 'keys')
  const keys: Adjustment[] = moved ? [{ id: was?.id ?? o.newId(), kind: 'keys', enabled: true, gear: o.gearKeys }] : []
  // (a copy: the slot may be live app state)
  const copy = JSON.parse(JSON.stringify(kept)) as Adjustment[]
  return [{ type: 'slot.fill', id: slot.id, clip, speed: 1, loop: o.loop, inPlace: slot.inPlace, keepAdjustments: false, adjustments: [...copy, ...keys] }]
}

/**
 * The one batch that puts an edit, saved as library clip `clip`, into a slot of the character chosen by name (the
 * editor's one save, "Save as Attack"; the designer, 2026-10-28: "I super just need to be able to save animations with
 * the character as a replacement to attack or run"). The slot it was made on: as saveToSlotCommands puts it there. Any
 * other (a slot the game plays, a trial, or a new one by `target.name`) plays it as it was shown: at speed 1, its own
 * loop and in place kept (a new one: the edit's), what it had for its old clip gone, the ground the edit stood on
 * (`lift`), the gear keys the edit moved, and, made 'as it plays' on a slot, that slot's hand poses and handle holds
 * (copied: their windows are phases of the clip as it played, which is the saved clip).
 */
export function saveIntoSlotCommands (target: { slot: Slot | null, name: string }, from: { slot: Slot | null, mode: EditMode }, clip: ClipRef,
  o: { loop: boolean, inPlace: boolean, lift: number, gearKeys: Record<string, ClipKey[]>, newId: () => string }): Command[] {
  const t = target.slot
  if (t !== null && from.slot !== null && t.id === from.slot.id && from.mode !== 'held') return saveToSlotCommands(t, from.mode, clip, { loop: t.loop, gearKeys: o.gearKeys, newId: o.newId })
  const hands = from.mode === 'plays' && from.slot !== null ? from.slot.adjustments.filter(a => a.enabled && (a.kind === 'handPose' || a.kind === 'handleHold')) : []
  const lift = Math.round(o.lift * 1e4) / 1e4
  const adjustments: Adjustment[] = [
    ...(Math.abs(lift) >= 1e-4 ? [{ id: o.newId(), kind: 'ground', enabled: true, lift } as Adjustment] : []),
    // (copies, with ids of their own: the slot they came from may be live app state, and keeps its own)
    ...(JSON.parse(JSON.stringify(hands)) as Adjustment[]).map(a => ({ ...a, id: o.newId() })),
    ...(Object.keys(o.gearKeys).length > 0 ? [{ id: o.newId(), kind: 'keys', enabled: true, gear: o.gearKeys } as Adjustment] : []),
  ]
  if (t !== null) return [{ type: 'slot.fill', id: t.id, clip, speed: 1, loop: t.loop, inPlace: t.inPlace, keepAdjustments: false, adjustments, note: null }]
  return [{ type: 'slot.fill', name: target.name, newId: o.newId(), clip, loop: o.loop, inPlace: o.inPlace, adjustments }]
}

/** A slot's adjustments with its keys adjustment's keys on the pieces `gear` (by gear id) taken off, the adjustment
 * gone when nothing is left on it: an edit opened again from its record, whose paths for those pieces make that motion
 * again. Copies; the slot is left as it is. */
export function withoutGearKeys (adjustments: readonly Adjustment[], gear: readonly string[]): Adjustment[] {
  if (gear.length === 0) return [...adjustments]
  return adjustments.flatMap((a): Adjustment[] => {
    if (a.kind !== 'keys' || a.gear === undefined || !gear.some(g => a.gear![g] !== undefined)) return [a]
    const left = Object.fromEntries(Object.entries(a.gear).filter(([g]) => !gear.includes(g)))
    const next: Extract<Adjustment, { kind: 'keys' }> = { ...a, gear: left }
    if (Object.keys(left).length === 0) delete next.gear
    return next.bones === undefined && next.gear === undefined ? [] : [next]
  })
}

/** A handle name for `hand` on a piece not yet taken by its other handles: "Left grip", "Left grip 2"... */
export function gripName (hand: Side, taken: readonly string[]): string {
  const base = `${hand} grip`
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base} ${i}`)) return `${base} ${i}`
}
