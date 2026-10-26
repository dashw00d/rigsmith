// Natural movement, learned from the library's motion captures: how a body's joints move TOGETHER (turn the chest and
// the shoulders and head follow; raise an arm and the collarbone lifts and the torso leans), as a linear model of the
// pose, and a solver that reaches goals (a hand on a point, a fist on a shaft, a foot staying put) with the most
// natural whole-body pose nearest the one it starts from.
//
// The model (static/templates/rom/human-pose.json, built by tools/posespace.ts): a pose is the local turn of each of 22
// body bones from the Y Bot's rest (a rotation vector, 3 numbers; the hips' own turn with its heading taken out, so
// facing doesn't matter), 66 numbers; PCA over every frame of the library (and its mirror image) gives a mean and
// components, each with how much it varies (its variance). A character's bones map onto it by the retarget's turns K
// (src/engine/retarget.ts retargetOffsets: Qcharacter = Qsource * K, so a local turn lt is ls = Kp * lt * Kb^-1).
//
// The solver (NaturalRig.solve) is a damped least-squares (Levenberg-Marquardt) over the pose in WHITENED coordinates
// (z_j = coefficient / its spread: moving one unit along any component is one 'standard deviation' of natural variation):
//   goals   the points / turns asked for, and the kept bones' world transforms (feet, a prop's carrier), as heavy goals
//   near    the Mahalanobis distance from the start pose: moving along what people do together is cheap, against it dear
//   natural what makes the pose less natural than the start (its Mahalanobis distance from the mean past the start's)
//   angle   a small plain pull on every joint's angle (a free direction doesn't let one joint swing wildly)
//   limits  joints held within the measured range of motion (src/engine/limits.ts)
// plus the hips' heading and position free on springs (a body may turn a little and shift to reach). The poses it
// searches are all the 66 numbers: the first K (components that matter) vary by their own spread, the rest (the part
// outside the subspace) are free but dear.
//
// Feet are SOFT (NaturalOptions.feet): a standing foot stays where it is until the pose needs it to move, and sliding,
// twisting (a pivot on the ball or the heel), tilting and lifting each cost (FOOT); the one hard thing is the floor
// (no sole point under its rest height). The search first holds them (finding the body's way to the goals in the
// stance it has), then lets them go. `planted` locks them as the first solver did.
//
// Balance and upright (on with soft feet): the centre of mass (a mass-weighted mean of the body's segments) over the
// ground must stay inside the support (the hull of the standing feet's sole points), and the trunk no more tilted than the
// start had it (and a few degrees), both steep costs; a foot's slide costs like a Huber loss (squared to a knee, then
// linear, steep past a stride), so the body lunges (hips forward and down, a foot stepping, flat) rather than folding
// over its goal.
//
// Elbows (ELBOW): the elbow's BOW is how far it stands off the line from its shoulder to its hand, forward in the chest's
// frame (forward = the shoulder line crossed with the chest's up): an arm reaching forward and down lies on that line
// (no bow, free), an elbow pointing forward bows. What may bow depends on how low the hand is below the shoulder in WORLD
// up, in upper arms (so no turning of the chest or swinging of the forearm changes it): free with the hand at the
// shoulder's height or above, down to the library's own 99th percentile of the bow (ELBOW.table, measured on every
// frame of the library) from half an upper arm below, and past it the cost is steep. A hand goal may also yield a few
// degrees of roll round its grip line (NaturalGoal.roll; the prop's line stays exact), which is what lets a hand be held
// on a prop with the elbow back; or, on a socket, give a little on every axis (NaturalGoal.give, GIVE: free within about
// 5 degrees, rising, steep from about 15; the roll round the grip line the cheapest, the position as tight as ever). A hand
// that carries the prop (it rides the hand) keeps its turn exactly: the turn is the prop's place.
//
// A whole clip: naturalizeFrames / naturalizeClip solve every frame this way with the corrections between neighbouring
// frames pulled together (swept forward and back), so the pass is smooth over time and the edit's own motion stays.
import * as THREE from 'three'
import { canonical } from './retarget.ts'
import { keepOffFloor, reach, setWorldQuaternion, type Leg, type Limb, type NameOf } from './ik.ts'
import type { JointLimits } from './limits.ts'
import type { BodyState, HandGoal, SolveOptions } from './bodysolve.ts'

/** The bones of the pose, parents first. */
export const BODY = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'] as const
export const NB = BODY.length
export const DIM = NB * 3
/** Each bone's parent in BODY (-1: the hips). */
export const PARENT = [-1, 0, 1, 2, 3, 4, 3, 6, 7, 8, 3, 10, 11, 12, 0, 14, 15, 16, 0, 18, 19, 20]
/** The bone on the other side (itself for the middle ones). */
export const MIRROR = [0, 1, 2, 3, 4, 5, 10, 11, 12, 13, 6, 7, 8, 9, 18, 19, 20, 21, 14, 15, 16, 17]
const INDEX = new Map<string, number>(BODY.map((n, i) => [n, i]))
/** BODY indices the elbow terms read. */
const E = { leftArm: BODY.indexOf('LeftArm'), rightArm: BODY.indexOf('RightArm'), spine1: BODY.indexOf('Spine1'), neck: BODY.indexOf('Neck') }

// ---- the model -----------------------------------------------------------------------------------------------------

export interface PoseModelData {
  version: 1
  bones: string[]
  /** The Y Bot's rest, x y z w per bone: its local turn (the hips': its world turn). */
  rest: number[][]
  /** The mean pose, DIM numbers. */
  mean: number[]
  /** All DIM components (unit, perpendicular), strongest first: rows of DIM numbers. */
  components: number[][]
  /** Each component's variance (rad^2). */
  variances: number[]
  /** How many components carry the pose (the rest are the part outside the subspace). */
  k: number
  explained: number
  clips: number
  frames: number
  /** The reconstruction error on held-out clips at k components: per bone, degrees. */
  heldOut?: { clips: number, frames: number, k: number, perBone: Record<string, { median: number, p95: number }>, median: number, p95: number }
}

/** What the part outside the subspace costs, against a unit of the subspace's (its variance is the tail's average, this much). */
export const OUTSIDE_WEIGHT = 0.25

export class PoseModel {
  readonly data: PoseModelData
  readonly k: number
  readonly mean = new Float64Array(DIM)
  /** Components, row j = component j (DIM numbers). */
  readonly comps = new Float64Array(DIM * DIM)
  readonly variances = new Float64Array(DIM)
  /** How far each whitened coordinate z_j moves its component (the spread: the component's, and for the part outside the subspace the tail's, loosened). */
  readonly sigma = new Float64Array(DIM)
  /** The tail's spread per dimension (rad). */
  readonly tail: number
  readonly rest: THREE.Quaternion[]
  readonly restInv: THREE.Quaternion[]

  constructor (data: PoseModelData) {
    this.data = data
    this.k = data.k
    this.mean.set(data.mean)
    data.components.forEach((c, j) => { this.comps.set(c, j * DIM) })
    this.variances.set(data.variances)
    let tailSum = 0
    for (let j = this.k; j < DIM; j++) tailSum += this.variances[j]
    this.tail = Math.sqrt(Math.max(tailSum / Math.max(1, DIM - this.k), 1e-8))
    for (let j = 0; j < DIM; j++) this.sigma[j] = j < this.k ? Math.sqrt(Math.max(this.variances[j], 1e-8)) : this.tail / Math.sqrt(OUTSIDE_WEIGHT)
    this.rest = data.rest.map(q => new THREE.Quaternion(q[0], q[1], q[2], q[3]))
    this.restInv = this.rest.map(q => q.clone().invert())
  }

  /** p = mean + sum_j z_j sigma_j component_j. */
  fromWhite (z: ArrayLike<number>, out: Float64Array): void {
    out.set(this.mean)
    for (let j = 0; j < DIM; j++) {
      const s = z[j] * this.sigma[j]
      if (s === 0) continue
      const o = j * DIM
      for (let d = 0; d < DIM; d++) out[d] += s * this.comps[o + d]
    }
  }

  /** z_j = component_j . (p - mean) / sigma_j. */
  toWhite (p: ArrayLike<number>, out: Float64Array): void {
    for (let j = 0; j < DIM; j++) {
      let s = 0
      const o = j * DIM
      for (let d = 0; d < DIM; d++) s += this.comps[o + d] * (p[d] - this.mean[d])
      out[j] = s / this.sigma[j]
    }
  }

  /** How natural a pose is: the Mahalanobis distance (squared) of its coefficients in the subspace, and the (small) cost of what lies outside it. */
  cost (p: ArrayLike<number>): NaturalCost {
    let mahalanobis = 0; let outside = 0
    for (let j = 0; j < DIM; j++) {
      let c = 0
      const o = j * DIM
      for (let d = 0; d < DIM; d++) c += this.comps[o + d] * (p[d] - this.mean[d])
      if (j < this.k) mahalanobis += c * c / this.variances[j]
      else outside += OUTSIDE_WEIGHT * c * c / (this.tail * this.tail)
    }
    return { mahalanobis, outside, total: mahalanobis + outside }
  }

  /** The pose projected into the subspace and back (its first k components kept). */
  reconstruct (p: ArrayLike<number>, out: Float64Array, k = this.k): void {
    out.set(this.mean)
    for (let j = 0; j < k; j++) {
      let c = 0
      const o = j * DIM
      for (let d = 0; d < DIM; d++) c += this.comps[o + d] * (p[d] - this.mean[d])
      for (let d = 0; d < DIM; d++) out[d] += c * this.comps[o + d]
    }
  }
}

export interface NaturalCost { mahalanobis: number, outside: number, total: number }

// ---- the pose vector -----------------------------------------------------------------------------------------------

/** Where a body faces (radians, about +Y: 0 along +Z): the hips' forward, or their up where they lie over. */
export function heading (q: THREE.Quaternion): number {
  const f = new THREE.Vector3(0, 0, 1).applyQuaternion(q)
  const u = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
  const v = f.x * f.x + f.z * f.z >= u.x * u.x + u.z * u.z ? f : u
  return Math.atan2(v.x, v.z)
}

const yawQ = (a: number): THREE.Quaternion => new THREE.Quaternion(0, Math.sin(a / 2), 0, Math.cos(a / 2))

/** A turn as a rotation vector (axis * angle, angle within 0..pi), written to out[o..o+2]. */
export function logTo (q: THREE.Quaternion, out: ArrayLike<number> & { [i: number]: number }, o: number): void {
  let { x, y, z, w } = q
  if (w < 0) { x = -x; y = -y; z = -z; w = -w }
  const s = Math.sqrt(x * x + y * y + z * z)
  const k = s < 1e-9 ? 2 : 2 * Math.atan2(s, w) / s
  out[o] = x * k; out[o + 1] = y * k; out[o + 2] = z * k
}

/** The turn of a rotation vector. */
export function expQ (x: number, y: number, z: number, into = new THREE.Quaternion()): THREE.Quaternion {
  const a = Math.sqrt(x * x + y * y + z * z)
  if (a < 1e-9) return into.set(x * 0.5, y * 0.5, z * 0.5, 1).normalize()
  const s = Math.sin(a / 2) / a
  return into.set(x * s, y * s, z * s, Math.cos(a / 2))
}

/**
 * The pose vector of a body in the model's own skeleton (the Y Bot's frames): `turns[i]` is BODY[i]'s local turn, the
 * hips' its WORLD turn. Writes DIM numbers to `out`; returns the hips' heading (what was taken out of the hips' turn).
 */
export function encodeSource (model: PoseModel, turns: THREE.Quaternion[], out: Float64Array | number[]): number {
  const yaw = heading(turns[0])
  for (let i = 0; i < NB; i++) {
    const q = i === 0 ? yawQ(-yaw).multiply(turns[0]) : turns[i]
    logTo(model.restInv[i].clone().multiply(q), out as number[], i * 3)
  }
  return yaw
}

/** The reverse of encodeSource: BODY[i]'s local turn in the model's skeleton (the hips': world, heading `yaw` put back). */
export function decodeSource (model: PoseModel, p: ArrayLike<number>, yaw: number, out: THREE.Quaternion[]): void {
  for (let i = 0; i < NB; i++) {
    const e = expQ(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], out[i] ?? new THREE.Quaternion())
    out[i] = model.rest[i].clone().multiply(e)
  }
  out[0] = yawQ(yaw).multiply(out[0])
}

/** The pose vector as it is mirrored (left and right swapped): what the other side's body would do. */
export function mirrorPose (p: ArrayLike<number>, out: Float64Array | number[]): void {
  for (let i = 0; i < NB; i++) {
    const m = MIRROR[i] * 3
    out[m] = p[i * 3]; out[m + 1] = -p[i * 3 + 1]; out[m + 2] = -p[i * 3 + 2]
  }
}

// ---- goals ---------------------------------------------------------------------------------------------------------

export interface NaturalGoal {
  /** The bone the goal is on (any bone of the body: fingers and the toes' tip too). */
  bone: string
  /** A point on the bone, in the bone's own frame (a fist's middle, the tip): the bone's joint by default. */
  at?: THREE.Vector3 | [number, number, number]
  /** Where that point should be (world). */
  position?: THREE.Vector3
  /** The point may slide along this direction (a shaft): only its distance off the line through `position` counts. */
  slide?: THREE.Vector3
  /** The turn the bone should have (world). */
  turn?: THREE.Quaternion
  /** Or: a direction in the bone's frame that should run along a world direction (either way round when `either`). */
  axis?: { local: THREE.Vector3 | [number, number, number], world: THREE.Vector3, either?: boolean }
  /** How much it matters (default 1): a centimetre off at weight 1 costs as much as a centimetre off a kept bone at 1/KEEP_WEIGHT. */
  weight?: number
  /** A hard goal (the default) counts for more and more until it is met to half a millimetre; `false`: a target at this weight (a keyed bone's). */
  hard?: boolean
  /** The turn is put on the bone exactly at the end (a hand's on its prop), its range or not. */
  exact?: boolean
  /**
   * The turn yields round one axis: `axis` (in the bone's own frame: a hand's grip line, the prop's) must run exactly
   * along where the goal turn puts it, but the roll round it may give a few degrees (at `weight`, per 5 degrees; it
   * costs steeply past about 10) when holding it exactly forces an unnatural arm.
   */
  roll?: { axis: THREE.Vector3 | [number, number, number], weight?: number }
  /**
   * The turn gives a little on every axis (a hand on a socket is not a death grip): each of the three axes of the turn's
   * error is free within a few degrees, then costs, then steeply (GIVE: `roll` round the grip line `axis`, the cheapest;
   * `other`: the two axes the grip line swings about). Without an `axis` all three count as `other`. The position stays as
   * tight as the goal's weight makes it; the turn is NOT put back exactly at the end (the prop's place is the caller's).
   */
  give?: { axis?: THREE.Vector3 | [number, number, number], roll?: Partial<GiveAxis>, other?: Partial<GiveAxis> }
}

/** An axis of a turn's give: free to `free` degrees, rising to `steep` degrees, then steeply; `weight` per 5 degrees past the free. */
export interface GiveAxis { free: number, steep: number, weight: number }

export interface NaturalOptions {
  /** Bones that keep their world position and turn (the feet, the hand carrying a prop). */
  keep?: string[]
  /** 'quick': a live drag (a few steps); 'full': a bake (to the end). */
  mode?: 'quick' | 'full'
  /** The pose to stay near, as `encode` gave it (default: the bones as they stand). */
  start?: NaturalPose
  /** What the last frame's solution moved from its start (its `delta`): where this one begins its search. */
  warm?: Float64Array
  /** May the hips shift (a lunge, a drop) to let the limbs reach? Default true; a bake that keys only turns passes false (the heading stays free). */
  hipsMove?: boolean
  /**
   * The feet that stand (their Foot bones): SOFT goals. A foot stays where it is until the pose needs it to move: sliding
   * (the foot's middle), twisting (its heading: a pivot on the ball or the heel), tilting and lifting each cost (FOOT).
   * The `floor` is the one thing held hard.
   */
  feet?: string[]
  /** The feet hard-locked on their place and turn (the first solver's behaviour, and a bake that must not slide). */
  planted?: boolean
  /** The floor (world y) and each sole point's rest height above it (restSoles): no sole point goes under its height. */
  floor?: { y: number, soles: Record<string, number> }
  /** The anatomical elbow cost (default on): an elbow bowing forward (in the chest's frame) off the line from its shoulder to its hand more than the hand's height allows (ELBOW). */
  elbows?: boolean
  /** How many times the usual number of search steps (default 1 in quick mode, 2 in full). */
  effort?: number
  /** Balance and upright (default on when soft `feet` are given, off with `planted`: the first solver's behaviour): the centre of mass over the standing feet's support, the trunk no more bent than the start had it. `false`: lean anywhere. */
  balance?: boolean
  /** A pull of the whole pose toward the model's mean, per whitened unit squared (default 0: the pose stays as near the start as the goals allow; more drifts every joint toward the most natural pose too). */
  pull?: number
  /** A pull of the correction (p - start, the result's `delta` shape) toward `ref` (its neighbours' in a clip), `weight` per radian squared. */
  smooth?: { ref: Float64Array, weight: number }
}

/** A pose: its numbers, the hips' heading and position. */
export interface NaturalPose { p: Float64Array, yaw: number, hips: THREE.Vector3 }

export interface NaturalResult {
  /** The worst a goal's point is off (world, metres), and a kept bone is off; the worst turn off (degrees). */
  miss: number
  keepMiss: number
  turnMiss: number
  /** How natural the pose is now (and at the start). */
  cost: NaturalCost
  startCost: NaturalCost
  /** The pose the bones are now in, and how far it moved from the start (p - start.p: to warm the next frame). */
  pose: NaturalPose
  delta: Float64Array
  iterations: number
  ms: number
  /** How far under its floor a sole point is left (metres; 0: none), and the most the soft feet moved from where they stood (slide metres, twist and tilt degrees). */
  floorMiss: number
  feetMoved: { slide: number, lift: number, twist: number, tilt: number }
  /** The worst a soft target (a goal with `hard: false`) is off (metres). */
  softMiss: number
  /** The standing feet's balance as the bones stand now (only with `feet`). */
  balance: Balance | null
  /** The most a goal's turn gave round its roll axis (degrees; 0 without `roll` or `give`). */
  rollYield: number
  /** What each goal with a `give` turned off its asked turn (degrees): the roll round its grip line, and the rest (the swing of the line). */
  give: Array<{ bone: string, roll: number, other: number }>
  /** The score the search lowers, term by term, where it began (the warm start, or the start) and where it ended (every row on, at the goals' own weights: two solves compare fairly). */
  objective?: { start: ObjectiveTerms, end: ObjectiveTerms }
}

/** The solver's score of a pose, term by term (each a sum of squares). */
export interface ObjectiveTerms {
  /** The hands' goals; the feet's (kept, soft, the floor); balance and upright; the elbows; the joint ranges. */
  hands: number, feet: number, balance: number, elbows: number, limits: number
  /** How far the pose moved from the start (whitened: per spread of natural variation), and the heading's and hips' springs. */
  near: number, springs: number
  /** How much less natural than the start it is. */
  natural: number
  total: number
}

/** An arm's elbow in the chest's frame (forward from the shoulders' line; the shoulder line's left to right). */
export interface Elbow {
  /** How far the elbow is ahead of the shoulder line (metres; negative: behind it). */
  ahead: number
  /** How far the hand is ahead of the shoulder line. */
  handAhead: number
  /** The forearm's forward part, from the elbow to the hand (-1 pointing back, 1 forward). */
  forearm: number
  /** The elbow's bow off the shoulder-to-hand line, forward (metres), and the most the hand's height allows (ELBOW.table, metres). */
  bow: number
  allowed: number
  /** How far the hand is below the shoulder, in world up, in upper arms (negative: above). */
  below: number
}

/** The centre of mass over the floor against the support, and the trunk's tilt. */
export interface Balance {
  /** The centre of mass (world). */
  com: THREE.Vector3
  /** How far inside the support the centre of mass's ground point is (metres; negative: outside by that much). */
  margin: number
  /** The trunk's (hips to neck) tilt from the vertical, and its forward part (degrees; forward is where the hips face). */
  tilt: number
  pitch: number
}

export interface RigOptions {
  /** The retarget's turns K (character = source * K) by bone; none for the model's own skeleton. */
  offsets?: Map<string, THREE.Quaternion> | null
  limits?: JointLimits | null
  nameOf?: NameOf
}

// the units residuals are measured in: a centimetre of a body the Y Bot's size, five degrees
const CM = 0.01
const FIVE = THREE.MathUtils.degToRad(5)
const Y_BOT_LEG = 0.827
/** A kept bone's weight against a goal's (at 1). */
export const KEEP_WEIGHT = 12
const PRIOR = { near: 1, natural: 2, angle: 1, heading: 1, hips: 1 }
/** The hips' heading and position, free on springs: the spread (radians; metres of a Y Bot, scaled). */
const HEADING_SPREAD = 0.35
const HIPS_SPREAD = 0.08
const EXTRA = 4
const LIMIT_WEIGHT = 40
/** What a soft foot's moving costs: per centimetre slid, per centimetre lifted, per 5 degrees twisted (heading), per 5 degrees tilted. */
export const FOOT = { slide: 0.3, lift: 1.5, twist: 0.4, tilt: 1.2 }
/** A sole point under its floor: per centimetre. */
const FLOOR_WEIGHT = 30
/**
 * A foot's slide costs like a Huber loss: squared up to this knee (centimetres of a Y Bot's size), then only linearly, so a
 * step that the balance needs costs little more than a shuffle (a lean that the balance forbids costs a great deal).
 */
const SLIDE_KNEE = 4
/** The longest step (centimetres of a Y Bot's size; a stride is about this) a foot may travel from where it stood before the cost of more goes up steeply, per centimetre past it. */
const STRIDE = { max: 45, weight: 2 }
/**
 * Balance: the centre of mass (a mass-weighted mean of the body's segments' middles: the torso and the hips heavy) over
 * the ground, held inside the support (the hull of the standing feet's sole points: ankle, ball and toes' tip). The cost
 * starts `BALANCE_RAMP` before the support's edge (or the start pose's own overhang, when it has one) and rises steeply
 * (BALANCE.weight per centimetre, then steeper: its square grows with the fourth power of the overhang).
 */
export const BALANCE = { weight: 3, steep: 6, ramp: 0.06 }
/** Upright: the trunk's (hips to neck) tilt from the vertical beyond what the start pose has plus `slack` (radians), per 5 degrees, steepening past 20. */
export const UPRIGHT = { weight: 3, slack: THREE.MathUtils.degToRad(3) }
/**
 * The elbow's bow (how far it stands off the line from the shoulder to the hand, forward in the chest's frame: forward =
 * the shoulder line crossed with the chest's up) beyond what is allowed for the hand's height below the shoulder (world
 * up) costs `weight` per centimetre (of a Y Bot's size; squared, steepening). `table`: [the hand's height below the
 * shoulder, in upper arms; the bow allowed, in upper arms]: free (1: more than an arm can bow) at the shoulder's height
 * and above, then, from half an upper arm below, the 99th percentile of the bow over every frame of the library's 2,446
 * captures (both arms, 130,763 frames each: tools/posespace.ts's scan; so the rule leaves 1% of the library's own poses
 * over it, 0.6% overall), by the height of the hand (the arm hanging: almost none).
 */
export const ELBOW = {
  weight: 3,
  steep: 6,
  table: [[0, 1], [0.625, 0.53], [0.875, 0.43], [1.125, 0.31], [1.375, 0.22], [1.625, 0.14], [1.875, 0.06], [2.2, 0.04]] as Array<[number, number]>,
}
/** The bow allowed (in upper arms) a hand `below` upper arms under its shoulder (world up), from ELBOW.table. */
export function elbowAllowed (below: number): number {
  const t = ELBOW.table
  if (below <= t[0][0]) return t[0][1]
  for (let i = 1; i < t.length; i++) {
    if (below <= t[i][0]) return t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (below - t[i - 1][0]) / (t[i][0] - t[i - 1][0])
  }
  return t[t.length - 1][1]
}
/** A turn that yields round its roll axis: per 5 degrees (boosted goals do not harden it). */
export const ROLL = { weight: 0.6 }
/**
 * How much a hand's turn gives on a socket (degrees; the weight per 5 degrees past the free): the roll round the grip line
 * the cheapest (free to 8, rising to 20, then steeply), the swing of the line costlier (free to 5, rising to 15, then steeply). Not boosted: only
 * the position of a goal hardens.
 */
export const GIVE: { roll: GiveAxis, other: GiveAxis } = { roll: { free: 8, steep: 20, weight: 2.5 }, other: { free: 5, steep: 15, weight: 4 } }

/** One component of a turn's error (radians) through an axis's give: nothing within `free`, then rising, then steeply. */
function giveResidual (c: number, g: Float64Array, o: number): number {
  const m = Math.abs(c) - g[o]
  if (m <= 0) return 0
  const u = m / FIVE
  const k = u / Math.max(0.5, (g[o + 1] - g[o]) / FIVE)
  const r = g[o + 2] * u * (1 + k * k)
  return c < 0 ? -r : r
}
/** The body's segments: [bone, the bone whose joint ends the segment (null: the joint itself), share of the mass]. */
const SEGMENTS: Array<[string, string | null, number]> = [
  ['Hips', 'Spine', 0.14], ['Spine', 'Spine1', 0.11], ['Spine1', 'Spine2', 0.11], ['Spine2', 'Neck', 0.14], ['Neck', 'Head', 0.02], ['Head', null, 0.07],
  ...['Left', 'Right'].flatMap((s): Array<[string, string | null, number]> => [
    [`${s}Arm`, `${s}ForeArm`, 0.028], [`${s}ForeArm`, `${s}Hand`, 0.016], [`${s}Hand`, null, 0.007],
    [`${s}UpLeg`, `${s}Leg`, 0.10], [`${s}Leg`, `${s}Foot`, 0.047], [`${s}Foot`, `${s}ToeBase`, 0.014]]),
]

// ---- small quaternion arithmetic on typed arrays (the solver's inner loop allocates nothing) -------------------------

function mul (o: Float64Array, oi: number, a: Float64Array, ai: number, b: Float64Array, bi: number): void {
  const ax = a[ai]; const ay = a[ai + 1]; const az = a[ai + 2]; const aw = a[ai + 3]
  const bx = b[bi]; const by = b[bi + 1]; const bz = b[bi + 2]; const bw = b[bi + 3]
  o[oi] = aw * bx + ax * bw + ay * bz - az * by
  o[oi + 1] = aw * by - ax * bz + ay * bw + az * bx
  o[oi + 2] = aw * bz + ax * by - ay * bx + az * bw
  o[oi + 3] = aw * bw - ax * bx - ay * by - az * bz
}
function expInto (o: Float64Array, oi: number, x: number, y: number, z: number): void {
  const a = Math.sqrt(x * x + y * y + z * z)
  if (a < 1e-9) { o[oi] = x * 0.5; o[oi + 1] = y * 0.5; o[oi + 2] = z * 0.5; o[oi + 3] = 1; return }
  const s = Math.sin(a * 0.5) / a
  o[oi] = x * s; o[oi + 1] = y * s; o[oi + 2] = z * s; o[oi + 3] = Math.cos(a * 0.5)
}
/** v rotated by q, added to `add`'s i (or 0) onto out[oi..]. */
function rotAdd (out: Float64Array, oi: number, q: Float64Array, qi: number, vx: number, vy: number, vz: number, base: Float64Array, bi: number): void {
  const x = q[qi]; const y = q[qi + 1]; const z = q[qi + 2]; const w = q[qi + 3]
  const tx = 2 * (y * vz - z * vy); const ty = 2 * (z * vx - x * vz); const tz = 2 * (x * vy - y * vx)
  out[oi] = base[bi] + vx + w * tx + (y * tz - z * ty)
  out[oi + 1] = base[bi + 1] + vy + w * ty + (z * tx - x * tz)
  out[oi + 2] = base[bi + 2] + vz + w * tz + (x * ty - y * tx)
}
const ZERO3 = new Float64Array(3)

interface Compiled {
  /** The driven bone the goal rides, the point in its frame, the goal bone's turn relative to it. */
  a: number
  at: Float64Array
  rel: Float64Array
  position: Float64Array | null
  slide: Float64Array | null
  turn: Float64Array | null
  axisLocal: Float64Array | null
  axisWorld: Float64Array | null
  either: boolean
  weight: number
  keep: boolean
  /** The goal's bone, for an exact turn. */
  bone: string
  /** Counts for more as it misses (hard goals and keeps); not the soft feet, the floor, a keyed target. */
  boost: boolean
  /** A foot's middle and turn at its weights: the vertical weight against the position's, the turn's against it, tilt against twist. */
  soft: boolean
  wy: number
  turnRatio: number
  tiltK: number
  /** A sole point's lowest world height (null: not a floor row). */
  floorY: number | null
  exact: boolean
  hard: boolean
  /** The roll axis in the goal bone's frame and where the goal puts it (world), and its weight. */
  rollLocal: Float64Array | null
  rollWorld: Float64Array | null
  rollW: number
  /** A turn with give: [roll free, steep (radians), weight, other free, steep, weight], and the two axes perpendicular to the roll axis (world; the roll axis is rollWorld, or none). */
  give: Float64Array | null
  giveB: Float64Array | null
  /** 0: always; 1: only while the feet are held (the first stage); 2: only once they are released (soft feet, the floor). */
  phase: 0 | 1 | 2
}

const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())

/**
 * A character's body bound to the pose model: encode its pose, put one back, and solve goals. Built once per character
 * (bones, their offsets K, the limits); every call reads the bones as they stand.
 */
export class NaturalRig {
  readonly model: PoseModel
  readonly bones: THREE.Bone[]
  private readonly byName: Map<string, THREE.Bone>
  private readonly limits: JointLimits | null
  private readonly nameOf: NameOf
  /** K per body bone (identity when none). */
  private readonly K: THREE.Quaternion[]
  /** lt = A exp(p) B: A = Kp^-1 rest, B = K (the hips: world = heading * rest exp(p) K). */
  private readonly A: Float64Array
  private readonly B: Float64Array
  private readonly rest0: Float64Array
  /** The bones' offsets from their parents, in the parent's frame. */
  private readonly off: Float64Array
  /** The body's size against the Y Bot's. */
  readonly scale: number
  // (scratch)
  private readonly Q = new Float64Array(NB * 4)
  private readonly P = new Float64Array(NB * 3)
  private readonly tmp = new Float64Array(12)
  // balance: the segments' ends in BODY, their masses; the toes' tips (in their ToeBase's frame); the support points
  private readonly seg: Int32Array
  private readonly segMass: Float64Array
  private readonly tip = new Map<string, Float64Array>()
  private readonly hx = new Float64Array(8)
  private readonly hz = new Float64Array(8)
  private readonly hull = new Int32Array(20)

  constructor (model: PoseModel, bones: Map<string, THREE.Bone>, opts: RigOptions = {}) {
    this.model = model
    this.byName = bones
    this.limits = opts.limits ?? null
    this.nameOf = opts.nameOf ?? ((b: THREE.Bone): string => canonical(b.name))
    this.bones = BODY.map(n => {
      const b = bones.get(n)
      if (b === undefined) throw new Error(`NaturalRig: no ${n} bone`)
      return b
    })
    const root = this.bones[0].parent ?? this.bones[0]
    root.updateMatrixWorld(true)
    this.K = BODY.map(n => opts.offsets?.get(n)?.clone() ?? new THREE.Quaternion())
    this.A = new Float64Array(NB * 4); this.B = new Float64Array(NB * 4); this.rest0 = new Float64Array(4)
    this.off = new Float64Array(NB * 3)
    for (let i = 0; i < NB; i++) {
      const a = i === 0 ? new THREE.Quaternion() : this.K[PARENT[i]].clone().invert().multiply(model.rest[i])
      a.toArray(this.A, i * 4)
      this.K[i].toArray(this.B, i * 4)
      if (i > 0) {
        const par = this.bones[PARENT[i]]
        const o = wp(this.bones[i]).sub(wp(par)).applyQuaternion(wq(par).invert())
        o.toArray(this.off, i * 3)
      }
    }
    model.rest[0].toArray(this.rest0)
    const leg = (s: string): number => Math.hypot(this.off[INDEX.get(`${s}Leg`)! * 3], this.off[INDEX.get(`${s}Leg`)! * 3 + 1], this.off[INDEX.get(`${s}Leg`)! * 3 + 2]) +
      Math.hypot(this.off[INDEX.get(`${s}Foot`)! * 3], this.off[INDEX.get(`${s}Foot`)! * 3 + 1], this.off[INDEX.get(`${s}Foot`)! * 3 + 2])
    this.scale = leg('Left') / Y_BOT_LEG
    this.seg = new Int32Array(SEGMENTS.length * 2)
    this.segMass = new Float64Array(SEGMENTS.length)
    const total = SEGMENTS.reduce((m, x) => m + x[2], 0)
    SEGMENTS.forEach(([a, b, m], i) => { this.seg[i * 2] = INDEX.get(a)!; this.seg[i * 2 + 1] = b === null ? -1 : INDEX.get(b)!; this.segMass[i] = m / total })
    for (const side of ['Left', 'Right']) {
      const toe = bones.get(`${side}ToeBase`); const end = bones.get(`${side}Toe_End`)
      if (toe !== undefined && end !== undefined) this.tip.set(`${side}Foot`, Float64Array.from(wp(end).sub(wp(toe)).applyQuaternion(wq(toe).invert()).toArray()))
    }
  }

  /**
   * The balance terms of the FK in this.P / this.Q: [the signed distance (metres, positive outside) of the centre of
   * mass's ground point from the hull of the standing feet's sole points, the trunk's tilt (radians), its forward part].
   * `feet` are the Foot bones' BODY indices (with the tips' offsets in `tips`).
   */
  private balanceTerms (feet: ArrayLike<number>, tips: Array<Float64Array | undefined>, out: Float64Array, forward: ArrayLike<number>): void {
    const P = this.P; const Q = this.Q
    let cx = 0; let cy = 0; let cz = 0
    for (let i = 0; i < this.segMass.length; i++) {
      const a = this.seg[i * 2]; const b = this.seg[i * 2 + 1]; const m = this.segMass[i]
      if (b < 0) { cx += m * P[a * 3]; cy += m * P[a * 3 + 1]; cz += m * P[a * 3 + 2] } else {
        cx += m * 0.5 * (P[a * 3] + P[b * 3]); cy += m * 0.5 * (P[a * 3 + 1] + P[b * 3 + 1]); cz += m * 0.5 * (P[a * 3 + 2] + P[b * 3 + 2])
      }
    }
    // the support: each standing foot's ankle, ball and toes' tip, on the ground
    let n = 0
    const hx = this.hx; const hz = this.hz
    for (let f = 0; f < feet.length; f++) {
      const foot = feet[f]; const toe = foot + 1
      hx[n] = P[foot * 3]; hz[n++] = P[foot * 3 + 2]
      hx[n] = P[toe * 3]; hz[n++] = P[toe * 3 + 2]
      const tip = tips[f]
      if (tip !== undefined) {
        rotAdd(this.tmp, 0, Q, toe * 4, tip[0], tip[1], tip[2], P, toe * 3)
        hx[n] = this.tmp[0]; hz[n++] = this.tmp[2]
      }
    }
    out[0] = n === 0 ? 0 : this.hullDistance(n, cx, cz)
    // the trunk
    const hips = 0; const neck = INDEX.get('Neck')!
    const ax = P[neck * 3] - P[hips * 3]; const ay = P[neck * 3 + 1] - P[hips * 3 + 1]; const az = P[neck * 3 + 2] - P[hips * 3 + 2]
    out[1] = Math.atan2(Math.hypot(ax, az), ay)
    out[2] = Math.atan2(ax * forward[0] + az * forward[1], ay)
  }

  /** The signed distance of (qx, qz) from the convex hull of the first `n` points of hx, hz (positive outside, negative inside by its depth). */
  private hullDistance (n: number, qx: number, qz: number): number {
    const hx = this.hx; const hz = this.hz; const h = this.hull
    // (the points sorted by x then z: insertion sort of their indices, then Andrew's monotone chain)
    const order = this.hull.subarray(12, 12 + n)
    for (let i = 0; i < n; i++) order[i] = i
    for (let i = 1; i < n; i++) {
      const k = order[i]; let j = i - 1
      while (j >= 0 && (hx[order[j]] > hx[k] || (hx[order[j]] === hx[k] && hz[order[j]] > hz[k]))) { order[j + 1] = order[j]; j-- }
      order[j + 1] = k
    }
    const cross = (o: number, a: number, b: number): number => (hx[a] - hx[o]) * (hz[b] - hz[o]) - (hz[a] - hz[o]) * (hx[b] - hx[o])
    let m = 0
    for (let i = 0; i < n; i++) { while (m >= 2 && cross(h[m - 2], h[m - 1], order[i]) <= 0) m--; h[m++] = order[i] }
    const lowerEnd = m + 1
    for (let i = n - 2; i >= 0; i--) { while (m >= lowerEnd && cross(h[m - 2], h[m - 1], order[i]) <= 0) m--; h[m++] = order[i] }
    if (m > 1) m--
    if (m === 1) return Math.hypot(qx - hx[h[0]], qz - hz[h[0]])
    let inside = m >= 3; let near = Infinity; let depth = Infinity
    for (let i = 0; i < m; i++) {
      const a = h[i]; const b = h[(i + 1) % m]
      const ex = hx[b] - hx[a]; const ez = hz[b] - hz[a]
      const len2 = ex * ex + ez * ez
      if (len2 < 1e-14) continue
      const t = Math.max(0, Math.min(1, ((qx - hx[a]) * ex + (qz - hz[a]) * ez) / len2))
      near = Math.min(near, Math.hypot(qx - hx[a] - t * ex, qz - hz[a] - t * ez))
      const side = (ex * (qz - hz[a]) - ez * (qx - hx[a])) / Math.sqrt(len2)
      if (side < 0) inside = false
      depth = Math.min(depth, side)
    }
    return inside ? -depth : near
  }

  /**
   * An arm's elbow in the chest's frame, from the FK in this.P: [how far the elbow is ahead of the shoulder line (metres),
   * the hand ahead of it, the forearm's forward part (-1..1), the elbow's bow off the shoulder-to-hand line (metres, forward),
   * the hand's height below the shoulder in WORLD up (upper arms), the bow allowed at that height (metres)]. Forward is the
   * shoulder line (left minus right) crossed with the chest's up (Spine1 to Neck); the bow is the elbow's offset from the
   * line S->H (its projection t on it clamped to the arm: an extended arm has its elbow on it) along that forward.
   */
  private elbowTerms (side: number, out: Float64Array, shoulderY?: number): void {
    const P = this.P
    const la = E.leftArm * 3; const ra = E.rightArm * 3; const sp = E.spine1 * 3; const nk = E.neck * 3
    const sx = P[la] - P[ra]; const sy = P[la + 1] - P[ra + 1]; const sz = P[la + 2] - P[ra + 2]
    const ux = P[nk] - P[sp]; const uy = P[nk + 1] - P[sp + 1]; const uz = P[nk + 2] - P[sp + 2]
    let fx = sy * uz - sz * uy; let fy = sz * ux - sx * uz; let fz = sx * uy - sy * ux
    const fl = Math.hypot(fx, fy, fz) || 1
    fx /= fl; fy /= fl; fz /= fl
    const o = side === 0 ? E.leftArm : E.rightArm
    const sh = o * 3; const el = (o + 1) * 3; const ha = (o + 2) * 3
    const vx = P[el] - P[sh]; const vy = P[el + 1] - P[sh + 1]; const vz = P[el + 2] - P[sh + 2]
    const wx = P[ha] - P[sh]; const wy = P[ha + 1] - P[sh + 1]; const wz = P[ha + 2] - P[sh + 2]
    const ahead = vx * fx + vy * fy + vz * fz
    const hx = P[ha] - P[el]; const hy = P[ha + 1] - P[el + 1]; const hz = P[ha + 2] - P[el + 2]
    const len = Math.hypot(hx, hy, hz) || 1
    const w2 = wx * wx + wy * wy + wz * wz
    const t = w2 > 1e-12 ? Math.min(1, Math.max(0, (vx * wx + vy * wy + vz * wz) / w2)) : 0
    const upper = Math.hypot(vx, vy, vz) || 1
    // (the hand's height under the shoulder: the START pose's shoulder when given, so that crouching or leaning to lower the shoulder does not widen what may bow)
    const below = shoulderY === undefined ? -wy / upper : (shoulderY - P[ha + 1]) / upper
    out[0] = ahead
    out[1] = wx * fx + wy * fy + wz * fz
    out[2] = (hx * fx + hy * fy + hz * fz) / len
    out[3] = (vx - t * wx) * fx + (vy - t * wy) * fy + (vz - t * wz) * fz
    out[4] = below
    out[5] = elbowAllowed(below) * upper
  }

  /** Both elbows as the bones stand now (left, right). */
  elbowsOf (): { left: Elbow, right: Elbow } {
    const pose = this.encode()
    this.fk(pose.p, pose.yaw, pose.hips.x, pose.hips.y, pose.hips.z)
    const out = new Float64Array(6)
    const read = (side: number): Elbow => { this.elbowTerms(side, out); return { ahead: out[0], handAhead: out[1], forearm: out[2], bow: out[3], below: out[4], allowed: out[5] } }
    return { left: read(0), right: read(1) }
  }

  /** The standing feet's balance as the bones stand now: the centre of mass, how far inside the support it is, the trunk's tilt. */
  balanceOf (feet: string[] = ['LeftFoot', 'RightFoot']): Balance {
    const pose = this.encode()
    const hipsPos = pose.hips
    this.fk(pose.p, pose.yaw, hipsPos.x, hipsPos.y, hipsPos.z)
    const out = new Float64Array(3)
    const fwd = [Math.sin(pose.yaw), Math.cos(pose.yaw)]
    this.balanceTerms(feet.map(f => INDEX.get(f)!), feet.map(f => this.tip.get(f)), out, fwd)
    let cx = 0; let cy = 0; let cz = 0
    for (let i = 0; i < this.segMass.length; i++) {
      const a = this.seg[i * 2]; const b = this.seg[i * 2 + 1]; const m = this.segMass[i]
      const k = b < 0 ? 1 : 0.5
      cx += m * k * (this.P[a * 3] + (b < 0 ? 0 : this.P[b * 3])); cy += m * k * (this.P[a * 3 + 1] + (b < 0 ? 0 : this.P[b * 3 + 1])); cz += m * k * (this.P[a * 3 + 2] + (b < 0 ? 0 : this.P[b * 3 + 2]))
    }
    return { com: new THREE.Vector3(cx, cy, cz), margin: -out[0], tilt: THREE.MathUtils.radToDeg(out[1]), pitch: THREE.MathUtils.radToDeg(out[2]) }
  }


  /** The bones' pose as they stand: the pose vector (in the model's frames), the hips' heading and world position. */
  encode (): NaturalPose {
    this.bones[0].updateMatrixWorld(true)
    const turns: THREE.Quaternion[] = []
    for (let i = 0; i < NB; i++) {
      if (i === 0) { turns.push(wq(this.bones[0]).multiply(this.K[0].clone().invert())); continue }
      const kp = this.K[PARENT[i]]
      turns.push(kp.clone().multiply(this.bones[i].quaternion).multiply(this.K[i].clone().invert()))
    }
    const p = new Float64Array(DIM)
    const yaw = encodeSource(this.model, turns, p)
    return { p, yaw, hips: wp(this.bones[0]) }
  }

  /** Put a pose on the bones. */
  apply (pose: NaturalPose): void {
    const lt = new THREE.Quaternion(); const e = new THREE.Quaternion(); const a = new THREE.Quaternion()
    const p = pose.p
    for (let i = 1; i < NB; i++) {
      a.fromArray(this.A, i * 4)
      expQ(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], e)
      lt.copy(a).multiply(e).multiply(new THREE.Quaternion().fromArray(this.B, i * 4))
      this.bones[i].quaternion.copy(lt.normalize())
    }
    // the hips: world turn, then where they stand
    const world = yawQ(pose.yaw).multiply(this.model.rest[0]).multiply(expQ(p[0], p[1], p[2])).multiply(this.K[0])
    const hips = this.bones[0]
    if (hips.parent !== null) hips.parent.updateMatrixWorld(true)
    hips.position.copy(hips.parent === null ? pose.hips : hips.parent.worldToLocal(pose.hips.clone()))
    setWorldQuaternion(hips, world)
    hips.updateMatrixWorld(true)
  }

  /** A bone by name. */
  bone (name: string): THREE.Bone | undefined { return this.byName.get(name) }

  /** How natural the bones' pose is. */
  naturalness (): NaturalCost { return this.model.cost(this.encode().p) }

  // ---- the solver --------------------------------------------------------------------------------------------------

  /** World turns and positions of the body's bones (into this.Q, this.P) for the pose p, heading, hips' position. */
  private fk (p: ArrayLike<number>, yaw: number, hx: number, hy: number, hz: number): void {
    const Q = this.Q; const P = this.P; const t = this.tmp
    // the hips: world = heading * rest * exp(p) * K
    t[0] = 0; t[1] = Math.sin(yaw / 2); t[2] = 0; t[3] = Math.cos(yaw / 2)
    mul(t, 4, t, 0, this.rest0, 0)
    expInto(t, 8, p[0], p[1], p[2])
    mul(t, 0, t, 4, t, 8)
    mul(Q, 0, t, 0, this.B, 0)
    P[0] = hx; P[1] = hy; P[2] = hz
    for (let i = 1; i < NB; i++) {
      expInto(t, 0, p[i * 3], p[i * 3 + 1], p[i * 3 + 2])
      mul(t, 4, this.A, i * 4, t, 0)
      mul(t, 8, t, 4, this.B, i * 4)
      const par = PARENT[i]
      mul(Q, i * 4, Q, par * 4, t, 8)
      rotAdd(P, i * 3, Q, par * 4, this.off[i * 3], this.off[i * 3 + 1], this.off[i * 3 + 2], P, par * 3)
    }
  }

  /** The nearest body bone at or above `bone` (its index) and `bone`'s transform relative to it. */
  private attach (bone: string, at: ArrayLike<number> | undefined): { a: number, at: Float64Array, rel: Float64Array } {
    let b: THREE.Object3D | null = this.byName.get(bone) ?? null
    if (b === null) throw new Error(`NaturalRig: no ${bone} bone`)
    const goalBone = b
    while (b !== null && !this.bones.includes(b as THREE.Bone)) b = b.parent
    if (b === null) throw new Error(`NaturalRig: ${bone} hangs off no body bone`)
    const a = this.bones.indexOf(b as THREE.Bone)
    goalBone.updateMatrixWorld(true)
    const qa = wq(b); const qb = wq(goalBone)
    const point = new THREE.Vector3(at?.[0] ?? 0, at?.[1] ?? 0, at?.[2] ?? 0).applyMatrix4(goalBone.matrixWorld)
    const inA = point.sub(wp(b)).applyQuaternion(qa.clone().invert())
    return { a, at: Float64Array.from(inA.toArray()), rel: Float64Array.from(qa.invert().multiply(qb).toArray()) }
  }

  private compile (goals: NaturalGoal[], opts: NaturalOptions): Compiled[] {
    const out: Compiled[] = []
    const v = (x: THREE.Vector3 | number[] | undefined): Float64Array | null => (x === undefined ? null : Float64Array.from(x instanceof THREE.Vector3 ? x.toArray() : x))
    const base = { slide: null, axisLocal: null, axisWorld: null, either: false, soft: false, wy: 1, turnRatio: 1, tiltK: 1, floorY: null, exact: false, hard: true, phase: 0 as 0 | 1 | 2, rollLocal: null as Float64Array | null, rollWorld: null as Float64Array | null, rollW: 0, give: null as Float64Array | null, giveB: null as Float64Array | null }
    for (const g of goals) {
      const att = this.attach(g.bone, g.at instanceof THREE.Vector3 ? g.at.toArray() : g.at)
      out.push({
        ...base, ...att, bone: g.bone, position: v(g.position), slide: g.slide === undefined ? null : Float64Array.from(g.slide.clone().normalize().toArray()),
        turn: g.turn === undefined ? null : Float64Array.from(g.turn.clone().normalize().toArray()),
        axisLocal: g.axis === undefined ? null : Float64Array.from((g.axis.local instanceof THREE.Vector3 ? g.axis.local.clone() : new THREE.Vector3(...g.axis.local)).normalize().toArray()),
        axisWorld: g.axis === undefined ? null : Float64Array.from(g.axis.world.clone().normalize().toArray()),
        either: g.axis?.either === true, weight: g.weight ?? 1, keep: false, boost: g.hard !== false, hard: g.hard !== false, exact: g.exact === true,
        ...(g.give !== undefined && g.turn !== undefined ? (() => {
          const deg = THREE.MathUtils.degToRad
          const r = { ...GIVE.roll, ...g.give.roll }; const o = { ...GIVE.other, ...g.give.other }
          const params = Float64Array.from([deg(r.free), deg(r.steep), r.weight, deg(o.free), deg(o.steep), o.weight])
          if (g.give.axis === undefined) return { give: params }
          const local = (g.give.axis instanceof THREE.Vector3 ? g.give.axis.clone() : new THREE.Vector3(...g.give.axis)).normalize()
          const a = local.clone().applyQuaternion(g.turn.clone().normalize())
          const helper = Math.abs(a.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
          const b1 = new THREE.Vector3().crossVectors(a, helper).normalize(); const b2 = new THREE.Vector3().crossVectors(a, b1).normalize()
          return { give: params, giveB: Float64Array.from([...b1.toArray(), ...b2.toArray()]), rollLocal: Float64Array.from(local.toArray()), rollWorld: Float64Array.from(a.toArray()) }
        })() : g.roll !== undefined && g.turn !== undefined ? (() => {
          const local = (g.roll.axis instanceof THREE.Vector3 ? g.roll.axis.clone() : new THREE.Vector3(...g.roll.axis)).normalize()
          return { rollLocal: Float64Array.from(local.toArray()), rollWorld: Float64Array.from(local.clone().applyQuaternion(g.turn.clone().normalize()).toArray()), rollW: g.roll.weight ?? ROLL.weight }
        })() : {}),
      })
    }
    // the feet that stand: planted (kept hard, as the first solver did) or soft
    const feet = opts.feet ?? []
    const planted = opts.planted === true
    // the kept: their transform now (a foot keeps its toes' turn too)
    const keep = [...(opts.keep ?? []), ...(planted ? feet : [])]
    const names = [...new Set(keep.flatMap(n => (/Foot$/.test(n) && this.byName.has(n.replace('Foot', 'ToeBase')) ? [n, n.replace('Foot', 'ToeBase')] : [n])))]
    for (const n of names) {
      const bone = this.byName.get(n)
      if (bone === undefined) continue
      bone.updateMatrixWorld(true)
      const att = this.attach(n, undefined)
      out.push({
        ...base, ...att, bone: n, position: Float64Array.from(wp(bone).toArray()), turn: Float64Array.from(wq(bone).toArray()),
        weight: KEEP_WEIGHT, keep: true, boost: true,
      })
    }
    if (!planted) {
      for (const n of feet) {
        const bone = this.byName.get(n); const toe = this.byName.get(n.replace('Foot', 'ToeBase'))
        if (bone === undefined) continue
        bone.updateMatrixWorld(true)
        // (the search starts with the feet held, to find the body's way to the goals as the stance it has; then they are let go to what is cheaper)
        for (const held of toe === undefined ? [n] : [n, n.replace('Foot', 'ToeBase')]) {
          const hb = this.byName.get(held)!
          out.push({ ...base, ...this.attach(held, undefined), bone: held, position: Float64Array.from(wp(hb).toArray()), turn: Float64Array.from(wq(hb).toArray()), weight: KEEP_WEIGHT, keep: false, boost: true, hard: false, phase: 1 as 0 | 1 | 2 })
        }
        // (the foot's middle: halfway from the ankle to the ball, which rides the foot rigidly: a pivot on either costs the twist and half a slide)
        const ti = toe === undefined ? -1 : this.bones.indexOf(toe)
        const mid = ti < 0 ? [0, 0, 0] : [this.off[ti * 3] / 2, this.off[ti * 3 + 1] / 2, this.off[ti * 3 + 2] / 2]
        const att = this.attach(n, mid)
        const point = new THREE.Vector3(...mid).applyMatrix4(bone.matrixWorld)
        out.push({
          ...base, ...att, bone: n, position: Float64Array.from(point.toArray()), turn: Float64Array.from(wq(bone).toArray()),
          phase: 2 as 0 | 1 | 2, weight: FOOT.slide, soft: true, wy: FOOT.lift / FOOT.slide, turnRatio: FOOT.twist / FOOT.slide, tiltK: FOOT.tilt / FOOT.twist, keep: false, boost: false, hard: false,
        })
      }
    }
    // the floor: every sole point of a standing foot at least its rest height above it
    if (opts.floor !== undefined) {
      for (const n of feet) {
        if (planted) break
        for (const sole of [n, n.replace('Foot', 'ToeBase'), n.replace('Foot', 'Toe_End')]) {
          const height = opts.floor.soles[sole]
          if (height === undefined || !this.byName.has(sole)) continue
          const att = this.attach(sole, undefined)
          // (a sole point the start pose already has under its rest height keeps that: the clip's own contact is not the edit's to lift)
          const now = wp(this.byName.get(sole)!).y
          out.push({ ...base, ...att, bone: sole, position: null, turn: null, weight: FLOOR_WEIGHT, keep: false, boost: false, hard: false, phase: 2 as 0 | 1 | 2, floorY: Math.min(opts.floor.y + height, now) })
        }
      }
    }
    return out
  }

  /**
   * Reach the goals with the most natural pose nearest the start: writes it on the bones, a kept bone snapped back onto
   * its transform by reach (src/engine/ik.ts) when the search left it off by a hair. The bones are read as they stand
   * (`opts.start` otherwise: the pose to stay near).
   */
  solve (goals: NaturalGoal[], opts: NaturalOptions = {}): NaturalResult {
    const t0 = performance.now()
    const quick = opts.mode === 'quick'
    this.bones[0].updateMatrixWorld(true)
    const model = this.model
    const standing = this.encode()
    const start = opts.start ?? standing
    const rows = this.compile(goals, opts)
    const n = DIM + EXTRA
    const unit = CM * this.scale
    const spreadH = HIPS_SPREAD * this.scale
    const startCost = model.cost(start.p)
    // the whitened start; heading, hips' position as springs about the start
    const z0 = new Float64Array(n)
    model.toWhite(start.p, z0)
    const z = new Float64Array(n)
    z.set(z0)
    // (the springs' variables: heading and hips' shift, as spreads)
    const zStartHips = [start.hips.x, start.hips.y, start.hips.z]
    if (opts.warm !== undefined) {
      const w = new Float64Array(DIM)
      for (let d = 0; d < DIM; d++) w[d] = start.p[d] + opts.warm[d]
      model.toWhite(w, z)
      z[DIM] = (opts.warm[DIM] ?? 0) / HEADING_SPREAD
      for (let a = 0; a < 3; a++) z[DIM + 1 + a] = (opts.warm[DIM + 1 + a] ?? 0) / spreadH
    }
    // the unknowns' curvature priors (z-space): near the start, toward the mean, plain angle
    const prior = new Float64Array(n)
    for (let j = 0; j < DIM; j++) prior[j] = PRIOR.near + PRIOR.angle * model.sigma[j] * model.sigma[j]
    prior[DIM] = PRIOR.heading
    for (let a = 0; a < 3; a++) prior[DIM + 1 + a] = opts.hipsMove === false ? 1e8 : PRIOR.hips

    // (smooth: a pull of the correction toward its neighbours', in plain angle for the pose, the springs' own units for the rest)
    const pullW = opts.pull ?? 0
    const sdiag = new Float64Array(n); const zref = new Float64Array(n)
    zref.set(z0)
    if (opts.smooth !== undefined) {
      const w = new Float64Array(DIM)
      for (let d = 0; d < DIM; d++) w[d] = start.p[d] + opts.smooth.ref[d]
      model.toWhite(w, zref)
      zref[DIM] = (opts.smooth.ref[DIM] ?? 0) / HEADING_SPREAD
      for (let a = 0; a < 3; a++) zref[DIM + 1 + a] = (opts.smooth.ref[DIM + 1 + a] ?? 0) / spreadH
      for (let j = 0; j < DIM; j++) sdiag[j] = opts.smooth.weight * model.sigma[j] * model.sigma[j]
      sdiag[DIM] = opts.smooth.weight * HEADING_SPREAD * HEADING_SPREAD
      for (let a = 0; a < 3; a++) sdiag[DIM + 1 + a] = opts.hipsMove === false ? 0 : opts.smooth.weight * spreadH * spreadH * 4
    }

    // (balance and upright: the start pose's own overhang and trunk tilt are what they are; only worse costs)
    const feetNames = (opts.feet ?? []).filter(n => INDEX.has(n) && INDEX.has(n.replace('Foot', 'ToeBase')))
    const useBalance = (opts.balance ?? opts.planted !== true) && feetNames.length > 0
    const feetIdx = feetNames.map(n => INDEX.get(n)!)
    const feetTips = feetNames.map(n => this.tip.get(n))
    const bal = new Float64Array(3)
    let balTh = 0; let tiltTh = 0
    if (useBalance) {
      this.fk(start.p, start.yaw, start.hips.x, start.hips.y, start.hips.z)
      this.balanceTerms(feetIdx, feetTips, bal, [Math.sin(start.yaw), Math.cos(start.yaw)])
      balTh = Math.max(bal[0], -BALANCE.ramp * this.scale)
      tiltTh = Math.max(bal[1], 0) + UPRIGHT.slack
    }

    const useElbows = opts.elbows !== false
    // (each shoulder's height at the start)
    const shoulderY0 = [0, 0]
    if (useElbows) {
      this.fk(start.p, start.yaw, start.hips.x, start.hips.y, start.hips.z)
      shoulderY0[0] = this.P[E.leftArm * 3 + 1]; shoulderY0[1] = this.P[E.rightArm * 3 + 1]
    }
    const elb = new Float64Array(6)
    const nRows = rows.length * 9 + 6 + DIM
    const f = new Float64Array(nRows); const f2 = new Float64Array(nRows)
    const J = new Float64Array(nRows * n)
    const p = new Float64Array(DIM); const pj = new Float64Array(DIM)
    const limitTarget = new Float64Array(DIM)
    const limited = new Uint8Array(NB)
    // (joints the search leaves alone: a kept bone's, and any already out of its range in the start pose: that is the clip's own)
    const exempt = new Uint8Array(NB)
    for (const row of rows) if (row.keep) exempt[row.a] = 2
    const weights = rows.map(r => r.weight)

    // (the floor's rows are off until a solution without them leaves a sole point under it: a hinge from the start is a kink the steps can't see)
    let floorOn = false
    let phase: 1 | 2 = rows.some(r => r.phase === 1) ? 1 : 2
    const evalRows = (pp: ArrayLike<number>, zz: Float64Array, out: Float64Array): number => {
      const yawNow = zz[DIM] * HEADING_SPREAD + start.yaw
      this.fk(pp, yawNow, zStartHips[0] + zz[DIM + 1] * spreadH, zStartHips[1] + zz[DIM + 2] * spreadH, zStartHips[2] + zz[DIM + 3] * spreadH)
      let r = 0
      const Q = this.Q; const P = this.P; const t = this.tmp
      for (let g = 0; g < rows.length; g++) {
        const c = rows[g]
        if (c.phase !== 0 && c.phase !== phase) { for (let k = 0; k < 9; k++) out[r++] = 0; continue }
        const w = weights[g]
        const ao = c.a * 4
        let stride = 0
        // (the point; a floor row: only how far under its lowest height)
        if (c.floorY !== null) {
          rotAdd(t, 0, Q, ao, c.at[0], c.at[1], c.at[2], P, c.a * 3)
          const under = c.floorY - t[1]
          out[r++] = 0; out[r++] = floorOn && under > 0 ? w * under / unit : 0; out[r++] = 0
        } else if (c.position !== null) {
          rotAdd(t, 0, Q, ao, c.at[0], c.at[1], c.at[2], P, c.a * 3)
          let dx = t[0] - c.position[0]; let dy = t[1] - c.position[1]; let dz = t[2] - c.position[2]
          if (c.slide !== null) { const k = dx * c.slide[0] + dy * c.slide[1] + dz * c.slide[2]; dx -= k * c.slide[0]; dy -= k * c.slide[1]; dz -= k * c.slide[2] }
          // (a soft foot's slide is a Huber loss: squared to the knee, linear past it, so a step costs little more than a shuffle; past a stride, steeply)
          stride = 0
          if (c.soft) {
            const m = Math.hypot(dx, dz) / unit
            stride = STRIDE.weight * Math.max(0, m - STRIDE.max)
            if (m > 1e-9) { const k = Math.sqrt(2 * SLIDE_KNEE * SLIDE_KNEE * (Math.sqrt(1 + (m / SLIDE_KNEE) ** 2) - 1)) / m; dx *= k; dz *= k }
          }
          const s = w / unit
          out[r++] = dx * s; out[r++] = dy * s * c.wy; out[r++] = dz * s
        } else { stride = 0; out[r++] = 0; out[r++] = 0; out[r++] = 0 }
        // (the turn: the error as a rotation vector)
        let rollRes = 0
        if (c.turn !== null) {
          mul(t, 4, Q, ao, c.rel, 0)
          // error = bone * target^-1 (world), as its log
          t[8] = -c.turn[0]; t[9] = -c.turn[1]; t[10] = -c.turn[2]; t[11] = c.turn[3]
          mul(t, 0, t, 4, t, 8)
          let ex = t[0]; let ey = t[1]; let ez = t[2]; let ew = t[3]
          if (ew < 0) { ex = -ex; ey = -ey; ez = -ez; ew = -ew }
          const sn = Math.sqrt(ex * ex + ey * ey + ez * ez)
          const k = sn < 1e-9 ? 2 : 2 * Math.atan2(sn, ew) / sn
          let vx = ex * k; let vy = ey * k; let vz = ez * k
          if (c.give !== null) {
            // (a turn with give: each axis of the error free within its few degrees, then costing; none of it boosted)
            if (c.rollWorld !== null && c.giveB !== null) {
              out[r++] = giveResidual(vx * c.rollWorld[0] + vy * c.rollWorld[1] + vz * c.rollWorld[2], c.give, 0)
              out[r++] = giveResidual(vx * c.giveB[0] + vy * c.giveB[1] + vz * c.giveB[2], c.give, 3)
              out[r++] = giveResidual(vx * c.giveB[3] + vy * c.giveB[4] + vz * c.giveB[5], c.give, 3)
            } else { out[r++] = giveResidual(vx, c.give, 3); out[r++] = giveResidual(vy, c.give, 3); out[r++] = giveResidual(vz, c.give, 3) }
          } else {
          // (a turn that yields round its roll axis: the swing stays at the goal's weight, the roll has its own, unboosted)
          if (c.rollWorld !== null) {
            const roll = vx * c.rollWorld[0] + vy * c.rollWorld[1] + vz * c.rollWorld[2]
            const u = roll / FIVE
            rollRes = c.rollW * u * (1 + Math.abs(u) / 2)
            vx -= roll * c.rollWorld[0]; vy -= roll * c.rollWorld[1]; vz -= roll * c.rollWorld[2]
          }
          const s = w * c.turnRatio / FIVE
          out[r++] = vx * s * c.tiltK; out[r++] = vy * s; out[r++] = vz * s * c.tiltK
          }
        } else { out[r++] = 0; out[r++] = 0; out[r++] = 0 }
        // (the axis)
        if (c.axisLocal !== null && c.axisWorld !== null) {
          mul(t, 4, Q, ao, c.rel, 0)
          // a = rotate(axisLocal) by t[4..7]
          rotAdd(t, 8, t, 4, c.axisLocal[0], c.axisLocal[1], c.axisLocal[2], ZERO3, 0)
          const ax = t[8]; const ay = t[9]; const az = t[10]
          const dx = c.axisWorld[0]; const dy = c.axisWorld[1]; const dz = c.axisWorld[2]
          const s = w * c.turnRatio / FIVE
          if (c.either) { out[r++] = (ay * dz - az * dy) * s; out[r++] = (az * dx - ax * dz) * s; out[r++] = (ax * dy - ay * dx) * s } else { out[r++] = (ax - dx) * s; out[r++] = (ay - dy) * s; out[r++] = (az - dz) * s }
        } else if (stride > 0) { out[r++] = stride; out[r++] = 0; out[r++] = 0 } else if (rollRes !== 0) { out[r++] = rollRes; out[r++] = 0; out[r++] = 0 } else { out[r++] = 0; out[r++] = 0; out[r++] = 0 }
      }
      // (balance: the centre of mass past the support; upright: the trunk bent past the start's)
      if (useBalance) {
        this.balanceTerms(feetIdx, feetTips, bal, [Math.sin(yawNow), Math.cos(yawNow)])
        const ub = Math.max(0, bal[0] - balTh) / unit
        out[r++] = BALANCE.weight * ub * (1 + ub / BALANCE.steep)
        const ut = Math.max(0, bal[1] - tiltTh) / FIVE
        out[r++] = UPRIGHT.weight * ut * (1 + ut / 4)
        out[r++] = 0
      } else { out[r++] = 0; out[r++] = 0; out[r++] = 0 }
      // (the elbows: ahead of the shoulder line while the hand is not well ahead of them)
      if (useElbows) {
        for (let side = 0; side < 2; side++) {
          this.elbowTerms(side, elb, shoulderY0[side])
          const ue = Math.max(0, elb[3] - elb[5]) / unit
          out[r++] = ELBOW.weight * ue * (1 + ue / ELBOW.steep)
        }
        out[r++] = 0
      } else { out[r++] = 0; out[r++] = 0; out[r++] = 0 }
      // (the limits: a joint out of its range pulled to the nearest turn in it, as chosen at the iteration's start)
      for (let b = 0; b < NB; b++) {
        for (let e = 0; e < 3; e++) out[r++] = limited[b] === 1 ? LIMIT_WEIGHT * (pp[b * 3 + e] - limitTarget[b * 3 + e]) : 0
      }
      return r
    }

    // (natural: only what makes the pose less natural than the start was costs: its distance from the mean past the start's)
    const norm0 = Math.hypot(...z0.subarray(0, DIM))
    const lessNatural = (zz: Float64Array): number => {
      let s = 0
      for (let j = 0; j < DIM; j++) s += zz[j] * zz[j]
      return Math.max(0, Math.sqrt(s) - norm0)
    }
    const cost = (ff: Float64Array, r: number, zz: Float64Array): number => {
      let s = 0
      for (let i = 0; i < r; i++) s += ff[i] * ff[i]
      for (let j = 0; j < n; j++) {
        const dz = zz[j] - (j < DIM ? z0[j] : 0)
        const ds = zz[j] - zref[j]
        s += prior[j] * dz * dz + sdiag[j] * ds * ds + (j < DIM ? pullW * zz[j] * zz[j] : 0)
      }
      const e = PRIOR.natural * lessNatural(zz)
      return s + e * e
    }

    // the joints out of range at p: their nearest in-range pose (null: all in)
    const limitPull = (pp: ArrayLike<number>): boolean => {
      if (this.limits === null) return false
      let any = false
      const lt = new THREE.Quaternion()
      for (let b = 1; b < NB; b++) {
        limited[b] = 0
        const name = BODY[b]
        if (!this.limits.has(name)) continue
        expQ(pp[b * 3], pp[b * 3 + 1], pp[b * 3 + 2], lt)
        lt.premultiply(new THREE.Quaternion().fromArray(this.A, b * 4)).multiply(new THREE.Quaternion().fromArray(this.B, b * 4)).normalize()
        if (this.limits.within(name, lt)) continue
        if (exempt[b] !== 0) continue
        const held = this.limits.clamp(name, lt)
        // back to the model's frame
        const ls = this.K[PARENT[b]].clone().multiply(held).multiply(this.K[b].clone().invert())
        logTo(model.restInv[b].clone().multiply(ls), limitTarget, b * 3)
        limited[b] = 1; any = true
      }
      limited[0] = 0
      return any
    }

    // ---- Levenberg-Marquardt ----
    const H = new Float64Array(n * n); const g = new Float64Array(n); const step = new Float64Array(n)
    const zt = new Float64Array(n)
    model.fromWhite(z, p)
    // (out of range in the start pose: the joint is left as the clip has it)
    if (this.limits !== null) {
      const lt = new THREE.Quaternion()
      for (let b = 1; b < NB; b++) {
        if (exempt[b] !== 0 || !this.limits.has(BODY[b])) continue
        expQ(start.p[b * 3], start.p[b * 3 + 1], start.p[b * 3 + 2], lt)
        lt.premultiply(new THREE.Quaternion().fromArray(this.A, b * 4)).multiply(new THREE.Quaternion().fromArray(this.B, b * 4)).normalize()
        if (!this.limits.within(BODY[b], lt)) exempt[b] = 1
      }
    }
    // (the score term by term, at the goals' own weights with every row on)
    const weights0 = [...weights]
    const terms = (pp: ArrayLike<number>, zz: Float64Array): ObjectiveTerms => {
      const held = [...weights]; const ph = phase
      for (let i = 0; i < weights.length; i++) weights[i] = weights0[i]
      phase = 2
      const out = new Float64Array(nRows)
      const rr = evalRows(pp, zz, out)
      for (let i = 0; i < weights.length; i++) weights[i] = held[i]
      phase = ph
      const sq = (a: number, b: number): number => { let v = 0; for (let i = a; i < b; i++) v += out[i] * out[i]; return v }
      let hands = 0; let feet = 0
      rows.forEach((row, i) => { const v = sq(i * 9, i * 9 + 9); if (row.bone.endsWith('Hand')) hands += v; else feet += v })
      const G = rows.length * 9
      let near = 0; let springs = 0
      for (let j = 0; j < n; j++) {
        const dz = zz[j] - (j < DIM ? z0[j] : 0)
        const v = prior[j] * dz * dz + sdiag[j] * (zz[j] - zref[j]) ** 2 + (j < DIM ? pullW * zz[j] * zz[j] : 0)
        if (j < DIM) near += v; else springs += v
      }
      const e = PRIOR.natural * lessNatural(zz)
      const t = { hands, feet, balance: sq(G, G + 3), elbows: sq(G + 3, G + 6), limits: sq(G + 6, rr), near, springs, natural: e * e, total: 0 }
      t.total = hands + feet + t.balance + t.elbows + t.limits + near + springs + t.natural
      return t
    }
    limitPull(p)
    const startTerms = terms(p, z)
    let r = evalRows(p, z, f)
    let c = cost(f, r, z)
    let mu = 1e-2
    let iterations = 0
    const goalMiss = (): number => {
      // (the worst point miss, metres, from the rows' units)
      let worst = 0
      for (let gi = 0; gi < rows.length; gi++) {
        if (!rows[gi].boost || rows[gi].position === null) continue
        const o = gi * 9
        worst = Math.max(worst, Math.hypot(f[o], f[o + 1], f[o + 2]) * unit / weights[gi])
      }
      return worst
    }
    const iterate = (maxIter: number): void => {
      mu = 1e-2
      for (let it = 0; it < maxIter; it++) {
        iterations++
        // the Jacobian (forward differences)
        const h = 1e-4
        for (let j = 0; j < n; j++) {
          zt.set(z)
          zt[j] += h
          let rr: number
          if (j < DIM) {
            pj.set(p)
            const s = h * model.sigma[j]; const o = j * DIM
            for (let d = 0; d < DIM; d++) pj[d] += s * model.comps[o + d]
            rr = evalRows(pj, zt, f2)
          } else rr = evalRows(p, zt, f2)
          for (let i = 0; i < rr; i++) J[i * n + j] = (f2[i] - f[i]) / h
        }
        // H = J^t J + prior, g = J^t f + prior gradient
        H.fill(0); g.fill(0)
        for (let i = 0; i < r; i++) {
          const o = i * n
          const fi = f[i]
          for (let a = 0; a < n; a++) {
            const ja = J[o + a]
            if (ja === 0) continue
            g[a] += ja * fi
            for (let b = a; b < n; b++) H[a * n + b] += ja * J[o + b]
          }
        }
        for (let a = 0; a < n; a++) {
          const dz = z[a] - (a < DIM ? z0[a] : 0)
          H[a * n + a] += prior[a] + sdiag[a] + (a < DIM ? pullW : 0)
          g[a] += prior[a] * dz + sdiag[a] * (z[a] - zref[a]) + (a < DIM ? pullW * z[a] : 0)
        }
        // (the natural hinge: a row w e with e = |z| - |z0| while positive, its gradient w z / |z|)
        const excess = lessNatural(z)
        if (excess > 0) {
          const nz = excess + norm0
          for (let a = 0; a < DIM; a++) {
            const ja = PRIOR.natural * z[a] / nz
            g[a] += ja * PRIOR.natural * excess
            for (let b = a; b < DIM; b++) H[a * n + b] += ja * PRIOR.natural * z[b] / nz
          }
        }
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) H[b * n + a] = H[a * n + b]
        // damped steps until one lowers the cost
        let accepted = false
        for (let tries = 0; tries < 8 && !accepted; tries++) {
          step.set(g)
          if (!solveSPD(H, n, mu, step)) { mu *= 10; continue }
          for (let j = 0; j < n; j++) zt[j] = z[j] - step[j]
          model.fromWhite(zt, pj)
          const rr = evalRows(pj, zt, f2)
          const c2 = cost(f2, rr, zt)
          if (c2 < c) {
            accepted = true
            const dec = c - c2
            z.set(zt); p.set(pj); f.set(f2.subarray(0, rr)); r = rr; c = c2
            mu = Math.max(mu * 0.3, 1e-6)
            // (the limits' targets move with the pose)
            if (limitPull(p)) { r = evalRows(p, z, f); c = cost(f, r, z) }
            if (dec < 1e-7 * (1 + c)) return
          } else mu *= 6
        }
        if (!accepted) return
      }
    }
    const soften = phase === 1
    const meet = (): void => {
      // (a goal still off by over half a millimetre counts for more: a few rounds)
      for (let boost = 0; !quick && boost < 3 && goalMiss() > 0.0005; boost++) {
        for (let gi = 0; gi < rows.length; gi++) if (rows[gi].boost) weights[gi] *= 4
        r = evalRows(p, z, f); c = cost(f, r, z)
        iterate(10)
      }
    }
    const effort = opts.effort ?? (quick ? 1 : 2)
    // (a bake goes on while a goal is still over a millimetre off: a long reach with balance and upright asks for more steps)
    const finish = (): void => {
      meet()
      for (let more = 0; more < (quick ? 2 : 4) && goalMiss() > (quick ? 0.003 : 0.001); more++) { iterate(Math.round((quick ? 5 : 20) * effort)); meet() }
    }
    iterate(Math.round((soften ? (quick ? 6 : 15) : (quick ? 8 : 15)) * effort))
    finish()
    // the feet let go: from the stance the goals were met in, what is cheaper (a pivot, a slide, a tilt) is taken
    if (soften) {
      phase = 2
      r = evalRows(p, z, f); c = cost(f, r, z)
      iterate(Math.round((quick ? 4 : 12) * effort))
      finish()
    }
    // the floor: switched on if a sole point is left under its height, then the search goes on from there
    if (rows.some(r => r.floorY !== null)) {
      this.fk(p, z[DIM] * HEADING_SPREAD + start.yaw, zStartHips[0] + z[DIM + 1] * spreadH, zStartHips[1] + z[DIM + 2] * spreadH, zStartHips[2] + z[DIM + 3] * spreadH)
      let under = 0
      for (const c of rows) {
        if (c.floorY === null) continue
        rotAdd(this.tmp, 0, this.Q, c.a * 4, c.at[0], c.at[1], c.at[2], this.P, c.a * 3)
        under = Math.max(under, c.floorY - this.tmp[1])
      }
      if (under > 5e-4) {
        floorOn = true
        r = evalRows(p, z, f); c = cost(f, r, z)
        iterate(Math.round((quick ? 5 : 20) * effort))
      }
    }
    // ---- put it on the bones ----
    const pose: NaturalPose = { p: Float64Array.from(p), yaw: z[DIM] * HEADING_SPREAD + start.yaw, hips: new THREE.Vector3(zStartHips[0] + z[DIM + 1] * spreadH, zStartHips[1] + z[DIM + 2] * spreadH, zStartHips[2] + z[DIM + 3] * spreadH) }
    limitPull(p)
    const endTerms = terms(p, z)
    this.apply(pose)
    this.hold(rows, exempt, opts)
    const res = this.measure(rows, startCost, start, performance.now() - t0, iterations, feetNames)
    res.objective = { start: startTerms, end: endTerms }
    return res
  }

  /** Joints held in range; the kept bones put back by reach where the search left them off. */
  private hold (rows: Compiled[], exempt: Uint8Array, opts: NaturalOptions): void {
    const limits = this.limits ?? undefined
    // every joint in its range
    if (limits !== undefined) {
      for (let i = 1; i < NB; i++) {
        const name = BODY[i]
        if (!limits.has(name) || exempt[i] !== 0) continue
        const held = limits.clamp(name, this.bones[i].quaternion)
        this.bones[i].quaternion.copy(held)
      }
      this.bones[0].updateMatrixWorld(true)
    }
    // the kept: a limb's end back on its transform
    const limbs: Array<[string, Limb]> = []
    for (const s of ['Left', 'Right']) {
      for (const [end, upper, lower] of [[`${s}Foot`, `${s}UpLeg`, `${s}Leg`], [`${s}Hand`, `${s}Arm`, `${s}ForeArm`]]) {
        limbs.push([end, { upper: this.byName.get(upper)!, lower: this.byName.get(lower)!, end: this.byName.get(end)! }])
      }
    }
    for (const row of rows) {
      if (!row.keep || row.position === null || row.turn === null) continue
      const bone = this.bones[row.a]
      const limb = limbs.find(([end]) => end === BODY[row.a])
      const at = new THREE.Vector3(row.position[0], row.position[1], row.position[2])
      const turn = new THREE.Quaternion(row.turn[0], row.turn[1], row.turn[2], row.turn[3])
      // (the row is the bone's own transform: kept exactly, its range or not, as a hand carrying a prop keeps it on its line)
      if (limb !== undefined && wp(bone).distanceTo(at) >= 5e-4) reach(limb[1], at, { limits, nameOf: this.nameOf, keepEnd: false })
      if (wq(bone).angleTo(turn) > 0.002) setWorldQuaternion(bone, turn)
    }
    // the turns asked exactly
    for (const row of rows) {
      const bone = this.byName.get(row.bone)
      if (!row.exact || row.turn === null || bone === undefined || row.give !== null) continue
      if (row.rollLocal !== null && row.rollWorld !== null) {
        // (the roll yielded stays; the roll axis goes exactly where the goal puts it: the swing, the shortest way)
        const now = new THREE.Vector3(...row.rollLocal).applyQuaternion(wq(bone))
        setWorldQuaternion(bone, new THREE.Quaternion().setFromUnitVectors(now, new THREE.Vector3(...row.rollWorld)).multiply(wq(bone)))
      } else setWorldQuaternion(bone, new THREE.Quaternion(row.turn[0], row.turn[1], row.turn[2], row.turn[3]))
    }
    // the floor, the one hard thing of a soft foot: a leg whose sole point is left under its height reaches its foot up by that much
    if (opts.floor !== undefined && opts.planted !== true) {
      const legs: Leg[] = []; const soles: number[][] = []
      for (const n of opts.feet ?? []) {
        const side = n.replace('Foot', '')
        const upper = this.byName.get(`${side}UpLeg`); const lower = this.byName.get(`${side}Leg`); const end = this.byName.get(n)
        if (upper === undefined || lower === undefined || end === undefined) continue
        const ballName = `${side}ToeBase`; const tipName = `${side}Toe_End`
        const ball = this.byName.get(ballName) ?? null; const tip = this.byName.get(tipName) ?? null
        legs.push({ upper, lower, end, ball, tip })
        // (the heights the search held them to: the rest heights, or lower where the start pose had a point under its own)
        const held = (name: string): number => { const row = rows.find(r => r.floorY !== null && r.bone === name); return row === undefined ? -Infinity : row.floorY! - opts.floor!.y }
        soles.push([held(n), held(ballName), held(tipName)])
      }
      // (a leg that is only a hair under is left: reaching it up with the limits on can throw a leg at the edge of its range far from where the search put it; one that is moved and strays is put back)
      legs.forEach((leg, i) => {
        const under = Math.max(...[leg.end, leg.ball, leg.tip].map((b, k) => (b === null || !Number.isFinite(soles[i][k]) ? 0 : opts.floor!.y + soles[i][k] - wp(b).y)))
        if (under <= 5e-4 * this.scale) return
        const saved = [leg.upper, leg.lower, leg.end].map(b => b.quaternion.clone())
        const at = wp(leg.end)
        keepOffFloor([leg], opts.floor!.y, [soles[i]], { limits, nameOf: this.nameOf })
        const moved = wp(leg.end).sub(at)
        if (Math.hypot(moved.x, moved.z) > 0.5 * under + 1e-3 * this.scale || moved.y > 2 * under + 1e-3 * this.scale) {
          [leg.upper, leg.lower, leg.end].forEach((b, k) => b.quaternion.copy(saved[k]))
          leg.upper.updateMatrixWorld(true)
        }
      })
    }
  }

  private measure (rows: Compiled[], startCost: NaturalCost, start: NaturalPose, ms: number, iterations: number, feet: string[]): NaturalResult {
    this.bones[0].updateMatrixWorld(true)
    let miss = 0; let keepMiss = 0; let turnMiss = 0; let softMiss = 0; let floorMiss = 0; let rollYield = 0
    const gave: Array<{ bone: string, roll: number, other: number }> = []
    const moved = { slide: 0, lift: 0, twist: 0, tilt: 0 }
    const goalOf = (row: Compiled): { at: THREE.Vector3, q: THREE.Quaternion } => {
      const b = this.bones[row.a]
      const q = wq(b)
      return { at: new THREE.Vector3(...row.at).applyQuaternion(q).add(wp(b)), q: q.multiply(new THREE.Quaternion(...row.rel)) }
    }
    for (const row of rows) {
      if (row.phase === 1) continue
      const { at, q } = goalOf(row)
      if (row.floorY !== null) { floorMiss = Math.max(floorMiss, row.floorY - at.y); continue }
      if (row.soft) {
        const d = at.clone().sub(new THREE.Vector3(...row.position!))
        moved.slide = Math.max(moved.slide, Math.hypot(d.x, d.z)); moved.lift = Math.max(moved.lift, Math.abs(d.y))
        const e = q.clone().multiply(new THREE.Quaternion(...row.turn!).invert())
        const rv = [0, 0, 0]
        logTo(e, rv, 0)
        moved.twist = Math.max(moved.twist, THREE.MathUtils.radToDeg(Math.abs(rv[1])))
        moved.tilt = Math.max(moved.tilt, THREE.MathUtils.radToDeg(Math.hypot(rv[0], rv[2])))
        continue
      }
      if (row.position !== null) {
        const d = at.clone().sub(new THREE.Vector3(...row.position))
        if (row.slide !== null) { const s = new THREE.Vector3(...row.slide); d.addScaledVector(s, -d.dot(s)) }
        if (row.keep) keepMiss = Math.max(keepMiss, d.length()); else if (row.hard) miss = Math.max(miss, d.length()); else softMiss = Math.max(softMiss, d.length())
      }
      if (row.turn !== null && row.give !== null) {
        // (a turn with give: what it gave, as the roll round its grip line and the rest)
        const e = q.clone().multiply(new THREE.Quaternion(...row.turn).invert())
        const rv = [0, 0, 0]
        logTo(e, rv, 0)
        const all = Math.hypot(rv[0], rv[1], rv[2])
        const roll = row.rollWorld === null ? 0 : rv[0] * row.rollWorld[0] + rv[1] * row.rollWorld[1] + rv[2] * row.rollWorld[2]
        const other = Math.sqrt(Math.max(0, all * all - roll * roll))
        gave.push({ bone: row.bone, roll: THREE.MathUtils.radToDeg(Math.abs(roll)), other: THREE.MathUtils.radToDeg(other) })
        rollYield = Math.max(rollYield, THREE.MathUtils.radToDeg(Math.abs(roll)))
      } else if (row.turn !== null && (row.hard || row.keep)) {
        if (row.rollWorld !== null) {
          // (a turn that yields round its roll axis: the axis's miss is the turn's miss; the roll is what it gave)
          const e = q.clone().multiply(new THREE.Quaternion(...row.turn).invert())
          const rv = [0, 0, 0]
          logTo(e, rv, 0)
          const roll = rv[0] * row.rollWorld[0] + rv[1] * row.rollWorld[1] + rv[2] * row.rollWorld[2]
          const swing = Math.hypot(rv[0] - roll * row.rollWorld[0], rv[1] - roll * row.rollWorld[1], rv[2] - roll * row.rollWorld[2])
          turnMiss = Math.max(turnMiss, THREE.MathUtils.radToDeg(swing)); rollYield = Math.max(rollYield, THREE.MathUtils.radToDeg(Math.abs(roll)))
        } else turnMiss = Math.max(turnMiss, THREE.MathUtils.radToDeg(q.angleTo(new THREE.Quaternion(...row.turn))))
      }
    }
    const now = this.encode()
    const delta = new Float64Array(DIM + EXTRA)
    for (let d = 0; d < DIM; d++) delta[d] = now.p[d] - start.p[d]
    delta[DIM] = now.yaw - start.yaw
    delta[DIM + 1] = now.hips.x - start.hips.x
    delta[DIM + 2] = now.hips.y - start.hips.y
    delta[DIM + 3] = now.hips.z - start.hips.z
    return { miss, keepMiss, turnMiss, cost: this.model.cost(now.p), startCost, pose: now, delta, iterations, ms, floorMiss: Math.max(0, floorMiss), feetMoved: moved, softMiss, balance: feet.length > 0 ? this.balanceOf(feet) : null, rollYield, give: gave }
  }
}

/** Solve (H + mu diag(H)) x = b in place (b becomes x) by Cholesky; false when H isn't positive definite. */
function solveSPD (H: Float64Array, n: number, mu: number, b: Float64Array): boolean {
  const L = new Float64Array(n * n)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = H[i * n + j]
      if (i === j) s += mu * (H[i * n + i] + 1e-9)
      for (let k = 0; k < j; k++) s -= L[i * n + k] * L[j * n + k]
      if (i === j) {
        if (s <= 1e-14) return false
        L[i * n + i] = Math.sqrt(s)
      } else L[i * n + j] = s / L[j * n + j]
    }
  }
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= L[i * n + k] * b[k]; b[i] = s / L[i * n + i] }
  for (let i = n - 1; i >= 0; i--) { let s = b[i]; for (let k = i + 1; k < n; k++) s -= L[k * n + i] * b[k]; b[i] = s / L[i * n + i] }
  return true
}

/** The model from its file's contents. */
export function loadPoseModel (data: PoseModelData): PoseModel { return new PoseModel(data) }

/** Reach `goals` with the most natural pose nearest the start (NaturalRig.solve). */
export function solveNatural (rig: NaturalRig, goals: NaturalGoal[], opts: NaturalOptions = {}): NaturalResult { return rig.solve(goals, opts) }

/**
 * Each sole point's height above the floor (the ankle, the ball and the toes' tip of both feet, by bone name), from the
 * bones as they stand: call it with the character standing at rest on the floor (the `floor.soles` of a solve).
 */
export function restSoles (bones: Map<string, THREE.Bone>, floorY = 0): Record<string, number> {
  const out: Record<string, number> = {}
  const root = bones.get('Hips')
  root?.updateMatrixWorld(true)
  for (const side of ['Left', 'Right']) {
    for (const n of ['Foot', 'ToeBase', 'Toe_End']) {
      const b = bones.get(`${side}${n}`)
      if (b !== undefined) out[`${side}${n}`] = wp(b).y - floorY
    }
  }
  return out
}

// ---- a drop-in for src/engine/bodysolve.ts solveBody -----------------------------------------------------------------

/** What the drop-in hands back as the frame's state: bodysolve's four numbers (as they came out, for show and for a rule-based next frame) and this solver's own warm start. */
export type NaturalBodyState = BodyState & { warm?: Float64Array, objective?: NaturalResult['objective'] }
/** solveBody's options, and: `planted` (the feet hard-locked, the first solver's behaviour), the `floor` (world y) and `soles` (each leg's [ankle, ball, tip] rest heights above it, as ik.ts keepOffFloor takes them) that keep every sole point from going under it. */
export interface NaturalSolveOptions extends SolveOptions {
  planted?: boolean, floor?: number, soles?: number[][]
  /** The hands carrying a prop (it rides the hand: its turn is the prop's, held exactly; the other hands' turns give). A goal marked `carrier: true` counts too, and so does a hand with a non-bone object (a garment) on it. */
  carrying?: Array<'Left' | 'Right'>
}
export type BodySolver = (bones: Map<string, THREE.Bone>, goals: HandGoal[], opts: NaturalSolveOptions, prev: BodyState | null) => { state: BodyState, miss: number }
export interface BodySolverOptions {
  /** May the hips shift (a lunge, a drop)? Default true: the bake must key the Hips position track. */
  hipsMove?: boolean
  /** The feet hard-locked (also per call: opts.planted). Default false: soft. */
  planted?: boolean
  /** Balance and upright (the centre of mass over the feet's support, the trunk no more bent than the clip has it): default true with soft feet (off with `planted`); false lets the body lean anywhere. */
  balance?: boolean
  /** The anatomical elbow cost (an elbow bowing forward off its shoulder-to-hand line more than the hand's height allows): default true. */
  elbows?: boolean
  /** The hands carrying a prop (see NaturalSolveOptions.carrying): their turns are held exactly, whatever give says. */
  carrying?: Array<'Left' | 'Right'>
  /** A hand's turn yields at all: false asks every hand's turn exactly. Default true. */
  roll?: boolean
  /** A hand's turn gives a little on every axis (GIVE: the roll round its grip line the cheapest, then the swing of the line), the position staying tight; false: only the roll yields (the grip line exact). Default true. */
  give?: boolean
}

/**
 * A hand's grip line in the hand's own frame, from its knuckles (as src/engine/clipedit.ts handGrip has it: across the
 * knuckles from the little finger's to the index's, leaning 25 degrees toward the heel of the hand): the line a shaft takes
 * through the fist. Null for a hand without fingers.
 */
export function gripAxisOf (bones: Map<string, THREE.Bone>, hand: 'Left' | 'Right'): THREE.Vector3 | null {
  const wrist = bones.get(`${hand}Hand`)
  const index = bones.get(`${hand}HandIndex1`); const middle = bones.get(`${hand}HandMiddle1`) ?? index
  const little = bones.get(`${hand}HandPinky1`) ?? bones.get(`${hand}HandRing1`) ?? bones.get(`${hand}HandMiddle1`)
  if (wrist === undefined || index === undefined || little === undefined || middle === undefined) return null
  wrist.updateMatrixWorld(true)
  const h = wp(wrist)
  const f = wp(middle).sub(h).normalize()
  const k = wp(index).sub(wp(little))
  if (k.length() < 1e-9) return null
  k.addScaledVector(f, -k.dot(f)).normalize()
  const lean = THREE.MathUtils.degToRad(25)
  return k.multiplyScalar(Math.cos(lean)).addScaledVector(f, -Math.sin(lean)).normalize().applyQuaternion(wq(wrist).invert())
}

/** The bones the natural solve moves (to bake their tracks): the whole body's, and the fingers a goal closes. (The Hips' position track too, when the hips may move.) */
export function bodyBonesNatural (goals: Array<{ hand: 'Left' | 'Right', fingers?: Record<string, unknown> }>, legs: Leg[]): string[] {
  return [...new Set([...BODY, ...goals.flatMap(g => Object.keys(g.fingers ?? {})), ...legs.flatMap(l => [l.upper.name, l.lower.name, l.end.name])])]
}

/**
 * solveBody's contract on the natural-pose solver: on a frame as the clip has it, each hand with a goal (its wrist's
 * world place and its world turn) reaches it, the whole body turning, leaning, bending and (hipsMove) shifting the way
 * people's bodies do together to let it. The feet (opts.legs) are SOFT: they stay where they stand until the pose needs
 * them to slide, twist or tilt, and no sole point goes under the floor (opts.floor, opts.soles); `planted` locks them
 * as before. Writes the bones; returns the state (`prev` of the next frame: it carries the solver's warm start) and
 * the worst hand miss left (world units). `opts.quick` is a drag, live (a few steps, a few ms); otherwise a bake (to the
 * end, about 10-25 ms). `opts.height` is not needed (the solver knows the body's size). A body missing some of the 22
 * body bones is left as it is (miss Infinity).
 */
export function createBodySolver (model: PoseModel, offsets: Map<string, THREE.Quaternion> | null, options: BodySolverOptions = {}): BodySolver {
  const rigs = new WeakMap<Map<string, THREE.Bone>, { rig: NaturalRig, limits: JointLimits | null }>()
  return (bones, goals, opts, prev) => {
    const zero: NaturalBodyState = { yaw: 0, lean: 0, forward: 0, drop: 0 }
    if (goals.length === 0) return { state: prev ?? zero, miss: 0 }
    let held = rigs.get(bones)
    if (held === undefined || held.limits !== opts.limits) {
      if (BODY.some(n => !bones.has(n))) return { state: prev ?? zero, miss: Infinity }
      held = { rig: new NaturalRig(model, bones, { offsets, limits: opts.limits, nameOf: opts.nameOf }), limits: opts.limits }
      rigs.set(bones, held)
    }
    const rig = held.rig
    const nameOf = (b: THREE.Bone | null | undefined): string | undefined => (b === null || b === undefined ? undefined : [...bones].find(([, x]) => x === b)?.[0])
    const feet = opts.legs.map(l => nameOf(l.end)).filter((n): n is string => n !== undefined)
    // (the floor: each leg's sole points by name, at the heights above it the caller measured)
    let floor: NaturalOptions['floor']
    if (opts.floor !== undefined && opts.soles !== undefined) {
      const soles: Record<string, number> = {}
      opts.legs.forEach((l, i) => {
        [l.end, l.ball, l.tip].forEach((b, k) => { const n = nameOf(b); const h = opts.soles![i]?.[k]; if (n !== undefined && h !== undefined && Number.isFinite(h)) soles[n] = h })
      })
      floor = { y: opts.floor, soles }
    }
    const spine = bones.get('Spine2')!; const hips = bones.get('Hips')!
    rig.bones[0].updateMatrixWorld(true)
    const turnBefore = wq(spine); const hipsBefore = wp(hips)
    const lateral = wp(bones.get('LeftArm')!).sub(wp(bones.get('RightArm')!)); lateral.y = 0
    lateral.normalize()
    const warm = opts.quick === true ? undefined : (prev as NaturalBodyState | null)?.warm
    const res = rig.solve(goals.map(g => {
      // (a hand's turn: exact with roll false; with give false only the roll round its grip line yields; by default it gives a little on every axis)
      // (a hand carrying a prop keeps its turn exactly: the prop rides it, so its turn is the prop's place)
      const hand = bones.get(`${g.hand}Hand`)
      const carries = (g as { carrier?: boolean }).carrier === true || (opts.carrying ?? options.carrying)?.includes(g.hand) === true ||
        (hand?.children.some(c => (c as THREE.Bone).isBone !== true && c.children.length > 0) ?? false)
      const grip = options.roll === false || carries ? null : gripAxisOf(bones, g.hand)
      const turn = options.roll === false || carries ? {} : options.give === false ? (grip === null ? {} : { roll: { axis: grip } }) : { give: grip === null ? {} : { axis: grip } }
      return { bone: `${g.hand}Hand`, position: g.at, turn: g.turn, exact: true, ...turn }
    }), {
      feet, planted: opts.planted ?? options.planted, balance: options.balance, elbows: options.elbows, floor, mode: opts.quick === true ? 'quick' : 'full', hipsMove: options.hipsMove ?? true, warm,
    })
    // (the fingers as asked; the miss as it stands)
    let miss = 0
    for (const g of goals) {
      const hand = bones.get(`${g.hand}Hand`)!
      for (const [name, q] of Object.entries(g.fingers ?? {})) { const b = bones.get(name); if (b !== undefined) { b.quaternion.set(...q); b.updateMatrixWorld(true) } }
      miss = Math.max(miss, wp(hand).distanceTo(g.at))
    }
    // (for show: how far the chest turned and leaned, the hips shifted)
    const rv = [0, 0, 0]
    logTo(wq(spine).multiply(turnBefore.invert()), rv, 0)
    const ahead = new THREE.Vector3().crossVectors(lateral, new THREE.Vector3(0, 1, 0)).normalize()
    const moved = wp(hips).sub(hipsBefore)
    const state: NaturalBodyState = { yaw: rv[1], lean: rv[0] * lateral.x + rv[2] * lateral.z, forward: moved.dot(ahead) / opts.height, drop: -moved.y / opts.height, warm: res.delta, objective: res.objective }
    return { state, miss }
  }
}

let bound: BodySolver | null = null
/** Once per character: the model and the retarget's K the drop-in solves with (retargetOffsets(source rest, character rest).offsets; null for the model's own skeleton). */
export function bindNaturalBody (model: PoseModel, offsets: Map<string, THREE.Quaternion> | null, options: BodySolverOptions = {}): void { bound = createBodySolver(model, offsets, options) }
/** bodysolve.ts solveBody's signature, solved naturally (bindNaturalBody first). */
export const solveBodyNatural: BodySolver = (bones, goals, opts, prev) => {
  if (bound === null) throw new Error('solveBodyNatural: bindNaturalBody(model, offsets) first')
  return bound(bones, goals, opts, prev)
}

// ---- the whole clip: a naturalize pass ---------------------------------------------------------------------------------

/** Targets for bones as they stand now (the edited pose's: a keyed bone's world turn, and its place), soft, at `weight`. */
export function poseTargets (rig: NaturalRig, names: string[], opts: { weight?: number, position?: boolean, turn?: boolean } = {}): NaturalGoal[] {
  const out: NaturalGoal[] = []
  rig.bones[0].updateMatrixWorld(true)
  for (const n of names) {
    const b = rig.bone(n)
    if (b === undefined) continue
    out.push({ bone: n, position: opts.position === false ? undefined : wp(b), turn: opts.turn === false ? undefined : wq(b), weight: opts.weight ?? 1, hard: false })
  }
  return out
}

export interface NaturalizeOptions {
  /** How many frames. */
  frames: number
  /** Put the rig's bones in the edited clip's frame `i` (and its world matrices up to date). */
  pose: (i: number) => void
  /** The goals of frame `i`, called with the rig posed in the edited frame (so a target can be read off it: poseTargets). Hard ones (the hands on their prop's sockets) are met; `hard: false` ones (a keyed bone's) are pulled toward at their weight. */
  goals: (i: number) => NaturalGoal[]
  /** Bones kept hard on their place and turn (a prop's carrier). */
  keep?: string[]
  /** The standing feet (Foot bones): soft unless `planted`; and the floor under them (restSoles). */
  feet?: string[]
  planted?: boolean
  floor?: NaturalOptions['floor']
  /** May the hips move (and the clip get a Hips position track)? Default true. */
  hipsMove?: boolean
  /** 'full' (default) or 'quick' per frame. */
  mode?: 'quick' | 'full'
  /** A pull of every frame toward the model's mean pose (NaturalOptions.pull; default 0: only what the goals need moves). */
  pull?: number
  /** How hard the correction of a frame is held to its neighbours' (per radian squared; default 40: a 6 degree jump between frames costs about 0.4 per joint). */
  smooth?: number
  /** Passes over the clip, alternating forward and backward (default 2; the last one is the result). */
  sweeps?: number
  progress?: (done: number, total: number) => void
}

export interface NaturalizedFrame {
  /** BODY bones' local turns (x y z w each, in BODY's order), and the hips' local position. */
  q: Float32Array
  hips: [number, number, number]
  /** The worst hard goal's miss (world metres), a kept bone's, a soft target's; a sole point under the floor; the worst turn off (degrees). */
  miss: number
  keepMiss: number
  softMiss: number
  floorMiss: number
  turnMiss: number
  cost: NaturalCost
  startCost: NaturalCost
  feetMoved: NaturalResult['feetMoved']
}

/**
 * Adjust every frame of an edited clip toward the most natural pose: each frame is solved as `rig.solve` does (its goals
 * met, its pose as near the edit as the model's joint couplings allow), and the corrections (what each frame moved from
 * the edited one) are held smooth over time by a pull of each toward its neighbours', swept forward and back. The feet
 * are soft and the floor held; the edit's own motion between frames is untouched (only the corrections are smoothed).
 */
export function naturalizeFrames (rig: NaturalRig, o: NaturalizeOptions): NaturalizedFrame[] {
  const n = o.frames
  const sweeps = Math.max(1, o.sweeps ?? 2)
  const deltas: Array<Float64Array | null> = new Array<Float64Array | null>(n).fill(null)
  const out: NaturalizedFrame[] = new Array<NaturalizedFrame>(n)
  let done = 0
  for (let s = 0; s < sweeps; s++) {
    const last = s === sweeps - 1
    for (let k = 0; k < n; k++) {
      const i = s % 2 === 0 ? k : n - 1 - k
      o.pose(i)
      const near = [deltas[i - 1], deltas[i + 1]].filter((d): d is Float64Array => d !== null && d !== undefined)
      let smooth: NaturalOptions['smooth']
      if (near.length > 0) {
        const ref = new Float64Array(DIM + EXTRA)
        for (const d of near) for (let j = 0; j < ref.length; j++) ref[j] += d[j] / near.length
        smooth = { ref, weight: (o.smooth ?? 40) * near.length }
      }
      const res = rig.solve(o.goals(i), { keep: o.keep, feet: o.feet, planted: o.planted, floor: o.floor, hipsMove: o.hipsMove ?? true, mode: o.mode ?? 'full', pull: o.pull, warm: deltas[i] ?? undefined, smooth })
      deltas[i] = res.delta
      if (last) {
        const q = new Float32Array(NB * 4)
        rig.bones.forEach((b, j) => { b.quaternion.toArray(q, j * 4) })
        const hp = rig.bones[0].position
        out[i] = { q, hips: [hp.x, hp.y, hp.z], miss: res.miss, keepMiss: res.keepMiss, softMiss: res.softMiss, floorMiss: res.floorMiss, turnMiss: res.turnMiss, cost: res.cost, startCost: res.startCost, feetMoved: res.feetMoved }
      }
      o.progress?.(++done, n * sweeps)
    }
  }
  return out
}

/**
 * naturalizeFrames on a baked clip: the clip played on the rig's character at `fps` (30), each frame's goals from
 * `goals(i, t)`, the result as a new dense clip (the 22 body bones' quaternion tracks and, when the hips may move, the
 * Hips position track replaced; every other track as it was) with the per-frame misses.
 */
export function naturalizeClip (rig: NaturalRig, clip: THREE.AnimationClip, o: Omit<NaturalizeOptions, 'frames' | 'pose' | 'goals'> & { goals: (i: number, t: number) => NaturalGoal[], fps?: number, root?: THREE.Object3D }): { clip: THREE.AnimationClip, times: number[], frames: NaturalizedFrame[], misses: number[] } {
  const fps = o.fps ?? 30
  let root: THREE.Object3D = o.root ?? rig.bones[0]
  if (o.root === undefined) while (root.parent !== null) root = root.parent
  const count = Math.max(1, Math.round(clip.duration * fps))
  const times = Array.from({ length: count + 1 }, (_, i) => Math.min(clip.duration, i / fps))
  // (every bone as it was, to put back)
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion]> = []
  root.traverse(b => { if ((b as THREE.Bone).isBone === true) saved.push([b, b.position.clone(), b.quaternion.clone()]) })
  const mixer = new THREE.AnimationMixer(root)
  const pose = (i: number): void => {
    mixer.stopAllAction()
    const a = mixer.clipAction(clip)
    // (once and held at the end: at its very end a looping action wraps round to its first frame)
    a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true
    a.reset(); a.play()
    mixer.setTime(times[i])
    root.updateMatrixWorld(true)
  }
  const frames = naturalizeFrames(rig, { ...o, frames: times.length, pose, goals: i => o.goals(i, times[i]) })
  mixer.stopAllAction()
  mixer.uncacheRoot(root)
  for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q) }
  root.updateMatrixWorld(true)
  const names = new Set(rig.bones.map(b => `${b.name}.quaternion`))
  const hipsMove = o.hipsMove ?? true
  if (hipsMove) names.add(`${rig.bones[0].name}.position`)
  const tracks = clip.tracks.filter(t => !names.has(t.name))
  rig.bones.forEach((b, j) => {
    const values = new Float32Array(frames.length * 4)
    frames.forEach((f, i) => { values.set(f.q.subarray(j * 4, j * 4 + 4), i * 4) })
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values))
  })
  if (hipsMove) {
    const values = new Float32Array(frames.length * 3)
    frames.forEach((f, i) => { values.set(f.hips, i * 3) })
    tracks.push(new THREE.VectorKeyframeTrack(`${rig.bones[0].name}.position`, times, values))
  }
  return { clip: new THREE.AnimationClip(clip.name, clip.duration, tracks), times, frames, misses: frames.map(f => f.miss) }
}
