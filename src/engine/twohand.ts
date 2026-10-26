// Both hands on one prop (a spear held two-handed), the whole body taking part: on each frame the prop stays where the
// clip has it (riding the hand that carries it), the other hand's fist is put on it (src/engine/clipedit.ts Hold), and
// the body turns and leans to let both arms reach: the hips and the spine share the turn (the feet kept where they
// stand: the legs reach back to them), the hand that carries the prop is put back on it, the other arm reaches its
// grip, its hand rolled round the shaft to the straightest wrist. The turn and lean are searched (the arms' misses, how
// straight or crushed the arms are, the wrists' bend, and how far and how suddenly the body turns), so the body squares
// to the shaft only as much as the grip needs. A grip still out of reach: the carrying hand gives way along the shaft
// (both hands keep it: a one-handed thrust held two-handed reaches as far as two arms can).
import * as THREE from 'three'
import { reach, setWorldQuaternion, type Leg, type NameOf } from './ik.ts'
import type { JointLimits } from './limits.ts'

export interface TwoHandHold {
  hand: 'Left' | 'Right'
  /** The bone carrying the prop (the other hand). */
  bone: string
  /** The fist's middle on the shaft, and the shaft's direction (towards its far end), in the carrier's frame. */
  fist: [number, number, number]
  shaft: [number, number, number]
  /** The hand's turn relative to the carrier when it was locked (its roll round the shaft is free from there). */
  turn: [number, number, number, number]
  /** The fist's middle in the hand's own frame (from the wrist). */
  fistOffset: [number, number, number]
  /** The hand's fingers closed round it. */
  fingers?: Record<string, [number, number, number, number]>
}

export interface BodyTurn { yaw: number, lean: number }

const SHARE_YAW: Array<[string, number]> = [['Hips', 0.2], ['Spine', 0.25], ['Spine1', 0.3], ['Spine2', 0.25]]
const SHARE_LEAN: Array<[string, number]> = [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]]
const deg = THREE.MathUtils.degToRad

const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())

/** Turn `bone` by `q` (world), about its own origin. */
function turnWorld (bone: THREE.Object3D, q: THREE.Quaternion): void {
  setWorldQuaternion(bone, q.clone().multiply(wq(bone)))
}

function arm (bones: Map<string, THREE.Bone>, side: 'Left' | 'Right'): { upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone } | null {
  const upper = bones.get(`${side}Arm`); const lower = bones.get(`${side}ForeArm`); const end = bones.get(`${side}Hand`)
  return upper === undefined || lower === undefined || end === undefined ? null : { upper, lower, end }
}

/** How a solved arm sits: 0 at ease; up as it locks straight, folds tight, or the wrist bends far from the forearm. */
function strain (a: { upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone }): number {
  const s = wp(a.upper); const e = wp(a.lower); const h = wp(a.end)
  const reach = s.distanceTo(h) / Math.max(s.distanceTo(e) + e.distanceTo(h), 1e-6)
  const straight = Math.max(0, reach - 0.93) * 12
  const folded = Math.max(0, 0.45 - reach) * 4
  const fore = h.clone().sub(e).normalize()
  const handDir = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(a.end))
  const wrist = Math.max(0, fore.angleTo(handDir) - deg(45))
  return straight + folded + wrist
}

export interface TwoHandOptions { limits: JointLimits | null, nameOf: NameOf, legs: Leg[], /** only round the last frame's turn (a drag, live) */ quick?: boolean }

/**
 * Solve one frame, the body as it stands (the clip's pose, keyed): both hands on the prop. `prev`: the last frame's turn
 * (kept near). Returns the turn taken and the worst miss left.
 */
export function holdTwoHanded (bones: Map<string, THREE.Bone>, hold: TwoHandHold, opts: TwoHandOptions, prev: BodyTurn | null): { turn: BodyTurn, miss: number } {
  const side = /^(Left|Right)Hand$/.exec(hold.bone)?.[1] as 'Left' | 'Right' | undefined
  const carrier = bones.get(hold.bone)
  const own = arm(bones, hold.hand)
  const other = side === undefined || side === hold.hand ? null : arm(bones, side)
  const hips = bones.get('Hips')
  if (carrier === undefined || own === null || hips === undefined) return { turn: { yaw: 0, lean: 0 }, miss: 0 }
  // the body as the clip has it: what each try starts from
  const touched = [...new Set([...SHARE_YAW.map(([n]) => n), ...SHARE_LEAN.map(([n]) => n), `${hold.hand}Shoulder`,
    ...Object.values(own).map(b => b.name), ...(other !== null ? Object.values(other).map(b => b.name) : []),
    ...opts.legs.flatMap(l => [l.upper.name, l.lower.name, l.end.name])])].map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined)
  const start = touched.map(b => [b, b.quaternion.clone(), b.position.clone()] as const)
  const restore = (): void => { for (const [b, q, p] of start) { b.quaternion.copy(q); b.position.copy(p) } hips.updateMatrixWorld(true) }
  hips.updateMatrixWorld(true)
  // what stays put: the prop (its carrier's world frame), the feet
  const prop = carrier.matrixWorld.clone()
  const propTurn = wq(carrier)
  const feet = opts.legs.map(l => ({ at: wp(l.end), turn: wq(l.end) }))
  const fist = new THREE.Vector3(...hold.fist).applyMatrix4(prop)
  const shaft = new THREE.Vector3(...hold.shaft).transformDirection(prop)
  const lockedTurn = propTurn.clone().multiply(new THREE.Quaternion(...hold.turn))
  const fistOffset = new THREE.Vector3(...hold.fistOffset)
  const up = new THREE.Vector3(0, 1, 0)
  const nameOf = opts.nameOf; const limits = opts.limits ?? undefined

  /** Pose the body with this turn; both arms on the prop. Returns [miss, cost]. */
  const pose = (t: BodyTurn, finalRoll: boolean): [number, number] => {
    restore()
    const across = wp(bones.get('LeftArm') ?? hips).sub(wp(bones.get('RightArm') ?? hips)); across.y = 0
    const lateral = across.lengthSq() > 1e-8 ? across.normalize() : new THREE.Vector3(1, 0, 0)
    for (const [n, k] of SHARE_YAW) { const b = bones.get(n); if (b !== undefined) turnWorld(b, new THREE.Quaternion().setFromAxisAngle(up, t.yaw * k)) }
    for (const [n, k] of SHARE_LEAN) { const b = bones.get(n); if (b !== undefined) turnWorld(b, new THREE.Quaternion().setFromAxisAngle(lateral, t.lean * k)) }
    // the feet back where they stand
    opts.legs.forEach((l, i) => { reach(l, feet[i].at, { limits, nameOf, keepEnd: false }); setWorldQuaternion(l.end, feet[i].turn) })
    // the carrying hand back on the prop, exactly as it was
    let miss = 0
    if (other !== null) {
      miss = Math.max(miss, reach(other, new THREE.Vector3().setFromMatrixPosition(prop), { limits, nameOf, keepEnd: false }))
      setWorldQuaternion(other.end, propTurn)
    }
    // the other hand's fist on the shaft, its roll round the shaft the straightest wrist's (a few tried at the end)
    const rolls = finalRoll ? [-90, -60, -30, 0, 30, 60, 90] : [0]
    let best: { miss: number, cost: number, q: THREE.Quaternion[] } | null = null
    const ownStart = Object.values(own).map(b => b.quaternion.clone())
    for (const r of rolls) {
      Object.values(own).forEach((b, i) => b.quaternion.copy(ownStart[i])); own.upper.updateMatrixWorld(true)
      const turn = new THREE.Quaternion().setFromAxisAngle(shaft, deg(r)).multiply(lockedTurn)
      const wrist = fist.clone().sub(fistOffset.clone().applyQuaternion(turn))
      const m = reach(own, wrist, { limits, nameOf, keepEnd: false })
      setWorldQuaternion(own.end, turn)
      const c = strain(own) + Math.abs(r) / 180
      if (best === null || m * 40 + c < best.miss * 40 + best.cost) best = { miss: m, cost: c, q: Object.values(own).map(b => b.quaternion.clone()) }
    }
    Object.values(own).forEach((b, i) => b.quaternion.copy(best!.q[i])); own.upper.updateMatrixWorld(true)
    miss = Math.max(miss, best!.miss)
    const cost = miss * 40 + best!.cost + (other !== null ? strain(other) : 0) +
      0.6 * (t.yaw * t.yaw + t.lean * t.lean) + (prev === null ? 0 : 3 * ((t.yaw - prev.yaw) ** 2 + (t.lean - prev.lean) ** 2))
    return [miss, cost]
  }

  // search: coarse, then round the best
  let best = { t: prev ?? { yaw: 0, lean: 0 }, cost: Infinity, miss: Infinity }
  const tryTurn = (t: BodyTurn): void => { const [m, c] = pose(t, false); if (c < best.cost) best = { t, cost: c, miss: m } }
  tryTurn(best.t)
  if (opts.quick !== true) for (let y = -60; y <= 60; y += 15) for (const l of [-10, 0, 10, 20]) tryTurn({ yaw: deg(y), lean: deg(l) })
  for (const step of opts.quick === true ? [4] : [6, 2]) {
    const c = best.t
    for (const dy of [-1, 0, 1]) for (const dl of [-1, 0, 1]) tryTurn({ yaw: c.yaw + deg(step * dy), lean: c.lean + deg(step * dl) })
  }
  let [miss] = pose(best.t, true)
  // still out of reach: the carrying hand gives way along to where the other can hold
  for (let round = 0; round < 10 && miss > 0.005 && other !== null; round++) {
    const turn = wq(own.end)
    const gap = wp(own.end).add(fistOffset.clone().applyQuaternion(turn)).sub(new THREE.Vector3(...hold.fist).applyMatrix4(carrier.matrixWorld))
    reach(other, wp(other.end).add(gap), { nameOf, keepEnd: true, endFree: true })
    carrier.updateMatrixWorld(true)
    const f2 = new THREE.Vector3(...hold.fist).applyMatrix4(carrier.matrixWorld)
    miss = reach(own, f2.sub(fistOffset.clone().applyQuaternion(turn)), { nameOf, keepEnd: false })
    setWorldQuaternion(own.end, turn)
  }
  for (const [name, q] of Object.entries(hold.fingers ?? {})) { const b = bones.get(name); if (b !== undefined) { b.quaternion.set(...q); b.updateMatrixWorld(true) } }
  return { turn: best.t, miss }
}

/** The bones a two-handed hold moves (to bake their tracks). */
export function twoHandBones (hold: TwoHandHold, legs: Leg[]): string[] {
  const side = /^(Left|Right)Hand$/.exec(hold.bone)?.[1]
  return [...new Set([...SHARE_YAW.map(([n]) => n), ...SHARE_LEAN.map(([n]) => n), `${hold.hand}Shoulder`,
    `${hold.hand}Arm`, `${hold.hand}ForeArm`, `${hold.hand}Hand`, ...(side !== undefined && side !== hold.hand ? [`${side}Arm`, `${side}ForeArm`, `${side}Hand`] : []),
    ...legs.flatMap(l => [l.upper.name, l.lower.name, l.end.name]), ...Object.keys(hold.fingers ?? {})])]
}
