// The user's own meshes worn by a character: clothing skinned to the body (bleed-free), or rigid pieces on a bone.
//
// Clothing takes its weights from the body surface underneath each vertex, then a policy removes bones
// that must not move it (a cape never follows the arms, a skirt never follows the shins) and a smoothing
// pass along the garment removes jagged borders. Optionally the body under the garment is hidden so it
// can't poke through during animation.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import type { Garment } from '../../server/workspace.ts'
import type { CharacterView } from './CharacterView.ts'

export type { Garment }

export const POLICIES: Array<{ id: Garment['policy'], label: string, hint: string }> = [
  { id: 'body', label: 'Follows body', hint: 'Shirts, armor, boots: takes weights from whatever it covers' },
  { id: 'upper', label: 'Upper body', hint: 'Torso and arms only, never the legs' },
  { id: 'lower', label: 'Lower body', hint: 'Hips and legs only' },
  { id: 'cape', label: 'Cape / cloak', hint: 'Torso and neck only, never the arms' },
  { id: 'skirt', label: 'Skirt / robe', hint: 'Hips and thighs, blended so it never splits between the legs' },
  { id: 'head', label: 'Head', hint: 'Hats, hoods and hair: head and neck only' },
]

const ALLOWED: Record<Garment['policy'], RegExp | null> = {
  body: null,
  upper: /^(Hips|Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*))$/,
  lower: /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/,
  cape: /^(Hips|Spine\d?|Neck|Head|(Left|Right)Shoulder)$/,
  skirt: /^(Hips|Spine|(Left|Right)UpLeg)$/,
  head: /^(Neck|Head)$/,
}

const SMOOTHING: Record<Garment['policy'], number> = { body: 3, upper: 3, lower: 3, cape: 10, skirt: 14, head: 2 }

export const GARMENT_FLAG = 'rigsmithGarment'

const loader = new GLTFLoader()
const models = new Map<string, Promise<THREE.Group>>()

async function load (url: string): Promise<THREE.Group> {
  let pending = models.get(url)
  if (pending === undefined) {
    pending = loader.loadAsync(url).then(g => g.scene)
    models.set(url, pending)
    pending.catch(() => models.delete(url))
  }
  return await pending
}

export function garmentMatrix (g: Garment): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(...g.rotation.map(d => THREE.MathUtils.degToRad(d)) as [number, number, number]))
  return new THREE.Matrix4().compose(new THREE.Vector3(...g.position), q, new THREE.Vector3(g.scale, g.scale, g.scale))
}

/** The garment's meshes as static geometry in character rest space (transform applied). */
export async function garmentMeshes (url: string, g: Garment): Promise<THREE.Mesh[]> {
  const scene = await load(url)
  scene.updateMatrixWorld(true)
  const placement = garmentMatrix(g)
  const out: THREE.Mesh[] = []
  scene.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = mesh.geometry.clone()
    for (const name of ['skinIndex', 'skinWeight']) geometry.deleteAttribute(name)
    geometry.applyMatrix4(new THREE.Matrix4().multiplyMatrices(placement, mesh.matrixWorld))
    const material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone()
    const copy = new THREE.Mesh(geometry, material)
    copy.name = `${g.name.replace(/[^\w]+/g, '_')}_${out.length}`
    copy.castShadow = true
    copy.frustumCulled = false
    out.push(copy)
  })
  return out
}

// ---- closest-point queries on a triangle soup -------------------------------------------------------

class TriangleGrid {
  private readonly cells = new Map<string, number[]>()
  private readonly a = new THREE.Vector3()
  private readonly b = new THREE.Vector3()
  private readonly c = new THREE.Vector3()
  private readonly tri = new THREE.Triangle()

  constructor (readonly positions: Float32Array, readonly index: ArrayLike<number>, readonly cell: number) {
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

interface BodySurface {
  mesh: THREE.SkinnedMesh
  grid: TriangleGrid
  positions: Float32Array
  index: ArrayLike<number>
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
}

function bodySurface (view: CharacterView): BodySurface | null {
  const mesh = view.skinned.find(m => m.userData[GARMENT_FLAG] === undefined)
  if (mesh === undefined) return null
  const geometry = mesh.geometry
  const positions = new Float32Array(geometry.attributes.position.array.length)
  const v = new THREE.Vector3()
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    v.fromBufferAttribute(geometry.attributes.position, i).applyMatrix4(mesh.bindMatrix)
    positions.set([v.x, v.y, v.z], i * 3)
  }
  const index = (mesh.userData.fullIndex as THREE.BufferAttribute | undefined)?.array ?? geometry.index?.array ?? Array.from({ length: geometry.attributes.position.count }, (_, i) => i)
  return {
    mesh,
    grid: new TriangleGrid(positions, index, view.height / 40),
    positions,
    index,
    skinIndex: geometry.attributes.skinIndex as THREE.BufferAttribute,
    skinWeight: geometry.attributes.skinWeight as THREE.BufferAttribute,
  }
}

// ---- weights ----------------------------------------------------------------------------------------

function computeWeights (body: BodySurface, geometry: THREE.BufferGeometry, policy: Garment['policy'], view: CharacterView): { indices: Uint16Array, weights: Float32Array } {
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
function skirtBlend (w: Float32Array, geometry: THREE.BufferGeometry, bones: THREE.Bone[], view: CharacterView): void {
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

/** Laplacian smoothing of per-vertex weights over the garment's edges (coincident vertices welded). */
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

/** Remove body triangles whose corners all sit just under a garment (prevents poke-through). */
function hideCovered (body: BodySurface, garments: THREE.BufferGeometry[], view: CharacterView): number {
  const geometry = body.mesh.geometry
  if (body.mesh.userData.fullIndex === undefined) body.mesh.userData.fullIndex = geometry.index?.clone() ?? null
  const full = body.mesh.userData.fullIndex as THREE.BufferAttribute | null
  if (full === null || garments.length === 0) return 0
  const positions: number[] = []
  const index: number[] = []
  for (const g of garments) {
    const offset = positions.length / 3
    positions.push(...(g.attributes.position.array as Float32Array))
    const gi = g.index?.array ?? Array.from({ length: g.attributes.position.count }, (_, i) => i)
    for (let i = 0; i < gi.length; i++) index.push(gi[i] + offset)
  }
  const grid = new TriangleGrid(new Float32Array(positions), index, view.height / 40)
  // Use the model's own normals; compute on a copy only if it has none (never touch its shading).
  let normals = geometry.attributes.normal as THREE.BufferAttribute | undefined
  if (normals === undefined) {
    const copy = geometry.clone()
    copy.computeVertexNormals()
    normals = copy.attributes.normal as THREE.BufferAttribute
  }
  const reach = view.height * 0.05
  const covered = new Uint8Array(geometry.attributes.position.count)
  const v = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let i = 0; i < covered.length; i++) {
    v.fromArray(body.positions, i * 3)
    const hit = grid.closest(v, 3)
    if (hit === null || hit.distance > reach) continue
    n.fromBufferAttribute(normals, i).normalize()
    // The garment must lie outside the body here (in front of the surface along its normal).
    if (hit.point.clone().sub(v).dot(n) >= -reach * 0.15) covered[i] = 1
  }
  const kept: number[] = []
  for (let t = 0; t < full.count; t += 3) {
    const a = full.getX(t)
    const b = full.getX(t + 1)
    const c = full.getX(t + 2)
    if (covered[a] === 1 && covered[b] === 1 && covered[c] === 1) continue
    kept.push(a, b, c)
  }
  geometry.setIndex(kept)
  return (full.count - kept.length) / 3
}

function restoreBody (view: CharacterView): void {
  for (const mesh of view.skinned) {
    const full = mesh.userData.fullIndex as THREE.BufferAttribute | null | undefined
    if (full !== undefined && full !== null) mesh.geometry.setIndex(full.clone())
  }
}

// ---- attach -----------------------------------------------------------------------------------------

export function detachGarments (view: CharacterView): void {
  const found: THREE.Object3D[] = []
  view.root.traverse(o => { if (o.userData[GARMENT_FLAG] !== undefined) found.push(o) })
  for (const o of found) {
    o.removeFromParent()
    const index = view.skinned.indexOf(o as THREE.SkinnedMesh)
    if (index >= 0) view.skinned.splice(index, 1)
  }
  restoreBody(view)
}

/**
 * Attach ready garments. `fitting` (a garment id) shows that one as a static mesh with its placement,
 * so it can be moved with a gizmo before binding.
 */
export async function attachGarments (view: CharacterView, garments: Garment[], urlFor: (g: Garment) => string, fitting: string | null = null): Promise<Map<string, THREE.Object3D>> {
  detachGarments(view)
  const out = new Map<string, THREE.Object3D>()
  const body = bodySurface(view)
  if (body === null) return out
  const skeleton = body.mesh.skeleton
  const hideFrom: THREE.BufferGeometry[] = []
  for (const g of garments) {
    if (g.status !== 'ready' || g.file === undefined || (g.hidden === true && g.id !== fitting)) continue
    const meshes = await garmentMeshes(urlFor(g), g)
    if (g.id === fitting) {
      // Static, unbound copy for placement; the gizmo moves this group.
      const group = new THREE.Group()
      group.name = `${g.name}_fit`
      group.userData[GARMENT_FLAG] = g.id
      const inverse = garmentMatrix(g).invert()
      for (const m of meshes) { m.geometry.applyMatrix4(inverse); group.add(m) }
      group.applyMatrix4(garmentMatrix(g))
      view.root.add(group)
      out.set(g.id, group)
      continue
    }
    if (g.mode === 'rigid') {
      const bone = view.bones.get(g.bone) ?? skeleton.bones[0]
      const group = new THREE.Group()
      group.name = g.name.replace(/[^\w]+/g, '_')
      group.userData[GARMENT_FLAG] = g.id
      // Keep the rest-space placement: express it in the bone's rest frame.
      const rest = view.rest?.bones.get(g.bone)
      const restWorld = rest !== undefined ? new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1)) : bone.matrixWorld.clone()
      group.applyMatrix4(restWorld.invert())
      for (const m of meshes) group.add(m)
      bone.add(group)
      out.set(g.id, group)
      continue
    }
    const group = new THREE.Group()
    group.name = g.name.replace(/[^\w]+/g, '_')
    for (const m of meshes) {
      const { indices, weights } = computeWeights(body, m.geometry, g.policy, view)
      m.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
      m.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
      const skinned = new THREE.SkinnedMesh(m.geometry, m.material)
      skinned.name = m.name
      skinned.castShadow = true
      skinned.frustumCulled = false
      skinned.userData[GARMENT_FLAG] = g.id
      body.mesh.parent?.add(skinned)
      skinned.bind(skeleton, body.mesh.bindMatrix)
      view.skinned.push(skinned)
      if (g.hideBody) hideFrom.push(m.geometry)
      out.set(g.id, skinned)
    }
  }
  if (hideFrom.length > 0) hideCovered(body, hideFrom, view)
  return out
}
