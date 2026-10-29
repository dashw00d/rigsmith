// Pull handles: points of a piece of gear a bone takes hold of and draws (a bowstring drawn back by the other hand).
//
// A piece with pulls is skinned to a small skeleton of its own: its root ('PropRoot', riding the piece's bone as the
// piece does) and one bone per pull handle (`Prop_<gear>_<handle>`, as the game export names it too), which rests at
// the handle's point on the piece. Each vertex is weighted between them: rigid (all root) or soft (pulled), painted
// with the weight brushes (garments/<id>/weights.json keys them 'PropRoot' and 'pull:<handle id>'); unpainted, the
// vertices right by a pull's rest point follow it fully. A strand with no vertices there (a bowstring is one straight
// piece) is split there first, so it bends into a V.
//
// When a slot holds a pull is the slot's handleHold adjustment (its windows, phases of the clip as it plays); the bake
// (src/engine/bake.ts pullPlans) turns those into PullPlans, and every frame the animator calls tickPulls with the
// playing slot's plans: each pull bone sits at its rest point, or, while held (eased in, let go quickly: a released
// string snaps back), at the pulling bone's grip.
import * as THREE from 'three'
import type { Handle, Vec3, Window } from '../model/types.ts'
import { safeName } from '../model/select.ts'
import type { PullPlan } from './bake.ts'
import { principalAxis } from './geom.ts'

/** The piece's own bone, rigid on whatever it rides; also its key in painted weights. */
export const PROP_ROOT = 'PropRoot'

/** A pull handle's bone (as the game export names it too: an extra bone the game allows, Prop_*). */
export function pullBoneName (gear: string, handle: Pick<Handle, 'name'>): string {
  return `Prop_${safeName(gear)}_${safeName(handle.name)}`
}

/** What a pull handle's painted weights are keyed by in garments/<id>/weights.json (stable across renames). */
export const pullWeightName = (handle: Pick<Handle, 'id'>): string => `pull:${handle.id}`

/** A pulled piece's painted-weight keys by the bone names its rig carries (PropRoot, Prop_<gear>_<handle>), and the
 * keys themselves, so a painter that knows only bone names saves under the keys (and weights painted before the keys
 * existed, under the old bone names, still count). */
export function pullWeightKeys (gear: string, handles: ReadonlyArray<Pick<Handle, 'id' | 'name' | 'kind'>>): Map<string, string> {
  const out = new Map<string, string>([[PROP_ROOT, PROP_ROOT]])
  for (const h of handles) {
    if (h.kind !== 'pull') continue
    out.set(pullWeightName(h), pullWeightName(h))
    if (!out.has(pullBoneName(gear, h))) out.set(pullBoneName(gear, h), pullWeightName(h))
  }
  return out
}

// ---- geometry ---------------------------------------------------------------------------------------

/** The connected piece (vertices welded by position) nearest `point`: its vertices, their middle, its long axis and
 * its length along it. */
export function strandNear (geometry: THREE.BufferGeometry, point: THREE.Vector3): { vertices: Set<number>, center: THREE.Vector3, axis: THREE.Vector3, length: number } {
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
  const tri = new THREE.Triangle(); const on = new THREE.Vector3()
  for (let t = 0; t < index.length; t += 3) {
    tri.a.fromBufferAttribute(pos, index[t]); tri.b.fromBufferAttribute(pos, index[t + 1]); tri.c.fromBufferAttribute(pos, index[t + 2])
    const d = tri.closestPointToPoint(point, on).distanceToSquared(point)
    if (d < best) { best = d; nearest = index[t] }
  }
  const root = find(nearest)
  const vertices = new Set<number>()
  for (let i = 0; i < pos.count; i++) if (find(i) === root) vertices.add(i)
  // its long axis: the principal direction of its vertices (begun from (1, 1, 1), as strands were always found)
  const { center, axis, lo, hi } = principalAxis([...vertices].map(i => new THREE.Vector3().fromBufferAttribute(pos, i)), new THREE.Vector3(1, 1, 1))
  return { vertices, center, axis, length: Math.max(hi - lo, 1e-9) }
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
export function defaultPullWeights (geometry: THREE.BufferGeometry, pulls: ReadonlyArray<{ rest: Vec3 }>): { indices: Uint16Array, weights: Float32Array } {
  const count = geometry.attributes.position.count
  const indices = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) weights[i * 4] = 1
  pulls.forEach((p, k) => {
    for (const [i, w] of stringWeights(geometry, new THREE.Vector3(...p.rest))) {
      if (w <= 1e-6) continue
      // (the pull's share and the piece's: a vertex is moved by w of the nock's move)
      indices[i * 4] = 1 + k; weights[i * 4] = w
      indices[i * 4 + 1] = 0; weights[i * 4 + 1] = 1 - w
    }
  })
  return { indices, weights }
}

/**
 * How much of the nock's move each vertex of the string through `rest` takes: 1 at the nock, falling in a straight line
 * to 0 at each end of the string. The pull only moves its bone (never turns it), so the drawn string is then exactly
 * two straight lines from the bow's tips to the fingers, however many rings the string's mesh has (a weight of 1 on
 * the nock's ring alone left the rings between it and the tips where they were: the string bent in a zigzag; the
 * designer, 2026-10-29). Only vertices on the string's line count: a bow modelled with its string joined to its limbs
 * keeps its limbs still.
 */
export function stringWeights (geometry: THREE.BufferGeometry, rest: THREE.Vector3): Map<number, number> {
  const { vertices, axis, length } = strandNear(geometry, rest)
  const v = new THREE.Vector3()
  const along = new Map<number, number>()
  for (const i of vertices) {
    v.fromBufferAttribute(geometry.attributes.position, i).sub(rest)
    const s = v.dot(axis)
    if (v.addScaledVector(axis, -s).length() > length * 0.04) continue
    along.set(i, s)
  }
  const out = new Map<number, number>()
  if (along.size === 0) return out
  const lo = Math.min(...along.values()); const hi = Math.max(...along.values())
  for (const [i, s] of along) {
    const w = s >= 0 ? (hi > 1e-9 ? 1 - s / hi : 1) : (lo < -1e-9 ? 1 - s / lo : 1)
    out.set(i, Math.min(1, Math.max(0, w)))
  }
  return out
}

/** The middle of the longest, thinnest piece among `meshes` (a bowstring), in their parent's space (each mesh's own
 * matrix applied): where a new pull rests. Null without meshes. */
export function strandMiddle (meshes: readonly THREE.Mesh[]): THREE.Vector3 | null {
  let best: { score: number, at: THREE.Vector3 } | null = null
  for (const m of meshes) {
    const geometry = m.geometry
    const pos = geometry.attributes.position
    const seen = new Set<number>()
    for (let i = 0; i < pos.count; i++) {
      if (seen.has(i)) continue
      const strand = strandNear(geometry, new THREE.Vector3().fromBufferAttribute(pos, i))
      for (const v of strand.vertices) seen.add(v)
      // thickness: how far its vertices stray from its long axis
      const c = strand.center.clone()
      let thick = 0
      for (const v of strand.vertices) {
        const d = new THREE.Vector3().fromBufferAttribute(pos, v).sub(c)
        thick = Math.max(thick, d.sub(strand.axis.clone().multiplyScalar(d.dot(strand.axis))).length())
      }
      const score = strand.length / Math.max(thick, 1e-6)
      if (best === null || score > best.score) best = { score, at: c.applyMatrix4(m.matrix) }
    }
  }
  return best?.at ?? null
}

/** The strand a pull rests on, end to end (in the meshes' parent's space): what a hand takes hold of anywhere along it.
 * Taken from whichever of `meshes` comes nearest `rest`. Null without meshes. */
export function strandSegment (meshes: readonly THREE.Mesh[], rest: Vec3): THREE.Line3 | null {
  const at = new THREE.Vector3(...rest)
  let best: { line: THREE.Line3, d: number } | null = null
  const tri = new THREE.Triangle(); const on = new THREE.Vector3()
  for (const m of meshes) {
    // (in the mesh's own space, then back)
    const toLocal = m.matrix.clone().invert()
    const local = at.clone().applyMatrix4(toLocal)
    const geometry = m.geometry
    const pos = geometry.attributes.position
    const index = geometry.index?.array ?? Array.from({ length: pos.count }, (_, i) => i)
    let d = Infinity
    for (let t = 0; t < index.length; t += 3) {
      tri.a.fromBufferAttribute(pos, index[t]); tri.b.fromBufferAttribute(pos, index[t + 1]); tri.c.fromBufferAttribute(pos, index[t + 2])
      d = Math.min(d, tri.closestPointToPoint(local, on).distanceTo(local))
    }
    if (best !== null && d >= best.d) continue
    const { vertices, axis } = strandNear(geometry, local)
    const v = new THREE.Vector3()
    let lo = Infinity; let hi = -Infinity
    for (const i of vertices) { const t = v.fromBufferAttribute(pos, i).sub(local).dot(axis); lo = Math.min(lo, t); hi = Math.max(hi, t) }
    if (!Number.isFinite(lo)) continue
    const line = new THREE.Line3(local.clone().addScaledVector(axis, lo).applyMatrix4(m.matrix), local.clone().addScaledVector(axis, hi).applyMatrix4(m.matrix))
    best = { line, d }
  }
  return best?.line ?? null
}

// ---- holding ----------------------------------------------------------------------------------------

/** How held a pull is at a part of a clip (0..1): its windows, eased in over `ease` before each, let go fast after. */
export function holdFactor (holds: readonly Window[] | undefined, at: number, ease = 0.03): number {
  let f = 0
  for (const [from, to] of holds ?? []) {
    if (at >= from && at <= to) return 1
    if (at < from && at > from - ease) f = Math.max(f, THREE.MathUtils.smootherstep(at, from - ease, from))
    if (at > to && at < to + ease / 3) f = Math.max(f, 1 - THREE.MathUtils.smootherstep(at, to, to + ease / 3))
  }
  return f
}

/** Where a pull's bone sits (in the piece root's space): its rest point, or toward the grip as far as it is held. */
export function pullPosition (pull: { rest: Vec3 }, held: number, gripInRoot: THREE.Vector3): THREE.Vector3 {
  return new THREE.Vector3(...pull.rest).lerp(gripInRoot, THREE.MathUtils.clamp(held, 0, 1))
}

/** What finding a slot's hold windows plays and measures (gear.svelte.ts gives it the animator's playing slot). */
export interface HoldProbe {
  /** Pose the character at phase `u` of the slot as it plays (its world matrices brought up to date). */
  seek: (u: number) => void
  /** The pulling bone, as posed. */
  hand: THREE.Object3D
  /** Where on the pulling bone the point is held (its own frame). */
  grip: Vec3
  /** The piece's placed node (its children are in the piece's own space). */
  node: THREE.Object3D
  /** The strand the pull rests on, end to end, in the piece's own space (strandSegment). */
  strand: THREE.Line3
  /** How near the grip must come to the strand to take hold (a few hundredths of the character's height). */
  reach: number
  /** Where the slot lets go, as a phase (its blow): the window ends there when it comes after the hold starts. */
  release?: number
  samples?: number
}

/** When a slot holds a pull, found by playing it: from when the pulling bone's grip first comes to the strand the pull
 * rests on (anywhere along it: a hand nocks by the bow's grip, then draws), until the slot's release (its blow, if that
 * comes after) or until the grip goes past a full draw (more than 60% of the strand's length away). [] when it never
 * reaches it. Phases are rounded to thousandths. */
export function findHolds (p: HoldProbe): Window[] {
  const samples = p.samples ?? 120
  const dist: number[] = []
  const grip = new THREE.Vector3(); const on = new THREE.Vector3()
  for (let i = 0; i <= samples; i++) {
    p.seek(i / samples)
    p.hand.updateWorldMatrix(true, false)
    p.node.updateWorldMatrix(true, false)
    grip.set(...p.grip).applyMatrix4(p.hand.matrixWorld).applyMatrix4(p.node.matrixWorld.clone().invert())
    dist.push(grip.distanceTo(p.strand.closestPointToPoint(grip, true, on)))
  }
  const start = dist.findIndex(d => d <= p.reach)
  if (start < 0) return []
  let end = start
  if (p.release !== undefined && p.release > start / samples) end = Math.min(samples, Math.round(p.release * samples))
  else while (end + 1 <= samples && dist[end + 1] <= p.strand.distance() * 0.6) end++
  return [[+(start / samples).toFixed(3), +(end / samples).toFixed(3)]]
}

// ---- in the viewer: rigs, stepped each frame ---------------------------------------------------------

/** One pull handle rigged on stage: its piece's root bone, its own bone, and the bone drawing it. */
export interface PullRig {
  gear: string
  handle: string
  grip: Vec3
  rest: Vec3
  root: THREE.Object3D
  bone: THREE.Object3D
  hand: THREE.Object3D
}

const rigs = new Map<object, PullRig[]>()
// (the pieces on stage register here as they are worn: a hot update of this module would leave them in the old copy's
// map while the animator ticks the new, empty one, and every string stays at rest until a reload; so a change here
// reloads the page instead (the designer, 2026-10-29: "is it caching again"))
const hot = (import.meta as ImportMeta & { hot?: { accept: (cb: () => void) => void } }).hot
if (hot !== undefined) hot.accept(() => { location.reload() })

export function registerPulls (owner: object, list: PullRig[]): void { rigs.set(owner, [...(rigs.get(owner) ?? []), ...list]) }
/** Take an owner's rigs off (all of them, or one piece's). */
export function clearPulls (owner: object, gear?: string): void {
  if (gear === undefined) { rigs.delete(owner); return }
  const kept = (rigs.get(owner) ?? []).filter(r => r.gear !== gear)
  if (kept.length === 0) rigs.delete(owner); else rigs.set(owner, kept)
}

/** Every pull where the slot playing puts it: `plans` its pulls (BakedSlot.pulls; null: nothing playing, all at rest),
 * `u` the phase of it played. A pull its plans don't name rests. */
export function tickPulls (plans: readonly PullPlan[] | null, u: number): void {
  const grip = new THREE.Vector3()
  for (const list of rigs.values()) {
    for (const r of list) {
      const plan = plans?.find(p => p.gear === r.gear && p.handle === r.handle)
      const held = plan === undefined ? 0 : holdFactor(plan.windows, u)
      if (held === 0) { r.bone.position.set(...r.rest); continue }
      r.hand.updateWorldMatrix(true, false)
      grip.set(...r.grip).applyMatrix4(r.hand.matrixWorld)
      r.root.updateWorldMatrix(true, false)
      r.bone.position.copy(pullPosition(r, held, r.root.worldToLocal(grip.clone())))
    }
  }
}
