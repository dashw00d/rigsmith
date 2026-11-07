// Gear on a character in the viewer, one piece at a time, by how it follows the body (src/model/types.ts GearAttach):
//   bone   rides one bone: bone -> the bone's rest frame undone -> the place node (its placement, the node clips move
//          with gear tracks, named geom.gearNode) -> its meshes. With pull handles its meshes are skinned to a small rig
//          of their own (pulls.ts) and the pulls are drawn each frame by tickPulls.
//   skin   skinned to the body: each vertex takes the weights of the body surface under it, then its policy removes
//          bones that must not move it (a cape never follows the arms, a skirt never follows the shins) and a smoothing
//          pass removes jagged borders; weights painted by hand (garments/<id>/weights.json) are laid over those.
//          Optionally the body under it is hidden so it can't poke through.
//   spot   pinned to one spot of the body's surface (its anchor, else the skin nearest its middle): every vertex takes
//          that spot's weights, so the whole piece moves as that skin does (a buckle, a pouch). One playing its own
//          animation (a mechanism) rides the spot's leading bone instead.
// A skin or spot piece being placed (fitted) shows unbound, as it sits at rest, for the gizmo to move.
//
// The weight functions (bodySurface, computeWeights, partSpot, spotWeights, partWeights, applyEdits) are shared with the
// game export (tools/lib/gearskin.ts), so the game gets the weights Rigsmith shows.
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import type { Gear, Placement, SkinPolicy } from '../model/types.ts'
import type { CharacterView } from './CharacterView.ts'
import { gearNode, safeName } from './geom.ts'
import { HIDE_SHARE, hiddenRegions, regionsOf, type Regions } from './regions.ts'
import { applyGeometryMatrix } from './geometry-transform.ts'
import { cloneMorphGeometry, restoreMorphState } from './morph-state.ts'
import { disposeObject, Lru, MB, objectBytes } from './lru.ts'
import { timed } from './perf.ts'
import { garmentMatrix, placementMatrix } from './placement.ts'
import { clearPulls, defaultPullWeights, PROP_ROOT, pullBoneName, pullWeightKeys, pullWeightName, registerPulls, splitStrand } from './pulls.ts'

export { garmentMatrix }

/** What the weight functions read of a character on stage (CharacterView, or tools/lib/node3d.ts's view). */
export type BodyView = Pick<CharacterView, 'skinned' | 'height' | 'rest'>
/** What wearing a piece needs of it. */
export type WearView = Pick<CharacterView, 'root' | 'skinned' | 'height' | 'rest' | 'bones'>

export const POLICIES: Array<{ id: SkinPolicy, label: string, hint: string }> = [
  { id: 'body', label: 'Follows body', hint: 'Shirts, armor, boots: takes weights from whatever it covers' },
  { id: 'upper', label: 'Upper body', hint: 'Torso and arms only, never the legs' },
  { id: 'lower', label: 'Lower body', hint: 'Hips and legs only' },
  { id: 'cape', label: 'Cape / cloak', hint: 'Torso and neck only, never the arms' },
  { id: 'skirt', label: 'Skirt / robe', hint: 'Hips and thighs, blended so it never splits between the legs' },
  { id: 'head', label: 'Head', hint: 'Hats, hoods and hair: head and neck only' },
]

const ALLOWED: Record<SkinPolicy, RegExp | null> = {
  body: null,
  upper: /^(Hips|Spine\d?|Neck|Head|(Left|Right)(Shoulder|Arm|ForeArm|Hand.*))$/,
  lower: /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))$/,
  cape: /^(Hips|Spine\d?|Neck|Head|(Left|Right)Shoulder)$/,
  skirt: /^(Hips|Spine|(Left|Right)UpLeg)$/,
  head: /^(Neck|Head)$/,
}

const SMOOTHING: Record<SkinPolicy, number> = { body: 3, upper: 3, lower: 3, cape: 10, skirt: 14, head: 2 }

/** userData key on everything a piece adds to the view: its gear id. */
export const GARMENT_FLAG = 'rigsmithGarment'

const loader = new GLTFLoader()
type Model = { scene: THREE.Group, animations: THREE.AnimationClip[] }
/** Pieces' models by URL (a workspace file's carries its content hash: src/engine/assetUrls.ts), the oldest let go
 * past the budget. A worn piece owns copies of its geometry (meshesOf), so letting one go only costs a download. */
const models = new Lru<Model>({ budget: 768 * MB, max: 600, size: m => objectBytes(m.scene), dispose: m => { disposeObject(m.scene) } })

async function loadModel (url: string): Promise<Model> {
  return await models.load(url, async () => {
    const g = await loader.loadAsync(url)
    return { scene: g.scene, animations: g.animations }
  })
}

/** A piece's model fetched and parsed ahead of being worn (an outfit about to be shown), when there is time. */
export async function preloadModel (url: string): Promise<void> {
  await loadModel(url)
}

/** The animations a piece's model carries (a mechanism's), by name. */
export async function gearAnimations (url: string): Promise<string[]> {
  return (await loadModel(url)).animations.map(a => a.name)
}

/** A piece's hand-painted weights: per vertex of one of its meshes (in the model's mesh order), by bone name (skin
 * gear) or by 'PropRoot' / 'pull:<handle id>' (pulled gear). */
export interface GarmentEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

/** Mechanisms worn (spot gear playing its own animation), by owner (a view) and gear id, stepped by tickMechanisms. */
const mechanisms = new Map<object, Map<string, THREE.AnimationMixer>>()

/** Step every worn mechanism's own animation. */
export function tickMechanisms (dt: number): void {
  for (const mixers of mechanisms.values()) for (const m of mixers.values()) m.update(dt)
}

/** Where a piece's model is moved to so its origin (Gear.origin, a point of the model's own space) is at zero: the
 * frame its placement, handles, pulls and keys are in. Identity for a piece keeping its file's origin. */
export function originMatrix (g: Pick<Gear, 'origin'>): THREE.Matrix4 {
  const o = g.origin
  return o === undefined ? new THREE.Matrix4() : new THREE.Matrix4().makeTranslation(-o[0], -o[1], -o[2])
}

/** The piece's meshes as static geometry, `placement` applied (identity: in its own frame, its origin at zero), in its
 * model's mesh order. Their geometry and materials are copies the piece owns. */
async function meshesOf (url: string, g: Pick<Gear, 'name' | 'origin'>, placement: THREE.Matrix4): Promise<THREE.Mesh[]> {
  const scene = (await loadModel(url)).scene
  scene.updateMatrixWorld(true)
  const out: THREE.Mesh[] = []
  const name = g.name
  const own = g.origin === undefined ? placement : placement.clone().multiply(originMatrix(g))
  scene.traverse(o => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const geometry = cloneMorphGeometry(mesh)
    for (const attribute of ['skinIndex', 'skinWeight']) geometry.deleteAttribute(attribute)
    applyGeometryMatrix(geometry, new THREE.Matrix4().multiplyMatrices(own, mesh.matrixWorld))
    const material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone()
    const copy = restoreMorphState(new THREE.Mesh(geometry, material))
    copy.name = `${safeName(name)}_${out.length}`
    copy.castShadow = true
    copy.frustumCulled = false
    copy.userData.ownGeometry = true
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

export interface BodySurface {
  /** The first of the body's meshes: its skeleton and bind matrix are every one's (one rig). */
  mesh: THREE.SkinnedMesh
  /** All of the body's skinned meshes (a body of several materials loads as one mesh each), in the view's order. */
  meshes: THREE.SkinnedMesh[]
  /** Where each mesh's vertices start in `positions` (and the weights, the index, the regions). */
  offsets: number[]
  grid: TriangleGrid
  positions: Float32Array
  index: ArrayLike<number>
  skinIndex: THREE.BufferAttribute
  skinWeight: THREE.BufferAttribute
  /** The pieces the body's seams cut it into (regions.ts): gear hides the body by whole regions. */
  regions: Regions
}

/** The body as gear sees it: its rest surface (closest-point queries), its weights and its regions, over every one of
 * its meshes (v6's Skin, Face, Shirt and Trousers are four). */
export function bodySurface (view: BodyView): BodySurface | null {
  const meshes = view.skinned.filter(m => m.userData[GARMENT_FLAG] === undefined)
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

// (a view's body surface, measured once: its rest positions and weights don't change while it is on stage)
const bodies = new WeakMap<object, BodySurface | null>()
function bodyOf (view: BodyView): BodySurface | null {
  if (!bodies.has(view)) bodies.set(view, bodySurface(view))
  return bodies.get(view) ?? null
}

// ---- weights ----------------------------------------------------------------------------------------

/** Skin gear's weights: each vertex (rest space) the weights of the body surface under it, the policy's bones only,
 * smoothed along the piece; the four strongest. */
export function computeWeights (body: BodySurface, geometry: THREE.BufferGeometry, policy: SkinPolicy, view: Pick<BodyView, 'rest' | 'height'>): { indices: Uint16Array, weights: Float32Array } {
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

/** A spot piece's spot on the body at rest: its anchor, else the skin nearest the middle of its meshes (rest space). */
export function partSpot (g: { anchor?: readonly number[] }, meshes: THREE.Mesh[]): THREE.Vector3 {
  if (g.anchor !== undefined) return new THREE.Vector3(g.anchor[0], g.anchor[1], g.anchor[2])
  const box = new THREE.Box3()
  for (const m of meshes) { m.geometry.computeBoundingBox(); box.union(m.geometry.boundingBox!) }
  return box.getCenter(new THREE.Vector3())
}

/** The body's weights at the skin nearest `spot` (rest space), the four strongest: what a spot piece moves by. */
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

/** Every vertex of a spot piece weighted alike: `spot`'s weights. */
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
export function coveredVertices (body: BodySurface, pieces: THREE.BufferGeometry[], height: number): Uint8Array {
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

/** The share of a region a piece must cover to hide it: HIDE_SHARE, or FACE_SHARE for headwear over the face (a great
 * helm sits tight on the head: the face it closes over would show through where it doesn't quite reach). */
export const FACE_SHARE = 0.6
export const hideShareOf = (g: Pick<Gear, 'tags'>): number => ((g.tags ?? []).includes('covers-face') ? FACE_SHARE : HIDE_SHARE)

/** The body regions `pieces` hide: those they cover (nearly) everywhere (regions.ts). */
export function regionsHidden (body: BodySurface, pieces: THREE.BufferGeometry[], height: number, share = HIDE_SHARE): number[] {
  return hiddenRegions(body.regions, coveredVertices(body, pieces, height), share)
}

/** What one worn piece hides, worked out once: its geometry at rest doesn't change while it is worn, and the coverage
 * test is the slow part (a closest-point query per body vertex), so swapping one piece must not test every other. */
const hiddenByPiece = new WeakMap<THREE.BufferGeometry[], { body: BodySurface, share: number, height: number, regions: number[] }>()
function hiddenBy (body: BodySurface, hides: THREE.BufferGeometry[], height: number, share: number): number[] {
  const known = hiddenByPiece.get(hides)
  if (known !== undefined && known.body === body && known.share === share && known.height === height) return known.regions
  const regions = regionsHidden(body, hides, height, share)
  hiddenByPiece.set(hides, { body, share, height, regions })
  return regions
}

/** Remove the body regions the pieces cover, whole (prevents poke-through, and the body stops at a seam): each worn
 * piece's at its own share. */
function hideCovered (body: BodySurface, worn: Array<{ hides: THREE.BufferGeometry[], share: number }>, view: BodyView): number {
  if (worn.length === 0) return 0
  const hidden = new Set(worn.flatMap(w => hiddenBy(body, w.hides, view.height, w.share)))
  if (hidden.size === 0) return 0
  let removed = 0
  for (const [k, mesh] of body.meshes.entries()) {
    const geometry = mesh.geometry
    if (mesh.userData.fullIndex === undefined) mesh.userData.fullIndex = geometry.index?.clone() ?? null
    const full = mesh.userData.fullIndex as THREE.BufferAttribute | null
    if (full === null) continue
    const o = body.offsets[k]
    const kept: number[] = []
    for (let t = 0; t < full.count; t += 3) {
      if (hidden.has(body.regions.of[full.getX(t) + o])) continue
      kept.push(full.getX(t), full.getX(t + 1), full.getX(t + 2))
    }
    removed += (full.count - kept.length) / 3
    geometry.setIndex(kept)
  }
  return removed
}

function restoreBody (view: BodyView): void {
  for (const mesh of view.skinned) {
    const full = mesh.userData.fullIndex as THREE.BufferAttribute | null | undefined
    if (full !== undefined && full !== null) mesh.geometry.setIndex(full.clone())
  }
}

/** The body whole again, then hidden under every worn piece that hides it. */
export function hideBodyUnder (view: BodyView, worn: Iterable<Worn>): void {
  restoreBody(view)
  const pieces = [...worn].flatMap(w => (w.hides !== undefined && w.hides.length > 0 ? [{ hides: w.hides, share: w.hideShare ?? HIDE_SHARE }] : []))
  if (pieces.length === 0) return
  const body = bodyOf(view)
  if (body !== null) hideCovered(body, pieces, view)
}

// ---- wearing ----------------------------------------------------------------------------------------

/** A bone's rest frame in the character's rest space (no scale): what a bone piece's placement is relative to. */
export function restFrame (view: Pick<CharacterView, 'rest'>, bone: string): THREE.Matrix4 | null {
  const rest = view.rest?.bones.get(bone)
  return rest === undefined ? null : new THREE.Matrix4().compose(rest.worldPosition, rest.worldQuaternion, new THREE.Vector3(1, 1, 1))
}

/** A piece as the viewer wears it. */
export interface Worn {
  gear: string
  /** What its placement moves: a bone piece's place node (clips move it too, with gear tracks), a piece being fitted,
   * a mechanism's place. Null for skin and spot gear bound to the body. */
  node: THREE.Object3D | null
  /** Its meshes as shown (to pick on), in its model's mesh order. */
  meshes: THREE.Mesh[]
  /** What it added to the view (taken off by takeOff). */
  objects: THREE.Object3D[]
  /** Skin gear hiding the body under it: its geometry at rest. */
  hides?: THREE.BufferGeometry[]
  /** The share of a region it must cover to hide it (hideShareOf). */
  hideShare?: number
}

/** A bone piece's frame on its bone: bone -> the bone's rest frame undone -> the place node (named geom.gearNode, with
 * `place`), put on the bone at once, before its model loads, so a clip baked meanwhile finds the node its gear tracks
 * move. A bone the skeleton lacks: its first bone. Null when it has no bones. */
export function boneFrame (view: Pick<CharacterView, 'rest' | 'bones'>, g: Pick<Gear, 'id' | 'name'>, bone: string, place: Placement): { bone: THREE.Object3D, group: THREE.Group, place: THREE.Group } | null {
  const node = view.bones.get(bone) ?? view.bones.values().next().value
  if (node === undefined) return null
  const group = new THREE.Group()
  group.name = safeName(g.name)
  group.userData[GARMENT_FLAG] = g.id
  // Keep the rest-space placement: express it in the bone's rest frame.
  group.applyMatrix4((restFrame(view, view.bones.has(bone) ? bone : node.name) ?? node.matrixWorld.clone()).invert())
  const holder = new THREE.Group()
  holder.name = gearNode(g)
  placementMatrix(place).decompose(holder.position, holder.quaternion, holder.scale)
  group.add(holder)
  node.add(group)
  return { bone: node, group, place: holder }
}

export interface WearOptions {
  /** Where the model loads from. */
  url: string
  /** Its placement in rest space (a catalog piece's old grip-frame placement already converted). */
  place: Placement
  /** A skin or spot piece shown unbound for the gizmo to place it. */
  fitting?: boolean
  /** Its painted weights (skin gear; pulled gear), when it has some. */
  edits?: () => Promise<GarmentEdit[]>
  /** Who registers its pull rigs and mechanism (the view it is on, by default). */
  owner?: object
  /** A bone piece's frame made beforehand (boneFrame). */
  frame?: ReturnType<typeof boneFrame>
}

/** Put one ready piece on the character on stage. Null when it can't be worn here (no body to skin it to, no bones). */
export async function wear (view: WearView, g: Gear, o: WearOptions): Promise<Worn | null> {
  const owner = o.owner ?? view
  const a = g.attach
  if (a.kind === 'bone') {
    const frame = o.frame ?? boneFrame(view, g, a.bone, o.place)
    if (frame === null) return null
    let meshes: THREE.Mesh[]
    try {
      meshes = await meshesOf(o.url, g, new THREE.Matrix4())
    } catch (error) {
      frame.group.removeFromParent()
      throw error
    }
    const pulled = g.handles.some(h => h.kind === 'pull' && h.pull !== undefined)
    const shown = pulled ? await rigPulls(view, g, frame.place, meshes, o.edits, owner) : meshes
    if (!pulled) for (const m of meshes) frame.place.add(m)
    for (const m of shown) m.userData[GARMENT_FLAG] = g.id
    return { gear: g.id, node: frame.place, meshes: shown, objects: [frame.group] }
  }
  const body = bodyOf(view)
  if (body === null) return null
  const skeleton = body.mesh.skeleton
  const placed = placementMatrix(o.place)
  // A mechanism (a spot piece playing its own animation): it rides its spot's leading bone, as a bone piece does.
  const pinned = a.kind === 'spot' ? a : null
  const model = pinned?.animation !== undefined ? await loadModel(o.url) : null
  const clip = model?.animations.find(x => x.name === pinned?.animation)
  if (pinned !== null && model !== null && clip !== undefined) {
    const meshes = await meshesOf(o.url, g, placed)
    const lead = skeleton.bones[spotWeights(body, partSpot(pinned, meshes))[0][0]] ?? skeleton.bones[0]
    for (const m of meshes) dispose(m)
    const frame = boneFrame(view, g, lead.name, o.place)
    if (frame === null) return null
    const copy = cloneSkinned(model.scene)
    // (its own animation moves the model's own nodes: the whole model moved so its origin is the piece's)
    if (g.origin !== undefined) copy.position.add(new THREE.Vector3(...g.origin).negate())
    const shown: THREE.Mesh[] = []
    copy.traverse(x => {
      if (!(x as THREE.Mesh).isMesh) return
      const m = x as THREE.Mesh
      m.castShadow = true; m.frustumCulled = false; m.userData[GARMENT_FLAG] = g.id
      shown.push(m)
    })
    frame.place.add(copy)
    const mixer = new THREE.AnimationMixer(copy)
    mixer.clipAction(clip).play()
    const mine = mechanisms.get(owner) ?? new Map<string, THREE.AnimationMixer>()
    mine.set(g.id, mixer)
    mechanisms.set(owner, mine)
    return { gear: g.id, node: frame.place, meshes: shown, objects: [frame.group] }
  }
  if (o.fitting === true) {
    // Static, unbound, in its own space under a node holding its placement: the gizmo moves the node.
    const group = new THREE.Group()
    group.name = `${safeName(g.name)}_fit`
    group.userData[GARMENT_FLAG] = g.id
    const meshes = await meshesOf(o.url, g, new THREE.Matrix4())
    for (const m of meshes) { m.userData[GARMENT_FLAG] = g.id; group.add(m) }
    placed.decompose(group.position, group.quaternion, group.scale)
    view.root.add(group)
    return { gear: g.id, node: group, meshes, objects: [group] }
  }
  // skin: the body's weights under each vertex, then what was painted; spot: every vertex its spot's weights
  const meshes = await meshesOf(o.url, g, placed)
  const spot = a.kind === 'spot' ? spotWeights(body, partSpot(a, meshes)) : null
  const edits = a.kind === 'skin' && (g.painted ?? 0) > 0 && o.edits !== undefined ? await o.edits().catch(() => []) : []
  const boneNames = skeleton.bones.map(b => b.name)
  const shown: THREE.SkinnedMesh[] = []
  for (const [i, m] of meshes.entries()) {
    const { indices, weights } = a.kind === 'skin' ? timed('computeWeights', () => computeWeights(body, m.geometry, a.policy, view), g.name) : partWeights(m.geometry.attributes.position.count, spot!)
    if (edits.length > 0) applyEdits(indices, weights, edits, i, boneNames)
    m.geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
    m.geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const skinned = restoreMorphState(new THREE.SkinnedMesh(m.geometry, m.material))
    skinned.name = m.name
    skinned.castShadow = true
    skinned.frustumCulled = false
    skinned.userData[GARMENT_FLAG] = g.id
    skinned.userData.ownGeometry = true
    // (which of the model's meshes it is: painted weights are kept by it)
    skinned.userData.garmentMesh = i
    body.mesh.parent?.add(skinned)
    skinned.bind(skeleton, body.mesh.bindMatrix)
    view.skinned.push(skinned)
    shown.push(skinned)
  }
  return {
    gear: g.id, node: null, meshes: shown, objects: shown,
    ...(a.kind === 'skin' && a.hideBody === true && g.role !== 'hair' ? { hides: shown.map(m => m.geometry), hideShare: hideShareOf(g) } : {}),
  }
}

/** Take a worn piece off: its nodes, its skinned meshes from the view's list, its pulls and mechanism, its copies. */
export function takeOff (view: Pick<CharacterView, 'skinned'>, worn: Worn, owner: object = view): void {
  mechanisms.get(owner)?.get(worn.gear)?.stopAllAction()
  mechanisms.get(owner)?.delete(worn.gear)
  clearPulls(owner, worn.gear)
  for (const o of worn.objects) {
    o.removeFromParent()
    o.traverse(x => {
      const i = view.skinned.indexOf(x as THREE.SkinnedMesh)
      if (i >= 0) view.skinned.splice(i, 1)
      const m = x as THREE.Mesh
      if (m.isMesh === true && m.userData.ownGeometry === true) dispose(m)
    })
  }
}

/** Everything gear put on a view taken off (whatever the bookkeeping says), the body whole again. */
export function takeOffAll (view: BodyView & Pick<CharacterView, 'root'>, owner: object = view): void {
  for (const m of mechanisms.get(owner)?.values() ?? []) m.stopAllAction()
  mechanisms.delete(owner)
  clearPulls(owner)
  const found: THREE.Object3D[] = []
  view.root.traverse(o => { if (o.userData[GARMENT_FLAG] !== undefined && (o.parent === null || o.parent.userData[GARMENT_FLAG] === undefined)) found.push(o) })
  for (const o of found) takeOff(view, { gear: '', node: null, meshes: [], objects: [o] }, owner)
  restoreBody(view)
}

function dispose (m: THREE.Mesh): void {
  m.geometry.dispose()
  for (const material of Array.isArray(m.material) ? m.material : [m.material]) material.dispose()
}

/**
 * A bone piece with pull handles (pulls.ts): its meshes split where a strand must bend, skinned to its own root and one
 * bone per pull (resting at the pull's point), each vertex rigid or soft as painted (else soft right by a pull's
 * point); the pulls registered for tickPulls by gear and handle id.
 */
async function rigPulls (view: Pick<CharacterView, 'bones' | 'skinned'>, g: Gear, place: THREE.Object3D, meshes: THREE.Mesh[],
  editsFor: (() => Promise<GarmentEdit[]>) | undefined, owner: object): Promise<THREE.SkinnedMesh[]> {
  const handles = g.handles.filter((h): h is typeof h & { pull: NonNullable<typeof h.pull> } => h.kind === 'pull' && h.pull !== undefined)
  const root = new THREE.Bone()
  root.name = PROP_ROOT
  root.userData.weightKey = PROP_ROOT
  place.add(root)
  const bones = handles.map(h => {
    const b = new THREE.Bone()
    b.name = pullBoneName(g.name, h)
    b.userData.weightKey = pullWeightName(h)
    b.position.set(...h.pull.rest)
    root.add(b)
    return b
  })
  const skeleton = new THREE.Skeleton([root, ...bones])
  // (painted weights by their keys; ones painted under the bones' names count too)
  const keys = pullWeightKeys(g.name, g.handles)
  const raw = (g.painted ?? 0) > 0 && editsFor !== undefined ? await editsFor().catch(() => []) : []
  const edits = raw.map(e => ({ ...e, weights: e.weights.map(([n, w]): [string, number] => [keys.get(n) ?? n, w]) }))
  const names = [PROP_ROOT, ...handles.map(pullWeightName)]
  place.updateMatrixWorld(true)
  const out: THREE.SkinnedMesh[] = []
  for (const [i, m] of meshes.entries()) {
    let geometry = m.geometry
    for (const h of handles) geometry = splitStrand(geometry, new THREE.Vector3(...h.pull.rest))
    if (geometry !== m.geometry) m.geometry.dispose()
    const { indices, weights } = defaultPullWeights(geometry, handles.map(h => h.pull))
    if (edits.length > 0) applyEdits(indices, weights, edits, i, names)
    geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
    geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
    const skinned = restoreMorphState(new THREE.SkinnedMesh(geometry, m.material))
    skinned.name = m.name
    skinned.castShadow = true
    skinned.frustumCulled = false
    skinned.userData.ownGeometry = true
    skinned.userData.garmentMesh = i
    place.add(skinned)
    skinned.updateMatrixWorld(true)
    skinned.bind(skeleton)
    out.push(skinned)
  }
  // (painted like the body: the painter finds the piece's meshes among the view's skinned ones)
  view.skinned.push(...out)
  registerPulls(owner, handles.map((h, k) => ({ gear: g.id, handle: h.id, grip: h.pull.grip, rest: h.pull.rest, root, bone: bones[k], hand: view.bones.get(h.pull.bone) ?? root })))
  return out
}
