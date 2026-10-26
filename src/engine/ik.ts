// Posing by reaching, for the animation editor: a limb's end put where it is dragged (two bones, the middle joint
// bending towards where it already bends), the hips raised or lowered with the feet kept where they stand (a crouch, a
// jump: the legs bend), and the floor (no foot below the ground). Every joint stays within its limits when a
// JointLimits is given (src/engine/limits.ts). All on the character's own bones, in place.
import * as THREE from 'three'
import type { JointLimits } from './limits.ts'

export interface Limb {
  upper: THREE.Bone
  lower: THREE.Bone
  end: THREE.Bone
}

/** A bone's name as the limits know it (a rig's prefix dropped). */
export type NameOf = (bone: THREE.Bone) => string

const worldQ = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
const worldP = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())

/** Give `bone` this world turn (its local one set from its parent's). */
export function setWorldQuaternion (bone: THREE.Object3D, q: THREE.Quaternion): void {
  const parent = bone.parent === null ? new THREE.Quaternion() : worldQ(bone.parent)
  bone.quaternion.copy(parent.invert().multiply(q)).normalize()
  bone.updateMatrixWorld(true)
}

function clampBone (bone: THREE.Bone, limits: JointLimits | undefined, nameOf: NameOf): void {
  if (limits === undefined) return
  const name = nameOf(bone)
  if (!limits.has(name)) return
  bone.quaternion.copy(limits.clamp(name, bone.quaternion))
  bone.updateMatrixWorld(true)
}

/**
 * Reach: the limb's end to `target` (world), the middle joint bending on the side it bends now (or towards `pole`);
 * the end keeps its world turn (a hand doesn't spin as the arm moves) unless `keepEnd` is false (held in its limit too
 * unless `endFree`). Within limits, a few
 * rounds: each solves, then holds every joint in range. Returns how far from the target the end is left.
 */
export function reach (limb: Limb, target: THREE.Vector3, opts: { limits?: JointLimits, nameOf: NameOf, pole?: THREE.Vector3, keepEnd?: boolean, endFree?: boolean, rounds?: number }): number {
  const { upper, lower, end } = limb
  upper.updateMatrixWorld(true)
  const endTurn = worldQ(end)
  const start = [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()]
  let miss = reachOnce(limb, target, opts, endTurn)
  // (held short by its limits: the middle joint may bend another way round the line to the target; the best of a
  // few kept)
  if (opts.limits !== undefined && miss > 0.005) {
    const S = worldP(upper)
    const axis = target.clone().sub(S).normalize()
    let best = { miss, q: [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()] }
    const side = new THREE.Vector3(0, 1, 0).cross(axis)
    if (side.lengthSq() < 1e-8) side.set(1, 0, 0)
    side.normalize()
    for (let k = 0; k < 8 && best.miss > 0.005; k++) {
      upper.quaternion.copy(start[0]); lower.quaternion.copy(start[1]); end.quaternion.copy(start[2]); upper.updateMatrixWorld(true)
      const pole = side.clone().applyAxisAngle(axis, (k / 8) * Math.PI * 2)
      const m = reachOnce(limb, target, { ...opts, pole }, endTurn)
      if (m < best.miss - 1e-4) best = { miss: m, q: [upper.quaternion.clone(), lower.quaternion.clone(), end.quaternion.clone()] }
    }
    upper.quaternion.copy(best.q[0]); lower.quaternion.copy(best.q[1]); end.quaternion.copy(best.q[2]); upper.updateMatrixWorld(true)
    miss = best.miss
  }
  return miss
}

function reachOnce (limb: Limb, target: THREE.Vector3, opts: { limits?: JointLimits, nameOf: NameOf, pole?: THREE.Vector3, keepEnd?: boolean, endFree?: boolean, rounds?: number }, endTurn: THREE.Quaternion): number {
  const { upper, lower, end } = limb
  const rounds = opts.limits === undefined ? 1 : (opts.rounds ?? 4)
  for (let r = 0; r < rounds; r++) {
    const S = worldP(upper); const E = worldP(lower); const H = worldP(end)
    const l1 = E.distanceTo(S); const l2 = H.distanceTo(E)
    const toT = target.clone().sub(S)
    const dist = Math.min(Math.max(toT.length(), Math.abs(l1 - l2) * 1.001 + 1e-6), (l1 + l2) * 0.9995)
    const dn = toT.lengthSq() > 1e-12 ? toT.normalize() : H.clone().sub(S).normalize()
    // the bend's side: where the middle joint is now, off the line from the top to the end (else the pole)
    const along = H.clone().sub(S).normalize()
    let side = E.clone().sub(S).addScaledVector(along, -E.clone().sub(S).dot(along))
    if (opts.pole !== undefined && (r === 0 || side.lengthSq() < 1e-10)) side = opts.pole.clone()
    side.addScaledVector(dn, -side.dot(dn))
    if (side.lengthSq() < 1e-12) side = new THREE.Vector3(0, 0, 1).addScaledVector(dn, -dn.z)
    side.normalize()
    const cos = Math.min(1, Math.max(-1, (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)))
    const elbow = S.clone().addScaledVector(dn, l1 * cos).addScaledVector(side, l1 * Math.sqrt(1 - cos * cos))
    const hand = S.clone().addScaledVector(dn, dist)
    // the top: aimed at the new middle (the smallest turn keeps its roll)
    setWorldQuaternion(upper, new THREE.Quaternion().setFromUnitVectors(E.clone().sub(S).normalize(), elbow.clone().sub(S).normalize()).multiply(worldQ(upper)))
    const E2 = worldP(lower); const H2 = worldP(end)
    setWorldQuaternion(lower, new THREE.Quaternion().setFromUnitVectors(H2.clone().sub(E2).normalize(), hand.clone().sub(E2).normalize()).multiply(worldQ(lower)))
    clampBone(upper, opts.limits, opts.nameOf)
    clampBone(lower, opts.limits, opts.nameOf)
  }
  if (opts.keepEnd !== false) {
    setWorldQuaternion(end, endTurn)
    // (endFree: the end keeps its turn exactly, its limit or not: a hand carrying a spear keeps the spear on its line)
    if (opts.endFree !== true) clampBone(end, opts.limits, opts.nameOf)
  }
  return worldP(end).distanceTo(target)
}

export interface Leg extends Limb {
  /** The ball of the foot and the toes' tip (soles: with the ankle, the points kept off the floor). */
  ball: THREE.Bone | null
  tip: THREE.Bone | null
}

/** The legs' sole points at rest above the floor: the ankle's, the ball's, the tip's height (world) with the feet flat. */
export function soleHeights (leg: Leg): number[] {
  return [leg.end, leg.ball, leg.tip].map(b => (b === null ? -Infinity : worldP(b).y))
}

/**
 * The hips raised (dy > 0) or lowered by `dy` (world) with the feet where they stand: each leg reaches back to its
 * foot, the foot keeping its turn (flat stays flat). Lowered past where the legs can fold, the hips stop there; raised
 * past where they reach, the feet leave the floor with them (a jump). Returns how far the hips went.
 */
export function moveHips (hips: THREE.Bone, delta: THREE.Vector3, legs: Leg[], opts: { limits?: JointLimits, nameOf: NameOf, floor?: number, soles?: number[][], planted?: Array<{ at: THREE.Vector3, turn: THREE.Quaternion }> }): THREE.Vector3 {
  hips.updateMatrixWorld(true)
  // (where the feet stand: as they are now, or where a drag found them)
  const planted = opts.planted ?? plantedFeet(legs)
  const start = worldP(hips)
  const put = (d: THREE.Vector3): number => {
    const world = start.clone().add(d)
    const local = hips.parent === null ? world : hips.parent.worldToLocal(world)
    hips.position.copy(local)
    hips.updateMatrixWorld(true)
    let miss = 0
    legs.forEach((leg, i) => {
      const left = reach(leg, planted[i].at, { limits: opts.limits, nameOf: opts.nameOf, keepEnd: false })
      setWorldQuaternion(leg.end, planted[i].turn)
      // (short of the foot: the hips too low for the legs to fold so far, or too high to reach)
      miss = Math.max(miss, left)
    })
    return miss
  }
  // down: the deepest the legs allow (halving back from the asked depth when they can't reach their feet); up, the
  // feet come off the floor with them
  let d = delta.clone()
  if (put(d) > 1e-3 && delta.y < 0) {
    let lo = 0; let hi = 1
    for (let k = 0; k < 12; k++) {
      const mid = (lo + hi) / 2
      if (put(delta.clone().multiplyScalar(mid)) > 1e-3) hi = mid; else lo = mid
    }
    d = delta.clone().multiplyScalar(lo)
    put(d)
  }
  if (opts.floor !== undefined) keepOffFloor(legs, opts.floor, opts.soles ?? legs.map(soleHeights), opts)
  return d
}

/** Where each leg's foot is and how it is turned (to keep it there through a crouch). */
export function plantedFeet (legs: Leg[]): Array<{ at: THREE.Vector3, turn: THREE.Quaternion }> {
  return legs.map(l => ({ at: worldP(l.end), turn: worldQ(l.end) }))
}

/** No foot below the floor: a leg whose ankle, ball or toes dip under their heights above the floor at rest
 * (`soles`, from soleHeights with the character standing at rest on `floor`) reaches its foot up by that much, the foot
 * keeping its turn. */
export function keepOffFloor (legs: Leg[], floor: number, soles: number[][], opts: { limits?: JointLimits, nameOf: NameOf }): void {
  legs.forEach((leg, i) => {
    const points = [leg.end, leg.ball, leg.tip]
    let under = 0
    points.forEach((b, k) => {
      if (b === null || !Number.isFinite(soles[i][k])) return
      under = Math.max(under, floor + soles[i][k] - worldP(b).y)
    })
    if (under <= 1e-5) return
    const turn = worldQ(leg.end)
    reach(leg, worldP(leg.end).add(new THREE.Vector3(0, under, 0)), { limits: opts.limits, nameOf: opts.nameOf, keepEnd: false })
    setWorldQuaternion(leg.end, turn)
  })
}
