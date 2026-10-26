// The animation editor's clip (src/state/clipedit.svelte.ts): a base clip as it plays on the character, the keys made
// on it (turns on bones, and the hips' moves, at moments of the clip: src/engine/keys.ts, tweened smoothly), and the
// floor: a foot the edit put under the ground lifted back (only what the edit sank: the base plays as it was). Saving
// takes the edited clip back onto the base's own skeleton (the retarget undone: Qsource = Qcharacter * K^-1), for the
// library.
import * as THREE from 'three'
import type { ClipKey } from '../../server/workspace.ts'
import { applyBoneKeys, KEY_FPS, sampleKeys } from './keys.ts'
import { keepOffFloor, reach, setWorldQuaternion, type Leg } from './ik.ts'
import { bodyBones, solveBody, type BodyState, type HandGoal } from './bodysolve.ts'
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

/** A clip's frames (KEY_FPS) as times. */
export function frameTimes (duration: number): number[] {
  const n = Math.max(1, Math.round(duration * KEY_FPS))
  return Array.from({ length: n + 1 }, (_, i) => Math.min(duration, i / KEY_FPS))
}

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
}

/** A hand on a socket through the clip (the edit's). */
export interface Attachment { hand: 'Left' | 'Right', prop: string, socket: string }

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
    for (const a of props.attachments.filter(x => x.prop === prop)) {
      const sock = props.sockets[prop]?.find(x => x.id === a.socket)
      if (sock === undefined || used.has(a.hand)) continue
      used.add(a.hand)
      goals.push({ hand: a.hand, ...handOn(place, sock), fingers: props.fingers[a.hand] })
    }
  }
  for (const a of props.attachments) {
    if (used.has(a.hand) || props.paths[a.prop]?.locked === true) continue
    const node = root.getObjectByName(props.node(a.prop))
    const sock = props.sockets[a.prop]?.find(x => x.id === a.socket)
    if (node === undefined || sock === undefined) continue
    node.updateMatrixWorld(true)
    used.add(a.hand)
    goals.push({ hand: a.hand, ...handOn(node.matrixWorld, sock), fingers: props.fingers[a.hand] })
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
  for (const t of times) {
    pose(base, t)
    const was = sunk(legs, soles, floor)
    // (where each locked prop rode before the edit)
    const rode = active ? new Map(Object.keys(props!.paths).filter(p => props!.paths[p].locked).map(p => [p, posable.getObjectByName(props!.node(p))?.matrixWorld.clone()]).filter((x): x is [string, THREE.Matrix4] => x[1] !== undefined)) : null
    pose(keyed, t)
    if (active) {
      const goals = handGoals(posable, bones, props!, keyed.duration > 0 ? t / keyed.duration : 0, loop, rode)
      if (goals.length > 0) state = solver.solve(bones, goals, { limits, nameOf, legs, height, floor, soles } as Parameters<typeof solveBody>[2], state).state
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
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  if (!changed) return keyed
  const tracks = keyed.tracks.filter(t => !touched.some(b => t.name === `${b.name}.quaternion`) && !(active && hipsBone !== undefined && t.name === `${hipsBone.name}.position`))
  for (const b of touched) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b.name)!))
  if (active && hipsBone !== undefined) tracks.push(new THREE.VectorKeyframeTrack(`${hipsBone.name}.position`, times, hipsAt))
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
      const parent = source.parentWorld.get(sHips)
      hips.push((parent !== undefined ? at.applyMatrix4(parent.clone().invert()) : at).toArray())
    } else hips.push(sh.localPosition.toArray())
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  return { fps: KEY_FPS, bones: order, rotations, hips }
}
