// The Rig step's markers: a few points placed on one flat view of the model (static/templates/markers.json), from
// which every joint follows. A marker pins its joint (or a point of its own tied to joints, the groin); every other
// joint moves with the pinned ones as rigidly as it can, keeping the skeleton's own shape between them
// (as-rigid-as-possible: each joint's neighbourhood turns as one). Markers left where they were seeded
// give back the skeleton they were seeded from, exactly. All positions in the model's own space (glTF: Y up, +Z
// forward, its left +X).
import * as THREE from 'three'

export type V3 = [number, number, number]
export type Side = 'left' | 'right'

export interface MarkerDef {
  id: string
  label: string
  /** Where it goes on the body, for the tooltip. */
  hint?: string
  color: string
  letter?: string
  /** The joint it pins: `{Side}` (Left/Right) or `{s}` (l/r) in a pair's name. */
  joint?: string
  /** One on each side of the body. */
  pair?: boolean
  /** A point of its own (no joint of its own), tied to these joints. */
  attach?: string[]
  /** On the body's middle line. */
  mid?: boolean
  /** keep: placing it sets only its height and side, the joint as deep in the body as it was (the chin: the head
   * joint is inside the neck, behind the chin). */
  depth?: 'keep'
  /** Placed on a flat view of each hand (finger tips), not the body's. */
  view?: 'hand'
}
export interface MarkerSet { view: 'front' | 'side', markers: MarkerDef[] }

/** A character's markers: the skeleton they were seeded from (`base`: its joints, and each own point's seed under
 * `marker:<id>`) and where they are now, by key (a pair on a front view `<id>_l` / `<id>_r`, else `<id>`). */
export interface Markers { set: string, base: Record<string, V3>, positions: Record<string, V3> }

let sets: Record<string, MarkerSet> | null = null
export async function markerSets (): Promise<Record<string, MarkerSet>> {
  if (sets === null) {
    const json = await fetch('/templates/markers.json').then(async r => await r.json()) as Record<string, MarkerSet | string>
    sets = Object.fromEntries(Object.entries(json).filter(([k]) => !k.startsWith('_'))) as Record<string, MarkerSet>
  }
  return sets
}
export function useMarkerSets (json: Record<string, unknown>): void {
  sets = Object.fromEntries(Object.entries(json).filter(([k]) => !k.startsWith('_'))) as Record<string, MarkerSet>
}

export function jointOf (def: MarkerDef, side: Side | null): string | null {
  if (def.joint === undefined) return null
  if (side === null) return def.joint
  return def.joint.replace('{Side}', side === 'left' ? 'Left' : 'Right').replace('{s}', side === 'left' ? 'l' : 'r')
}

/** The keys a set places, each with its marker and side (a side view places a pair's near side, its left). */
export interface MarkerKey { key: string, def: MarkerDef, side: Side | null }
export function keysOf (set: MarkerSet): MarkerKey[] {
  return set.markers.flatMap((def): MarkerKey[] => !def.pair ? [{ key: def.id, def, side: null }]
    : set.view === 'front' ? [{ key: `${def.id}_r`, def, side: 'right' as Side }, { key: `${def.id}_l`, def, side: 'left' as Side }]
      : [{ key: def.id, def, side: 'left' as Side }])
}

export const mirrorX = (p: V3, xCenter: number): V3 => [2 * xCenter - p[0], p[1], p[2]]

/** Seed a set's markers from a skeleton: each where its joint is; a marker of its own where `seedOwn` puts it (else
 * the middle of the joints it is tied to). */
export function seed (setName: string, set: MarkerSet, joints: Record<string, V3>, seedOwn?: (def: MarkerDef) => V3 | null): Markers {
  const base: Record<string, V3> = { ...joints }
  const positions: Record<string, V3> = {}
  for (const { key, def, side } of keysOf(set)) {
    const joint = jointOf(def, side)
    if (joint !== null) {
      if (joints[joint] !== undefined) positions[key] = [...joints[joint]]
      continue
    }
    const tied = (def.attach ?? []).map(j => joints[j]).filter((p): p is V3 => p !== undefined)
    const own = seedOwn?.(def) ?? (tied.length > 0 ? tied.reduce<V3>((s, p) => [s[0] + p[0] / tied.length, s[1] + p[1] / tied.length, s[2] + p[2] / tied.length], [0, 0, 0]) : null)
    if (own === null) continue
    base[`marker:${def.id}`] = own
    positions[key] = [...own]
  }
  return { set: setName, base, positions }
}

/**
 * A character's saved markers fitted to its skeleton as it is now (more finger bones than when they were placed, or
 * fewer): a joint it has gained joins their rest where its nearest kept ancestor's rest puts it (moved with that
 * ancestor), and its marker starts where the joint is; a joint it has lost leaves, with its marker. Markers of another
 * set, or none, are seeded afresh.
 */
export function fitMarkers (setName: string, set: MarkerSet, saved: Markers | undefined, joints: Record<string, V3>, parents: Record<string, string | null>, seedOwn?: (def: MarkerDef) => V3 | null): Markers {
  if (saved === undefined || saved.set !== setName) return seed(setName, set, joints, seedOwn)
  const base: Record<string, V3> = {}
  for (const [k, p] of Object.entries(saved.base)) if (k.startsWith('marker:') || joints[k] !== undefined) base[k] = [...p]
  for (const [k, p] of Object.entries(joints)) {
    if (base[k] !== undefined) continue
    let anchor = parents[k] ?? null
    while (anchor !== null && (saved.base[anchor] === undefined || joints[anchor] === undefined)) anchor = parents[anchor] ?? null
    const d: V3 = anchor === null ? [0, 0, 0] : [0, 1, 2].map(i => saved.base[anchor!][i] - joints[anchor!][i]) as V3
    base[k] = [p[0] + d[0], p[1] + d[1], p[2] + d[2]]
  }
  const positions: Record<string, V3> = {}
  for (const { key, def, side } of keysOf(set)) {
    const joint = jointOf(def, side)
    if (joint === null) { if (saved.positions[key] !== undefined && base[`marker:${def.id}`] !== undefined) positions[key] = [...saved.positions[key]]; continue }
    if (joints[joint] === undefined) continue
    positions[key] = saved.positions[key] !== undefined && saved.base[joint] !== undefined ? [...saved.positions[key]] : [...joints[joint]]
  }
  return { set: setName, base, positions }
}

/** What the markers pin: joint (or `marker:<id>`) -> position; a side view's pair mirrored onto the far side. */
export function pinsOf (set: MarkerSet, m: Markers, xCenter: number): Map<string, V3> {
  const pins = new Map<string, V3>()
  for (const { key, def, side } of keysOf(set)) {
    const at = m.positions[key]
    if (at === undefined) continue
    const joint = jointOf(def, side)
    const node = joint ?? `marker:${def.id}`
    if (m.base[node] === undefined) continue
    pins.set(node, at)
    if (def.pair && set.view === 'side' && joint !== null) {
      const far = jointOf(def, 'right')!
      if (m.base[far] !== undefined) pins.set(far, mirrorX(at, xCenter))
    }
  }
  return pins
}

/** The skeleton's edges for the solver: its bones (child, parent) and each own marker's ties. */
export function edgesOf (set: MarkerSet, parents: Record<string, string | null>, base: Record<string, V3>): Array<[string, string]> {
  const edges: Array<[string, string]> = []
  for (const [child, parent] of Object.entries(parents)) if (parent !== null && base[child] !== undefined && base[parent] !== undefined) edges.push([child, parent])
  for (const def of set.markers) {
    if (def.joint !== undefined || base[`marker:${def.id}`] === undefined) continue
    for (const j of def.attach ?? []) if (base[j] !== undefined) edges.push([`marker:${def.id}`, j])
  }
  return edges
}

/** Horn's closed form, by power iteration: the turn taking the `from` vectors onto the `to` vectors best. */
function bestTurn (from: THREE.Vector3[], to: THREE.Vector3[], warm: THREE.Quaternion): THREE.Quaternion {
  let sxx = 0; let sxy = 0; let sxz = 0; let syx = 0; let syy = 0; let syz = 0; let szx = 0; let szy = 0; let szz = 0
  for (let k = 0; k < from.length; k++) {
    const a = from[k]; const b = to[k]
    sxx += a.x * b.x; sxy += a.x * b.y; sxz += a.x * b.z
    syx += a.y * b.x; syy += a.y * b.y; syz += a.y * b.z
    szx += a.z * b.x; szy += a.z * b.y; szz += a.z * b.z
  }
  const N = [
    [sxx + syy + szz, syz - szy, szx - sxz, sxy - syx],
    [syz - szy, sxx - syy - szz, sxy + syx, szx + sxz],
    [szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy],
    [sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz],
  ]
  const shift = N.flat().reduce((s, v) => s + Math.abs(v), 0) + 1e-12
  // (w, x, y, z), from the last turn: the top eigenvector of N + shift I
  let q = [warm.w, warm.x, warm.y, warm.z]
  for (let it = 0; it < 24; it++) {
    const n = [0, 1, 2, 3].map(r => N[r][0] * q[0] + N[r][1] * q[1] + N[r][2] * q[2] + N[r][3] * q[3] + shift * q[r])
    const len = Math.hypot(...n)
    if (len < 1e-20) break
    q = n.map(v => v / len)
  }
  return new THREE.Quaternion(q[1], q[2], q[3], q[0]).normalize()
}

/** Cholesky of a dense symmetric positive matrix (row-major n x n), in place below the diagonal. */
function cholesky (a: Float64Array, n: number): void {
  for (let j = 0; j < n; j++) {
    let d = a[j * n + j]
    for (let k = 0; k < j; k++) d -= a[j * n + k] * a[j * n + k]
    d = Math.sqrt(Math.max(d, 1e-12))
    a[j * n + j] = d
    for (let i = j + 1; i < n; i++) {
      let s = a[i * n + j]
      for (let k = 0; k < j; k++) s -= a[i * n + k] * a[j * n + k]
      a[i * n + j] = s / d
    }
  }
}
function choleskySolve (l: Float64Array, n: number, b: Float64Array): Float64Array {
  const y = new Float64Array(n)
  for (let i = 0; i < n; i++) { let s = b[i]; for (let k = 0; k < i; k++) s -= l[i * n + k] * y[k]; y[i] = s / l[i * n + i] }
  const x = new Float64Array(n)
  for (let i = n - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < n; k++) s -= l[k * n + i] * x[k]; x[i] = s / l[i * n + i] }
  return x
}

/** Every node of `base` moved so the pinned ones sit at their pins and the rest follow as rigidly as they can (each
 * node's edges turned as one: as-rigid-as-possible). A chain pulled longer between its pins shares the stretch
 * evenly; past its last pin (a hoof's tip, an ear) it keeps its lengths. */
/** What one solve leaves the next with, while a marker is dragged: the factored system (the same skeleton and
 * pins) and each node's turn, to start from. */
export interface SolveCache { key?: string, L?: Float64Array, turn?: THREE.Quaternion[] }

export function solve (base: Record<string, V3>, edges: Array<[string, string]>, pins: Map<string, V3>, iterations = 16, cache?: SolveCache): Record<string, V3> {
  const names = Object.keys(base)
  const index = new Map(names.map((n, i) => [n, i]))
  const n = names.length
  const pinned = [...pins.keys()].filter(k => index.has(k))
  if (pinned.length === 0) return { ...base }
  const key = `${names.join(',')}|${pinned.join(',')}|${edges.length}`
  const T = names.map(k => new THREE.Vector3(...base[k]))
  const nbr: number[][] = names.map(() => [])
  for (const [a, b] of edges) {
    const i = index.get(a); const j = index.get(b)
    if (i === undefined || j === undefined || i === j) continue
    nbr[i].push(j); nbr[j].push(i)
  }
  const pinW = 1e4
  let L: Float64Array
  if (cache?.key === key && cache.L !== undefined) L = cache.L
  else {
    L = new Float64Array(n * n)
    for (let i = 0; i < n; i++) {
      for (const j of nbr[i]) { L[i * n + i] += 1; L[i * n + j] -= 1 }
    }
    // (a node joined to nothing pinned stays put: a tiny pull to its own place keeps the system solvable)
    for (let i = 0; i < n; i++) L[i * n + i] += 1e-6
    for (const k of pinned) { const i = index.get(k)!; L[i * n + i] += pinW }
    cholesky(L, n)
    if (cache !== undefined) { cache.key = key; cache.L = L; cache.turn = undefined }
  }
  // (from the last solve's turns while dragging: a few rounds then reach what many would from rest)
  const turn = cache?.turn?.length === n ? cache.turn.map(q => q.clone()) : names.map(() => new THREE.Quaternion())
  let X = T.map(v => v.clone())
  const e = new THREE.Vector3(); const f = new THREE.Vector3()
  for (let it = 0; it < iterations; it++) {
    // global: positions for these turns
    const bx = new Float64Array(n); const by = new Float64Array(n); const bz = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      for (const j of nbr[i]) {
        e.subVectors(T[i], T[j])
        const a = e.clone().applyQuaternion(turn[i])
        const b = e.clone().applyQuaternion(turn[j])
        f.addVectors(a, b).multiplyScalar(0.5)
        bx[i] += f.x; by[i] += f.y; bz[i] += f.z
      }
      bx[i] += 1e-6 * T[i].x; by[i] += 1e-6 * T[i].y; bz[i] += 1e-6 * T[i].z
    }
    for (const k of pinned) {
      const i = index.get(k)!; const p = pins.get(k)!
      bx[i] += pinW * p[0]; by[i] += pinW * p[1]; bz[i] += pinW * p[2]
    }
    const x = choleskySolve(L, n, bx); const y = choleskySolve(L, n, by); const z = choleskySolve(L, n, bz)
    X = names.map((_, i) => new THREE.Vector3(x[i], y[i], z[i]))
    // local: each node's turn and scale for these positions
    for (let i = 0; i < n; i++) {
      if (nbr[i].length === 0) continue
      const from = nbr[i].map(j => new THREE.Vector3().subVectors(T[j], T[i]))
      const to = nbr[i].map(j => new THREE.Vector3().subVectors(X[j], X[i]))
      turn[i] = from.length === 1 ? new THREE.Quaternion().setFromUnitVectors(from[0].clone().normalize(), to[0].clone().normalize()) : bestTurn(from, to, turn[i])
    }
  }
  if (cache !== undefined) cache.turn = turn
  const out: Record<string, V3> = {}
  names.forEach((k, i) => { out[k] = [X[i].x, X[i].y, X[i].z] })
  // the pins exactly (the solve holds them within its stiffness)
  for (const k of pinned) out[k] = [...pins.get(k)!]
  return out
}

/** The skeleton the markers give: `base` moved by them, its joints only. */
export function jointsFrom (set: MarkerSet, m: Markers, parents: Record<string, string | null>, xCenter: number, iterations = 16, cache?: SolveCache): Record<string, V3> {
  const solved = solve(m.base, edgesOf(set, parents, m.base), pinsOf(set, m, xCenter), iterations, cache)
  return Object.fromEntries(Object.entries(solved).filter(([k]) => !k.startsWith('marker:')))
}

/** Where along a ray a marker sits inside the body: the middle of the first stretch of the body the ray passes
 * through (hit distances, nearest first), else null. */
export function insideDepth (hits: number[]): number | null {
  if (hits.length >= 2) return 0.5 * (hits[0] + hits[1])
  return hits.length === 1 ? hits[0] : null
}
