// The whole body reaching for its hands' goals (a spear's sockets as the spear moves, src/state/clipedit.svelte.ts): on
// a frame as the clip has it, each hand with a goal (a world place and turn) reaches it, the feet kept where they stand,
// and the body turns, leans, lunges and drops to let the arms reach at ease. The four are searched (the hands' misses,
// how straight or folded the arms are, the wrists' bend, and how far and how suddenly the body moves), so the body
// follows the hands only as much as they need. (The search stands in for the library's natural-pose solver, being
// built: the goals and what it returns stay the same.)
import * as THREE from 'three'
import { moveHips, reach, setWorldQuaternion, type Leg, type NameOf } from './ik.ts'
import type { JointLimits } from './limits.ts'

export interface HandGoal {
  hand: 'Left' | 'Right'
  at: THREE.Vector3
  turn: THREE.Quaternion
  /** The hand's fingers (local turns) while it holds. */
  fingers?: Record<string, [number, number, number, number]>
  /** Where the hand holds a shaft (src/engine/clipedit.ts Grip: the hold point and the shaft's line through it, in the wrist's own turn, from the wrist, world units). The natural solver keeps this point on its goal (`at` + `turn` carrying it), and lets the turn give about it. */
  grip?: { axis: THREE.Vector3, fist: THREE.Vector3 }
  /** Held exactly (its socket put there by hand): its place and turn as given, no give. */
  exact?: boolean
  /** A hand on a leading prop's shaft: it may slide along it (`dir`, world, unit) from `back` (metres, negative) to `ahead`,
   * at a cost, and its turn gives, so at an extreme it gives on the prop before its wrist bends past its range. */
  slide?: { dir: THREE.Vector3, back: number, ahead: number }
}

export interface BodyState { yaw: number, lean: number, forward: number, drop: number }

const SHARE_YAW: Array<[string, number]> = [['Hips', 0.2], ['Spine', 0.25], ['Spine1', 0.3], ['Spine2', 0.25]]
const SHARE_LEAN: Array<[string, number]> = [['Spine', 0.3], ['Spine1', 0.35], ['Spine2', 0.35]]
const deg = THREE.MathUtils.degToRad
const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
const turnWorld = (b: THREE.Object3D, q: THREE.Quaternion): void => { setWorldQuaternion(b, q.clone().multiply(wq(b))) }

function armOf (bones: Map<string, THREE.Bone>, side: 'Left' | 'Right'): { upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone } | null {
  const upper = bones.get(`${side}Arm`); const lower = bones.get(`${side}ForeArm`); const end = bones.get(`${side}Hand`)
  return upper === undefined || lower === undefined || end === undefined ? null : { upper, lower, end }
}

/** 0 at ease; up as the arm locks straight or folds tight, or the wrist bends far off the forearm. */
function strain (a: { upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone }): number {
  const s = wp(a.upper); const e = wp(a.lower); const h = wp(a.end)
  const r = s.distanceTo(h) / Math.max(s.distanceTo(e) + e.distanceTo(h), 1e-6)
  const fore = h.clone().sub(e).normalize()
  const hand = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(a.end))
  return Math.max(0, r - 0.93) * 12 + Math.max(0, 0.45 - r) * 4 + Math.max(0, fore.angleTo(hand) - deg(45))
}

export interface SolveOptions {
  limits: JointLimits | null
  nameOf: NameOf
  legs: Leg[]
  /** The body's height (the lunge and drop are shares of it). */
  height: number
  /** Only round the last frame's state (a drag, live). */
  quick?: boolean
}

/** The bones the solve moves (to bake their tracks). */
export function bodyBones (goals: Array<{ hand: 'Left' | 'Right', fingers?: Record<string, unknown> }>, legs: Leg[]): string[] {
  return [...new Set([...SHARE_YAW.map(([n]) => n), ...SHARE_LEAN.map(([n]) => n),
    ...goals.flatMap(g => [`${g.hand}Shoulder`, `${g.hand}Arm`, `${g.hand}ForeArm`, `${g.hand}Hand`, ...Object.keys(g.fingers ?? {})]),
    ...legs.flatMap(l => [l.upper.name, l.lower.name, l.end.name])])]
}

/** Solve one frame (the body as it stands). `prev`: the last frame's state (kept near). Returns the state taken and the
 * worst miss left (world units). */
export function solveBody (bones: Map<string, THREE.Bone>, goals: HandGoal[], opts: SolveOptions, prev: BodyState | null): { state: BodyState, miss: number } {
  const hips = bones.get('Hips')
  const arms = goals.map(g => armOf(bones, g.hand))
  const zero = { yaw: 0, lean: 0, forward: 0, drop: 0 }
  if (hips === undefined || goals.length === 0 || arms.some(a => a === null)) return { state: prev ?? zero, miss: 0 }
  const touched = bodyBones(goals, opts.legs).map(n => bones.get(n)).filter((b): b is THREE.Bone => b !== undefined)
  const start = touched.map(b => [b, b.quaternion.clone(), b.position.clone()] as const)
  const restore = (): void => { for (const [b, q, p] of start) { b.quaternion.copy(q); b.position.copy(p) } hips.updateMatrixWorld(true) }
  hips.updateMatrixWorld(true)
  const feet = opts.legs.map(l => ({ at: wp(l.end), turn: wq(l.end) }))
  const up = new THREE.Vector3(0, 1, 0)
  const across = wp(bones.get('LeftArm') ?? hips).sub(wp(bones.get('RightArm') ?? hips)); across.y = 0
  const lateral = across.lengthSq() > 1e-8 ? across.normalize() : new THREE.Vector3(1, 0, 0)
  const ahead = new THREE.Vector3().crossVectors(lateral, up).normalize()
  const nameOf = opts.nameOf; const limits = opts.limits ?? undefined
  const H = opts.height

  const pose = (s: BodyState): [number, number] => {
    restore()
    // the hips: forward (a lunge) and down (a crouch), the feet kept; then the turn and lean up the spine
    if (Math.abs(s.forward) > 1e-6 || Math.abs(s.drop) > 1e-6) moveHips(hips, ahead.clone().multiplyScalar(s.forward * H).add(new THREE.Vector3(0, -s.drop * H, 0)), opts.legs, { limits, nameOf, planted: feet })
    for (const [n, k] of SHARE_YAW) { const b = bones.get(n); if (b !== undefined) turnWorld(b, new THREE.Quaternion().setFromAxisAngle(up, s.yaw * k)) }
    for (const [n, k] of SHARE_LEAN) { const b = bones.get(n); if (b !== undefined) turnWorld(b, new THREE.Quaternion().setFromAxisAngle(lateral, s.lean * k)) }
    opts.legs.forEach((l, i) => { reach(l, feet[i].at, { limits, nameOf, keepEnd: false }); setWorldQuaternion(l.end, feet[i].turn) })
    let miss = 0; let cost = 0
    goals.forEach((g, i) => {
      const a = arms[i]!
      miss = Math.max(miss, reach(a, g.at, { limits, nameOf, keepEnd: false }))
      setWorldQuaternion(a.end, g.turn)
      cost += strain(a)
    })
    cost += miss * 40 + 0.6 * (s.yaw ** 2 + s.lean ** 2) + 8 * (s.forward ** 2 + s.drop ** 2)
    if (prev !== null) cost += 3 * ((s.yaw - prev.yaw) ** 2 + (s.lean - prev.lean) ** 2) + 30 * ((s.forward - prev.forward) ** 2 + (s.drop - prev.drop) ** 2)
    return [miss, cost]
  }

  let best = { s: prev ?? zero, cost: Infinity, miss: Infinity }
  const tryState = (s: BodyState): void => { const [m, c] = pose(s); if (c < best.cost) best = { s, cost: c, miss: m } }
  tryState(best.s)
  if (opts.quick !== true) {
    for (let y = -60; y <= 60; y += 15) for (const l of [-10, 0, 10, 20]) tryState({ ...best.s, yaw: deg(y), lean: deg(l) })
    for (const f of [-0.1, 0, 0.1, 0.2]) for (const d of [0, 0.05, 0.12]) tryState({ ...best.s, forward: f, drop: d })
  }
  for (const step of opts.quick === true ? [1] : [2, 0.6]) {
    const c = best.s
    for (const dy of [-1, 0, 1]) for (const dl of [-1, 0, 1]) tryState({ ...c, yaw: c.yaw + deg(5 * step * dy), lean: c.lean + deg(5 * step * dl) })
    const c2 = best.s
    for (const df of [-1, 0, 1]) for (const dd of [-1, 0, 1]) tryState({ ...c2, forward: c2.forward + 0.03 * step * df, drop: Math.max(0, c2.drop + 0.02 * step * dd) })
  }
  const [miss] = pose(best.s)
  for (const g of goals) for (const [name, q] of Object.entries(g.fingers ?? {})) { const b = bones.get(name); if (b !== undefined) { b.quaternion.set(...q); b.updateMatrixWorld(true) } }
  return { state: best.s, miss }
}
