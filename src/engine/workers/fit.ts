// The slow part of wearing skin gear, as plain arrays (docs/dressing-plan.md Phase 0 §4): each vertex's weights from
// the body surface under it (skinWeights) and which body vertices a piece lies over (coverHits). Run in the derive
// worker (./derive.worker.ts) for the viewer and on the main thread by the game export (garments.ts computeWeights,
// coveredVertices, through tools/lib/gearskin.ts and unit_export.ts), so the game gets the weights Rigsmith shows:
// the same code on the same numbers, bit for bit. Bump ALGO whenever what these answer changes (the derived files on
// disk are named by it). No DOM, no three.js objects but its maths.
import * as THREE from 'three'
import type { SkinPolicy } from '../../model/types.ts'

/** The version of what skinWeights and coverHits answer: part of every derived file's name (derive.ts). */
export const ALGO = 1

const ALLOWED: Record<SkinPolicy, RegExp | null> = {
  body: null,
  upper: /^(Hips|Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*))$/,
  lower: /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/,
  cape: /^(Hips|Spine\d?|Neck|Head|(Left|Right)Shoulder)$/,
  skirt: /^(Hips|Spine|(Left|Right)UpLeg)$/,
  head: /^(Neck|Head)$/,
}

const SMOOTHING: Record<SkinPolicy, number> = { body: 3, upper: 3, lower: 3, cape: 10, skirt: 14, head: 2 }

// ---- closest-point queries on a triangle soup -------------------------------------------------------

/** Cells by a number packing their three coordinates (exact in a double for |coordinate| < 2^16 cells), else by text. */
const SPAN = 131072
const HALF = 65536
const cellKey = (x: number, y: number, z: number): number | string =>
  (x >= -HALF && x < HALF && y >= -HALF && y < HALF && z >= -HALF && z < HALF) ? ((x + HALF) * SPAN + (y + HALF)) * SPAN + (z + HALF) : `${x},${y},${z}`

export class TriangleGrid {
  private readonly cells = new Map<number | string, number[]>()
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly c = new THREE.Vector3()
  private readonly tri = new THREE.Triangle()

  // (plain fields, no parameter properties: node runs this file by stripping its types, for the game export)
  readonly positions: Float32Array
  readonly index: ArrayLike<number>
  readonly cell: number

  constructor (positions: Float32Array, index: ArrayLike<number>, cell: number) {
    this.positions = positions
    this.index = index
    this.cell = cell
    for (let t = 0; t < index.length / 3; t++) {
      let lx = Infinity; let ly = Infinity; let lz = Infinity
      let hx = -Infinity; let hy = -Infinity; let hz = -Infinity
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k] * 3
        lx = Math.min(lx, positions[v]); hx = Math.max(hx, positions[v])
        ly = Math.min(ly, positions[v + 1]); hy = Math.max(hy, positions[v + 1])
        lz = Math.min(lz, positions[v + 2]); hz = Math.max(hz, positions[v + 2])
      }
      for (let x = Math.floor(lx / cell); x <= Math.floor(hx / cell); x++) {
        for (let y = Math.floor(ly / cell); y <= Math.floor(hy / cell); y++) {
          for (let z = Math.floor(lz / cell); z <= Math.floor(hz / cell); z++) {
            const key = cellKey(x, y, z)
            let list = this.cells.get(key)
            if (list === undefined) { list = []; this.cells.set(key, list) }
            list.push(t)
          }
        }
      }
    }
  }

  private vertex (i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.positions, i * 3)
  }

  /** Nearest triangle and point within maxRings cells; null if nothing nearby. */
  closest (p: THREE.Vector3, maxRings = 6): { triangle: number, point: THREE.Vector3, distance: number } | null {
    const cx = Math.floor(p.x / this.cell)
    const cy = Math.floor(p.y / this.cell)
    const cz = Math.floor(p.z / this.cell)
    let best = null as { triangle: number, point: THREE.Vector3, distance: number } | null
    const point = new THREE.Vector3()
    for (let ring = 0; ring <= maxRings; ring++) {
      for (let x = cx - ring; x <= cx + ring; x++) {
        for (let y = cy - ring; y <= cy + ring; y++) {
          for (let z = cz - ring; z <= cz + ring; z++) {
            if (Math.max(Math.abs(x - cx), Math.abs(y - cy), Math.abs(z - cz)) !== ring) continue
            const list = this.cells.get(cellKey(x, y, z))
            if (list === undefined) continue
            for (const t of list) {
              this.tri.set(this.vertex(this.index[t * 3], this.a), this.vertex(this.index[t * 3 + 1], this.b), this.vertex(this.index[t * 3 + 2], this.c))
              this.tri.closestPointToPoint(p, point)
              const d = point.distanceTo(p)
              if (best === null || d < best.distance) best = { triangle: t, point: point.clone(), distance: d }
            }
          }
        }
      }
      // Anything in a farther ring is at least `ring * cell` away.
      if (best !== null && best.distance <= ring * this.cell) break
    }
    return best
  }

  barycentric (t: number, p: THREE.Vector3): THREE.Vector3 {
    this.tri.set(this.vertex(this.index[t * 3], this.a), this.vertex(this.index[t * 3 + 1], this.b), this.vertex(this.index[t * 3 + 2], this.c))
    return this.tri.getBarycoord(p, new THREE.Vector3()) ?? new THREE.Vector3(1, 0, 0)
  }
}

// ---- the body, as numbers ---------------------------------------------------------------------------

/** The body at rest as the fitting reads it, every one of its meshes in one list (garments.ts bodySurface order). Plain
 * typed arrays: it goes to the worker as it is. */
export interface BodyCore {
  /** Rest space, 3 per vertex. */
  positions: Float32Array
  /** Rest-space unit normals (in doubles: the coverage test reads them as the main thread worked them out). */
  normals: Float64Array
  index: Uint32Array
  /** 4 per vertex. */
  skinIndex: Float32Array
  skinWeight: Float32Array
  /** Every vertex's region (regions.ts), and each region's vertex count. */
  regionOf: Int32Array
  regionVertices: Int32Array
  height: number
  /** The skeleton's bones, in its order, and where each is at rest (3 per bone). */
  bones: string[]
  bonePos: Float64Array
}

/** A body's grid for closest-point queries (built once per body, the slow part of a first query). */
export function gridOf (body: Pick<BodyCore, 'positions' | 'index' | 'height'>): TriangleGrid {
  return new TriangleGrid(body.positions, body.index, body.height / 40)
}

/** One of a piece's meshes as the fitting reads it: rest space (its placement applied), 3 per vertex; its triangles
 * (null: every three vertices one). */
export interface MeshCore { positions: Float32Array, index: Uint32Array | Uint16Array | null }

// ---- weights ----------------------------------------------------------------------------------------

/** Skin gear's weights: each vertex (rest space) the weights of the body surface under it, the policy's bones only,
 * smoothed along the piece; the four strongest. */
export function skinWeights (body: BodyCore, grid: TriangleGrid, mesh: MeshCore, policy: SkinPolicy): { indices: Uint16Array, weights: Float32Array } {
  const bones = body.bones
  const allowedRe = ALLOWED[policy]
  const allowed = bones.map(b => allowedRe === null || allowedRe.test(b))
  const pos = mesh.positions
  const count = pos.length / 3
  const nb = bones.length
  const w = new Float32Array(count * nb)
  const p = new THREE.Vector3()
  const bp = new THREE.Vector3()
  const bodyIndex = body.index
  const bodySkin = body.skinIndex
  const bodyWeight = body.skinWeight
  for (let i = 0; i < count; i++) {
    p.fromArray(pos, i * 3)
    const hit = grid.closest(p)
    if (hit !== null) {
      const bary = grid.barycentric(hit.triangle, hit.point)
      const corners = [bodyIndex[hit.triangle * 3], bodyIndex[hit.triangle * 3 + 1], bodyIndex[hit.triangle * 3 + 2]]
      const lambdas = [bary.x, bary.y, bary.z]
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < 4; k++) {
          const bone = bodySkin[corners[c] * 4 + k]
          const weight = bodyWeight[corners[c] * 4 + k] * lambdas[c]
          if (weight > 0 && allowed[bone]) w[i * nb + bone] += weight
        }
      }
    }
    let sum = 0
    for (let b = 0; b < nb; b++) sum += w[i * nb + b]
    if (sum < 1e-4) {
      // Nothing allowed underneath: use the nearest allowed bone.
      let best = -1
      let bestD = Infinity
      for (let b = 0; b < nb; b++) {
        if (!allowed[b]) continue
        const d = bp.fromArray(body.bonePos, b * 3).distanceToSquared(p)
        if (d < bestD) { bestD = d; best = b }
      }
      if (best >= 0) w[i * nb + best] = 1
    }
  }
  if (policy === 'skirt') skirtBlend(w, pos, body)
  smooth(w, mesh, nb, SMOOTHING[policy])
  // Keep the four strongest influences, normalized (in the order a stable sort by weight, strongest first, gives).
  const indices = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)
  const top = [0, 0, 0, 0]
  const topW = [0, 0, 0, 0]
  for (let i = 0; i < count; i++) {
    let n = 0
    for (let b = 0; b < nb; b++) {
      const v = w[i * nb + b]
      if (n === 4 && !(v > topW[3])) continue
      let k = n < 4 ? n : 3
      while (k > 0 && v > topW[k - 1]) k--
      for (let j = Math.min(n, 3); j > k; j--) { top[j] = top[j - 1]; topW[j] = topW[j - 1] }
      top[k] = b; topW[k] = v
      if (n < 4) n++
    }
    let sum = 0
    for (let k = 0; k < n; k++) sum += w[i * nb + top[k]]
    for (let k = 0; k < n; k++) { indices[i * 4 + k] = top[k]; weights[i * 4 + k] = sum > 0 ? w[i * nb + top[k]] / sum : (k === 0 ? 1 : 0) }
  }
  return { indices, weights }
}

/** Skirts: legs pull only at the sides and near the hem; the middle front/back follows the hips. */
function skirtBlend (w: Float32Array, pos: Float32Array, body: BodyCore): void {
  const bones = body.bones
  const nb = bones.length
  const hips = bones.indexOf('Hips')
  const left = bones.indexOf('LeftUpLeg')
  const right = bones.indexOf('RightUpLeg')
  if (hips < 0 || left < 0 || right < 0) return
  const hipY = body.bonePos[hips * 3 + 1]
  const legX = Math.abs(body.bonePos[left * 3])
  for (let i = 0; i < pos.length / 3; i++) {
    const x = pos[i * 3]
    const y = pos[i * 3 + 1]
    const side = THREE.MathUtils.smoothstep(Math.abs(x), legX * 0.2, legX * 1.6)
    const depth = THREE.MathUtils.clamp((hipY - y) / (body.height * 0.3), 0, 1)
    const leg = side * (0.35 + 0.65 * depth) * 0.85
    for (let b = 0; b < nb; b++) w[i * nb + b] = 0
    w[i * nb + hips] = 1 - leg
    w[i * nb + (x >= 0 ? left : right)] = leg
  }
}

/** Laplacian smoothing of per-vertex weights over the piece's edges (coincident vertices welded). */
function smooth (w: Float32Array, mesh: MeshCore, nb: number, iterations: number): void {
  const p = mesh.positions
  const count = p.length / 3
  const index = mesh.index ?? Array.from({ length: count }, (_, i) => i)
  // Weld by position so UV seams don't block smoothing.
  const key = new Map<string, number>()
  const weld = new Int32Array(count)
  for (let i = 0; i < count; i++) {
    const k = `${p[i * 3].toFixed(5)},${p[i * 3 + 1].toFixed(5)},${p[i * 3 + 2].toFixed(5)}`
    weld[i] = key.get(k) ?? i
    if (!key.has(k)) key.set(k, i)
  }
  const sets: Array<Set<number>> = Array.from({ length: count }, () => new Set())
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = weld[index[t + k]]
      const b = weld[index[t + ((k + 1) % 3)]]
      if (a !== b) { sets[a].add(b); sets[b].add(a) }
    }
  }
  // (each vertex's neighbours in the order they were met, as one flat list: the sums below add them in that order)
  const start = new Int32Array(count + 1)
  for (let i = 0; i < count; i++) start[i + 1] = start[i] + sets[i].size
  const near = new Int32Array(start[count])
  for (let i = 0; i < count; i++) { let at = start[i]; for (const j of sets[i]) near[at++] = j }
  const next = new Float32Array(w.length)
  for (let it = 0; it < iterations; it++) {
    next.set(w)
    for (let i = 0; i < count; i++) {
      const n = start[i + 1] - start[i]
      if (weld[i] !== i || n === 0) continue
      for (let b = 0; b < nb; b++) {
        let s = 0
        for (let at = start[i]; at < start[i + 1]; at++) s += w[near[at] * nb + b]
        next[i * nb + b] = 0.5 * w[i * nb + b] + 0.5 * s / n
      }
    }
    w.set(next)
  }
  for (let i = 0; i < count; i++) {
    if (weld[i] !== i) for (let b = 0; b < nb; b++) w[i * nb + b] = w[weld[i] * nb + b]
  }
}

// ---- what a piece covers ----------------------------------------------------------------------------

/** How far out a piece may lie over the body (a share of its height: the gear is fitted 4 mm off, chunky boots and
 * fur further) and how square over it (the cosine of the cone round the normal: a hat's brim is near the face, but
 * above it). A sole is covered by the boot's sole under it, so boots must reach the floor (gear_finish.py). */
const COVER_REACH = 0.04
const COVER_CONE = 0.5

/** Which body vertices sit just under the piece made of `meshes` (rest space): the piece lies outside the surface
 * there, along its normal, within reach. */
export function coverVertices (body: Pick<BodyCore, 'positions' | 'normals' | 'height'>, meshes: readonly MeshCore[]): Uint8Array {
  const covered = new Uint8Array(body.positions.length / 3)
  if (meshes.length === 0) return covered
  let total = 0
  let triangles = 0
  for (const m of meshes) { total += m.positions.length; triangles += m.index?.length ?? m.positions.length / 3 }
  const positions = new Float32Array(total)
  const index = new Uint32Array(triangles)
  let at = 0
  let ti = 0
  for (const m of meshes) {
    const offset = at / 3
    positions.set(m.positions, at)
    if (m.index !== null) for (let i = 0; i < m.index.length; i++) index[ti++] = m.index[i] + offset
    else for (let i = 0; i < m.positions.length / 3; i++) index[ti++] = i + offset
    at += m.positions.length
  }
  const height = body.height
  const grid = new TriangleGrid(positions, index, height / 40)
  // (a piece lies over a vertex when its nearest point is close and out along the normal, within a cone: a hat's brim
  // is near the face but above it, not over it)
  const reach = height * COVER_REACH
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  const out = new THREE.Vector3()
  for (let i = 0; i < covered.length; i++) {
    v.fromArray(body.positions, i * 3)
    n.fromArray(body.normals, i * 3)
    const hit = grid.closest(v, 3)
    if (hit === null || hit.distance > reach) continue
    // The piece must lie outside the body here, out along its normal (or right on it).
    out.copy(hit.point).sub(v)
    if (hit.distance < height * 0.002 || out.dot(n) >= COVER_CONE * hit.distance) covered[i] = 1
  }
  return covered
}

/** Per region, how many of its vertices `covered` holds: what a piece hides at any share (hiddenAt). */
export function regionHits (regionOf: Int32Array, regionCount: number, covered: ArrayLike<number>): Int32Array {
  const hits = new Int32Array(regionCount)
  for (let v = 0; v < regionOf.length; v++) {
    const r = regionOf[v]
    if (r >= 0 && covered[v] !== 0) hits[r]++
  }
  return hits
}

/** The regions hidden at `share` (regions.ts hiddenRegions, from the per-region counts), ascending. */
export function hiddenAt (hits: ArrayLike<number>, regionVertices: ArrayLike<number>, share: number): number[] {
  const out: number[] = []
  for (let r = 0; r < regionVertices.length; r++) if (regionVertices[r] > 0 && hits[r] >= share * regionVertices[r]) out.push(r)
  return out
}

// ---- hashing what goes in ---------------------------------------------------------------------------

/** A running 64-bit content hash (two 32-bit lanes) over typed arrays and text: what the derived files are named by. */
export class Hasher {
  private h1 = 0x811c9dc5 | 0
  private h2 = 0x9e3779b9 | 0
  private n = 0

  words (u: Uint32Array | Int32Array): this {
    let h1 = this.h1
    let h2 = this.h2
    for (let i = 0; i < u.length; i++) {
      const k = u[i] | 0
      h1 = Math.imul(h1 ^ k, 0x01000193)
      h2 = Math.imul((h2 ^ k) + ((h2 << 5) | 0), 0x5bd1e995)
      h2 ^= h2 >>> 15
    }
    this.h1 = h1; this.h2 = h2; this.n += u.length
    return this
  }

  array (a: ArrayBufferView): this {
    const bytes = a.byteLength
    const whole = bytes >>> 2
    if (a.byteOffset % 4 === 0) this.words(new Uint32Array(a.buffer, a.byteOffset, whole))
    else this.words(new Uint32Array(new Uint8Array(a.buffer, a.byteOffset, whole * 4).slice().buffer))
    const rest = new Uint8Array(a.buffer, a.byteOffset + whole * 4, bytes - whole * 4)
    if (rest.length > 0) { const pad = new Uint8Array(4); pad.set(rest); this.words(new Uint32Array(pad.buffer)) }
    return this.number(bytes)
  }

  number (x: number): this {
    return this.words(new Uint32Array(new Float64Array([x]).buffer))
  }

  text (s: string): this {
    const u = new Uint32Array(s.length + 1)
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
    u[s.length] = s.length
    return this.words(u)
  }

  /** 16 hex. */
  hex (): string {
    const f = (h: number): number => { h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0 }
    const a = f(this.h1 ^ this.n)
    const b = f(this.h2 ^ Math.imul(this.n, 0x27d4eb2d))
    return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0')
  }
}

/** The body's identity: everything the fitting reads of it. */
export function bodyKey (body: BodyCore): string {
  const h = new Hasher().array(body.positions).array(body.normals).array(body.index).array(body.skinIndex).array(body.skinWeight)
    .array(body.regionOf).number(body.height).array(body.bonePos)
  for (const b of body.bones) h.text(b)
  return h.hex()
}

/** A piece's identity as worn: its meshes at rest, placed (so its file, origin and placement all count). */
export function meshesKey (meshes: readonly MeshCore[]): string {
  const h = new Hasher().number(meshes.length)
  for (const m of meshes) { h.array(m.positions); if (m.index !== null) h.array(m.index); else h.number(-1) }
  return h.hex()
}
