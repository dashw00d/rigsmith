// Distance LODs for exported characters: simplified copies of every skinned mesh, bound to the same
// skeleton and sharing its material, with fewer vertices to skin as well as fewer triangles.
// In Godot they switch by visibility range (godot/rigsmith_lods.gd reads the distances from extras).
import * as THREE from 'three'
import { MeshoptSimplifier } from 'meshoptimizer'

/** Share of the original triangles kept per level. */
export const LOD_RATIOS = [0.5, 0.25, 0.12]
/** Where each level takes over, in character heights (12, 25, 50 m for a 1 m unit). */
export const LOD_DISTANCES = [12, 25, 50]

function attributeArray (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array {
  const out = new Float32Array(attr.count * attr.itemSize)
  for (let i = 0; i < attr.count; i++) for (let k = 0; k < attr.itemSize; k++) out[i * attr.itemSize + k] = attr.getComponent(i, k)
  return out
}

/** Keep only the vertices `indices` uses; every attribute (skin included) follows. */
export function compact (geometry: THREE.BufferGeometry, indices: Uint32Array): THREE.BufferGeometry {
  const remap = new Int32Array(geometry.attributes.position.count).fill(-1)
  const order: number[] = []
  const index = new Uint32Array(indices.length)
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i]
    if (remap[v] < 0) { remap[v] = order.length; order.push(v) }
    index[i] = remap[v]
  }
  const out = new THREE.BufferGeometry()
  for (const [name, attr] of Object.entries(geometry.attributes)) {
    const size = attr.itemSize
    const source = attr as THREE.BufferAttribute
    const Ctor = (source.array?.constructor ?? Float32Array) as new (n: number) => THREE.TypedArray
    const array = new Ctor(order.length * size)
    for (let i = 0; i < order.length; i++) for (let k = 0; k < size; k++) array[i * size + k] = attr.getComponent(order[i], k)
    out.setAttribute(name, new THREE.BufferAttribute(array, size, attr.normalized))
  }
  out.setIndex(new THREE.BufferAttribute(order.length > 65535 ? index : Uint16Array.from(index), 1))
  out.computeBoundingBox()
  out.computeBoundingSphere()
  return out
}

/** Simplify a geometry to about `ratio` of its triangles, keeping UV seams and shading. */
export function simplify (geometry: THREE.BufferGeometry, ratio: number): THREE.BufferGeometry {
  const positions = attributeArray(geometry.attributes.position)
  const source = geometry.index !== null ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i)
  const target = Math.max(3, Math.floor(source.length * ratio / 3) * 3)
  const parts: Array<{ data: Float32Array, size: number, weight: number }> = []
  if (geometry.attributes.normal !== undefined) parts.push({ data: attributeArray(geometry.attributes.normal), size: 3, weight: 0.5 })
  // UVs weigh 4x: fewer triangles spanning two texture charts (smears) for a small shape cost.
  if (geometry.attributes.uv !== undefined) parts.push({ data: attributeArray(geometry.attributes.uv), size: 2, weight: 4 })
  let indices: Uint32Array
  if (parts.length > 0) {
    const stride = parts.reduce((s, p) => s + p.size, 0)
    const count = geometry.attributes.position.count
    const attributes = new Float32Array(count * stride)
    for (let v = 0; v < count; v++) {
      let o = v * stride
      for (const p of parts) for (let k = 0; k < p.size; k++) attributes[o++] = p.data[v * p.size + k]
    }
    const weights = parts.flatMap(p => new Array<number>(p.size).fill(p.weight))
    // Permissive: AI meshes are cut into many UV charts, and without it simplification stalls at the
    // seams (~45% on a Tripo character); with it, collapses may cross seams when the UV/normal error
    // allows, reaching 25% / 12% at a third of the error.
    ;[indices] = MeshoptSimplifier.simplifyWithAttributes(source, positions, 3, attributes, stride, weights, null, target, 1, ['Permissive'])
  } else {
    ;[indices] = MeshoptSimplifier.simplify(source, positions, 3, target, 1, ['Permissive'])
  }
  return compact(geometry, indices)
}

/**
 * Add LOD levels next to every skinned mesh under `root`: <name>_LOD1.. with extras
 * { lod, lodBegin, lodEnd } in metres (lodEnd 0 = no limit); the original gets { lod: 0, lodEnd }.
 */
export async function addLods (root: THREE.Object3D, levels: number, height: number): Promise<void> {
  if (levels <= 0) return
  await MeshoptSimplifier.ready
  const meshes: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh) })
  const distance = (level: number): number => level === 0 ? 0 : level > levels ? 0 : Math.round(LOD_DISTANCES[level - 1] * height * 10) / 10
  for (const mesh of meshes) {
    mesh.userData = { ...mesh.userData, lod: 0, lodBegin: 0, lodEnd: distance(1) }
    for (let level = 1; level <= Math.min(levels, LOD_RATIOS.length); level++) {
      const lod = new THREE.SkinnedMesh(simplify(mesh.geometry, LOD_RATIOS[level - 1]), mesh.material)
      lod.name = `${mesh.name}_LOD${level}`
      lod.position.copy(mesh.position)
      lod.quaternion.copy(mesh.quaternion)
      lod.scale.copy(mesh.scale)
      lod.userData = { lod: level, lodBegin: distance(level), lodEnd: distance(level + 1) }
      mesh.parent!.add(lod)
      lod.bind(mesh.skeleton, mesh.bindMatrix)
    }
  }
}
