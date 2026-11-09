// Posture (docs/motion-plan.md §12.1): the body turned from how the clip holds it, a slot's adjustment the bake applies
// after the hands and before the ground. A part's degrees are shared over its bones, each turned in its parent's frame
// (q' = r · q_clip, r about the character's axis as that parent holds it at rest), so a lean follows the hips wherever
// the clip turns them and the arms open from the chest. The axes are the character's own, from its rest skeleton: up,
// left (the left thigh's place minus the right's, flattened) and forward = left × up.
//
// Its windows are source time: each frame of the clip as it plays is taken back to its source moment through the slot's
// time map, so a posture stays on the motion it was set on whatever the timing does.
import * as THREE from 'three'
import type { Adjustment, PosturePart } from '../model/types.ts'
import { envelope } from '../model/envelope.ts'
import type { TimeMap } from '../model/timemap.ts'
import { frameTimes } from './keys.ts'
import type { RestSkeleton } from './retarget.ts'

export type Posture = Extract<Adjustment, { kind: 'posture' }>
type Axis = 'up' | 'left' | 'forward'

/** Each part's bones, their shares of its degrees (a mirrored arm's negative) and the axis it turns about. */
export const PARTS: Record<PosturePart, { bones: Array<[string, number]>, axis: Axis }> = {
  lean: { bones: [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]], axis: 'left' },
  side: { bones: [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]], axis: 'forward' },
  twist: { bones: [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]], axis: 'up' },
  nod: { bones: [['Neck', 0.4], ['Head', 0.6]], axis: 'left' },
  turnHead: { bones: [['Neck', 0.4], ['Head', 0.6]], axis: 'up' },
  tiltHead: { bones: [['Neck', 0.4], ['Head', 0.6]], axis: 'forward' },
  armsOut: { bones: [['LeftArm', 1], ['RightArm', -1]], axis: 'forward' },
  armsForward: { bones: [['LeftArm', -1], ['RightArm', -1]], axis: 'left' },
  shrug: { bones: [['LeftShoulder', 1], ['RightShoulder', -1]], axis: 'forward' },
}

/** The character's up, left and forward in world space at rest. */
export function bodyAxes (rest: RestSkeleton): Record<Axis, THREE.Vector3> {
  const up = new THREE.Vector3(0, 1, 0)
  const l = rest.bones.get('LeftUpLeg') ?? rest.bones.get('LeftShoulder') ?? rest.bones.get('LeftArm')
  const r = rest.bones.get('RightUpLeg') ?? rest.bones.get('RightShoulder') ?? rest.bones.get('RightArm')
  const left = l !== undefined && r !== undefined ? l.worldPosition.clone().sub(r.worldPosition) : new THREE.Vector3(1, 0, 0)
  left.sub(up.clone().multiplyScalar(left.dot(up)))
  if (left.lengthSq() < 1e-12) left.set(1, 0, 0)
  left.normalize()
  return { up, left, forward: left.clone().cross(up).normalize() }
}

/** A rest bone's parent's world turn (the object holding the skeleton's for its top bone). */
function parentTurn (rest: RestSkeleton, name: string): THREE.Quaternion {
  const b = rest.bones.get(name)!
  if (b.parent !== null) return rest.bones.get(b.parent)!.worldQuaternion.clone()
  const m = rest.parentWorld.get(name) ?? new THREE.Matrix4()
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m)).normalize()
}

/** `clip` with the postures turned in. `map`: the slot's time map (frames to source moments); `seconds`: the source's
 * length (a fade's seconds over it are a phase of it). `report` gets each posture's bones turned (and those missing). */
export function applyPosture (clip: THREE.AnimationClip, postures: readonly Posture[], rest: RestSkeleton, map: TimeMap, seconds: number,
  report: Record<string, unknown> = {}): THREE.AnimationClip {
  const on = postures.filter(p => p.amount !== 0 && (p.weight ?? 1) > 0)
  for (const p of postures) if (!on.includes(p)) report[p.id] = { kind: 'posture', part: p.part, amount: p.amount, bones: [] }
  if (on.length === 0 || clip.duration <= 0) return clip
  const axes = bodyAxes(rest)
  // per bone: the turns that act on it (its axis in its parent's rest frame, radians per unit of envelope)
  const acts = new Map<string, Array<{ axis: THREE.Vector3, radians: number, p: Posture }>>()
  for (const p of on) {
    const part = PARTS[p.part]
    const turned: string[] = []; const missing: string[] = []
    for (const [bone, share] of part.bones) {
      const b = rest.bones.get(bone)
      if (b === undefined) { missing.push(bone); continue }
      const axis = axes[part.axis].clone().applyQuaternion(parentTurn(rest, bone).invert()).normalize()
      const list = acts.get(bone) ?? []
      list.push({ axis, radians: p.amount * share * (p.weight ?? 1) * Math.PI / 180, p })
      acts.set(bone, list)
      turned.push(bone)
    }
    report[p.id] = { kind: 'posture', part: p.part, amount: p.amount, bones: turned, ...(missing.length > 0 ? { missing: turned.length === 0, without: missing } : {}) }
  }
  if (acts.size === 0) return clip

  const times = frameTimes(clip.duration)
  // (each posture's envelope per frame, once: its windows and fade in source time)
  const env = new Map(on.map(p => [p.id, times.map(t => envelope(map.toSource(t / clip.duration), p.windows, (p.fade ?? 0) / Math.max(seconds, 1e-9)))]))
  let tracks = [...clip.tracks]
  const r = new THREE.Quaternion(); const step = new THREE.Quaternion()
  for (const [bone, list] of acts) {
    const node = rest.bones.get(bone)!.node.name
    const name = `${node}.quaternion`
    const track = tracks.find(t => t.name === name)
    const interpolant = track === undefined ? null : (track as unknown as { createInterpolant: () => THREE.Interpolant }).createInterpolant()
    const restQ = rest.bones.get(bone)!.localQuaternion
    const values: number[] = []
    times.forEach((t, i) => {
      const q = interpolant === null ? restQ.clone() : new THREE.Quaternion().fromArray(Array.from(interpolant.evaluate(t) as ArrayLike<number>)).normalize()
      r.identity()
      for (const a of list) {
        const e = env.get(a.p.id)![i]
        if (e > 0) r.premultiply(step.setFromAxisAngle(a.axis, a.radians * e))
      }
      values.push(...r.multiply(q).normalize().toArray())
    })
    tracks = tracks.filter(t => t !== track)
    tracks.push(new THREE.QuaternionKeyframeTrack(name, times, values))
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}
