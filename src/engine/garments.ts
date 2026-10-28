// The user's own meshes worn by a character, the Outfit step's accessories, of three kinds:
//   props (mode 'rigid')    ride one bone, socket based: a weapon in a hand, a quiver on the back
//   clothes ('clothing')    skinned to the body: each vertex takes the weights of the body surface under it, then a
//                           policy removes bones that must not move it (a cape never follows the arms, a skirt never
//                           follows the shins) and a smoothing pass removes jagged borders; weights painted by hand
//                           (garments/<id>/weights.json) are laid over those. Optionally the body under it is hidden
//                           so it can't poke through.
//   parts ('part')          pinned to one spot on the body's surface (its anchor, else the skin nearest its middle):
//                           every vertex takes that spot's weights, so the whole part moves as that skin does (a
//                           buckle, a pouch). One with its own animation (a mechanism) rides the spot's leading bone
//                           instead and plays it.
// Any of them can be switched off (hidden), and in a switch set (group) only one shows at a time.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { Garment } from '../../server/workspace.ts'
import type { CharacterView } from './CharacterView.ts'
import { garmentMatrix } from './placement.ts'
import { clearPulls, defaultPullWeights, PROP_ROOT, pullBoneName, registerPulls, splitStrand } from './pulls.ts'

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
const models = new Map<string, Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }>>()

async function loadModel (url: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  let pending = models.get(url)
  if (pending === undefined) {
    pending = loader.loadAsync(url).then(g => ({ scene: g.scene, animations: g.animations }))
    models.set(url, pending)
    pending.catch(() => models.delete(url))
  }
  return await pending
}

async function load (url: string): Promise<THREE.Group> {
  return (await loadModel(url)).scene
}

/** The animations a garment's model carries (a mechanism's), by name. */
export async function garmentAnimations (url: string): Promise<string[]> {
  return (await loadModel(url)).animations.map(a => a.name)
}

/** A clothing piece's hand-painted weights: per vertex of one of its meshes (in the model's mesh order), by bone name. */
export interface GarmentEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

/** Where a garment's painted weights are kept, beside its model. */
export function garmentWeightsUrl (modelUrl: string, g: Garment): string {
  return `${modelUrl.replace(/[?#].*$/, '').replace(/[^/]*$/, '')}weights.json?v=${g.painted ?? 0}`
}

/** Model animation mixers of the parts worn (mechanisms), stepped each frame (tickMechanisms). */
const mechanisms = new Map<CharacterView, THREE.AnimationMixer[]>()

/** Step every worn mechanism's own animation. */
export function tickMechanisms (dt: number): void {
  for (const mixers of mechanisms.values()) for (const m of mixers) m.update(dt)
}

export { garmentMatrix }

/** The garment's meshes as static geometry in character rest space (transform applied). */
export async function garmentMeshes (url: string, g: Garment): Promise<THREE.Mesh[]> {
  return await meshesOf(url, g, garmentMatrix(g))
}

/** The garment's meshes in its own frame (before its placement): a rigid garment's placement is a node above them. */
async function meshesOf (url: string, g: Garment, placement: THREE.Matrix4): Promise<THREE.Mesh[]> {
  const scene = await load(url)
  scene.updateMatrixWorld(true)
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

  // (plain fields, no parameter properties: node runs this file by stripping its types, for tools/game_export.ts)
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

export interface BodySurface {
  mesh: THREE.SkinnedMesh
  grid: TriangleGrid
  positions: Float32Array
  index: ArrayLike<number>
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
}

/** The body as garments see it: its rest surface (closest-point queries) and its weights. */
export function bodySurface (view: CharacterView): BodySurface | null {
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

/** Clothing weights: each vertex (rest space) the weights of the body surface under it, the policy's bones only,
 * smoothed along the garment; the four strongest. */
export function computeWeights (body: BodySurface, geometry: THREE.BufferGeometry, policy: Garment['policy'], view: CharacterView): { indices: Uint16Array, weights: Float32Array } {
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

/** A part's spot on the body at rest: its anchor, else the skin nearest the middle of its meshes (rest space). */
export function partSpot (g: Pick<Garment, 'anchor'>, meshes: THREE.Mesh[]): THREE.Vector3 {
  if (g.anchor !== undefined) return new THREE.Vector3(...g.anchor)
  const box = new THREE.Box3()
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!) }
  return box.getCenter(new THREE.Vector3())
}

/** The body's weights at the skin nearest `spot` (rest space), the four strongest: what a part moves by, all of it. */
export function spotWeights (body: BodySurface, spot: THREE.Vector3): Array<[number, number]> {
  const hit = body.grid.closest(spot, 40)
  if (hit === null) return [[0, 1]]
  const bary = body.grid.barycentric(hit.triangle, hit.point)
  const lambdas = [bary.x, bary.y, bary.z]
  const sum = new Map<number, number>()
  for (let c = 0; c < 3; c++) {
    const v = body.index[hit.triangle * 3 + c]
    for (let k = 0; k < 4; k++) {
      const w = body.skinWeight.getComponent(v, k) * lambdas[c]
      if (w > 0) sum.set(body.skinIndex.getComponent(v, k), (sum.get(body.skinIndex.getComponent(v, k)) ?? 0) + w)
    }
  }
  const top = [...sum].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const total = top.reduce((t, [, w]) => t + w, 0)
  return total > 0 ? top.map(([b, w]) => [b, w / total]) : [[0, 1]]
}

/** Every vertex of a part weighted alike: `spot`'s weights. */
export function partWeights (count: number, spot: Array<[number, number]>): { indices: Uint16Array, weights: Float32Array } {
  const indices = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) for (let k = 0; k < 4; k++) { indices[i * 4 + k] = spot[k]?.[0] ?? 0; weights[i * 4 + k] = spot[k]?.[1] ?? 0 }
  return { indices, weights }
}

/** Painted weights laid over computed ones (`mesh`: this mesh's index in the model; bones by name). */
export function applyEdits (indices: Uint16Array, weights: Float32Array, edits: GarmentEdit[], mesh: number, boneNames: string[]): number {
  let n = 0
  for (const e of edits) {
    if (e.mesh !== mesh || e.vertex * 4 >= indices.length) continue
    const top = e.weights.map(([name, w]) => [boneNames.indexOf(name), w] as [number, number]).filter(([b, w]) => b >= 0 && w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((t, [, w]) => t + w, 0)
    if (total <= 0) continue
    for (let k = 0; k < 4; k++) { indices[e.vertex * 4 + k] = top[k]?.[0] ?? 0; weights[e.vertex * 4 + k] = (top[k]?.[1] ?? 0) / total }
    n++
  }
  return n
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
  for (const m of mechanisms.get(view) ?? []) m.stopAllAction()
  mechanisms.delete(view)
  clearPulls(view)
  const found: THREE.Object3D[] = []
  view.root.traverse(o => { if (o.userData[GARMENT_FLAG] !== undefined) found.push(o) })
  for (const o of found) {
    o.removeFromParent()
    const index = view.skinned.indexOf(o as THREE.SkinnedMesh)
    if (index >= 0) view.skinned.splice(index, 1)
  }
  restoreBody(view)
}

/** A bone's rest frame in the character's rest space (no scale): what a rigid garment's placement is relative to. */
export function restFrame (view: CharacterView, bone: string): THREE.Matrix4 | null {
  const rest = view.rest?.bones.get(bone)
  return rest === undefined ? null : new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1))
}

/**
 * Attach ready garments. A rigid one rides its bone: bone -> its rest frame undone -> a node holding its placement
 * (the object returned for it, which a gizmo moves while the character plays or holds a pose) -> its meshes. A clothing
 * one is skinned to the body; while `fitting` (its id) it shows as a static mesh with its placement instead, to move
 * before binding. A hidden garment is left off unless it is the one being fitted.
 */
export async function attachGarments (view: CharacterView, garments: Garment[], urlFor: (g: Garment) => string, fitting: string | null = null,
  editsFor: (g: Garment) => Promise<GarmentEdit[]> = async g => await fetchEdits(garmentWeightsUrl(urlFor(g), g))): Promise<Map<string, THREE.Object3D>> {
  detachGarments(view)
  const out = new Map<string, THREE.Object3D>()
  const body = bodySurface(view)
  if (body === null) return out
  const skeleton = body.mesh.skeleton
  const hideFrom: THREE.BufferGeometry[] = []
  for (const g of garments) {
    if (g.status !== 'ready' || g.file === undefined || (g.hidden === true && g.id !== fitting)) continue
    if (g.mode === 'rigid') {
      const bone = view.bones.get(g.bone) ?? skeleton.bones[0]
      const group = new THREE.Group()
      group.name = g.name.replace(/[^\w]+/g, '_')
      group.userData[GARMENT_FLAG] = g.id
      // Keep the rest-space placement: express it in the bone's rest frame.
      group.applyMatrix4((restFrame(view, g.bone) ?? bone.matrixWorld.clone()).invert())
      const place = new THREE.Group()
      place.name = `${group.name}_place`
      garmentMatrix(g).decompose(place.position, place.quaternion, place.scale)
      group.add(place)
      bone.add(group)
      const meshes = await meshesOf(urlFor(g), g, new THREE.Matrix4())
      if ((g.pulls ?? []).length > 0) await rigPulls(view, g, place, meshes, editsFor)
      else for (const m of meshes) place.add(m)
      out.set(g.id, place)
      continue
    }
    const meshes = await garmentMeshes(urlFor(g), g)
    // A mechanism (a part with its own animation playing): it rides its spot's leading bone, as a prop does.
    const model = g.mode === 'part' && g.animation !== undefined ? await loadModel(urlFor(g)) : null
    const clip = model?.animations.find(a => a.name === g.animation)
    if (model !== null && clip !== undefined) {
      const lead = skeleton.bones[spotWeights(body, partSpot(g, meshes))[0][0]] ?? skeleton.bones[0]
      const group = new THREE.Group()
      group.name = g.name.replace(/[^\w]+/g, '_')
      group.userData[GARMENT_FLAG] = g.id
      group.applyMatrix4((restFrame(view, lead.name) ?? lead.matrixWorld.clone()).invert())
      const place = new THREE.Group()
      place.name = `${group.name}_place`
      garmentMatrix(g).decompose(place.position, place.quaternion, place.scale)
      const copy = cloneSkinned(model.scene)
      copy.traverse(o => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = true; o.frustumCulled = false } })
      place.add(copy)
      group.add(place)
      lead.add(group)
      const mixer = new THREE.AnimationMixer(copy)
      mixer.clipAction(clip).play()
      mechanisms.set(view, [...(mechanisms.get(view) ?? []), mixer])
      out.set(g.id, place)
      continue
    }
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
    const group = new THREE.Group()
    group.name = g.name.replace(/[^\w]+/g, '_')
    // a part: every vertex its spot's weights; clothing: the body's under each vertex, then what was painted
    const spot = g.mode === 'part' ? spotWeights(body, partSpot(g, meshes)) : null
    const edits = g.mode === 'clothing' && (g.painted ?? 0) > 0 ? await editsFor(g).catch(() => []) : []
    const boneNames = skeleton.bones.map(b => b.name)
    for (const [i, m] of meshes.entries()) {
      const { indices, weights } = spot !== null ? partWeights(m.geometry.attributes.position.count, spot) : computeWeights(body, m.geometry, g.policy, view)
      if (edits.length > 0) applyEdits(indices, weights, edits, i, boneNames)
      m.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
      m.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
      const skinned = new THREE.SkinnedMesh(m.geometry, m.material)
      skinned.name = m.name
      skinned.castShadow = true
      skinned.frustumCulled = false
      skinned.userData[GARMENT_FLAG] = g.id
      // (which of the model's meshes it is: painted weights are kept by it)
      skinned.userData.garmentMesh = i
      body.mesh.parent?.add(skinned)
      skinned.bind(skeleton, body.mesh.bindMatrix)
      view.skinned.push(skinned)
      if (g.hideBody && g.mode === 'clothing') hideFrom.push(m.geometry)
      out.set(g.id, skinned)
    }
  }
  if (hideFrom.length > 0) hideCovered(body, hideFrom, view)
  return out
}

/** A prop with pull sockets (pulls.ts): its meshes split where a strand must bend, skinned to its own root and one bone
 * per pull (resting at the pull's point), each vertex rigid or soft as painted (else soft right by a pull's point);
 * the pulls stepped each frame (tickPulls) toward the bones that hold them. */
async function rigPulls (view: CharacterView, g: Garment, place: THREE.Object3D, meshes: THREE.Mesh[], editsFor: (g: Garment) => Promise<GarmentEdit[]>): Promise<void> {
  const pulls = g.pulls ?? []
  const root = new THREE.Bone()
  root.name = PROP_ROOT
  place.add(root)
  const bones = pulls.map(p => { const b = new THREE.Bone(); b.name = pullBoneName(g.name, p); b.position.set(...p.rest); root.add(b); return b })
  const skeleton = new THREE.Skeleton([root, ...bones])
  const edits = (g.painted ?? 0) > 0 ? await editsFor(g).catch(() => []) : []
  const names = skeleton.bones.map(b => b.name)
  place.updateMatrixWorld(true)
  for (const [i, m] of meshes.entries()) {
    let geometry = m.geometry
    for (const p of pulls) geometry = splitStrand(geometry, new THREE.Vector3(...p.rest))
    const { indices, weights } = defaultPullWeights(geometry, pulls)
    if (edits.length > 0) applyEdits(indices, weights, edits, i, names)
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const skinned = new THREE.SkinnedMesh(geometry, m.material)
    skinned.name = m.name
    skinned.castShadow = true
    skinned.frustumCulled = false
    skinned.userData[GARMENT_FLAG] = g.id
    skinned.userData.garmentMesh = i
    place.add(skinned)
    skinned.updateMatrixWorld(true)
    skinned.bind(skeleton)
    view.skinned.push(skinned)
  }
  registerPulls(view, pulls.map((pull, k) => ({ pull, root, bone: bones[k], hand: view.bones.get(pull.bone) ?? root })))
}

async function fetchEdits (url: string): Promise<GarmentEdit[]> {
  const res = await fetch(url)
  if (!res.ok) return []
  return await res.json() as GarmentEdit[]
}
