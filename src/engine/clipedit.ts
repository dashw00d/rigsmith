// The animation editor's clip (src/state/clipedit.svelte.ts): a base clip as it plays on the character, the keys made
// on it (turns on bones, and the hips' moves, at moments of the clip: src/engine/keys.ts, tweened smoothly), and the
// floor: a foot the edit put under the ground lifted back (only what the edit sank: the base plays as it was). Saving
// takes the edited clip back onto the base's own skeleton (the retarget undone: Qsource = Qcharacter * K^-1), for the
// library.
import * as THREE from 'three'
import type { ClipKey } from '../../server/workspace.ts'
import { applyBoneKeys, frameTimes, KEY_FPS, sampleKeys } from './keys.ts'
import { keepOffFloor, reach, setWorldQuaternion, type Leg } from './ik.ts'
import { bodyBones, solveBody, type BodyState, type HandGoal } from './bodysolve.ts'
import { FOLLOW, type NaturalGoal, type Obstacle } from './posespace.ts'
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

function bonesOf (root: THREE.Object3D): Map<string, THREE.Bone> {
  const out = new Map<string, THREE.Bone>()
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) out.set(o.name, o as THREE.Bone) })
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

/** A grip on a prop (a rigid garment): where a hand's wrist goes and how the hand is turned, in the prop's own frame
 * (its placed node's). Kept on the garment (server/workspace.ts GarmentSocket): every clip can use it. */
export interface Socket {
  id: string
  name: string
  position: [number, number, number]
  rotation: [number, number, number, number]
  /** Put where it is by hand (the hand's gizmo, or dragged on it): the hand holds it exactly, no give. */
  placed?: boolean
}

/** A hand on a socket through the clip (the edit's). */
export interface Attachment { hand: 'Left' | 'Right', prop: string, socket: string }

/** The carrying hand's grip from the prop's fixed Outfit placement and the hand's rest frame. */
export function carrierGrip (prop: string, hand: 'Left' | 'Right', placement: THREE.Matrix4, handRest: THREE.Matrix4): Socket {
  const local = placement.clone().invert().multiply(handRest)
  const at = new THREE.Vector3(); const turn = new THREE.Quaternion()
  local.decompose(at, turn, new THREE.Vector3())
  return { id: `carrier:${prop}`, name: `${hand} hand (carries it)`, position: at.toArray(), rotation: turn.toArray() }
}

/** A prop's path through the clip: locked, it leads (the hands on it follow it, the body follows the hands); its keys are
 * moves and turns from where it rode in the clip (in the world, about its own origin). */
export interface PropPath { locked: boolean, keys: ClipKey[] }

/** What the props do in an edit: their paths, the hands on them, their sockets and fingers. */
export interface PropRig {
  /** By prop: its node in the posed copy is found by this name (src/state/tune.svelte.ts propNode). */
  node: (prop: string) => string
  paths: Record<string, PropPath>
  attachments: Attachment[]
  sockets: Record<string, Socket[]>
  /** The bone each prop rides. */
  carriers: Record<string, string>
  fingers: Partial<Record<'Left' | 'Right', Record<string, [number, number, number, number]>>>
  /** By leading prop: its shaft (the end by the hand carrying it and the far end, in its node's frame) and its radius: the
   * body is kept clear of it, but where the hands hold it (propObstacles). */
  shafts?: Record<string, { from: [number, number, number], to: [number, number, number], radius: number, /** how near two hands' holds may come along it (metres) */ gap?: number, /** the most a hand slides on it either way (metres) */ most?: number }>
  /** By prop: its node's place on its bone as the outfit has it (local position, turn). A leading prop's node is keyed
   * in the edit to where its path puts it, whatever hand holds it how; a copy posed from an edit is put back to this first. */
  rest?: Record<string, { position: [number, number, number], quaternion: [number, number, number, number] }>
  /** By hand: where it holds the shaft it is on (Grip; the carrying hand has none: its turn is held exactly). The solver keeps this point on the shaft while the hand's turn gives. */
  grips?: Partial<Record<'Left' | 'Right', Grip>>
  /** The prop drags let go (RootHold): the body's root held near where it was seen, on the frames each one moved the prop. */
  holds?: RootHold[]
}

/**
 * A prop drag let go at `u` (a key on `prop`'s path): on each frame the drag moved the prop (by frame index, frameTimes),
 * how much of the drag that frame carries (`w`, 0 to 1: the prop's move there over its move at the key), and the solve's
 * correction to the body's root there before the drag (world: the hips' move, the chest's turn, from the keyed pose). The
 * build holds the root to that correction softly, in proportion, so moving the prop away extends the arms instead of
 * bringing the body in; local in time, as the drag is, and never keyed.
 */
export interface RootHold {
  prop: string
  u: number
  frames: Record<number, { w: number, hips: [number, number, number], chest: [number, number, number, number] }>
}

/** A root hold: its weight at full (a soft goal's: as a keyed bone's in Naturalize), the chest bone it holds the turn of,
 * and the least share of the drag a frame must carry to be held. */
export const ROOT_HOLD = { weight: 4, chest: 'Spine2', min: 0.05 }

/** The soft goals that hold the body's root on frame `i` (posed in its keyed pose): the strongest hold there, if any, its
 * prop's path still keyed at its drag. */
export function rootGoals (holds: RootHold[] | undefined, paths: Record<string, PropPath>, i: number, bones: Map<string, THREE.Bone>, hips: string): NaturalGoal[] {
  const best = holdAt(holds, paths, i)
  const hb = bones.get(hips); const chest = bones.get(ROOT_HOLD.chest)
  if (best === null || hb === undefined || chest === undefined) return []
  const weight = ROOT_HOLD.weight * Math.min(1, best.w)
  return [
    { bone: hips, position: hb.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(...best.hips)), weight, hard: false },
    { bone: ROOT_HOLD.chest, turn: new THREE.Quaternion(...best.chest).multiply(chest.getWorldQuaternion(new THREE.Quaternion())).normalize(), weight, hard: false },
  ]
}

/** The strongest root hold on frame `i` whose prop's path is still keyed at its drag, or null. */
export function holdAt (holds: RootHold[] | undefined, paths: Record<string, PropPath>, i: number): RootHold['frames'][number] | null {
  let best: RootHold['frames'][number] | null = null
  for (const h of holds ?? []) {
    const f = h.frames[i]
    if (f === undefined || f.w < ROOT_HOLD.min || !(paths[h.prop]?.locked === true && paths[h.prop].keys.some(k => Math.abs(k.u - h.u) < 1e-4))) continue
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
 * What the body must stay clear of on a frame: each leading prop's shaft (where `placeOf` puts the prop), cut where each
 * hand holds it (`margin` metres either side of its fist), the hands holding it let through.
 */
export function propObstacles (props: PropRig, placeOf: (prop: string) => THREE.Matrix4 | null, margin: number): Obstacle[] {
  const out: Obstacle[] = []
  for (const [prop, path] of Object.entries(props.paths)) {
    const shaft = props.shafts?.[prop]
    if (!path.locked || shaft === undefined) continue
    const place = placeOf(prop)
    if (place === null) continue
    const from = new THREE.Vector3(...shaft.from).applyMatrix4(place); const to = new THREE.Vector3(...shaft.to).applyMatrix4(place)
    const dir = to.clone().sub(from); const length = dir.length()
    if (length < 1e-6) continue
    dir.divideScalar(length)
    const holding = props.attachments.filter(a => a.prop === prop)
    const hands = [...new Set([...holding.map(a => `${a.hand}Hand`), props.carriers[prop]].filter((h): h is string => h !== undefined && /^(Left|Right)Hand$/.test(h)))]
    // (where each hand holds it, along it: the wrist's place on the shaft's line)
    const cuts = holding.map(a => props.sockets[prop]?.find(x => x.id === a.socket)).filter((x): x is Socket => x !== undefined)
      .map(sock => handOn(place, sock).at.sub(from).dot(dir)).map(t => [t - margin, t + margin] as [number, number]).sort((a, b) => a[0] - b[0])
    let at = 0
    for (const [a, b] of [...cuts, [length, length] as [number, number]]) {
      if (a - at > margin * 0.25) out.push({ from: from.clone().addScaledVector(dir, at), to: from.clone().addScaledVector(dir, Math.min(a, length)), radius: shaft.radius, ignore: hands })
      at = Math.max(at, b)
      if (at >= length) break
    }
  }
  return out
}

/** A matrix from a socket (its wrist place and turn). */
export function socketMatrix (s: Socket): THREE.Matrix4 {
  return new THREE.Matrix4().compose(new THREE.Vector3(...s.position), new THREE.Quaternion(...s.rotation), new THREE.Vector3(1, 1, 1))
}

/** Where a hand on `socket` of a prop placed at `prop` (world) goes: its wrist and turn. */
export function handOn (prop: THREE.Matrix4, socket: Socket): { at: THREE.Vector3, turn: THREE.Quaternion } {
  const m = prop.clone().multiply(socketMatrix(socket))
  const at = new THREE.Vector3(); const turn = new THREE.Quaternion(); const scale = new THREE.Vector3()
  m.decompose(at, turn, scale)
  return { at, turn }
}

/** Measure the actual wrists against their sockets after baking, including movement of the carrying hand/prop. */
export function socketMisses (clip: THREE.AnimationClip, root: THREE.Object3D, props: PropRig): number[] {
  const bones = bonesOf(root)
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.play()
  const out: number[] = []
  for (const t of frameTimes(clip.duration)) {
    mixer.setTime(t); root.updateMatrixWorld(true)
    let miss = 0
    for (const a of props.attachments) {
      const hand = bones.get(`${a.hand}Hand`); const node = root.getObjectByName(props.node(a.prop))
      const socket = props.sockets[a.prop]?.find(s => s.id === a.socket)
      if (hand === undefined || node === undefined || socket === undefined) continue
      miss = Math.max(miss, hand.getWorldPosition(new THREE.Vector3()).distanceTo(handOn(node.matrixWorld, socket).at))
    }
    out.push(miss)
  }
  mixer.stopAllAction(); mixer.uncacheRoot(root)
  root.updateMatrixWorld(true)
  return out
}

/** A prop's world place on its path at phase `u`: where it rode (`base`), then its keys' move and turn. */
export function onPath (base: THREE.Matrix4, path: PropPath, u: number, loop: boolean): THREE.Matrix4 {
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
export function handGrip (rest: RestSkeleton, hand: 'Left' | 'Right'): { axis: THREE.Vector3, fist: THREE.Vector3 } | null {
  const at = (n: string): THREE.Vector3 | null => rest.bones.get(`${hand}${n}`)?.worldPosition.clone() ?? null
  const wrist = rest.bones.get(`${hand}Hand`)
  const index = at('HandIndex1'); const little = at('HandPinky1') ?? at('HandRing1') ?? at('HandMiddle1'); const middle = at('HandMiddle1') ?? index
  if (wrist === undefined || index === null || little === null || middle === null || index.distanceTo(little) < 1e-6) return null
  const h = wrist.worldPosition
  const along = middle.clone().sub(h)
  const length = along.length()
  const f = along.normalize()
  const k = index.clone().sub(little)
  const width = k.length()
  k.addScaledVector(f, -k.dot(f)).normalize()
  // (the palm's side: where the thumb is, off the plane of the knuckles)
  let n = new THREE.Vector3().crossVectors(f, k).normalize()
  const thumb = at('HandThumb1')
  if (thumb !== null && thumb.clone().sub(h).dot(n) < 0) n.negate()
  const lean = THREE.MathUtils.degToRad(25)
  const axis = k.clone().multiplyScalar(Math.cos(lean)).addScaledVector(f, -Math.sin(lean)).normalize()
  const fist = index.clone().add(little).multiplyScalar(0.5).addScaledVector(f, 0.12 * length).addScaledVector(n, 0.35 * width)
  const inv = wrist.worldQuaternion.clone().invert()
  return { axis: axis.applyQuaternion(inv), fist: fist.sub(h).applyQuaternion(inv) }
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
  let best: number | null = null
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
export function fistGrip (root: THREE.Object3D, hand: 'Left' | 'Right', fingers: Record<string, [number, number, number, number]>, radius = 0): Grip | null {
  const bones = new Map<string, THREE.Bone>()
  root.traverse(o => { if ((o as THREE.Bone).isBone === true) bones.set(o.name, o as THREE.Bone) })
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
  if (centres.length > 2) {
    const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
    for (const c of centres) { const d = c.clone().sub(curl).toArray(); for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C[i][j] += d[i] * d[j] }
    let v = axis.clone().normalize()
    for (let it = 0; it < 30; it++) { const x = v.toArray(); v = new THREE.Vector3(C[0][0] * x[0] + C[0][1] * x[1] + C[0][2] * x[2], C[1][0] * x[0] + C[1][1] * x[1] + C[1][2] * x[2], C[2][0] * x[0] + C[2][1] * x[1] + C[2][2] * x[2]).normalize() }
    axis = v
  }
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
export function armOf (hand: 'Left' | 'Right'): { upper: string, lower: string, end: string } {
  return { upper: `${hand}Arm`, lower: `${hand}ForeArm`, end: `${hand}Hand` }
}

/** The hands' goals on a frame (the body as it stands): each attached hand on its socket of its prop, the prop where its
 * path has it (locked: `base` gives where it rode before the edit, by prop) or as it rides now; a prop's carrying hand
 * with no socket keeps it where it is. */
export function handGoals (root: THREE.Object3D, bones: Map<string, THREE.Bone>, props: PropRig, u: number, loop: boolean, base: Map<string, THREE.Matrix4> | null): HandGoal[] {
  const goals: HandGoal[] = []
  const used = new Set<string>()
  for (const [prop, path] of Object.entries(props.paths)) {
    if (!path.locked) continue
    const node = root.getObjectByName(props.node(prop))
    const was = base?.get(prop) ?? node?.matrixWorld
    if (node === undefined || was === undefined) continue
    const place = onPath(was, path, u, loop)
    const first = goals.length
    for (const a of props.attachments.filter(x => x.prop === prop)) {
      const sock = props.sockets[prop]?.find(x => x.id === a.socket)
      if (sock === undefined || used.has(a.hand)) continue
      used.add(a.hand)
      goals.push({ hand: a.hand, ...handOn(place, sock), fingers: props.fingers[a.hand], grip: props.grips?.[a.hand], exact: sock.placed === true })
    }
    // (the hands on its shaft may slide along it at an extreme (and turn in their grips): from where each holds it, no
    // nearer another hand than the shaft's gap, off its ends)
    const shaft = props.shafts?.[prop]
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
  for (const a of props.attachments) {
    if (used.has(a.hand) || props.paths[a.prop]?.locked === true) continue
    const node = root.getObjectByName(props.node(a.prop))
    const sock = props.sockets[a.prop]?.find(x => x.id === a.socket)
    if (node === undefined || sock === undefined) continue
    node.updateMatrixWorld(true)
    used.add(a.hand)
    goals.push({ hand: a.hand, ...handOn(node.matrixWorld, sock), fingers: props.fingers[a.hand], grip: props.grips?.[a.hand], exact: sock.placed === true })
    // (the hand carrying an unlocked prop keeps it where the clip has it)
    const side = /^(Left|Right)Hand$/.exec(props.carriers[a.prop] ?? '')?.[1] as 'Left' | 'Right' | undefined
    const carrier = side === undefined ? undefined : bones.get(`${side}Hand`)
    if (side !== undefined && carrier !== undefined && !used.has(side)) {
      used.add(side)
      goals.push({ hand: side, at: carrier.getWorldPosition(new THREE.Vector3()), turn: carrier.getWorldQuaternion(new THREE.Quaternion()) })
    }
  }
  return goals
}

/**
 * The edited clip: `base` with the keys; then, on each frame (on `posable`, a copy of the character to pose off
 * stage), the hands held on their props (`holds`), and the floor: a leg the edit sank further under it than the base
 * had it reaches its foot back up.
 */
export function buildEdit (base: THREE.AnimationClip, keys: Record<string, ClipKey[]>, loop: boolean, rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null,
  posable: THREE.Object3D, rig: PoseRig, floor: number, limits: JointLimits | null, props: PropRig | null = null, height = 1,
  solver: { solve: typeof solveBody, bones: typeof bodyBones } = { solve: solveBody, bones: bodyBones }): THREE.AnimationClip {
  const keyed = applyBoneKeys(base, keys, loop, rest)
  const active = props !== null && (props.attachments.length > 0 || Object.values(props.paths).some(p => p.locked))
  if (Object.keys(keys).length === 0 && !active) return keyed
  const bones = bonesOf(posable)
  const legs = legsOf(bones, rig)
  // (the soles' heights at rest above the floor)
  const saved = [...bones.values()].map(b => [b, b.position.clone(), b.quaternion.clone()] as const)
  for (const b of bones.values()) { const r = rest(b.name); if (r !== null) { b.quaternion.copy(r.q); b.position.copy(r.p) } }
  // (the props' nodes as the outfit places them: an edit keys a leading prop's node, and a copy may carry that)
  for (const [prop, r] of Object.entries(props?.rest ?? {})) { const n = posable.getObjectByName(props!.node(prop)); if (n !== undefined) { n.position.fromArray(r.position); n.quaternion.fromArray(r.quaternion) } }
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
  const hands = active ? (['Left', 'Right'] as const).filter(h => props!.attachments.some(a => a.hand === h) || Object.entries(props!.paths).some(([p, x]) => x.locked && props!.carriers[p] === `${h}Hand`)) : []
  const held = solver.bones(hands.map(hand => ({ hand, fingers: props?.fingers[hand] })), legs).map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined)
  // (also the carrying arms of unlocked props a hand holds: they may be turned to keep the prop)
  const touched = [...new Set([...legs.flatMap(l => [l.upper, l.lower, l.end]), ...held, ...(active ? ['LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'].map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined) : [])])]
  const values = new Map(touched.map(b => [b.name, [] as number[]]))
  // (the body's solve may move the hips: a lunge, a drop)
  const hipsBone = bones.get(rig.hips)
  const hipsAt: number[] = []
  let changed = active
  let state: BodyState | null = null
  const nameOf = (b: THREE.Bone): string => b.name
  // (the frames a drag was let go on: a prop drag's key, a key on a bone; the solve there is not pulled toward the frame
  // before, so what was seen when it was let go stays)
  const frameOf = (u: number): number => Math.round(u * (times.length - 1))
  const letGo = new Set([...(props?.holds ?? []).map(h => frameOf(h.u)), ...Object.values(keys).flat().filter(k => !(k.p === undefined && Math.abs(k.q[3]) > 1 - 1e-9)).map(k => frameOf(k.u))])
  // (each leading prop's node keyed where its path puts it, on its bone as the solve left that: the prop is where it leads
  // to, however the hand carrying it holds it)
  const leading = active ? Object.keys(props!.paths).filter(p => props!.paths[p].locked && posable.getObjectByName(props!.node(p)) !== undefined) : []
  const propAt = new Map(leading.map(p => [p, { position: [] as number[], quaternion: [] as number[] }]))
  for (const [i, t] of times.entries()) {
    pose(base, t)
    const was = sunk(legs, soles, floor)
    // (where each locked prop rode before the edit)
    const rode = active ? new Map(Object.keys(props!.paths).filter(p => props!.paths[p].locked).map(p => [p, posable.getObjectByName(props!.node(p))?.matrixWorld.clone()]).filter((x): x is [string, THREE.Matrix4] => x[1] !== undefined)) : null
    pose(keyed, t)
    if (active) {
      const u = keyed.duration > 0 ? t / keyed.duration : 0
      const goals = handGoals(posable, bones, props!, u, loop, rode)
      // (the leading props' shafts, where their paths put them: the body kept clear of them but where the hands hold them)
      const obstacles = propObstacles(props!, prop => { const node = posable.getObjectByName(props!.node(prop)); const was = rode?.get(prop) ?? node?.matrixWorld; return was === undefined ? null : onPath(was, props!.paths[prop], u, loop) }, GRIP_CLEAR * height)
      // (the body's root held where the solve had it before each prop drag, on the frames the drag moved the prop)
      const soft = rootGoals(props!.holds, props!.paths, i, bones, rig.hips)
      if (goals.length > 0) state = solver.solve(bones, goals, { limits, nameOf, legs, height, floor, soles, obstacles, follow: letGo.has(i) ? undefined : FOLLOW.weight, soft } as Parameters<typeof solveBody>[2], state).state
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
    if (leading.length > 0) {
      posable.updateMatrixWorld(true)
      const u = keyed.duration > 0 ? t / keyed.duration : 0
      for (const prop of leading) {
        const node = posable.getObjectByName(props!.node(prop))!; const was = rode?.get(prop)
        const place = was === undefined ? node.matrixWorld.clone() : onPath(was, props!.paths[prop], u, loop)
        const local = (node.parent?.matrixWorld.clone().invert() ?? new THREE.Matrix4()).multiply(place)
        const pos = new THREE.Vector3(); const q = new THREE.Quaternion(); local.decompose(pos, q, new THREE.Vector3())
        const at = propAt.get(prop)!
        at.position.push(...pos.toArray()); at.quaternion.push(...q.toArray())
      }
    }
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  if (!changed) return keyed
  // (the tracks the edit replaces: the bones it solved, the hips' place, and a leading prop's node (a clip may key it: a
  // prop script's placement), which the edit keys where the prop's path puts it)
  const propNodes = new Set([...propAt.keys()].map(p => props!.node(p)))
  const tracks = keyed.tracks.filter(t => !touched.some(b => t.name === `${b.name}.quaternion`) && !(active && hipsBone !== undefined && t.name === `${hipsBone.name}.position`) &&
    !propNodes.has(t.name.slice(0, t.name.lastIndexOf('.'))))
  for (const b of touched) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b.name)!))
  if (active && hipsBone !== undefined) tracks.push(new THREE.VectorKeyframeTrack(`${hipsBone.name}.position`, times, hipsAt))
  for (const [prop, at] of propAt) {
    const name = props!.node(prop)
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
