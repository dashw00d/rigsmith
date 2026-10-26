// The animation editor's clip (src/state/clipedit.svelte.ts): a base clip as it plays on the character, the keys made
// on it (turns on bones, and the hips' moves, at moments of the clip: src/engine/keys.ts, tweened smoothly), and the
// floor: a foot the edit put under the ground lifted back (only what the edit sank: the base plays as it was). Saving
// takes the edited clip back onto the base's own skeleton (the retarget undone: Qsource = Qcharacter * K^-1), for the
// library.
import * as THREE from 'three'
import type { ClipKey } from '../../server/workspace.ts'
import { applyBoneKeys, KEY_FPS } from './keys.ts'
import { keepOffFloor, type Leg } from './ik.ts'
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

function legsOf (bones: Map<string, THREE.Bone>, rig: PoseRig): Leg[] {
  const b = (n: string | null): THREE.Bone | null => (n === null ? null : bones.get(n) ?? null)
  return rig.legs.filter(l => b(l.upper) !== null && b(l.lower) !== null && b(l.end) !== null)
    .map(l => ({ upper: b(l.upper)!, lower: b(l.lower)!, end: b(l.end)!, ball: b(l.ball), tip: b(l.tip) }))
}

/** How far under the floor each leg's soles go (0 above it), as `root` stands. */
function sunk (legs: Leg[], soles: number[][], floor: number): number[] {
  const v = new THREE.Vector3()
  return legs.map((l, i) => Math.max(0, ...[l.end, l.ball, l.tip].map((b, k) => (b === null || !Number.isFinite(soles[i][k]) ? 0 : floor + soles[i][k] - b.getWorldPosition(v).y))))
}

/**
 * The edited clip: `base` with the keys, then the floor (on `posable`, a copy of the character to pose off stage): on
 * each frame a leg the keys sank further under the floor than the base had it reaches its foot back up.
 */
export function buildEdit (base: THREE.AnimationClip, keys: Record<string, ClipKey[]>, loop: boolean, rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null,
  posable: THREE.Object3D, rig: PoseRig, floor: number, limits: JointLimits | null): THREE.AnimationClip {
  const keyed = applyBoneKeys(base, keys, loop, rest)
  if (Object.keys(keys).length === 0) return keyed
  const bones = bonesOf(posable)
  const legs = legsOf(bones, rig)
  if (legs.length === 0) return keyed
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
    a.reset(); a.play()
    mixer.setTime(t)
    posable.updateMatrixWorld(true)
  }
  const legBones = legs.flatMap(l => [l.upper, l.lower, l.end])
  const values = new Map(legBones.map(b => [b.name, [] as number[]]))
  let changed = false
  for (const t of times) {
    pose(base, t)
    const was = sunk(legs, soles, floor)
    pose(keyed, t)
    const now = sunk(legs, soles, floor)
    // (only what the keys sank: lift the leg by that, from where it stands)
    const lift = legs.map((_, i) => now[i] - was[i])
    if (lift.some(x => x > 1e-4)) {
      changed = true
      legs.forEach((leg, i) => {
        if (lift[i] <= 1e-4) return
        keepOffFloor([leg], floor - was[i], [soles[i]], { limits: limits ?? undefined, nameOf: b => b.name })
      })
    }
    for (const b of legBones) values.get(b.name)!.push(...b.quaternion.toArray())
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(posable)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  posable.updateMatrixWorld(true)
  if (!changed) return keyed
  const tracks = keyed.tracks.filter(t => !legBones.some(b => t.name === `${b.name}.quaternion`))
  for (const b of legBones) tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values.get(b.name)!))
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
