// Small geometry helpers every area used to copy: a character's first skinned mesh, the bone-safe form of a name and a
// gear piece's node, the long and thin axes of a cloud of points (and the 3 x 3 eigen solve under the thin one), a
// node's world position and turn.
import * as THREE from 'three'
import type { Gear } from '../model/types.ts'
import { safeName } from '../model/select.ts'

export { safeName }

/** The first skinned mesh under `root` (depth first): a character's body. */
export function firstSkinned (root: THREE.Object3D): THREE.SkinnedMesh | null {
  let found: THREE.SkinnedMesh | null = null
  root.traverse(o => { if (found === null && (o as THREE.SkinnedMesh).isSkinnedMesh === true) found = o as THREE.SkinnedMesh })
  return found
}

/** The node a bone-attached gear piece is placed by (its placement's transform; clips move it with gear tracks). */
export const gearNode = (gear: Pick<Gear, 'name'>): string => `${safeName(gear.name)}_place`

/** The direction a cloud of points is longest in (its covariance's top eigenvector, by power iteration), about its
 * middle, and how far the points reach along it either side of the middle. `start`: where the iteration begins
 * (default the bounding box's longest side, never at right angles to the answer of a long, thin cloud). */
export function principalAxis (points: readonly THREE.Vector3[], start?: THREE.Vector3): { center: THREE.Vector3, axis: THREE.Vector3, lo: number, hi: number } {
  const center = new THREE.Vector3()
  for (const p of points) center.add(p)
  center.divideScalar(Math.max(points.length, 1))
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  const d = new THREE.Vector3()
  for (const p of points) {
    d.subVectors(p, center)
    const a = [d.x, d.y, d.z]
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r * 3 + k] += a[r] * a[k]
  }
  let axis: THREE.Vector3
  if (start !== undefined) axis = start.clone().normalize()
  else {
    const size = new THREE.Box3().setFromPoints(points as THREE.Vector3[]).getSize(new THREE.Vector3())
    axis = size.x >= size.y && size.x >= size.z ? new THREE.Vector3(1, 0, 0) : size.y >= size.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1)
  }
  for (let it = 0; it < 50; it++) {
    const n = new THREE.Vector3(m[0] * axis.x + m[1] * axis.y + m[2] * axis.z, m[3] * axis.x + m[4] * axis.y + m[5] * axis.z, m[6] * axis.x + m[7] * axis.y + m[8] * axis.z)
    if (n.lengthSq() < 1e-30) break
    axis = n.normalize()
  }
  let lo = Infinity; let hi = -Infinity
  for (const p of points) { const t = d.subVectors(p, center).dot(axis); lo = Math.min(lo, t); hi = Math.max(hi, t) }
  return points.length === 0 ? { center, axis, lo: 0, hi: 0 } : { center, axis, lo, hi }
}

/** The covariance of a cloud of points about `center`, summed (not averaged), as the rows of a 3 x 3 matrix. */
export function covariance (points: readonly THREE.Vector3[], center: THREE.Vector3): number[][] {
  const a = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of points) {
    const d = [p.x - center.x, p.y - center.y, p.z - center.z]
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) a[i][j] += d[i] * d[j]
  }
  return a
}

/** The eigenvalues of a symmetric 3 x 3 matrix, smallest first, each with its unit eigenvector (cyclic Jacobi turns;
 * equal values keep the order of the axes they ended on). */
export function symmetricEigen (m: ReadonlyArray<readonly number[]>): { values: number[], vectors: THREE.Vector3[] } {
  const a = m.map(r => [...r])
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 50; sweep++) {
    for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[i][j]) < 1e-12) continue
      const theta = (a[j][j] - a[i][i]) / (2 * a[i][j])
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const cs = 1 / Math.sqrt(t * t + 1); const sn = t * cs
      for (let k = 0; k < 3; k++) {
        const aik = a[i][k]; const ajk = a[j][k]
        a[i][k] = cs * aik - sn * ajk; a[j][k] = sn * aik + cs * ajk
      }
      for (let k = 0; k < 3; k++) {
        const aki = a[k][i]; const akj = a[k][j]
        a[k][i] = cs * aki - sn * akj; a[k][j] = sn * aki + cs * akj
      }
      for (let k = 0; k < 3; k++) {
        const vki = v[k][i]; const vkj = v[k][j]
        v[k][i] = cs * vki - sn * vkj; v[k][j] = sn * vki + cs * vkj
      }
    }
  }
  // (a stable sort: of equal values the first axis comes first)
  const order = [0, 1, 2].sort((x, y) => a[x][x] - a[y][y])
  return { values: order.map(i => a[i][i]), vectors: order.map(i => new THREE.Vector3(v[0][i], v[1][i], v[2][i]).normalize()) }
}

/** The direction a cloud of points is thinnest in: its smallest principal axis about `center` (default: its middle).
 * A flat piece's normal (an axe's blade, across its face). */
export function smallestAxis (points: readonly THREE.Vector3[], center?: THREE.Vector3): THREE.Vector3 {
  const c = center ?? points.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(Math.max(points.length, 1))
  return symmetricEigen(covariance(points, c)).vectors[0]
}

/** A node's world position. */
export const wp = (o: THREE.Object3D): THREE.Vector3 => o.getWorldPosition(new THREE.Vector3())
/** A node's world turn. */
export const wq = (o: THREE.Object3D): THREE.Quaternion => o.getWorldQuaternion(new THREE.Quaternion())
