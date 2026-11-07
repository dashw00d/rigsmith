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
import { mark, timed } from './perf.ts'
import { bodyKey, coverVertices, hiddenAt, meshesKey, regionHits, skinWeights, TriangleGrid, type BodyCore, type MeshCore } from './workers/fit.ts'
import { derive, type DeriveBody, type DerivedStore } from './workers/derive.ts'
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

// ---- the body as gear sees it -----------------------------------------------------------------------

export { TriangleGrid }

export interface BodySurface {
  /** The first of the body's meshes: its skeleton and bind matrix are every one's (one rig). */
  mesh: THREE.SkinnedMesh
  /** All of the body's skinned meshes (a body of several materials loads as one mesh each), in the view's order. */
  meshes: THREE.SkinnedMesh[]
  /** Where each mesh's vertices start in `positions` (and the weights, the index, the regions). */
  offsets: number[]
  /** Its closest-point grid (built the first time it is asked for). */
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
  const owns = meshes.map(mesh => (mesh.userData.fullIndex as THREE.BufferAttribute | undefined)?.array ?? mesh.geometry.index?.array ?? null)
  let triangles = 0
  for (const [k, own] of owns.entries()) triangles += own?.length ?? counts[k]
  const index = new Uint32Array(triangles)
  const v = new THREE.Vector3()
  let t = 0
  for (const [k, mesh] of meshes.entries()) {
    const geometry = mesh.geometry
    const o = offsets[k]
    const position = geometry.attributes.position
    const si = geometry.attributes.skinIndex as THREE.BufferAttribute | undefined
    const sw = geometry.attributes.skinWeight as THREE.BufferAttribute | undefined
    for (let i = 0; i < counts[k]; i++) {
      v.fromBufferAttribute(position, i).applyMatrix4(mesh.bindMatrix)
      const at = (o + i) * 3
      positions[at] = v.x; positions[at + 1] = v.y; positions[at + 2] = v.z
      for (let c = 0; c < 4; c++) {
        skinIndex[(o + i) * 4 + c] = si?.getComponent(i, c) ?? 0
        skinWeight[(o + i) * 4 + c] = sw?.getComponent(i, c) ?? 0
      }
    }
    const own = owns[k]
    if (own !== null) for (let j = 0; j < own.length; j++) index[t++] = own[j] + o
    else for (let j = 0; j < counts[k]; j++) index[t++] = j + o
  }
  let grid: TriangleGrid | null = null
  return {
    mesh: meshes[0],
    meshes,
    offsets,
    get grid () { return (grid ??= timed('bodySurface.grid', () => new TriangleGrid(positions, index, view.height / 40))) },
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
  if (!bodies.has(view)) bodies.set(view, timed('bodySurface', () => bodySurface(view)))
  return bodies.get(view) ?? null
}

/** The body as the fitting reads it (workers/fit.ts), for `view` (its rest pose and height), and its identity. Worked
 * out once per body surface. */
const cores = new WeakMap<BodySurface, DeriveBody & { rest: BodyView['rest'] }>()
export function bodyCore (body: BodySurface, view: Pick<BodyView, 'rest' | 'height'>): DeriveBody {
  const had = cores.get(body)
  if (had !== undefined && had.core.height === view.height && had.rest === (view.rest ?? null)) return had
  const done = mark('bodyCore')
  const total = body.positions.length / 3
  const normals = new Float64Array(total * 3)
  const n = new THREE.Vector3()
  const turn = new THREE.Matrix3()
  for (const [k, mesh] of body.meshes.entries()) {
    // Use the model's own normals; compute on a copy only if it has none (never touch its shading).
    let own = mesh.geometry.attributes.normal as THREE.BufferAttribute | undefined
    if (own === undefined) {
      const copy = mesh.geometry.clone()
      copy.computeVertexNormals()
      own = copy.attributes.normal as THREE.BufferAttribute
    }
    turn.getNormalMatrix(mesh.bindMatrix)
    for (let i = 0; i < own.count; i++) {
      n.fromBufferAttribute(own, i).applyMatrix3(turn).normalize()
      const at = (body.offsets[k] + i) * 3
      normals[at] = n.x; normals[at + 1] = n.y; normals[at + 2] = n.z
    }
  }
  const bones = body.mesh.skeleton.bones
  const bonePos = new Float64Array(bones.length * 3)
  const p = new THREE.Vector3()
  // Rest positions (the character may be mid-animation).
  for (const [b, bone] of bones.entries()) {
    const at = view.rest?.bones.get(bone.name)?.worldPosition ?? bone.getWorldPosition(p)
    bonePos[b * 3] = at.x; bonePos[b * 3 + 1] = at.y; bonePos[b * 3 + 2] = at.z
  }
  const core: BodyCore = {
    positions: body.positions,
    normals,
    index: body.index instanceof Uint32Array ? body.index : Uint32Array.from(body.index),
    skinIndex: body.skinIndex.array as Float32Array,
    skinWeight: body.skinWeight.array as Float32Array,
    regionOf: body.regions.of,
    regionVertices: body.regions.vertices,
    height: view.height,
    bones: bones.map(b => b.name),
    bonePos,
  }
  const made = { core, key: bodyKey(core), rest: view.rest ?? null }
  cores.set(body, made)
  done()
  return made
}

/** One of a piece's geometries as the fitting reads it (its own arrays where they are plain, not copied). */
export function meshCore (geometry: THREE.BufferGeometry): MeshCore {
  const a = geometry.attributes.position as THREE.BufferAttribute | THREE.InterleavedBufferAttribute
  let positions: Float32Array
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === 3 && a.array.length === a.count * 3) {
    positions = a.array
  } else {
    positions = new Float32Array(a.count * 3)
    for (let i = 0; i < a.count; i++) { positions[i * 3] = a.getX(i); positions[i * 3 + 1] = a.getY(i); positions[i * 3 + 2] = a.getZ(i) }
  }
  const ix = geometry.index?.array
  const index = ix === undefined ? null : ix instanceof Uint32Array || ix instanceof Uint16Array ? ix : Uint32Array.from(ix)
  return { positions, index }
}

// ---- weights ----------------------------------------------------------------------------------------

/** Skin gear's weights: each vertex (rest space) the weights of the body surface under it, the policy's bones only,
 * smoothed along the piece; the four strongest (workers/fit.ts skinWeights, the code the viewer's worker runs). */
export function computeWeights (body: BodySurface, geometry: THREE.BufferGeometry, policy: SkinPolicy, view: Pick<BodyView, 'rest' | 'height'>): { indices: Uint16Array, weights: Float32Array } {
  return skinWeights(bodyCore(body, view).core, body.grid, meshCore(geometry), policy)
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

// ---- hiding covered body ----------------------------------------------------------------------------

/** Which body vertices (BodySurface order) sit just under one of `pieces` (rest space): the piece lies outside the
 * surface there, along its normal, within reach (workers/fit.ts coverVertices). */
export function coveredVertices (body: BodySurface, pieces: THREE.BufferGeometry[], height: number): Uint8Array {
  if (pieces.length === 0) return new Uint8Array(body.positions.length / 3)
  const core = bodyCore(body, { rest: null, height }).core
  return coverVertices(core, pieces.map(meshCore))
}

/** The share of a region a piece must cover to hide it: HIDE_SHARE, or FACE_SHARE for headwear over the face (a great
 * helm sits tight on the head: the face it closes over would show through where it doesn't quite reach). */
export const FACE_SHARE = 0.6
export const hideShareOf = (g: Pick<Gear, 'tags'>): number => ((g.tags ?? []).includes('covers-face') ? FACE_SHARE : HIDE_SHARE)

/** The body regions `pieces` hide: those they cover (nearly) everywhere (regions.ts). */
export function regionsHidden (body: BodySurface, pieces: THREE.BufferGeometry[], height: number, share = HIDE_SHARE): number[] {
  return hiddenRegions(body.regions, coveredVertices(body, pieces, height), share)
}

/** What a worn piece covers of a body, by content (its meshes as placed, the body): a piece worn again, or on the
 * body loaded again, isn't tested again. For pieces worn without their regions (Worn.hidden). */
const coverage = new Lru<Int32Array>({ budget: 16 * MB, max: 4000, size: h => h.byteLength })
function hitsBy (body: BodySurface, view: BodyView, hides: THREE.BufferGeometry[]): Int32Array {
  const { core, key } = bodyCore(body, view)
  const meshes = hides.map(meshCore)
  const name = `${meshesKey(meshes)}-${key}`
  let hits = coverage.get(name)
  if (hits === undefined) {
    hits = timed('coverVertices', () => regionHits(core.regionOf, core.regionVertices.length, coverVertices(core, meshes)))
    coverage.set(name, hits)
  }
  return hits
}

/** The body's own triangles, before any was hidden (set aside the first time it is). */
function fullIndexOf (mesh: THREE.Mesh): THREE.BufferAttribute | null {
  if (mesh.userData.fullIndex === undefined) mesh.userData.fullIndex = mesh.geometry.index ?? null
  return mesh.userData.fullIndex as THREE.BufferAttribute | null
}

/** Per body mesh, its triangles with some regions hidden, by which (the last few: flipping between outfits sets an
 * index already on the GPU). */
const INDEXES = 8
function indexWithout (mesh: THREE.Mesh, full: THREE.BufferAttribute, offset: number, regions: Regions, hidden: Set<number>, key: string): THREE.BufferAttribute {
  const kept = (mesh.userData.hiddenIndexes ??= new Map<string, THREE.BufferAttribute>()) as Map<string, THREE.BufferAttribute>
  const had = kept.get(key)
  if (had !== undefined) { kept.delete(key); kept.set(key, had); return had }
  const src = full.array
  const out = new (src instanceof Uint16Array ? Uint16Array : Uint32Array)(src.length)
  let n = 0
  for (let t = 0; t + 2 < src.length; t += 3) {
    if (hidden.has(regions.of[src[t] + offset])) continue
    out[n++] = src[t]; out[n++] = src[t + 1]; out[n++] = src[t + 2]
  }
  const made = new THREE.BufferAttribute(out.slice(0, n), 1)
  kept.set(key, made)
  while (kept.size > INDEXES) kept.delete(kept.keys().next().value!)
  return made
}

/** The body whole again, then hidden under every worn piece that hides it: each one's regions (Worn.hidden, worked
 * out when it was worn; else tested once by content), the body's triangles in them taken out, whole regions (prevents
 * poke-through, and the body stops at a seam). */
export function hideBodyUnder (view: BodyView, worn: Iterable<Worn>): void {
  const pieces = [...worn].filter(w => w.hidden !== undefined || (w.hides !== undefined && w.hides.length > 0))
  const body = pieces.length === 0 ? null : bodyOf(view)
  const hidden = new Set<number>()
  if (body !== null) {
    for (const w of pieces) {
      if (w.hits === undefined && w.hides !== undefined) w.hits = hitsBy(body, view, w.hides)
      for (const r of w.hidden ?? hiddenAt(w.hits!, body.regions.vertices, w.hideShare ?? HIDE_SHARE)) hidden.add(r)
    }
  }
  if (hidden.size === 0 || body === null) { restoreBody(view); return }
  const key = [...hidden].sort((a, b) => a - b).join(',')
  for (const [k, mesh] of body.meshes.entries()) {
    const full = fullIndexOf(mesh)
    if (full === null) continue
    const next = indexWithout(mesh, full, body.offsets[k], body.regions, hidden, key)
    if (mesh.geometry.index !== next) mesh.geometry.setIndex(next)
  }
}

function restoreBody (view: BodyView): void {
  for (const mesh of view.skinned) {
    const full = mesh.userData.fullIndex as THREE.BufferAttribute | null | undefined
    if (full !== undefined && full !== null && mesh.geometry.index !== full) mesh.geometry.setIndex(full)
  }
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
  /** The body regions it hides (at its share), worked out when it was worn (derived data): hideBodyUnder takes these
   * and tests nothing. */
  hidden?: number[]
  /** Body vertices covered in each region, before applying the hiding threshold. */
  hits?: Int32Array
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
  /** Where a skin piece's derived data (weights, what it covers) is kept between pages (workers/derive.ts): read
   * before working it out, written after. Left out: this page's memory only. */
  derived?: DerivedStore
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
  // skin: the body's weights under each vertex (derived off the main thread, or known), then what was painted; spot:
  // every vertex its spot's weights
  const meshes = await meshesOf(o.url, g, placed)
  const hides = a.kind === 'skin' && a.hideBody === true && g.role !== 'hair'
  const [derived, edits] = await Promise.all([
    a.kind === 'skin' ? derive(bodyCore(body, view), meshes.map(m => meshCore(m.geometry)), { policy: a.policy, cover: hides, store: o.derived, label: g.name }) : null,
    a.kind === 'skin' && (g.painted ?? 0) > 0 && o.edits !== undefined ? o.edits().catch(() => []) : [],
  ])
  const spot = a.kind === 'spot' ? spotWeights(body, partSpot(a, meshes)) : null
  const boneNames = skeleton.bones.map(b => b.name)
  const shown: THREE.SkinnedMesh[] = []
  for (const [i, m] of meshes.entries()) {
    const { indices, weights } = derived !== null ? derived.weights[i] : partWeights(m.geometry.attributes.position.count, spot!)
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
  const share = hideShareOf(g)
  return {
    gear: g.id, node: null, meshes: shown, objects: shown,
    ...(hides ? { hides: shown.map(m => m.geometry), hideShare: share, ...(derived?.hits != null ? { hits: derived.hits, hidden: hiddenAt(derived.hits, body.regions.vertices, share) } : {}) } : {}),
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
