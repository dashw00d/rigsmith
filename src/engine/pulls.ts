// Pull sockets: points of a prop another bone takes hold of and pulls (a bowstring drawn back by the other hand).
//
// A prop with pulls is skinned to a small skeleton of its own: its root ('PropRoot', riding the prop's bone as the
// prop does) and one bone per pull (`Prop_<prop>_<pull>`), which rests at the pull's point on the prop. Each vertex is
// weighted between them: rigid (all root) or soft (pulled), painted with the weight brushes; unpainted, the vertices
// right by a pull's rest point follow it fully. A strand with no vertices there (a bowstring is one straight piece)
// is split there first, so it bends into a V.
//
// Every frame the pull bone sits at its rest point, or, while the clip holds it (its hold windows, eased in, let go
// quickly: a released string snaps back), at the pulling bone's grip.
import * as THREE from 'three'
import type { PullSocket } from '../../server/workspace.ts'

export type { PullSocket }

/** The prop's own bone, rigid on whatever it rides. */
export const PROP_ROOT = 'PropRoot'

const safe = (s: string): string => s.replace(/[^\w]+/g, '_')

/** A pull's bone name (as the game export names it too: an extra bone the game allows, Prop_*). */
export function pullBoneName (prop: string, pull: Pick<PullSocket, 'name'>): string {
  return `Prop_${safe(prop)}_${safe(pull.name)}`
}

// ---- geometry ---------------------------------------------------------------------------------------

/** The connected piece (vertices welded by position) nearest `point`, its vertices and its long axis. */
export function strandNear (geometry: THREE.BufferGeometry, point: THREE.Vector3): { vertices: Set<number>, axis: THREE.Vector3, length: number } {
  const pos = geometry.attributes.position
  const index = geometry.index?.array ?? Array.from({ length: pos.count }, (_, i) => i)
  const parent = Array.from({ length: pos.count }, (_, i) => i)
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  const join = (a: number, b: number): void => { parent[find(a)] = find(b) }
  for (let t = 0; t < index.length; t += 3) { join(index[t], index[t + 1]); join(index[t + 1], index[t + 2]) }
  const keys = new Map<string, number>()
  for (let i = 0; i < pos.count; i++) {
    const k = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`
    const at = keys.get(k)
    if (at === undefined) keys.set(k, i); else join(i, at)
  }
  // (the nearest surface, not the nearest vertex: a bowstring has vertices only at its ends, far from its middle)
  let nearest = 0; let best = Infinity
  const v = new THREE.Vector3()
  const tri = new THREE.Triangle(); const on = new THREE.Vector3()
  for (let t = 0; t < index.length; t += 3) {
    tri.a.fromBufferAttribute(pos, index[t]); tri.b.fromBufferAttribute(pos, index[t + 1]); tri.c.fromBufferAttribute(pos, index[t + 2])
    const d = tri.closestPointToPoint(point, on).distanceToSquared(point)
    if (d < best) { best = d; nearest = index[t] }
  }
  const root = find(nearest)
  const vertices = new Set<number>()
  for (let i = 0; i < pos.count; i++) if (find(i) === root) vertices.add(i)
  // its long axis: the principal direction of its vertices (power iteration on the covariance)
  const c = new THREE.Vector3()
  for (const i of vertices) c.add(v.fromBufferAttribute(pos, i))
  c.divideScalar(Math.max(vertices.size, 1))
  const m = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (const i of vertices) {
    v.fromBufferAttribute(pos, i).sub(c)
    const d = [v.x, v.y, v.z]
    for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) m[r * 3 + k] += d[r] * d[k]
  }
  let axis = new THREE.Vector3(1, 1, 1).normalize()
  for (let it = 0; it < 50; it++) {
    const n = new THREE.Vector3(m[0] * axis.x + m[1] * axis.y + m[2] * axis.z, m[3] * axis.x + m[4] * axis.y + m[5] * axis.z, m[6] * axis.x + m[7] * axis.y + m[8] * axis.z)
    if (n.lengthSq() < 1e-30) break
    axis = n.normalize()
  }
  let lo = Infinity; let hi = -Infinity
  for (const i of vertices) { const t = v.fromBufferAttribute(pos, i).dot(axis); lo = Math.min(lo, t); hi = Math.max(hi, t) }
  return { vertices, axis, length: Math.max(hi - lo, 1e-9) }
}

/**
 * The geometry with the strand nearest `point` cut across at `point` (a plane through it, across the strand's long
 * axis): every triangle of the strand the plane crosses split there, its attributes interpolated, so the strand has a
 * ring of vertices to bend at. Unchanged if the strand already has vertices there.
 */
export function splitStrand (geometry: THREE.BufferGeometry, point: THREE.Vector3): THREE.BufferGeometry {
  const g = geometry.index === null ? geometry.clone() : geometry
  if (g.index === null) g.setIndex(Array.from({ length: g.attributes.position.count }, (_, i) => i))
  const { vertices, axis, length } = strandNear(g, point)
  const pos = g.attributes.position
  const v = new THREE.Vector3()
  const side = (i: number): number => v.fromBufferAttribute(pos, i).sub(point).dot(axis)
  const eps = length * 0.01
  for (const i of vertices) if (Math.abs(side(i)) <= eps) return geometry
  // new vertices: every attribute interpolated along a cut edge
  const names = Object.keys(g.attributes)
  const data = Object.fromEntries(names.map(n => [n, Array.from(g.attributes[n].array as ArrayLike<number>)])) as Record<string, number[]>
  const size = Object.fromEntries(names.map(n => [n, g.attributes[n].itemSize])) as Record<string, number>
  let count = pos.count
  const cut = new Map<string, number>()
  const onEdge = (a: number, b: number): number => {
    const key = a < b ? `${a},${b}` : `${b},${a}`
    const at = cut.get(key)
    if (at !== undefined) return at
    const da = side(a); const db = side(b)
    const t = da / (da - db)
    for (const n of names) for (let k = 0; k < size[n]; k++) data[n].push(data[n][a * size[n] + k] * (1 - t) + data[n][b * size[n] + k] * t)
    cut.set(key, count)
    return count++
  }
  const index = Array.from(g.index!.array as ArrayLike<number>)
  const out: number[] = []
  for (let t = 0; t < index.length; t += 3) {
    const tri = [index[t], index[t + 1], index[t + 2]]
    if (!tri.every(i => vertices.has(i))) { out.push(...tri); continue }
    const s = tri.map(i => side(i) > 0)
    const ups = s.filter(x => x).length
    if (ups === 0 || ups === 3) { out.push(...tri); continue }
    // the lone vertex (on its own side) first, the winding kept
    const lone = s.findIndex(x => (ups === 1 ? x : !x))
    const a = tri[lone]; const b = tri[(lone + 1) % 3]; const c = tri[(lone + 2) % 3]
    const p = onEdge(a, b); const q = onEdge(a, c)
    out.push(a, p, q, p, b, q, q, b, c)
  }
  const result = new THREE.BufferGeometry()
  for (const n of names) {
    const src = g.attributes[n]
    const Typed = (src.array as Float32Array).constructor as new (values: number[]) => ArrayLike<number>
    result.setAttribute(n, new THREE.BufferAttribute(new Typed(data[n]) as unknown as THREE.TypedArray, size[n], src.normalized))
  }
  result.setIndex(out)
  return result
}

/** Unpainted softness: the vertices of the strand nearest each pull's rest point, within a little of it along the
 * strand, follow that pull fully (bone index 1 + its index); every other vertex is rigid (0). */
export function defaultPullWeights (geometry: THREE.BufferGeometry, pulls: PullSocket[]): { indices: Uint16Array, weights: Float32Array } {
  const count = geometry.attributes.position.count
  const indices = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) weights[i * 4] = 1
  const v = new THREE.Vector3()
  pulls.forEach((p, k) => {
    const rest = new THREE.Vector3(...p.rest)
    const { vertices, axis, length } = strandNear(geometry, rest)
    for (const i of vertices) {
      v.fromBufferAttribute(geometry.attributes.position, i)
      if (Math.abs(v.clone().sub(rest).dot(axis)) > length * 0.02) continue
      indices[i * 4] = 1 + k; weights[i * 4] = 1
    }
  })
  return { indices, weights }
}

// ---- holding ----------------------------------------------------------------------------------------

/** How held a pull is at a part of a clip (0..1): its windows, eased in over `ease` before each, let go fast after. */
export function holdFactor (holds: Array<[number, number]> | undefined, at: number, ease = 0.03): number {
  let f = 0
  for (const [from, to] of holds ?? []) {
    if (at >= from && at <= to) return 1
    if (at < from && at > from - ease) f = Math.max(f, THREE.MathUtils.smootherstep(at, from - ease, from))
    if (at > to && at < to + ease / 3) f = Math.max(f, 1 - THREE.MathUtils.smootherstep(at, to, to + ease / 3))
  }
  return f
}

/** Where a pull's bone sits (in the prop root's space): its rest point, or toward the grip as far as it is held. */
export function pullPosition (pull: PullSocket, held: number, gripInRoot: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(...pull.rest).lerp(gripInRoot, THREE.MathUtils.clamp(held, 0, 1))
}

// ---- in the viewer: rigs, stepped each frame ---------------------------------------------------------

export interface PullRig { pull: PullSocket, root: THREE.Bone, bone: THREE.Bone, hand: THREE.Object3D }

const rigs = new Map<object, PullRig[]>()

export function registerPulls (owner: object, list: PullRig[]): void { rigs.set(owner, [...(rigs.get(owner) ?? []), ...list]) }
export function clearPulls (owner: object): void { rigs.delete(owner) }

/** Every pull where the clip playing puts it: `clip` its entry name (null: none playing, all at rest), `at` the part
 * of it played. */
export function tickPulls (clip: string | null, at: number): void {
  const grip = new THREE.Vector3()
  for (const list of rigs.values()) {
    for (const r of list) {
      const held = clip === null ? 0 : holdFactor(r.pull.holds?.[clip], at)
      r.hand.updateWorldMatrix(true, false)
      grip.set(...r.pull.grip).applyMatrix4(r.hand.matrixWorld)
      r.root.updateWorldMatrix(true, false)
      r.bone.position.copy(pullPosition(r.pull, held, r.root.worldToLocal(grip.clone())))
    }
  }
}
