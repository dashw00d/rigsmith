// A piece's shape read off its mesh, for setting its origin and fitting it into a hand (the designer, 2026-10-29: an
// uploaded weapon should land in the fist with its long axis through the grip, as catalog props do). Everything here
// is in the frame the points are given in (the piece's own, its origin at zero, unless said).
//   shape    its long axis (principalAxis over points spread on its surface), how thick it is along that axis, which
//            end is held (the thinner end: a handle, not a blade or a head; a tie goes to the end nearer the hand, or
//            the origin), where on it a fist holds it (the middle of the thin run by that end, a little in from the
//            end), and its widest way across (an axe's head, a blade's edge), pointed to the side it reaches furthest
//   fit      the placement that puts the grip in the fist, the long axis along the fist's grip line (the far end out
//            of the thumb's side) and the widest way along the knuckles' line (the edge forward, as a fist punches)
//   origins  its middle and its base (bottom middle) as it sits at rest, and where a hand holds it
import * as THREE from 'three'
import { covariance, principalAxis, symmetricEigen } from './geom.ts'

/** Bins along the long axis the thickness is read in. */
const BINS = 24
/** Ends this close in thickness are a tie. */
const TIE = 0.12
/** The handle: bins by the held end no thicker than this over its thinnest. */
const HANDLE = 1.3
/** The grip between these shares of the length from the held end. */
const GRIP_MIN = 0.06
const GRIP_MAX = 0.3

/** Points spread over the surface of `meshes` (by area, the same every time), each mesh's matrix applied (the frame of
 * their parent; `frame`: another matrix by mesh). A long shaft modelled as a few rings has its middle covered too, which
 * its vertices don't. */
export function surfacePoints (meshes: readonly THREE.Mesh[], count = 4000, frame?: (m: THREE.Mesh) => THREE.Matrix4): THREE.Vector3[] {
  const tris: Array<[THREE.Vector3, THREE.Vector3, THREE.Vector3, number]> = []
  let total = 0
  for (const m of meshes) {
    m.updateMatrix()
    const matrix = frame?.(m) ?? m.matrix
    const pos = m.geometry.attributes.position as THREE.BufferAttribute | undefined
    if (pos === undefined) continue
    const index = m.geometry.index
    const n = index === null ? pos.count : index.count
    const at = (i: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(pos, index === null ? i : index.getX(i)).applyMatrix4(matrix)
    for (let i = 0; i + 2 < n; i += 3) {
      const a = at(i); const b = at(i + 1); const c = at(i + 2)
      const area = new THREE.Vector3().crossVectors(b.clone().sub(a), c.clone().sub(a)).length() / 2
      if (!(area > 0)) continue
      tris.push([a, b, c, area])
      total += area
    }
  }
  const out: THREE.Vector3[] = []
  if (total <= 0) return out
  // (each triangle its share of the points, the remainder carried on: no randomness, the same points every time)
  let carry = 0
  let k = 0
  for (const [a, b, c, area] of tris) {
    carry += area / total * count
    // (every triangle's corners count once: a tiny one still says where the piece is)
    out.push(a)
    for (; carry >= 1; carry--) {
      // (a low-discrepancy spread over the triangle)
      k++
      let u = (k * 0.7548776662466927) % 1; let v = (k * 0.5698402909980532) % 1
      if (u + v > 1) { u = 1 - u; v = 1 - v }
      out.push(a.clone().addScaledVector(b.clone().sub(a), u).addScaledVector(c.clone().sub(a), v))
    }
  }
  return out
}

/** A piece's shape (in the points' frame). */
export interface Shape {
  /** Its middle (of the points), its long axis (unit, from the held end to the far end), and how far the points reach
   * along it from the middle: `lo` at the held end (negative), `hi` at the far end. */
  center: THREE.Vector3
  axis: THREE.Vector3
  lo: number
  hi: number
  /** Its thickness (radius) in each of BINS bins from the held end. */
  radius: number[]
  /** Where a fist holds it: on the axis. */
  grip: THREE.Vector3
  /** Its widest way across the axis (unit), toward the side it reaches furthest (an axe's blade). */
  side: THREE.Vector3
  /** Whether the held end was a tie in thickness (a staff, a spear without a head). */
  tie: boolean
}

/** A point at `t` along the shape's axis. */
export const along = (s: Pick<Shape, 'center' | 'axis'>, t: number): THREE.Vector3 => s.center.clone().addScaledVector(s.axis, t)

/**
 * The shape of a piece from points on its surface. `near`: a point the held end is nearer, when the ends are as thick
 * (where the hand is, or the origin). Null for fewer than 3 points or no length.
 */
export function shapeOf (points: readonly THREE.Vector3[], near?: THREE.Vector3): Shape | null {
  if (points.length < 3) return null
  const { center, axis, lo: lo0, hi: hi0 } = principalAxis(points)
  const length = hi0 - lo0
  if (!(length > 1e-9)) return null
  // (each point's place along the axis and its distance off it)
  const t = points.map(p => p.clone().sub(center).dot(axis))
  const off = points.map((p, i) => p.clone().sub(center).addScaledVector(axis, -t[i]).length())
  const bins: number[][] = Array.from({ length: BINS }, () => [])
  t.forEach((x, i) => bins[Math.min(BINS - 1, Math.max(0, Math.floor((x - lo0) / length * BINS)))].push(off[i]))
  // (a bin's thickness: most of its points within it, a stray one aside)
  let radius = bins.map(b => (b.length === 0 ? Number.NaN : [...b].sort((x, y) => x - y)[Math.floor((b.length - 1) * 0.85)]))
  radius = radius.map((r, i) => (Number.isFinite(r) ? r : nearestFinite(radius, i)))
  const smooth = radius.map((_, i) => mean([radius[i - 1], radius[i], radius[i + 1]].filter((x): x is number => x !== undefined)))
  const quarter = Math.max(1, Math.floor(BINS / 4))
  const a = mean(smooth.slice(0, quarter)); const b = mean(smooth.slice(-quarter))
  const tie = Math.abs(a - b) <= TIE * Math.max(a, b)
  let flip: boolean
  if (!tie) flip = b < a
  else if (near !== undefined) flip = near.clone().sub(center).dot(axis) > 0
  else flip = false
  const ax = flip ? axis.clone().negate() : axis.clone()
  const lo = flip ? -hi0 : lo0
  const profile = flip ? [...smooth].reverse() : smooth
  // (the handle: the thin run by the held end, round its thinnest bin in the held half; the fist in its middle)
  const half = profile.slice(0, BINS / 2)
  const thinnest = half.indexOf(Math.min(...half))
  let first = thinnest; let last = thinnest
  while (first > 0 && half[first - 1] <= half[thinnest] * HANDLE) first--
  while (last < half.length - 1 && half[last + 1] <= half[thinnest] * HANDLE) last++
  const share = THREE.MathUtils.clamp((first + last + 1) / 2 / BINS, GRIP_MIN, GRIP_MAX)
  // (a long handle is the line the fist holds: an axe's or a hammer's head tilts the whole piece's axis off it)
  let line = { center, axis: ax }
  const from = lo + first / BINS * length; const to = lo + (last + 1) / BINS * length
  const handle = points.filter((_, i) => { const x = flip ? -t[i] : t[i]; return x >= from && x <= to })
  if (to - from >= 6 * Math.max(half[thinnest], 1e-9) && handle.length >= 3) {
    const h = principalAxis(handle, ax)
    line = { center: h.center, axis: h.axis.dot(ax) < 0 ? h.axis.clone().negate() : h.axis }
  }
  const ts = points.map(p => p.clone().sub(line.center).dot(line.axis))
  const lo1 = Math.min(...ts); const hi1 = Math.max(...ts)
  const grip = along(line, lo1 + share * (hi1 - lo1))
  return { center: line.center, axis: line.axis, lo: lo1, hi: hi1, radius: profile, grip, side: sideOf(points, line.center, line.axis), tie }
}

/** The widest way across `axis` (the top principal axis of the points squashed onto the plane across it), pointed to
 * where the points reach further (their skew along it). */
function sideOf (points: readonly THREE.Vector3[], center: THREE.Vector3, axis: THREE.Vector3): THREE.Vector3 {
  const flat = points.map(p => { const d = p.clone().sub(center); return d.addScaledVector(axis, -d.dot(axis)) })
  const e = symmetricEigen(covariance(flat, new THREE.Vector3())).vectors[2].clone()
  e.addScaledVector(axis, -e.dot(axis))
  if (e.lengthSq() < 1e-12) {
    // (round, no widest way: any way across)
    e.copy(Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0))
    e.addScaledVector(axis, -e.dot(axis))
  }
  e.normalize()
  let skew = 0
  for (const d of flat) skew += d.dot(e) ** 3
  return skew < 0 ? e.negate() : e
}

/** Whether `p` lies on the piece's shaft: between its ends and within a few of its thicknesses of the axis. */
export function onShaft (s: Shape, p: THREE.Vector3): boolean {
  const t = p.clone().sub(s.center).dot(s.axis)
  if (t < s.lo || t > s.hi) return false
  const off = p.clone().sub(along(s, t)).length()
  const thick = Math.max(...s.radius.slice(0, BINS / 2))
  return off <= 2 * thick + 1e-6
}

/** The shape held at `grip` (a point of its shaft) instead: its axis from there toward the end farther from it. */
export function heldAt (s: Shape, grip: THREE.Vector3): Shape {
  const t = THREE.MathUtils.clamp(grip.clone().sub(s.center).dot(s.axis), s.lo + GRIP_MIN * (s.hi - s.lo), s.hi - GRIP_MIN * (s.hi - s.lo))
  const at = along(s, t)
  // (the far end the one farther from the grip; about even, as the shape had it)
  const flip = t - s.lo > (s.hi - t) * (1 + TIE)
  if (!flip) return { ...s, grip: at }
  return { ...s, axis: s.axis.clone().negate(), lo: -s.hi, hi: -s.lo, radius: [...s.radius].reverse(), grip: at }
}

/** A hand at rest and its grip (clipedit.ts handGrip: the line a shaft takes through the fist and the fist's middle,
 * in the hand's own turn, from the wrist), and the way its fingers point (the wrist to the middle knuckle, rest space). */
export interface HandAt {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  grip: { axis: THREE.Vector3, fist: THREE.Vector3 }
  fingers: THREE.Vector3
}

/** Where the fist of `hand` holds a shaft, in rest space. */
export const fistAt = (hand: HandAt): THREE.Vector3 => hand.grip.fist.clone().applyQuaternion(hand.quaternion).add(hand.position)

/**
 * The placement (a matrix: rest space from the piece's frame) that puts the shape's grip in the fist, its long axis
 * along the fist's grip line, its widest way along the fingers (squared to the line), at `scale`.
 */
export function fitMatrix (s: Shape, hand: HandAt, scale: number): THREE.Matrix4 {
  const A = hand.grip.axis.clone().applyQuaternion(hand.quaternion).normalize()
  const f = hand.fingers.clone().addScaledVector(A, -hand.fingers.dot(A))
  if (f.lengthSq() < 1e-12) {
    f.copy(Math.abs(A.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0))
    f.addScaledVector(A, -f.dot(A))
  }
  f.normalize()
  const side = s.side.clone().addScaledVector(s.axis, -s.side.dot(s.axis)).normalize()
  const from = new THREE.Matrix4().makeBasis(s.axis, side, new THREE.Vector3().crossVectors(s.axis, side))
  const to = new THREE.Matrix4().makeBasis(A, f, new THREE.Vector3().crossVectors(A, f))
  const turn = new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.transpose()))
  const at = fistAt(hand).sub(s.grip.clone().multiplyScalar(scale).applyQuaternion(turn))
  return new THREE.Matrix4().compose(at, turn, new THREE.Vector3(scale, scale, scale))
}

/** Whether a piece placed by `placement` already sits in the fist: the fist on its shaft (modelled in the hand). */
export function inFist (s: Shape, placement: THREE.Matrix4, hand: HandAt, height: number): THREE.Vector3 | null {
  const local = fistAt(hand).applyMatrix4(placement.clone().invert())
  const scale = new THREE.Vector3().setFromMatrixScale(placement).x || 1
  const t = local.clone().sub(s.center).dot(s.axis)
  if (t < s.lo || t > s.hi) return null
  return local.distanceTo(along(s, t)) * scale <= 0.04 * height ? along(s, t) : null
}

/** Its middle and its base (the bottom middle) as it sits at rest (placed by `placement`), as points of its frame. */
export function restPoints (points: readonly THREE.Vector3[], placement: THREE.Matrix4): { middle: THREE.Vector3, base: THREE.Vector3 } {
  const box = new THREE.Box3()
  for (const p of points) box.expandByPoint(p.clone().applyMatrix4(placement))
  const inv = placement.clone().invert()
  const middle = box.getCenter(new THREE.Vector3())
  return { middle: middle.clone().applyMatrix4(inv), base: middle.setY(box.min.y).applyMatrix4(inv) }
}

/** How far `p` is from the box round the points (0 inside it). */
export function offBox (points: readonly THREE.Vector3[], p: THREE.Vector3): number {
  return new THREE.Box3().setFromPoints(points as THREE.Vector3[]).distanceToPoint(p)
}

function mean (xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length
}

function nearestFinite (xs: number[], i: number): number {
  for (let d = 1; d < xs.length; d++) {
    if (Number.isFinite(xs[i - d])) return xs[i - d]
    if (Number.isFinite(xs[i + d])) return xs[i + d]
  }
  return 0
}
