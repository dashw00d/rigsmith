// "Test rig": one clip, made for the rig in front of it, that takes every joint through its range so bad weights show:
// a person's arms raised sideways, forward and overhead, elbows bent, forearms twisted, wrists flexed, the hands
// closing to fists and spreading while the arms move; the spine bent and twisted, the head nodded and turned, each leg
// lifted, the hips swung out, a squat. A four-legged body: the neck and head, each leg folded in turn, the back bent,
// the tail swung. Each motion turns a bone about an axis of the body (its left +X, up +Y, forward +Z) taken from the rest
// pose and carried in the parent's frame, so it fits any rig of the skeleton. No translation: the body stays put.
import * as THREE from 'three'
import type { RestSkeleton } from './retarget.ts'

const X = new THREE.Vector3(1, 0, 0); const Y = new THREE.Vector3(0, 1, 0); const Z = new THREE.Vector3(0, 0, 1)
const FPS = 30

interface Motion { bone: string, axis: THREE.Vector3, degrees: number, from: number, to: number, hold?: boolean, cycles?: number
  /** A move instead of a turn: the bone's joint shifted this far (body axes) at full (a squat lowering the hips). */
  move?: THREE.Vector3 }

/** 0 -> 1 -> 0 over [from, to] (eased), `cycles` times; held at 1 between its ramps with `hold`. */
function shape (m: Motion, t: number): number {
  if (t <= m.from || t >= m.to) return 0
  const u = (t - m.from) / (m.to - m.from)
  if (m.hold === true) {
    const ramp = 0.2
    const e = u < ramp ? u / ramp : u > 1 - ramp ? (1 - u) / ramp : 1
    return e * e * (3 - 2 * e)
  }
  const s = Math.sin(Math.PI * u * (m.cycles ?? 1))
  return (m.cycles ?? 1) === 1 ? s * s : s
}

/** Build the clip from motions: each bone's turn at each frame, in its parent's rest frame, over its rest turn. */
function bake (rest: RestSkeleton, motions: Motion[], duration: number, name: string): THREE.AnimationClip {
  const by = new Map<string, Motion[]>()
  for (const m of motions) if (rest.bones.has(m.bone)) (by.get(m.bone) ?? by.set(m.bone, []).get(m.bone)!).push(m)
  const frames = Math.round(duration * FPS) + 1
  const times = Array.from({ length: frames }, (_, i) => i / FPS)
  const tracks: THREE.KeyframeTrack[] = []
  const q = new THREE.Quaternion(); const d = new THREE.Quaternion()
  for (const name of rest.order) {
    const b = rest.bones.get(name)!
    const list = by.get(name)
    const values: number[] = []
    // (the parent's rest frame: an axis of the body at rest turns with the parent as it moves)
    const parentWorld = b.parent !== null ? rest.bones.get(b.parent)!.worldQuaternion : new THREE.Quaternion().setFromRotationMatrix(rest.parentWorld.get(name) ?? new THREE.Matrix4())
    const toParent = parentWorld.clone().invert()
    for (const t of times) {
      q.identity()
      for (const m of list ?? []) {
        const a = shape(m, t)
        if (a !== 0 && m.move === undefined) q.premultiply(d.setFromAxisAngle(m.axis, THREE.MathUtils.degToRad(m.degrees * a)))
      }
      // local = P^-1 . world turn . P . rest local
      const local = toParent.clone().multiply(q).multiply(parentWorld).multiply(b.localQuaternion).normalize()
      values.push(local.x, local.y, local.z, local.w)
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.node.name}.quaternion`, times, values))
    const moves = (list ?? []).filter(m => m.move !== undefined)
    if (moves.length > 0) {
      // (in the parent's frame: its world rest matrix undone, scale and all)
      const parentMatrix = b.parent !== null
        ? new THREE.Matrix4().compose(rest.bones.get(b.parent)!.worldPosition, rest.bones.get(b.parent)!.worldQuaternion, new THREE.Vector3(1, 1, 1))
        : (rest.parentWorld.get(name) ?? new THREE.Matrix4())
      const inv = parentMatrix.clone().invert()
      const p: number[] = []
      for (const t of times) {
        const w = b.worldPosition.clone()
        for (const m of moves) w.addScaledVector(m.move!, shape(m, t))
        const l = w.applyMatrix4(inv)
        p.push(l.x, l.y, l.z)
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${b.node.name}.position`, times, p))
    }
  }
  return new THREE.AnimationClip(name, duration, tracks)
}

const dir = (rest: RestSkeleton, a: string, b: string): THREE.Vector3 | null => {
  const p = rest.bones.get(a)?.worldPosition; const c = rest.bones.get(b)?.worldPosition
  return p === undefined || c === undefined ? null : c.clone().sub(p).normalize()
}

function human (rest: RestSkeleton): { motions: Motion[], duration: number } {
  const M: Motion[] = []
  const add = (bone: string, axis: THREE.Vector3 | null, degrees: number, from: number, to: number, extra: Partial<Motion> = {}): void => {
    if (axis !== null) M.push({ bone, axis: axis.clone().normalize(), degrees, from, to, ...extra })
  }
  for (const [side, s] of [['Left', 1], ['Right', -1]] as const) {
    const arm = `${side}Arm`; const fore = `${side}ForeArm`; const hand = `${side}Hand`
    // arms: sideways to overhead (turning out as they rise, as a shoulder does: palms up at shoulder height, in
    // overhead; a swing alone leaves the arm twisted), then forward and up
    add(arm, dir(rest, arm, fore), -120 * s, 0, 2.4)
    add(arm, Z, 125 * s, 0, 2.4)
    add(arm, X, -150, 2.4, 4.8)
    // held forward while the elbow bends and the forearm twists (twice)
    add(arm, X, -80, 4.8, 8.4, { hold: true })
    const forearm = dir(rest, fore, hand)
    add(fore, forearm === null ? null : forearm.clone().cross(Z), 135, 5.0, 8.2, { cycles: 2 })
    add(hand, forearm, 75 * s, 5.0, 8.2, { cycles: 3 })
    // wrist flex and sideways bend, the arm a little out so the hand shows
    add(arm, Z, 35 * s, 8.4, 11.4, { hold: true })
    const along = dir(rest, hand, `${side}HandMiddle1`) ?? dir(rest, hand, `${side}HandIndex1`) ?? forearm
    const a = rest.bones.get(`${side}HandIndex1`)?.worldPosition; const p = rest.bones.get(`${side}HandPinky1`)?.worldPosition ?? rest.bones.get(`${side}HandThumb1`)?.worldPosition
    const across = a !== undefined && p !== undefined && along !== null ? a.clone().sub(p).addScaledVector(along, -a.clone().sub(p).dot(along)).normalize() : null
    // (toward the palm, on either hand and in any pose: from the fingers' line and the index finger's side, the
    // thumb's: palm = side x (along x across))
    const palm = across !== null && along !== null ? along.clone().cross(across).multiplyScalar(s).normalize() : null
    if (palm !== null && along !== null) {
      add(hand, along.clone().cross(palm), 60, 8.6, 10.0, { cycles: 2 })
      add(hand, palm, 25 * s, 10.0, 11.2, { cycles: 2 })
    }
    // the fingers: a fist while the arms rise (twice), while the elbow works, and on their own; then spread
    for (const finger of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) {
      for (let i = 1; i <= 3; i++) {
        const bone = `${side}Hand${finger}${i}`
        const d = dir(rest, bone, `${side}Hand${finger}${i + 1}`)
        if (d === null || palm === null) continue
        const curl = d.clone().cross(palm)
        const deg = finger === 'Thumb' ? 45 : i === 1 ? 70 : 90
        for (const [from, to] of [[0, 1.2], [1.2, 2.4], [2.4, 3.6], [3.6, 4.8], [5.8, 7.4], [8.6, 9.8], [11.4, 12.4]]) add(bone, curl, deg, from, to)
        // spread: each away from the middle finger (about the palm's axis, +s turning toward the index side)
        if (i === 1 && finger !== 'Thumb') add(bone, palm, ({ Index: 14, Middle: 3, Ring: -7, Pinky: -16 } as Record<string, number>)[finger] * s, 12.4, 13.6)
        if (i === 1 && finger === 'Thumb') add(bone, palm, 30 * s, 12.4, 13.6)
      }
    }
    // legs: each lifted (hip and knee), then out to the side, the ankle flexed
    const t0 = side === 'Left' ? 18.0 : 19.6
    add(`${side}UpLeg`, X, -85, t0, t0 + 1.6)
    add(`${side}Leg`, X, 110, t0, t0 + 1.6)
    add(`${side}UpLeg`, Z, 45 * s, 21.2, 22.8)
    add(`${side}Foot`, X, 35, 21.2, 22.8, { cycles: 2 })
    // the squat: hips, knees, ankles together
    add(`${side}UpLeg`, X, -95, 22.8, 25.0)
    add(`${side}Leg`, X, 120, 22.8, 25.0)
    add(`${side}Foot`, X, -25, 22.8, 25.0)
    if (side === 'Left') {
      // (the hips come down by about a thigh, so the feet stay on the ground)
      const thigh = rest.bones.get('LeftUpLeg')?.worldPosition.distanceTo(rest.bones.get('LeftLeg')?.worldPosition ?? new THREE.Vector3()) ?? 0
      M.push({ bone: 'Hips', axis: Y, degrees: 0, from: 22.8, to: 25.0, move: new THREE.Vector3(0, -1.05 * thigh, -0.25 * thigh) })
    }
    add(`${side}Shoulder`, Z, 20 * s, 3.6, 4.8)
  }
  // the spine: forward and back, twist, sideways; the head: nod, turn, tilt
  for (const [bone, k] of [['Spine', 1], ['Spine1', 1], ['Spine2', 1]] as const) {
    add(bone, X, 18 * k, 13.6, 15.2, { cycles: 2 })
    add(bone, Y, 20, 15.2, 16.4, { cycles: 2 })
    add(bone, Z, 12, 16.4, 18.0, { cycles: 2 })
  }
  add('Neck', X, 22, 13.6, 15.2, { cycles: 2 })
  add('Head', X, 20, 13.6, 15.2, { cycles: 2 })
  add('Neck', Y, 35, 15.2, 16.4, { cycles: 2 })
  add('Head', Y, 30, 15.2, 16.4, { cycles: 2 })
  add('Head', Z, 20, 16.4, 18.0, { cycles: 2 })
  return { motions: M, duration: 25.0 }
}

/** A creature: its chains by their names (legs, spine, neck and head, tail; anything else bends about the side axis). */
function creature (rest: RestSkeleton): { motions: Motion[], duration: number } {
  const M: Motion[] = []
  const names = rest.order
  const add = (bone: string, axis: THREE.Vector3, degrees: number, from: number, to: number, extra: Partial<Motion> = {}): void => { M.push({ bone, axis, degrees, from, to, ...extra }) }
  // the legs, each in turn: folded (alternate joints the other way, as a leg folds), then swung
  const legs = new Map<string, string[]>()
  for (const n of names) {
    if (!/leg|arm|wing/i.test(n) || /leaf|end|tip/i.test(n)) continue
    const key = n.replace(/_(upper|lower|ankle|foot|toe|pelvis|scapula|humerus|\d+)/g, '')
    ;(legs.get(key) ?? legs.set(key, []).get(key)!).push(n)
  }
  let t = 0
  for (const chain of legs.values()) {
    chain.forEach((n, i) => add(n, X, (i % 2 === 0 ? -35 : 50), t, t + 1.6))
    chain.slice(0, 1).forEach(n => add(n, X, 30, t + 1.6, t + 2.4, { cycles: 2 }))
    t += 2.4
  }
  // (not the pelvis: turning it tilts the whole body)
  const spine = names.filter(n => /spine|back|chest/i.test(n) && !/leaf|leg/i.test(n))
  const head = names.filter(n => /neck|head|skull/i.test(n) && !/leaf|end/i.test(n))
  const tail = names.filter(n => /tail/i.test(n) && !/leaf/i.test(n))
  const ears = names.filter(n => /ear|jaw|mouth/i.test(n) && !/leaf/i.test(n))
  for (const n of spine) { add(n, X, 4, t, t + 1.6, { cycles: 2 }); add(n, Y, 5, t + 1.6, t + 3.2, { cycles: 2 }) }
  t += 3.2
  for (const n of head) { add(n, X, 18, t, t + 1.6, { cycles: 2 }); add(n, Y, 22, t + 1.6, t + 3.2, { cycles: 2 }) }
  for (const n of ears) add(n, X, 25, t, t + 3.2, { cycles: 3 })
  t += 3.2
  for (const n of tail) { add(n, Y, 20, t, t + 1.6, { cycles: 2 }); add(n, X, 18, t + 1.6, t + 3.2, { cycles: 2 }) }
  t += 3.2
  return { motions: M, duration: Math.max(t, 1) }
}

/** The test clip for a rig: a person's Mixamo skeleton, else a creature's by its bone names. */
export function rigTest (rest: RestSkeleton, human_: boolean): THREE.AnimationClip {
  const { motions, duration } = human_ ? human(rest) : creature(rest)
  return bake(rest, motions, duration, 'Test rig')
}
