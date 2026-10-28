// A piece of gear's whole-clip fit (src/state/clipedit.svelte.ts fitPath: "Leads the body" turned on, or a hand put on
// a piece that leads; "the piece" below): one generation over every frame, no gizmo. The piece leads, so the hands on
// it are goals and the body follows them; where those goals ask the body for too much (arms at full stretch or crushed,
// a joint past its range, an elbow bowing, a hand through the torso, the upper body yanked by a fast spear) the PIECE
// moves a little (a smooth offset in the world, from where its path has it) until the body can hold it with room to
// spare, and its motion stays the same motion. Only where there is a pose model (a person): the fit is the
// natural-pose solver's.
//
// The score of a frame with the piece at an offset (FitLab.solve, then `cost`): the natural-pose solver's own objective
// of the body that holds it (src/engine/posespace.ts: the hands' misses, the joints' ranges, the elbow rule, balance, how
// far from the clip's pose and how unnatural the pose is), the arms' reach margin, the body through itself and the
// piece through the body (the character's collider, src/engine/bodycollide.ts), the body's jerk against the neighbouring
// frames' bodies, and how far the piece moved and how unevenly. Candidates are scored with the solver's quick mode (a
// few steps; a full solve is ~45 ms), by a compass search over three world axes (away from the body horizontally,
// sideways, up) from coarse to fine, forward and back through the clip a sweep each so a frame sees its neighbours'
// bodies. The offsets are then smoothed and written as a few keys of the piece's path (smoothCurve, then fewestKeys:
// the fewest keys whose curve reproduces them).
import * as THREE from 'three'
import type { ClipKey } from '../model/types.ts'
import { applyBoneKeys, sampleKeys } from './keys.ts'
import { bonesOf, frameTimes, gearObstacles, GRIP_CLEAR, handGoals, legsOf, onPath, type GearRig } from './clipedit.ts'
import type { BodyCollider } from './bodycollide.ts'
import { wp } from './geom.ts'
import type { JointLimits } from './limits.ts'
import type { PoseRig } from './PoseEditor.ts'
import { BODY, FOLLOW, heading, type BodySolver, type BodyState } from './posespace.ts'

/** The weights of the score (units: the solver's own objective at 1; centimetres squared for the rest). */
export const FIT = {
  /** The hands' miss past `missFree` (cm; the quick solve leaves a few mm), per cm squared: a spot the hands can't reach isn't one. */
  miss: 400, missFree: 0.3,
  /** An arm past this much of its length stretched, or under it folded: per fraction squared. */
  reachHigh: 0.88, reachLow: 0.42, reach: 2500,
  /** A body part through another, the prop through the body: per cm squared. */
  self: 40, prop: 10, propSlack: 1,
  /** A joint out of its range, per joint. */
  limit: 30,
  /** The body's jerk: the mean over the body's joints of the second difference of their world positions (cm) squared, per frame. */
  jerk: 1.2,
  /** How far the prop moved from where its path has it, per (percent of the body's height) squared; and how unevenly (cm squared, against its neighbours' mean). */
  prox: 0.5, smooth: 0.25,
  /** The prop may move this far (shares of the body's height) from where its path has it. */
  maxMove: 0.1,
  /** The search: every this many frames, the first step (a share of the body's height) and how many times it is halved. */
  every: 4, step: 0.03, levels: 2,
  /** A fist's width (shares of the body's height). */
  fist: 0.05,
}

export interface FitInput {
  base: THREE.AnimationClip
  keys: Record<string, ClipKey[]>
  loop: boolean
  rest: (bone: string) => { q: THREE.Quaternion, p: THREE.Vector3 } | null
  /** A copy of the character to pose off stage, with the props on it. */
  posable: THREE.Object3D
  rig: PoseRig
  limits: JointLimits | null
  /** The gear as the edit has it (by gear id): the piece locked, its hands attached (the carrying hand's handle included). */
  gearRig: GearRig
  /** The piece fitted (its gear id). */
  gear: string
  height: number
  /** The body solve (posespace.ts createBodySolver). */
  solver: BodySolver
  /** The character's collider on `posable` (bodycollide.ts colliderFor); none: nothing collides. */
  collider?: BodyCollider | null
  floor?: number
}

export interface Sample {
  /** The solve's state (the next frame follows it, as in the build). */
  state?: BodyState | null
  /** The solver's objective total (null from a plain rule-based solver), the hands' worst miss (cm). */
  obj: number | null
  miss: number
  /** Arms' reach penalty, joints out of range, body through itself (cm), prop through the body (cm). */
  reach: number
  out: number
  self: number
  prop: number
  /** The score of the frame on its own (no neighbours). */
  cost: number
  /** The body joints' world positions (cm), BODY order. */
  pos: Float64Array
}

const fingersOf = (hand: 'Left' | 'Right'): string[] => ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].flatMap(f => [1, 2, 3, 4].map(i => `${hand}Hand${f}${i}`))

/** Every frame of a clip as it stands on the edit before the prop moves, to solve the body on again and again. */
export class FitLab {
  readonly times: number[]
  readonly n: number
  readonly bones: Map<string, THREE.Bone>
  /** The prop's world place on each frame as its path now has it. */
  private readonly places: THREE.Matrix4[] = []
  /** Every locked prop's base place by frame (the other props' paths stay as they are). */
  private readonly rode: Array<Map<string, THREE.Matrix4>> = []
  private readonly snaps: Array<{ q: Float64Array, p: Float64Array }> = []
  private readonly all: THREE.Bone[]
  private readonly legs: ReturnType<typeof legsOf>
  private readonly soles: number[][]
  private readonly keyed: THREE.AnimationClip
  readonly input: FitInput
  /** The body's axes as it faces at the clip's start: away from it, to its left, up. */
  readonly away = new THREE.Vector3(); readonly side = new THREE.Vector3(); readonly up = new THREE.Vector3(0, 1, 0)
  evals = 0

  constructor (input: FitInput) {
    this.input = input
    const { base, keys, loop, rest, posable, rig, gearRig: props, gear: prop } = input
    this.keyed = applyBoneKeys(base, keys, loop, rest)
    this.bones = bonesOf(posable)
    this.all = [...this.bones.values()]
    this.legs = legsOf(this.bones, rig)
    this.times = frameTimes(this.keyed.duration)
    this.n = this.times.length
    const floor = input.floor ?? 0
    // (the soles' heights at rest above the floor)
    const saved = this.all.map(b => [b, b.position.clone(), b.quaternion.clone()] as const)
    for (const b of this.all) { const r = rest(b.name); if (r !== null) { b.quaternion.copy(r.q); b.position.copy(r.p) } }
    posable.updateMatrixWorld(true)
    const v = new THREE.Vector3()
    this.soles = this.legs.map(l => [l.end, l.ball, l.tip].map(b => (b === null ? -Infinity : b.getWorldPosition(v).y - floor)))
    for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
    const mixer = new THREE.AnimationMixer(posable)
    const pose = (clip: THREE.AnimationClip, t: number): void => {
      mixer.stopAllAction()
      const a = mixer.clipAction(clip)
      a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true
      a.reset(); a.play()
      mixer.setTime(t)
      posable.updateMatrixWorld(true)
    }
    const locked = Object.keys(props.paths).filter(p => props.paths[p].locked)
    for (let i = 0; i < this.n; i++) {
      const t = this.times[i]; const u = this.keyed.duration > 0 ? t / this.keyed.duration : 0
      pose(base, t)
      const rode = new Map(locked.map(p => [p, posable.getObjectByName(props.node(p))?.matrixWorld.clone()]).filter((x): x is [string, THREE.Matrix4] => x[1] !== undefined))
      this.rode.push(rode)
      const was = rode.get(prop)
      // (the prop's place on this frame as its path has it, the fit's offsets on top of it)
      this.places.push(was === undefined ? new THREE.Matrix4() : onPath(was, props.paths[prop] ?? { locked: true, keys: [] }, u, loop))
      pose(this.keyed, t)
      const q = new Float64Array(this.all.length * 4); const p = new Float64Array(this.all.length * 3)
      this.all.forEach((b, k) => { b.quaternion.toArray(q, k * 4); b.position.toArray(p, k * 3) })
      this.snaps.push({ q, p })
    }
    mixer.stopAllAction(); mixer.uncacheRoot(posable)
    for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
    posable.updateMatrixWorld(true)
    this.restore(0)
    const yaw = heading(this.bones.get(rig.hips)?.getWorldQuaternion(new THREE.Quaternion()) ?? new THREE.Quaternion())
    this.away.set(Math.sin(yaw), 0, Math.cos(yaw))
    this.side.crossVectors(this.up, this.away).normalize()
  }

  /** The body as the edit has it on frame `i` (before any fit). */
  restore (i: number): void {
    const { q, p } = this.snaps[i]
    this.all.forEach((b, k) => { b.quaternion.fromArray(q, k * 4); b.position.fromArray(p, k * 3) })
    this.input.posable.updateMatrixWorld(true)
  }

  /** The prop's shaft at `place` as the obstacles the body keeps clear of (but where `rig`'s hands hold it). */
  obstaclesAt (rig: GearRig, place: THREE.Matrix4): ReturnType<typeof gearObstacles> {
    const { gear: prop, height } = this.input
    return gearObstacles({ ...rig, paths: { [prop]: { locked: true, keys: [] } } }, p => (p === prop ? place : null), GRIP_CLEAR * height)
  }

  /** How deep (cm) the prop is in the body on frame `i` as the edit has it before any solve (the prop where its path has it). */
  rawDepth (i: number): number {
    const collider = this.input.collider
    if (collider === undefined || collider === null) return 0
    this.restore(i)
    let worst = 0
    for (const o of this.obstaclesAt(this.input.gearRig, this.places[i])) worst = Math.max(worst, collider.penetration(o.from, o.to, o.radius, o.ignore) * 100)
    return worst
  }

  /** The prop's place on frame `i` as its path has it now (the fit's offset not yet on it). */
  placeAt (i: number): THREE.Matrix4 { return this.places[i] }

  /** Solve frame `i` (quickly) with the prop moved by `offset` (world) from where its path has it. */
  solve (i: number, offset: THREE.Vector3, opts: { prev?: BodyState | null } = {}): Sample {
    const { posable, gearRig: props, gear: prop, loop, height, limits, solver } = this.input
    this.evals++
    this.restore(i)
    const t = this.times[i]; const u = this.keyed.duration > 0 ? t / this.keyed.duration : 0
    const rode = new Map(this.rode[i]); rode.set(prop, this.places[i])
    const rig: GearRig = { ...props, paths: { ...props.paths, [prop]: { locked: true, keys: [{ u: 0, q: [0, 0, 0, 1], p: offset.toArray() as [number, number, number] }] } } }
    const goals = handGoals(posable, this.bones, rig, u, loop, rode)
    const nameOf = (b: THREE.Bone): string => b.name
    // (the prop where this offset puts it is solid, as in the edit's own solve: the body keeps clear of it but where the hands hold it)
    const place = this.places[i].clone().premultiply(new THREE.Matrix4().makeTranslation(offset.x, offset.y, offset.z))
    const obstacles = this.obstaclesAt(rig, place)
    const res = goals.length === 0 ? null : solver(this.bones, goals, { limits, nameOf, legs: this.legs, height, floor: this.input.floor ?? 0, soles: this.soles, quick: true, obstacles, follow: opts.prev === undefined || opts.prev === null ? undefined : FOLLOW.weight }, opts.prev ?? null)
    posable.updateMatrixWorld(true)
    const obj = res?.state.objective?.end.total ?? null
    const at = (n: string): THREE.Vector3 => wp(this.bones.get(n)!)
    const pos = new Float64Array(BODY.length * 3)
    BODY.forEach((n, k) => { if (this.bones.has(n)) at(n).multiplyScalar(100).toArray(pos, k * 3) })
    // (the hands' reach: how much of its arm's length each is stretched, and past what is easy)
    let reach = 0
    for (const g of goals) {
      const s = at(`${g.hand}Arm`); const e = at(`${g.hand}ForeArm`); const h = at(`${g.hand}Hand`)
      const r = s.distanceTo(h) / Math.max(s.distanceTo(e) + e.distanceTo(h), 1e-6)
      reach += Math.max(0, r - FIT.reachHigh) ** 2 + Math.max(0, FIT.reachLow - r) ** 2
    }
    let out = 0
    if (limits !== null) for (const n of BODY) { const b = this.bones.get(n); if (b !== undefined && n !== this.input.rig.hips && limits.has(n) && !limits.within(n, b.quaternion)) out++ }
    const collider = this.input.collider ?? null
    const self = (collider?.selfPenetration().worst ?? 0) * 100
    // (the piece through the body: its shaft but where the hands hold it)
    let prp = 0
    if (collider !== null) for (const o of obstacles) prp = Math.max(prp, collider.penetration(o.from, o.to, o.radius, [...(o.ignore ?? []), ...goals.flatMap(g => fingersOf(g.hand))]) * 100)
    const miss = (res?.miss ?? 0) * 100
    const slack = Math.max(0, prp - FIT.propSlack)
    const over = Math.max(0, miss - FIT.missFree)
    const cost = (obj ?? 0) + FIT.miss * over * over + FIT.reach * reach + FIT.limit * out + FIT.self * self * self + FIT.prop * slack * slack
    return { state: res?.state ?? null, obj, miss, reach, out, self, prop: prp, cost, pos }
  }
}

export interface FitResult {
  /** The offsets by frame (world metres) and the keys that carry them (on top of the prop's path as it was). */
  offsets: THREE.Vector3[]
  keys: ClipKey[]
  /** What the fit did: the clip's total score before and after (quick solves), evaluations, milliseconds, the frames it moved. */
  before: number
  after: number
  evals: number
  ms: number
  moved: number
  maxMove: number
}

const yieldUi = (): Promise<void> => new Promise(r => setTimeout(r, 0))

/** The whole-clip fit of the prop (see the header): offsets at every few frames, written as keys. */
export async function fitProp (input: FitInput, progress: (label: string) => void = () => {}): Promise<FitResult> {
  const t0 = performance.now()
  const lab = new FitLab(input)
  const n = lab.n
  const duration = input.base.duration
  const cm = input.height * 0.01
  // (the frames searched: every FIT.every-th and the last; and every frame where the prop starts out in the body, with its
  // neighbours, so a strike between the every-th frames is seen; a solve is tens of milliseconds, the rest follow the keys' curve)
  const picked = new Set<number>()
  for (let i = 0; i < n; i += FIT.every) picked.add(i)
  picked.add(n - 1)
  for (let i = 0; i < n; i++) if (lab.rawDepth(i) > FIT.propSlack) for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < n) picked.add(j)
  const at = [...picked].sort((a, b) => a - b)
  const O = at.map(() => new THREE.Vector3())
  progress('Fitting the prop: the clip as it stands')
  const S: Sample[] = []
  // (each searched frame solved after the one before it, following it, as the build solves its frames in turn)
  for (let k = 0; k < at.length; k++) { S.push(lab.solve(at[k], O[k], { prev: S[k - 1]?.state })); if (k % 4 === 3) await yieldUi() }
  const before = S.reduce((a, x) => a + x.cost, 0)
  const reachMax = input.height * FIT.maxMove
  // (a frame's whole score with the prop at `o`: its own, how far it moved and how unevenly against the neighbouring keys)
  // (the body's jerk on a searched frame against its searched neighbours' bodies: the second difference per frame squared,
  // the frames apart however far they are, the mean over the joints)
  const jerkOf = (k: number, pos: Float64Array): number => {
    const a = S[k - 1]; const b = S[k + 1]
    if (a === undefined || b === undefined) return 0
    const h0 = at[k] - at[k - 1]; const h1 = at[k + 1] - at[k]
    let sum = 0; let joints = 0
    for (let j = 0; j < pos.length; j += 3) {
      if (pos[j] === 0 && pos[j + 1] === 0 && pos[j + 2] === 0) continue
      for (let d = 0; d < 3; d++) { const acc = 2 * ((b.pos[j + d] - pos[j + d]) / h1 - (pos[j + d] - a.pos[j + d]) / h0) / (h0 + h1); sum += acc * acc }
      joints++
    }
    return joints === 0 ? 0 : sum / joints
  }
  const scoreOf = (k: number, o: THREE.Vector3, sample: Sample): number => {
    const mid = O[k - 1] !== undefined && O[k + 1] !== undefined ? O[k - 1].clone().add(O[k + 1]).multiplyScalar(0.5) : (O[k - 1] ?? O[k + 1])
    const uneven = mid === undefined ? 0 : o.distanceTo(mid) / cm
    return sample.cost + FIT.prox * (o.length() / input.height * 100) ** 2 + FIT.smooth * uneven * uneven + FIT.jerk * jerkOf(k, sample.pos)
  }
  const axes = [lab.away, lab.side, lab.up]
  for (let k = 0; k < at.length; k++) {
    progress(`Fitting the prop: frame ${at[k] + 1} of ${n}`)
    let best = O[k].clone(); let bestS = S[k]; let bestScore = scoreOf(k, best, bestS)
    // (the last key's offset is a good start too)
    if (k > 0 && O[k - 1].distanceTo(best) > 0.2 * cm) {
      const sample = lab.solve(at[k], O[k - 1], { prev: S[k - 1]?.state }); const c = scoreOf(k, O[k - 1], sample)
      if (c < bestScore) { best = O[k - 1].clone(); bestS = sample; bestScore = c }
    }
    let step = input.height * FIT.step
    for (let level = 0; level < FIT.levels; level++, step /= 2) {
      for (const axis of axes) {
        for (const sign of [1, -1]) {
          const o = best.clone().addScaledVector(axis, sign * step)
          if (o.length() > reachMax) continue
          const sample = lab.solve(at[k], o, { prev: S[k - 1]?.state }); const c = scoreOf(k, o, sample)
          if (c < bestScore - 1e-6) { best = o; bestS = sample; bestScore = c; break }
        }
      }
    }
    O[k].copy(best); S[k] = bestS
    await yieldUi()
  }
  const after = S.reduce((a, x) => a + x.cost, 0)
  // (the offsets on every frame: a smooth curve through the searched ones, near each, its bend from frame to frame kept
  // small (each searched on its own, they wobble); then the path as it was plus that curve written as the fewest keys
  // whose curve follows it to KEYS.tol: a few keys that tween, not one per frame)
  const existing = input.gearRig.paths[input.gear]?.keys ?? []
  const curve = smoothCurve(n, at, O, KEYS.bend)
  const uOf = (i: number): number => (duration > 0 ? lab.times[i] / duration : 0)
  const want = lab.times.map((_, i) => {
    const e = existing.length === 0 ? null : sampleKeys(existing, uOf(i), input.loop)
    return { p: (e?.p ?? new THREE.Vector3()).clone().add(curve[i]), q: e?.q ?? new THREE.Quaternion() }
  })
  const moves = curve.some(o => o.length() > 0.0015)
  const keys: ClipKey[] = moves || existing.length > 0 ? fewestKeys(want, uOf, input.loop, KEYS.tol * input.height, KEYS.most) : []
  const offsets = lab.times.map((_, i) => {
    if (keys.length === 0) return new THREE.Vector3()
    const e = existing.length === 0 ? new THREE.Vector3() : sampleKeys(existing, uOf(i), input.loop).p
    return sampleKeys(keys, uOf(i), input.loop).p.sub(e)
  })
  return { offsets, keys, before, after, evals: lab.evals, ms: performance.now() - t0, moved: offsets.filter(o => o.length() > 0.002).length, maxMove: Math.max(0, ...offsets.map(o => o.length())) }
}

/** The fit's keys: how much the offsets' curve may bend between frames (against how near it stays to the searched
 * offsets), how near the keys' curve must follow the path (a share of the body's height) and the most keys. */
export const KEYS = { bend: 6, tol: 0.003, most: 12 }

/** A smooth curve over frames 0..n-1 near the values at frames `at` (a smoothing spline: the squared misses plus `bend`
 * times the squared second differences, least). */
export function smoothCurve (n: number, at: number[], values: THREE.Vector3[], bend: number): THREE.Vector3[] {
  const A = Array.from({ length: n }, () => new Float64Array(n))
  const rhs = [new Float64Array(n), new Float64Array(n), new Float64Array(n)]
  at.forEach((i, k) => { A[i][i] += 1; const v = values[k].toArray(); for (let d = 0; d < 3; d++) rhs[d][i] += v[d] })
  for (let i = 1; i < n - 1; i++) {
    const idx = [i - 1, i, i + 1]; const c = [1, -2, 1]
    for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) A[idx[a]][idx[b]] += bend * c[a] * c[b]
  }
  // (a frame with no value and no neighbours to bend against stays where its neighbours put it: a tiny pull to 0 keeps the system solvable)
  for (let i = 0; i < n; i++) A[i][i] += 1e-9
  const x = rhs.map(r => solveDense(A.map(row => Float64Array.from(row)), Float64Array.from(r)))
  return Array.from({ length: n }, (_, i) => new THREE.Vector3(x[0][i], x[1][i], x[2][i]))
}

function solveDense (A: Float64Array[], b: Float64Array): Float64Array {
  const n = b.length
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    if (p !== c) { [A[p], A[c]] = [A[c], A[p]]; [b[p], b[c]] = [b[c], b[p]] }
    const d = A[c][c]
    if (Math.abs(d) < 1e-15) continue
    for (let r = c + 1; r < n; r++) { const f = A[r][c] / d; if (f === 0) continue; for (let k = c; k < n; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c] }
  }
  const x = new Float64Array(n)
  for (let r = n - 1; r >= 0; r--) { let s = b[r]; for (let k = r + 1; k < n; k++) s -= A[r][k] * x[k]; x[r] = Math.abs(A[r][r]) < 1e-15 ? 0 : s / A[r][r] }
  return x
}

/** The fewest keys (at frames, the first and last always) whose curve (sampleKeys, as the editor tweens) follows `want`
 * on every frame to `tol` metres (and a degree): the frame it misses most gets the next key. */
export function fewestKeys (want: Array<{ p: THREE.Vector3, q: THREE.Quaternion }>, uOf: (i: number) => number, loop: boolean, tol: number, most: number): ClipKey[] {
  const n = want.length
  const keyAt = (i: number): ClipKey => ({ u: uOf(i), q: want[i].q.toArray().map(v => Math.round(v * 1e6) / 1e6) as ClipKey['q'], p: want[i].p.toArray().map(v => Math.round(v * 1e5) / 1e5) as [number, number, number] })
  const chosen = new Set<number>([0, n - 1])
  for (;;) {
    const keys = [...chosen].sort((a, b) => a - b).map(keyAt)
    let worst = -1; let at = -1
    for (let i = 0; i < n; i++) {
      if (chosen.has(i)) continue
      const s = sampleKeys(keys, uOf(i), loop)
      const miss = Math.max(s.p.distanceTo(want[i].p) / tol, s.q.angleTo(want[i].q) / THREE.MathUtils.degToRad(1))
      if (miss > worst) { worst = miss; at = i }
    }
    if (worst <= 1 || at < 0 || chosen.size >= most) return keys
    chosen.add(at)
  }
}
