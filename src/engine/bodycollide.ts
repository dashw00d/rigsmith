// The body as solids, so no part of it ends up inside another (a hand in the chest, a thigh through a thigh): one capsule
// per body segment, its cross-section an ellipse (a chest is wider than it is deep), fitted to each character's OWN skinned
// mesh, and the pairs of segments that may not touch.
//
// The fit (buildBodyCollider): every vertex of the skinned meshes weighted mostly (>= WEIGHTED) to one bone belongs to that
// bone's segment (a hand: its wrist and fingers; the chest: Spine1 and Spine2; the head: its eyes, hair). In the bind pose,
// in the segment's bone frame, each such vertex is projected on the segment's axis (kept within the segment's length, joints
// excluded: those are blends of two bones) and its offset from the axis is split on the cross-section's two principal
// directions; the centre of the section and its two half-widths are the middle and half the spread between the
// `1 - EDGE` and `EDGE` quantiles of those offsets. The shape is kept in the bone's own frame in world metres, so it needs
// only the bones' world places to stand in any pose: a segment's axis runs from its bone to the next one (or to a fixed
// tip in its own frame: a hand's knuckles, the head's top), moved by the section's centre.
//
// Two ways to ask: BodyCollider (the bones as they stand, for a caller with a capsule of its own: a prop's), and the
// BoundShape the pose solver (src/engine/posespace.ts) walks on its own forward kinematics (typed arrays, no allocation).
//
// CharacterCollider is the one collision model every solve of the editor shares (the body solver, the gear fit in
// src/engine/propfit.ts, the finger correction in src/engine/handcontacts.ts, the editor's own checks): these capsules for
// the body, each hand's own skinned surface for its fingers (src/engine/surfacecontact.ts, built when first asked), and
// held shafts as obstacles (shaftObstacles).
import * as THREE from 'three'
import { canonical, type Side } from './retarget.ts'
import { HandContactSurface } from './surfacecontact.ts'

export interface BodyCollider {
  /** Deepest penetration (metres, 0 = none) of a capsule a–b of `radius` into the body as the bones stand now, ignoring the segments named (by bone). */
  penetration (a: THREE.Vector3, b: THREE.Vector3, radius: number, ignore?: string[]): number
  /** Every pair of body segments that may not touch, and how deep they are into each other now. */
  selfPenetration (): { worst: number, pairs: Array<[string, string, number]> }
  // (the depth is what is past what the pair may overlap, ALLOW: a hand rests on a thigh; `pairs` lists those past it, deepest first)
}

/** Two body segments' contact as the bones stand: how deep `a` is into `b` (metres, 0: apart) and the way straight out of
 * it for `a` (unit, world: from `b`'s nearest point to `a`'s). */
export interface Contact { depth: number, normal: THREE.Vector3 }

/** A BodyCollider that also carries its fitted shape (what the pose solver reads). `selfPenetration().pairs` lists only the pairs that overlap now, deepest first. */
export interface SolidBody extends BodyCollider {
  readonly shape: BodyShape
  /** Segments `a` and `b` (by name) as the bones stand; null when either isn't one of the body's. */
  contact (a: string, b: string): Contact | null
}

/** A vertex counts for a bone when at least this much of it is weighted there. */
const WEIGHTED = 0.55
/** The leg's length (thigh and shin) of the Y Bot, the body the pose model and these sizes were measured on: what the
 * overlaps allowed here and the pose solver's units (src/engine/posespace.ts) are scaled by. */
export const Y_BOT_LEG = 0.827
/** The quantile of the offsets (and its mirror) that bounds a segment's section; its half-spread is the radius. */
const EDGE = 0.9
/** The part of a segment's length (from either end, as a fraction of it) the vertices must lie within to be measured. */
const REACH = 0.2
/** At most this many vertices per mesh are read. */
const SAMPLE = 60000
/** A vertex farther from its segment's middle than this many times the median is left out (a skirt, a cloak, a strap). */
const OUTLIER = 2.2
/** A section is at least this much as wide as it is long across (a ribcage is no blade), and at least `MIN_R` of the leg's length (each segment's own: a neck is not a thread). */
const FLAT = 0.4
/** The least a section's half-width is, as a share of the leg's length (thigh and shin): by segment name, `default` the rest. */
const MIN_R: Record<string, number> = { default: 0.03, Neck: 0.05, Spine: 0.1, Spine1: 0.12, Hips: 0.12, Head: 0.1 }

/** One body segment: a capsule along bone `a`'s own frame (all lengths world metres). */
export interface Segment {
  /** The bone the segment is named for and rides. */
  name: string
  a: string
  /** The bone its axis runs to (the axis' end = a + (b - a) * ext), or null: the axis ends at `tip`, in a's frame. */
  b: string | null
  ext: number
  tip: [number, number, number]
  /** The section's centre, in a's frame, off the bones' line. */
  off: [number, number, number]
  /** The section's two principal directions (unit, in a's frame, perpendicular to the axis) and their half-widths. */
  u1: [number, number, number]
  u2: [number, number, number]
  r1: number
  r2: number
}

export interface BodyShape {
  segments: Segment[]
  /** The pairs of segments (indices) that may not touch, what each may overlap (metres), and how many of them (the first ones) a live drag looks at. */
  pairs: Array<[number, number]>
  slack: number[]
  quick: number
  /** The bones the segments read. */
  bones: string[]
}

// ---- the body's segments -------------------------------------------------------------------------------------------------

interface Def {
  name: string
  a: string
  b?: string
  /** A bone whose place in a's frame ends the axis (times ext), when no bone follows. */
  tipOf?: string
  /** Lengthen the axis (a bone-to-bone one, or a tip's) by this. */
  ext?: number
  /** The bones whose vertices are this segment's (their descendants without a segment of their own too). */
  from: string[]
}

const DEFS: Def[] = [
  { name: 'Hips', a: 'Hips', b: 'Spine', from: ['Hips'] },
  { name: 'Spine', a: 'Spine', b: 'Spine1', from: ['Spine'] },
  { name: 'Spine1', a: 'Spine1', b: 'Neck', from: ['Spine1', 'Spine2'] },
  { name: 'Neck', a: 'Neck', b: 'Head', from: ['Neck'] },
  { name: 'Head', a: 'Head', tipOf: 'HeadTop_End', from: ['Head'] },
  ...['Left', 'Right'].flatMap((s): Def[] => [
    { name: `${s}Arm`, a: `${s}Arm`, b: `${s}ForeArm`, from: [`${s}Arm`] },
    { name: `${s}ForeArm`, a: `${s}ForeArm`, b: `${s}Hand`, from: [`${s}ForeArm`] },
    { name: `${s}Hand`, a: `${s}Hand`, tipOf: `${s}HandMiddle1`, ext: 1.3, from: [`${s}Hand`] },
    { name: `${s}UpLeg`, a: `${s}UpLeg`, b: `${s}Leg`, from: [`${s}UpLeg`] },
    { name: `${s}Leg`, a: `${s}Leg`, b: `${s}Foot`, from: [`${s}Leg`] },
    { name: `${s}Foot`, a: `${s}Foot`, b: `${s}ToeBase`, ext: 1.35, from: [`${s}Foot`, `${s}ToeBase`] },
  ]),
]

/** The trunk's segments: they overlap one another, so a limb's or an obstacle's contact with them counts once, its
 * deepest (the pose solver's collision rows, src/engine/posespace.ts). */
export const TRUNK: ReadonlySet<string> = new Set(['Hips', 'Spine', 'Spine1', 'Neck'])

/**
 * How much two segments of a kind may overlap before it counts (centimetres of a Y Bot's size): fitted capsules are not the
 * skin, and some parts really do touch (a hand rests on a thigh or a hip, hands clasp, shins cross in a stride), as the
 * library's own captures do (their overlaps against these capsules, measured by the 'clean on the library's own poses' test in src/engine/bodycollide.test.ts: 94% of frames within a centimetre of them).
 */
export const ALLOW = { trunk: 1, thigh: 4, arms: 2, hands: 5, legs: 2.5 }

/** The pairs that may not touch, by segment name, with what they may overlap (ALLOW): arms against the trunk, head and thighs; arm against arm; legs against each other. The arms' come first (`arms` of them: the pairs a live drag can change). */
function pairNames (): { pairs: Array<[string, string, number]>, arms: number } {
  const arms: Array<[string, string, number]> = []
  const seen = new Set<string>()
  const add = (a: string, b: string, allow: number): void => {
    const k = [a, b].sort().join('|')
    if (seen.has(k)) return
    seen.add(k)
    arms.push([a, b, allow])
  }
  for (const s of ['Left', 'Right']) {
    const o = s === 'Left' ? 'Right' : 'Left'
    // (the upper arm meets the chest at the shoulder: it may not enter the belly, the pelvis or the head; the forearm and hand, the whole trunk and head)
    for (const t of ['Hips', 'Spine', 'Head']) add(`${s}Arm`, t, ALLOW.trunk)
    for (const arm of [`${s}ForeArm`, `${s}Hand`]) {
      for (const t of ['Hips', 'Spine', 'Spine1', 'Neck', 'Head']) add(arm, t, ALLOW.trunk)
      for (const t of ['UpLeg', 'Leg']) for (const side of ['Left', 'Right']) add(arm, `${side}${t}`, ALLOW.thigh)
      // (the other arm, all of it)
      for (const t of ['Arm', 'ForeArm', 'Hand']) add(arm, `${o}${t}`, arm.endsWith('Hand') && t === 'Hand' ? ALLOW.hands : ALLOW.arms)
    }
  }
  // (legs against each other; the two thighs meet at the pelvis: left alone)
  const legs: Array<[string, string, number]> = []
  for (const a of ['UpLeg', 'Leg', 'Foot']) for (const b of ['UpLeg', 'Leg', 'Foot']) if (!(a === 'UpLeg' && b === 'UpLeg')) legs.push([`Left${a}`, `Right${b}`, ALLOW.legs])
  return { pairs: [...arms, ...legs], arms: arms.length }
}

// ---- segments in a pose ------------------------------------------------------------------------------------------------

/** Floats per segment in a pose's frames: p0, p1, unit axis, u1, u2 (world), the bounding sphere's centre and radius. */
const FR = 19
const E = { p0: 0, p1: 3, e: 6, u1: 9, u2: 12, c: 15, R: 18 }

/** A shape on bones in some order: its segments' bone indices, and its pose frames (updated from the bones' world places). */
export class BoundShape {
  readonly shape: BodyShape
  readonly n: number
  private readonly ai: Int32Array
  private readonly bi: Int32Array
  readonly frames: Float64Array
  /** The pairs, flat (i, j, ...), what each may overlap, and how many of them (the first) a live drag looks at. */
  readonly pairs: Int32Array
  readonly slack: Float64Array
  readonly quick: number
  private readonly tmp = new Float64Array(24)

  /** `index` gives a bone's place in the P (3 per bone) and Q (4 per bone, x y z w) arrays `update` reads. */
  constructor (shape: BodyShape, index: (bone: string) => number) {
    this.shape = shape
    this.n = shape.segments.length
    this.ai = Int32Array.from(shape.segments.map(s => index(s.a)))
    this.bi = Int32Array.from(shape.segments.map(s => (s.b === null ? -1 : index(s.b))))
    this.frames = new Float64Array(this.n * FR)
    this.pairs = Int32Array.from(shape.pairs.flat())
    this.slack = Float64Array.from(shape.slack)
    this.quick = shape.quick
  }

  /** The segments' world frames from the bones' world places P and turns Q. */
  update (P: ArrayLike<number>, Q: ArrayLike<number>): void {
    const f = this.frames
    for (let i = 0; i < this.n; i++) {
      const s = this.shape.segments[i]; const o = i * FR
      const a = this.ai[i]; const b = this.bi[i]
      const qx = Q[a * 4]; const qy = Q[a * 4 + 1]; const qz = Q[a * 4 + 2]; const qw = Q[a * 4 + 3]
      // (offset: the section's centre; the axis' end: the next bone, or the tip, in a's frame)
      const t = this.tmp
      rot(t, 0, qx, qy, qz, qw, s.off[0], s.off[1], s.off[2])
      f[o + E.p0] = P[a * 3] + t[0]; f[o + E.p0 + 1] = P[a * 3 + 1] + t[1]; f[o + E.p0 + 2] = P[a * 3 + 2] + t[2]
      if (b >= 0) {
        f[o + E.p1] = P[a * 3] + (P[b * 3] - P[a * 3]) * s.ext + t[0]
        f[o + E.p1 + 1] = P[a * 3 + 1] + (P[b * 3 + 1] - P[a * 3 + 1]) * s.ext + t[1]
        f[o + E.p1 + 2] = P[a * 3 + 2] + (P[b * 3 + 2] - P[a * 3 + 2]) * s.ext + t[2]
      } else {
        rot(t, 3, qx, qy, qz, qw, s.tip[0], s.tip[1], s.tip[2])
        f[o + E.p1] = P[a * 3] + t[3] + t[0]; f[o + E.p1 + 1] = P[a * 3 + 1] + t[4] + t[1]; f[o + E.p1 + 2] = P[a * 3 + 2] + t[5] + t[2]
      }
      let ex = f[o + E.p1] - f[o + E.p0]; let ey = f[o + E.p1 + 1] - f[o + E.p0 + 1]; let ez = f[o + E.p1 + 2] - f[o + E.p0 + 2]
      const len = Math.hypot(ex, ey, ez)
      if (len > 1e-9) { ex /= len; ey /= len; ez /= len } else { ex = 0; ey = 1; ez = 0 }
      f[o + E.e] = ex; f[o + E.e + 1] = ey; f[o + E.e + 2] = ez
      rot(f, o + E.u1, qx, qy, qz, qw, s.u1[0], s.u1[1], s.u1[2])
      rot(f, o + E.u2, qx, qy, qz, qw, s.u2[0], s.u2[1], s.u2[2])
      f[o + E.c] = (f[o + E.p0] + f[o + E.p1]) / 2; f[o + E.c + 1] = (f[o + E.p0 + 1] + f[o + E.p1 + 1]) / 2; f[o + E.c + 2] = (f[o + E.p0 + 2] + f[o + E.p1 + 2]) / 2
      f[o + E.R] = len / 2 + Math.max(s.r1, s.r2)
    }
  }

  /** How deep segments i and j are into each other (metres; 0: apart), in the frames last updated. */
  depth (i: number, j: number): number {
    const f = this.frames; const a = i * FR; const b = j * FR
    // (the bounding spheres first)
    const dx = f[a + E.c] - f[b + E.c]; const dy = f[a + E.c + 1] - f[b + E.c + 1]; const dz = f[a + E.c + 2] - f[b + E.c + 2]
    const reach = f[a + E.R] + f[b + E.R]
    if (dx * dx + dy * dy + dz * dz >= reach * reach) return 0
    const t = this.tmp
    nearest(f, a + E.p0, f, a + E.p1, f, b + E.p0, f, b + E.p1, t)
    // (from i's nearest point to j's)
    const vx = t[3] - t[0]; const vy = t[4] - t[1]; const vz = t[5] - t[2]
    const dist = Math.hypot(vx, vy, vz)
    const sa = this.shape.segments[i]; const sb = this.shape.segments[j]
    const ra = dist < 1e-9 ? Math.min(sa.r1, sa.r2) : toward(f, a, sa.r1, sa.r2, vx, vy, vz)
    const rb = dist < 1e-9 ? Math.min(sb.r1, sb.r2) : toward(f, b, sb.r1, sb.r2, -vx, -vy, -vz)
    return Math.max(0, ra + rb - dist)
  }

  /** The way straight out of segment j for segment i (unit, world, into `out`), in the frames last updated: from j's
   * nearest point on its axis to i's; where the axes cross, from j's axis to i's middle (else j's first section direction). */
  apart (i: number, j: number, out: THREE.Vector3): THREE.Vector3 {
    const f = this.frames; const a = i * FR; const b = j * FR
    const t = this.tmp
    nearest(f, a + E.p0, f, a + E.p1, f, b + E.p0, f, b + E.p1, t)
    out.set(t[0] - t[3], t[1] - t[4], t[2] - t[5])
    if (out.lengthSq() > 1e-12) return out.normalize()
    // (i's middle off j's axis)
    const ex = f[b + E.e]; const ey = f[b + E.e + 1]; const ez = f[b + E.e + 2]
    out.set(f[a + E.c] - f[b + E.p0], f[a + E.c + 1] - f[b + E.p0 + 1], f[a + E.c + 2] - f[b + E.p0 + 2])
    const k = out.x * ex + out.y * ey + out.z * ez
    out.set(out.x - k * ex, out.y - k * ey, out.z - k * ez)
    if (out.lengthSq() > 1e-12) return out.normalize()
    return out.set(f[b + E.u1], f[b + E.u1 + 1], f[b + E.u1 + 2])
  }

  /** How deep the capsule p–q of `radius` is into segment i (metres; 0: apart). */
  depthOf (i: number, p: ArrayLike<number>, q: ArrayLike<number>, radius: number): number {
    const f = this.frames; const a = i * FR
    const t = this.tmp
    t[6] = p[0]; t[7] = p[1]; t[8] = p[2]; t[9] = q[0]; t[10] = q[1]; t[11] = q[2]
    const mx = (p[0] + q[0]) / 2 - f[a + E.c]; const my = (p[1] + q[1]) / 2 - f[a + E.c + 1]; const mz = (p[2] + q[2]) / 2 - f[a + E.c + 2]
    const reach = f[a + E.R] + radius + Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]) / 2
    if (mx * mx + my * my + mz * mz >= reach * reach) return 0
    nearest(f, a + E.p0, f, a + E.p1, t, 6, t, 9, t)
    const vx = t[3] - t[0]; const vy = t[4] - t[1]; const vz = t[5] - t[2]
    const dist = Math.hypot(vx, vy, vz)
    const s = this.shape.segments[i]
    const r = dist < 1e-9 ? Math.min(s.r1, s.r2) : toward(f, a, s.r1, s.r2, vx, vy, vz)
    return Math.max(0, r + radius - dist)
  }
}

/** v rotated by the turn (x y z w), into out[o..o+2]. */
function rot (out: Float64Array, o: number, x: number, y: number, z: number, w: number, vx: number, vy: number, vz: number): void {
  const tx = 2 * (y * vz - z * vy); const ty = 2 * (z * vx - x * vz); const tz = 2 * (x * vy - y * vx)
  out[o] = vx + w * tx + (y * tz - z * ty)
  out[o + 1] = vy + w * ty + (z * tx - x * tz)
  out[o + 2] = vz + w * tz + (x * ty - y * tx)
}

/** Radius toward d of the segment's ellipsoidal cap. Its two transverse radii
 * are the fitted section; the axial radius is the smaller one. Including the
 * axial component makes endpoint contacts continuous: projecting it away made
 * an almost axial direction suddenly take the entire wide-side radius. */
function toward (f: Float64Array, o: number, r1: number, r2: number, dx: number, dy: number, dz: number): number {
  const ex = f[o + E.e]; const ey = f[o + E.e + 1]; const ez = f[o + E.e + 2]
  const k = dx * ex + dy * ey + dz * ez
  const len = Math.hypot(dx, dy, dz)
  if (len < 1e-9) return Math.min(r1, r2)
  const c1 = (dx * f[o + E.u1] + dy * f[o + E.u1 + 1] + dz * f[o + E.u1 + 2]) / r1
  const c2 = (dx * f[o + E.u2] + dy * f[o + E.u2 + 1] + dz * f[o + E.u2 + 2]) / r2
  const c3 = k / Math.min(r1, r2)
  const q = c1 * c1 + c2 * c2 + c3 * c3
  return q < 1e-12 ? Math.min(r1, r2) : len / Math.sqrt(q)
}

/** The nearest points of segments p0-p1 (in A at ao, ao + 3) and q0-q1 (in B at bo, bo + 3): out = [point on the first (3), point on the second (3)]. */
function nearest (A: ArrayLike<number>, ao: number, A1: ArrayLike<number>, a1: number, B: ArrayLike<number>, bo: number, B1: ArrayLike<number>, b1: number, out: Float64Array): void {
  const p0x = A[ao]; const p0y = A[ao + 1]; const p0z = A[ao + 2]
  const d1x = A1[a1] - p0x; const d1y = A1[a1 + 1] - p0y; const d1z = A1[a1 + 2] - p0z
  const q0x = B[bo]; const q0y = B[bo + 1]; const q0z = B[bo + 2]
  const d2x = B1[b1] - q0x; const d2y = B1[b1 + 1] - q0y; const d2z = B1[b1 + 2] - q0z
  const rx = p0x - q0x; const ry = p0y - q0y; const rz = p0z - q0z
  const a = d1x * d1x + d1y * d1y + d1z * d1z; const e = d2x * d2x + d2y * d2y + d2z * d2z
  const f = d2x * rx + d2y * ry + d2z * rz
  let s: number; let t: number
  if (a <= 1e-12 && e <= 1e-12) { s = 0; t = 0 } else if (a <= 1e-12) { s = 0; t = clamp01(f / e) } else {
    const c = d1x * rx + d1y * ry + d1z * rz
    if (e <= 1e-12) { t = 0; s = clamp01(-c / a) } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z
      const denom = a * e - b * b
      s = denom > 1e-12 ? clamp01((b * f - c * e) / denom) : 0
      t = (b * s + f) / e
      if (t < 0) { t = 0; s = clamp01(-c / a) } else if (t > 1) { t = 1; s = clamp01((b - c) / a) }
    }
  }
  out[0] = p0x + d1x * s; out[1] = p0y + d1y * s; out[2] = p0z + d1z * s
  out[3] = q0x + d2x * t; out[4] = q0y + d2y * t; out[5] = q0z + d2z * t
}
const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)

// ---- the fit ---------------------------------------------------------------------------------------------------------------

const quantile = (sorted: Float64Array, q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]

/** Where a body-bone name's vertices belong: the segment of the nearest ancestor that has one (the shoulder's and anything above the body's: none). */
function ownerOf (bone: THREE.Object3D, owner: Map<string, number>, cache: Map<THREE.Object3D, number>): number {
  const hit = cache.get(bone)
  if (hit !== undefined) return hit
  const own = owner.get(canonical(bone.name))
  let r = -1
  if (own !== undefined) r = own
  else if (bone.parent !== null && (bone.parent as THREE.Bone).isBone === true && !/Shoulder$/.test(canonical(bone.name))) r = ownerOf(bone.parent, owner, cache)
  cache.set(bone, r)
  return r
}

/** The body's shape, fitted to the skinned meshes under `root`. Throws when there are none or the body lacks a bone. */
export function fitBodyShape (root: THREE.Object3D): BodyShape {
  root.updateMatrixWorld(true)
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh === true && o.visible) meshes.push(o as THREE.SkinnedMesh) })
  if (meshes.length === 0) throw new Error('bodycollide: no skinned mesh to fit')
  const owner = new Map<string, number>()
  DEFS.forEach((d, i) => { for (const n of d.from) owner.set(n, i) })
  // (per segment: the vertices in its bone's frame, in world metres, from every mesh)
  const points: number[][] = DEFS.map(() => [])
  const frames: Array<{ axis: THREE.Vector3, tip: THREE.Vector3 | null, scale: number } | null> = DEFS.map(() => null)
  // (the leg's length in the world now: what the least radii are shares of)
  let leg = 0
  {
    const at = new Map<string, THREE.Vector3>()
    meshes[0].skeleton.bones.forEach(b => { at.set(canonical(b.name), new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)) })
    const d = (a: string, b: string): number => at.get(a)?.distanceTo(at.get(b) ?? new THREE.Vector3()) ?? 0
    leg = d('LeftUpLeg', 'LeftLeg') + d('LeftLeg', 'LeftFoot')
    if (!(leg > 0)) leg = 0.8
  }
  for (const mesh of meshes) {
    const sk = mesh.skeleton
    const names = sk.bones.map(b => canonical(b.name))
    const inverse = sk.boneInverses
    const bindWorld = inverse.map(m => m.clone().invert())
    const index = (n: string): number => names.indexOf(n)
    const cache = new Map<THREE.Object3D, number>()
    const segOf = sk.bones.map(b => ownerOf(b, owner, cache))
    const segBone = DEFS.map(d => index(d.a))
    const geo = mesh.geometry
    const pos = geo.attributes.position; const si = geo.attributes.skinIndex; const sw = geo.attributes.skinWeight
    if (si === undefined || sw === undefined) continue
    // (each segment's axis and tip, in its bone's frame, from the first mesh that has them)
    DEFS.forEach((d, i) => {
      const ai = index(d.a)
      if (ai < 0 || frames[i] !== null) return
      const local = (n: string): THREE.Vector3 | null => { const k = index(n); return k < 0 ? null : new THREE.Vector3().setFromMatrixPosition(inverse[ai].clone().multiply(bindWorld[k])) }
      const scale = new THREE.Vector3().setFromMatrixScale(sk.bones[ai].matrixWorld).x
      let tip: THREE.Vector3 | null = null
      let axis: THREE.Vector3 | null = null
      if (d.b !== undefined) { axis = local(d.b); if (axis !== null) axis.multiplyScalar(d.ext ?? 1) } else if (d.tipOf !== undefined) {
        const t = local(d.tipOf)
        if (t !== null) axis = t.multiplyScalar(d.ext ?? 1)
        else {
          // (no such bone: the head's top, the hand's knuckles: straight on from the bone before, as far as it is long times a head's or a hand's share)
          const parent = sk.bones[ai].parent
          const back = parent === null ? null : local(canonical(parent.name))
          if (back !== null && back.lengthSq() > 0) axis = back.clone().multiplyScalar(-(d.a === 'Head' ? 2.2 : 0.35))
        }
        tip = axis
      }
      if (axis !== null) frames[i] = { axis, tip, scale }
    })
    const step = Math.max(1, Math.floor(pos.count / SAMPLE))
    const v = new THREE.Vector3()
    for (let k = 0; k < pos.count; k += step) {
      let best = -1; let bw = 0
      for (let c = 0; c < 4; c++) { const w = sw.getComponent(k, c); if (w > bw) { bw = w; best = si.getComponent(k, c) } }
      if (best < 0 || bw < WEIGHTED) continue
      const seg = segOf[best]
      if (seg < 0) continue
      const ai = segBone[seg]
      if (ai < 0) continue
      v.fromBufferAttribute(pos, k).applyMatrix4(mesh.bindMatrix).applyMatrix4(inverse[ai])
      points[seg].push(v.x, v.y, v.z)
    }
  }
  const segments: Segment[] = []
  DEFS.forEach((d, i) => {
    const fr = frames[i]
    if (fr === null) throw new Error(`bodycollide: no ${d.a} or its next bone`)
    const axis = fr.axis.clone(); const L2 = axis.lengthSq()
    // (the plane across the axis, two perpendicular directions in it)
    const e = axis.clone().normalize()
    const helper = Math.abs(e.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)
    const x = new THREE.Vector3().crossVectors(e, helper).normalize(); const y = new THREE.Vector3().crossVectors(e, x).normalize()
    let xs: number[] = []; let ys: number[] = []
    const p = new THREE.Vector3()
    const pts = points[i]
    for (let k = 0; k < pts.length; k += 3) {
      p.set(pts[k], pts[k + 1], pts[k + 2])
      const t = p.dot(axis) / Math.max(L2, 1e-12)
      if (t < -REACH || t > 1 + REACH) continue
      xs.push(p.dot(x)); ys.push(p.dot(y))
    }
    // (cloth and loose parts: what lies farther off the segment's own middle than a few of its typical distances is not the body)
    if (xs.length >= 24) {
      const mx0 = xs.reduce((a, b) => a + b, 0) / xs.length; const my0 = ys.reduce((a, b) => a + b, 0) / ys.length
      const dist = Float64Array.from(xs, (v, k) => Math.hypot(v - mx0, ys[k] - my0)).sort()
      const cut = OUTLIER * quantile(dist, 0.5)
      const keep = xs.map((v, k) => Math.hypot(v - mx0, ys[k] - my0) <= cut)
      xs = xs.filter((_, k) => keep[k]); ys = ys.filter((_, k) => keep[k])
    }
    const length = Math.sqrt(L2)
    let u1 = x.clone(); let u2 = y.clone()
    let r1 = Math.max(length * 0.25, 1e-4); let r2 = r1; let c1 = 0; let c2 = 0
    if (xs.length >= 24) {
      // (the section's principal directions: the covariance of the offsets)
      let mx = 0; let my = 0
      for (let k = 0; k < xs.length; k++) { mx += xs[k]; my += ys[k] }
      mx /= xs.length; my /= xs.length
      let sxx = 0; let syy = 0; let sxy = 0
      for (let k = 0; k < xs.length; k++) { const a = xs[k] - mx; const b = ys[k] - my; sxx += a * a; syy += b * b; sxy += a * b }
      const th = 0.5 * Math.atan2(2 * sxy, sxx - syy)
      const co = Math.cos(th); const si = Math.sin(th)
      u1 = x.clone().multiplyScalar(co).addScaledVector(y, si); u2 = x.clone().multiplyScalar(-si).addScaledVector(y, co)
      const a1 = new Float64Array(xs.length); const a2 = new Float64Array(xs.length)
      for (let k = 0; k < xs.length; k++) { a1[k] = xs[k] * co + ys[k] * si; a2[k] = -xs[k] * si + ys[k] * co }
      a1.sort(); a2.sort()
      const lo1 = quantile(a1, 1 - EDGE); const hi1 = quantile(a1, EDGE); const lo2 = quantile(a2, 1 - EDGE); const hi2 = quantile(a2, EDGE)
      r1 = Math.max((hi1 - lo1) / 2, 1e-3); r2 = Math.max((hi2 - lo2) / 2, 1e-3)
      c1 = (hi1 + lo1) / 2; c2 = (hi2 + lo2) / 2
    }
    // (a thin section is filled out: a flat one to a share of its wide side, any to its least)
    const widest = Math.max(r1, r2)
    const s = fr.scale
    const floor = Math.max(FLAT * widest, (MIN_R[d.name] ?? MIN_R.default) * leg / s)
    r1 = Math.max(r1, floor); r2 = Math.max(r2, floor)
    const off = u1.clone().multiplyScalar(c1).addScaledVector(u2, c2).multiplyScalar(s)
    const tip = (fr.tip ?? new THREE.Vector3()).clone().multiplyScalar(s)
    segments.push({ name: d.name, a: d.a, b: d.b ?? null, ext: d.b === undefined ? 1 : d.ext ?? 1, tip: tip.toArray() as [number, number, number], off: off.toArray() as [number, number, number], u1: u1.toArray() as [number, number, number], u2: u2.toArray() as [number, number, number], r1: r1 * s, r2: r2 * s })
  })
  const at = new Map(segments.map((s, i) => [s.name, i]))
  const { pairs, arms } = pairNames()
  const cm = 0.01 * leg / Y_BOT_LEG
  return { segments, pairs: pairs.map(([a, b]) => [at.get(a)!, at.get(b)!] as [number, number]), slack: pairs.map(p => p[2] * cm), quick: arms, bones: [...new Set(segments.flatMap(s => (s.b === null ? [s.a] : [s.a, s.b])))] }
}

/**
 * The body's collider on a character: the shape fitted to the skinned meshes under `root`, and the bones (by Mixamo name:
 * `bones`' own keys or the canonical form of them) it reads as they stand when asked.
 */
export function buildBodyCollider (root: THREE.Object3D, bones: Map<string, THREE.Bone>): SolidBody {
  return colliderOf(fitBodyShape(root), bones)
}

const cached = new WeakMap<THREE.Object3D, SolidBody>()
/** buildBodyCollider once per character root. */
export function bodyColliderFor (root: THREE.Object3D, bones: Map<string, THREE.Bone>): SolidBody {
  let c = cached.get(root)
  if (c === undefined) { c = buildBodyCollider(root, bones); cached.set(root, c) }
  return c
}

/** A collider of a fitted shape on a character's bones. */
export function colliderOf (shape: BodyShape, bones: Map<string, THREE.Bone>): SolidBody {
  const byName = new Map<string, THREE.Bone>()
  for (const [k, b] of bones) { byName.set(k, b); byName.set(canonical(k), b); byName.set(canonical(b.name), b) }
  const list = shape.bones
  const bound = new BoundShape(shape, n => list.indexOf(n))
  const found = list.map(n => byName.get(n))
  if (found.some(b => b === undefined)) throw new Error(`bodycollide: the character lacks ${list.filter((_, i) => found[i] === undefined).join(', ')}`)
  const P = new Float64Array(list.length * 3); const Q = new Float64Array(list.length * 4)
  const m = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3()
  const read = (): void => {
    list.forEach((_, i) => {
      const b = found[i]!
      b.updateWorldMatrix(true, false)
      b.matrixWorld.decompose(m, q, sc)
      P[i * 3] = m.x; P[i * 3 + 1] = m.y; P[i * 3 + 2] = m.z
      Q[i * 4] = q.x; Q[i * 4 + 1] = q.y; Q[i * 4 + 2] = q.z; Q[i * 4 + 3] = q.w
    })
    bound.update(P, Q)
  }
  return {
    shape,
    penetration (a, b, radius, ignore = []) {
      read()
      const skip = new Set(ignore)
      let worst = 0
      shape.segments.forEach((s, i) => { if (!skip.has(s.name)) worst = Math.max(worst, bound.depthOf(i, a.toArray(), b.toArray(), radius)) })
      return worst
    },
    selfPenetration () {
      read()
      const pairs: Array<[string, string, number]> = []
      let worst = 0
      shape.pairs.forEach(([i, j], k) => {
        const d = bound.depth(i, j) - shape.slack[k]
        if (d > 1e-5) { pairs.push([shape.segments[i].name, shape.segments[j].name, d]); worst = Math.max(worst, d) }
      })
      pairs.sort((x, y) => y[2] - x[2])
      return { worst, pairs }
    },
    contact (a, b) {
      const i = shape.segments.findIndex(x => x.name === a); const j = shape.segments.findIndex(x => x.name === b)
      if (i < 0 || j < 0) return null
      read()
      return { depth: bound.depth(i, j), normal: bound.apart(i, j, new THREE.Vector3()) }
    },
  }
}

/** The shape a collider carries (null for a BodyCollider of another make: the solver can't use it). */
export function shapeOf (c: BodyCollider | undefined): BodyShape | null {
  return (c as Partial<SolidBody> | undefined)?.shape ?? null
}

// ---- held shafts -------------------------------------------------------------------------------------------------------

/** A thing the body must stay clear of: a capsule in the world (a stretch of a spear's shaft), the segments named in
 * `ignore` (by the bone each rides: the hands holding it) let through. */
export interface Obstacle { from: THREE.Vector3, to: THREE.Vector3, radius: number, ignore?: string[] }

/**
 * A held shaft (a spear's) as what the body must stay clear of: the line `from`-`to` of `radius`, cut `margin` either
 * side of each hold (`holds`: how far along it from `from` each hand holds it, metres), the hands holding it (`ignore`,
 * by bone) let through. A stretch left between two cuts shorter than a quarter of the margin is no obstacle.
 */
export function shaftObstacles (from: THREE.Vector3, to: THREE.Vector3, radius: number, holds: readonly number[], margin: number, ignore: string[]): Obstacle[] {
  const dir = to.clone().sub(from); const length = dir.length()
  if (length < 1e-6) return []
  dir.divideScalar(length)
  const cuts = holds.map(t => [t - margin, t + margin] as [number, number]).sort((a, b) => a[0] - b[0])
  const out: Obstacle[] = []
  let at = 0
  for (const [a, b] of [...cuts, [length, length] as [number, number]]) {
    if (a - at > margin * 0.25) out.push({ from: from.clone().addScaledVector(dir, at), to: from.clone().addScaledVector(dir, Math.min(a, length)), radius, ignore })
    at = Math.max(at, b)
    if (at >= length) break
  }
  return out
}

// ---- the character's collider ---------------------------------------------------------------------------------------

/**
 * A character's collider (see the header): its body's capsules, fitted to its skinned mesh the first time they are
 * needed (`body`; null when the mesh can't be fitted, no skin or a bone missing: then nothing collides and the solves go
 * on without it), each hand's skinned surface for its fingers (`hand`, also built when first asked: reading a hand's
 * skin is costly), and what held shafts reach into (`obstacleDepth`). It reads the bones as they stand when asked; the
 * pose solver reads its `shape` on its own forward kinematics.
 */
export class CharacterCollider implements BodyCollider {
  readonly root: THREE.Object3D
  /** The body's height (the hands' surfaces measure and weld by it). */
  readonly height: number
  private readonly bones: Map<string, THREE.Bone>
  private fitted: { body: SolidBody | null, problem: string | null } | null = null
  private readonly surfaces = new Map<Side, HandContactSurface | null>()

  constructor (root: THREE.Object3D, bones: Map<string, THREE.Bone>, height: number) {
    this.root = root
    this.bones = bones
    this.height = height
  }

  /** The body's capsules, fitted the first time they are asked for (once per root: bodyColliderFor); null when the mesh
   * can't be fitted (`problem` says why, and the console once). */
  get body (): SolidBody | null { return this.fit().body }
  get problem (): string | null { return this.fit().problem }

  private fit (): { body: SolidBody | null, problem: string | null } {
    if (this.fitted === null) {
      try {
        this.fitted = { body: bodyColliderFor(this.root, this.bones), problem: null }
      } catch (error) {
        this.fitted = { body: null, problem: (error as Error).message }
        console.warn(`bodycollide: ${this.fitted.problem}`)
      }
    }
    return this.fitted
  }

  /** The capsules' shape (what the pose solver walks: shapeOf), or null without a body. */
  get shape (): BodyShape | null { return this.body?.shape ?? null }

  penetration (a: THREE.Vector3, b: THREE.Vector3, radius: number, ignore: string[] = []): number {
    return this.body?.penetration(a, b, radius, ignore) ?? 0
  }

  selfPenetration (): { worst: number, pairs: Array<[string, string, number]> } {
    return this.body?.selfPenetration() ?? { worst: 0, pairs: [] }
  }

  contact (a: string, b: string): Contact | null {
    return this.body?.contact(a, b) ?? null
  }

  /** How deep the deepest of `obstacles` is in the body as it stands now (metres), each but the segments it lets
   * through and those named in `ignore`. */
  obstacleDepth (obstacles: readonly Obstacle[], ignore: readonly string[] = []): number {
    let worst = 0
    for (const o of obstacles) worst = Math.max(worst, this.penetration(o.from, o.to, o.radius, [...(o.ignore ?? []), ...ignore]))
    return worst
  }

  /** A hand's width (its capsule's widest), or null without a body. */
  handWidth (side: Side): number | null {
    const seg = this.shape?.segments.find(s => s.name === `${side}Hand`)
    return seg === undefined ? null : 2 * Math.max(seg.r1, seg.r2)
  }

  /** A hand's own skinned surface (its fingers' contacts), built the first time it is asked; null when it can't be read
   * (a skeleton the root doesn't own: a plain Object3D clone of a live character). */
  hand (side: Side): HandContactSurface | null {
    if (!this.surfaces.has(side)) {
      let surface: HandContactSurface | null
      try { surface = new HandContactSurface(this.root, side, this.height) } catch { surface = null }
      this.surfaces.set(side, surface)
    }
    return this.surfaces.get(side) ?? null
  }
}

const colliders = new WeakMap<THREE.Object3D, CharacterCollider>()
/** A character's collider, made once per root (and height): its fit and its hands' surfaces are kept. */
export function colliderFor (root: THREE.Object3D, bones: Map<string, THREE.Bone>, height: number): CharacterCollider {
  let c = colliders.get(root)
  if (c === undefined || c.height !== height) {
    c = new CharacterCollider(root, bones, height)
    colliders.set(root, c)
  }
  return c
}
