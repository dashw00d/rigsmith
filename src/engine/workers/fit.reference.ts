// The fitting as it was before it moved to workers/fit.ts (garments.ts at e21fa38), kept as the reference the new
// code must match bit for bit (fit.test.ts): the game export and the viewer's worker run the new one.
/* eslint-disable */
import * as THREE from 'three'
import type { SkinPolicy } from '../../model/types.ts'
import { regionsOf, type Regions } from '../regions.ts'

const ALLOWED: Record<SkinPolicy, RegExp | null> = {
  body: null,
  upper: /^(Hips|Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*))$/,
  lower: /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/,
  cape: /^(Hips|Spine\d?|Neck|Head|(Left|Right)Shoulder)$/,
  skirt: /^(Hips|Spine|(Left|Right)UpLeg)$/,
  head: /^(Neck|Head)$/,
}
const SMOOTHING: Record<SkinPolicy, number> = { body: 3, upper: 3, lower: 3, cape: 10, skirt: 14, head: 2 }
type BodyView = { skinned: THREE.SkinnedMesh[], height: number, rest: { bones: Map<string, { worldPosition: THREE.Vector3 }> } | null }
export interface BodySurface { mesh: THREE.SkinnedMesh, meshes: THREE.SkinnedMesh[], offsets: number[], grid: TriangleGrid, positions: Float32Array, index: ArrayLike<number>, skinIndex: THREE.BufferAttribute, skinWeight: THREE.BufferAttribute, regions: Regions }
class TriangleGrid {
  private readonly cells = new Map<string, number[]>()
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
      const lo = [Infinity, Infinity, Infinity]
      const hi = [-Infinity, -Infinity, -Infinity]
      for (let k = 0; k < 3; k++) {
        const v = index[t * 3 + k] * 3
        for (let d = 0; d < 3; d++) { lo[d] = Math.min(lo[d], positions[v + d]); hi[d] = Math.max(hi[d], positions[v + d]) }
      }
      for (let x = Math.floor(lo[0] / cell); x <= Math.floor(hi[0] / cell); x++) {
        for (let y = Math.floor(lo[1] / cell); y <= Math.floor(hi[1] / cell); y++) {
          for (let z = Math.floor(lo[2] / cell); z <= Math.floor(hi[2] / cell); z++) {
            const key = `${x},${y},${z}`
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
            for (const t of this.cells.get(`${x},${y},${z}`) ?? []) {
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
/** The body as gear sees it: its rest surface (closest-point queries), its weights and its regions, over every one of
 * its meshes (v6's Skin, Face, Shirt and Trousers are four). */
export function oldBodySurface (view: BodyView): BodySurface | null {
  const meshes = view.skinned.filter(m => true)
  if (meshes.length === 0) return null
  const counts = meshes.map(m => m.geometry.attributes.position.count)
  const offsets: number[] = []
  let total = 0
  for (const n of counts) { offsets.push(total); total += n }
  const positions = new Float32Array(total * 3)
  const skinIndex = new Float32Array(total * 4)
  const skinWeight = new Float32Array(total * 4)
  const index: number[] = []
  const v = new THREE.Vector3()
  for (const [k, mesh] of meshes.entries()) {
    const geometry = mesh.geometry
    const o = offsets[k]
    for (let i = 0; i < counts[k]; i++) {
      v.fromBufferAttribute(geometry.attributes.position, i).applyMatrix4(mesh.bindMatrix)
      positions.set([v.x, v.y, v.z], (o + i) * 3)
      for (let c = 0; c < 4; c++) {
        skinIndex[(o + i) * 4 + c] = (geometry.attributes.skinIndex as THREE.BufferAttribute | undefined)?.getComponent(i, c) ?? 0
        skinWeight[(o + i) * 4 + c] = (geometry.attributes.skinWeight as THREE.BufferAttribute | undefined)?.getComponent(i, c) ?? 0
      }
    }
    const own = (mesh.userData.fullIndex as THREE.BufferAttribute | undefined)?.array ?? geometry.index?.array ?? Array.from({ length: counts[k] }, (_, i) => i)
    for (let t = 0; t < own.length; t++) index.push(own[t] + o)
  }
  return {
    mesh: meshes[0],
    meshes,
    offsets,
    grid: new TriangleGrid(positions, index, view.height / 40),
    positions,
    index,
    skinIndex: new THREE.BufferAttribute(skinIndex, 4),
    skinWeight: new THREE.BufferAttribute(skinWeight, 4),
    regions: regionsOf(index, total),
  }
}
// ---- weights ----------------------------------------------------------------------------------------

/** Skin gear's weights: each vertex (rest space) the weights of the body surface under it, the policy's bones only,
 * smoothed along the piece; the four strongest. */
export function oldComputeWeights (body: BodySurface, geometry: THREE.BufferGeometry, policy: SkinPolicy, view: Pick<BodyView, 'rest' | 'height'>): { indices: Uint16Array, weights: Float32Array } {
  const bones = body.mesh.skeleton.bones
  const allowedRe = ALLOWED[policy]
  const allowed = bones.map(b => allowedRe === null || allowedRe.test(b.name))
  const count = geometry.attributes.position.count
  const nb = bones.length
  const w = new Float32Array(count * nb)
  const p = new THREE.Vector3()
  // Rest positions (the character may be mid-animation).
  const bonePos = bones.map(b => view.rest?.bones.get(b.name)?.worldPosition.clone() ?? b.getWorldPosition(new THREE.Vector3()))
  for (let i = 0; i < count; i++) {
    p.fromBufferAttribute(geometry.attributes.position, i)
    const hit = body.grid.closest(p)
    if (hit !== null) {
      const bary = body.grid.barycentric(hit.triangle, hit.point)
      const corners = [body.index[hit.triangle * 3], body.index[hit.triangle * 3 + 1], body.index[hit.triangle * 3 + 2]]
      const lambdas = [bary.x, bary.y, bary.z]
      for (let c = 0; c < 3; c++) {
        for (let k = 0; k < 4; k++) {
          const bone = body.skinIndex.getComponent(corners[c], k)
          const weight = body.skinWeight.getComponent(corners[c], k) * lambdas[c]
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
        const d = bonePos[b].distanceToSquared(p)
        if (d < bestD) { bestD = d; best = b }
      }
      if (best >= 0) w[i * nb + best] = 1
    }
  }
  if (policy === 'skirt') skirtBlend(w, geometry, bones, view)
  smooth(w, geometry, nb, SMOOTHING[policy])
  // Keep the four strongest influences, normalized.
  const indices = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    const order = Array.from({ length: nb }, (_, b) => b).sort((a, b) => w[i * nb + b] - w[i * nb + a]).slice(0, 4)
    let sum = 0
    for (const b of order) sum += w[i * nb + b]
    order.forEach((b, k) => { indices[i * 4 + k] = b; weights[i * 4 + k] = sum > 0 ? w[i * nb + b] / sum : (k === 0 ? 1 : 0) })
  }
  return { indices, weights }
}
/** Skirts: legs pull only at the sides and near the hem; the middle front/back follows the hips. */
function skirtBlend (w: Float32Array, geometry: THREE.BufferGeometry, bones: THREE.Bone[], view: Pick<BodyView, 'rest' | 'height'>): void {
  const nb = bones.length
  const idx = (name: string): number => bones.findIndex(b => b.name === name)
  const hips = idx('Hips')
  const left = idx('LeftUpLeg')
  const right = idx('RightUpLeg')
  if (hips < 0 || left < 0 || right < 0) return
  const restOf = (b: THREE.Bone): THREE.Vector3 => view.rest?.bones.get(b.name)?.worldPosition ?? b.getWorldPosition(new THREE.Vector3())
  const hipY = restOf(bones[hips]).y
  const legX = Math.abs(restOf(bones[left]).x)
  const p = new THREE.Vector3()
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    p.fromBufferAttribute(geometry.attributes.position, i)
    const side = THREE.MathUtils.smoothstep(Math.abs(p.x), legX * 0.2, legX * 1.6)
    const depth = THREE.MathUtils.clamp((hipY - p.y) / (view.height * 0.3), 0, 1)
    const leg = side * (0.35 + 0.65 * depth) * 0.85
    for (let b = 0; b < nb; b++) w[i * nb + b] = 0
    w[i * nb + hips] = 1 - leg
    w[i * nb + (p.x >= 0 ? left : right)] = leg
  }
}

/** Laplacian smoothing of per-vertex weights over the piece's edges (coincident vertices welded). */
function smooth (w: Float32Array, geometry: THREE.BufferGeometry, nb: number, iterations: number): void {
  const count = geometry.attributes.position.count
  const index = geometry.index?.array ?? Array.from({ length: count }, (_, i) => i)
  // Weld by position so UV seams don't block smoothing.
  const key = new Map<string, number>()
  const weld = new Int32Array(count)
  const p = geometry.attributes.position
  for (let i = 0; i < count; i++) {
    const k = `${p.getX(i).toFixed(5)},${p.getY(i).toFixed(5)},${p.getZ(i).toFixed(5)}`
    weld[i] = key.get(k) ?? i
    if (!key.has(k)) key.set(k, i)
  }
  const neighbors: Array<Set<number>> = Array.from({ length: count }, () => new Set())
  for (let t = 0; t < index.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = weld[index[t + k]]
      const b = weld[index[t + ((k + 1) % 3)]]
      if (a !== b) { neighbors[a].add(b); neighbors[b].add(a) }
    }
  }
  const next = new Float32Array(w.length)
  for (let it = 0; it < iterations; it++) {
    next.set(w)
    for (let i = 0; i < count; i++) {
      if (weld[i] !== i || neighbors[i].size === 0) continue
      const n = neighbors[i].size
      for (let b = 0; b < nb; b++) {
        let s = 0
        for (const j of neighbors[i]) s += w[j * nb + b]
        next[i * nb + b] = 0.5 * w[i * nb + b] + 0.5 * s / n
      }
    }
    w.set(next)
  }
  for (let i = 0; i < count; i++) {
    if (weld[i] !== i) for (let b = 0; b < nb; b++) w[i * nb + b] = w[weld[i] * nb + b]
  }
}

// ---- hiding covered body ----------------------------------------------------------------------------

/** How far out a piece may lie over the body (a share of its height: the gear is fitted 4 mm off, chunky boots and
 * fur further) and how square over it (the cosine of the cone round the normal: a hat's brim is near the face, but
 * above it). A sole is covered by the boot's sole under it, so boots must reach the floor (gear_finish.py). */
const COVER_REACH = 0.04
const COVER_CONE = 0.5

/** Which body vertices (BodySurface order) sit just under one of `pieces` (rest space): the piece lies outside the
 * surface there, along its normal, within reach. */
export function oldCoveredVertices (body: BodySurface, pieces: THREE.BufferGeometry[], height: number): Uint8Array {
  const covered = new Uint8Array(body.positions.length / 3)
  if (pieces.length === 0) return covered
  const positions: number[] = []
  const index: number[] = []
  for (const g of pieces) {
    const offset = positions.length / 3
    positions.push(...(g.attributes.position.array as Float32Array))
    const gi = g.index?.array ?? Array.from({ length: g.attributes.position.count }, (_, i) => i)
    for (let i = 0; i < gi.length; i++) index.push(gi[i] + offset)
  }
  const grid = new TriangleGrid(new Float32Array(positions), index, height / 40)
  // (a piece lies over a vertex when its nearest point is close and out along the normal, within a cone: a hat's brim
  // is near the face but above it, not over it)
  const reach = height * COVER_REACH

  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  const turn = new THREE.Matrix3()
  for (const [k, mesh] of body.meshes.entries()) {
    // Use the model's own normals; compute on a copy only if it has none (never touch its shading).
    let normals = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined
    if (normals === undefined) {
      const copy = mesh.geometry.clone()
      copy.computeVertexNormals()
      normals = copy.attributes.normal as THREE.BufferAttribute
    }
    turn.getNormalMatrix(mesh.bindMatrix)
    for (let i = 0; i < normals.count; i++) {
      const at = body.offsets[k] + i
      v.fromArray(body.positions, at * 3)
      n.fromBufferAttribute(normals, i).applyMatrix3(turn).normalize()
      const hit = grid.closest(v, 3)
      if (hit === null || hit.distance > reach) continue
      // The piece must lie outside the body here, out along its normal (or right on it).
      const out = hit.point.clone().sub(v)
      if (hit.distance < height * 0.002 || out.dot(n) >= COVER_CONE * hit.distance) covered[at] = 1
    }
  }
  return covered
}
