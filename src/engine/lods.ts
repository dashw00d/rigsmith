// Simplified copies of a skinned mesh: the game unit's levels (<unit>_LOD1, _LOD2) and a body brought within its
// triangle budget. Fewer vertices to skin as well as fewer triangles; every attribute, skin included, follows the
// vertices kept.
import * as THREE from 'three'
import { MeshoptSimplifier } from 'meshoptimizer'

/** Resolves once the simplifier has loaded: await it before the first simplify. */
export const ready: Promise<void> = MeshoptSimplifier.ready

export function triangles (geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3
}

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

/** Lock both copies of a UV seam. A small LOD0 budget trim must not move a
 * vertex from one packed chart into another, even when their 3D points coincide. */
export function uvSeamLock (geometry: THREE.BufferGeometry): Uint8Array | undefined {
  const uv = geometry.attributes.uv
  if (uv === undefined) return undefined
  const p = geometry.attributes.position
  const groups = new Map<string, number[]>()
  for (let v = 0; v < p.count; v++) {
    const key = `${p.getX(v)},${p.getY(v)},${p.getZ(v)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [v])
    else group.push(v)
  }
  const lock = new Uint8Array(p.count)
  for (const group of groups.values()) {
    const first = group[0]
    if (group.some(v => uv.getX(v) !== uv.getX(first) || uv.getY(v) !== uv.getY(first))) {
      for (const v of group) lock[v] = 1
    }
  }
  return lock
}

/** Simplify a geometry to about `ratio` of its triangles, keeping UV seams and shading. `lock` (one byte per vertex)
 * marks vertices kept where they are: a pulled strand's ring, which left free collapses back into the straight strand
 * that then can't bend. Needs `ready`. */
export function simplify (geometry: THREE.BufferGeometry, ratio: number, lock?: Uint8Array): THREE.BufferGeometry {
  const count = geometry.attributes.position.count
  const positions = attributeArray(geometry.attributes.position)
  const source = geometry.index !== null ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: count }, (_, i) => i)
  const target = Math.max(3, Math.floor(source.length * ratio / 3) * 3)
  const parts: Array<{ data: Float32Array, size: number, weight: number }> = []
  if (geometry.attributes.normal !== undefined) parts.push({ data: attributeArray(geometry.attributes.normal), size: 3, weight: 0.5 })
  // UVs weigh 4x: fewer triangles spanning two texture charts (smears) for a small shape cost.
  if (geometry.attributes.uv !== undefined) parts.push({ data: attributeArray(geometry.attributes.uv), size: 2, weight: 4 })
  let indices: Uint32Array
  if (parts.length > 0 || lock !== undefined) {
    // (only the attribute simplifier takes a lock: without attributes it gets one weightless zero)
    const stride = Math.max(1, parts.reduce((s, p) => s + p.size, 0))
    const attributes = new Float32Array(count * stride)
    for (let v = 0; v < count; v++) {
      let o = v * stride
      for (const p of parts) for (let k = 0; k < p.size; k++) attributes[o++] = p.data[v * p.size + k]
    }
    const weights = parts.length > 0 ? parts.flatMap(p => new Array<number>(p.size).fill(p.weight)) : [0]
    // Permissive: AI meshes are cut into many UV charts, and without it simplification stalls at the
    // seams (~45% on a Tripo character); with it, collapses may cross seams when the UV/normal error
    // allows, reaching 25% / 12% at a third of the error.
    ;[indices] = MeshoptSimplifier.simplifyWithAttributes(source, positions, 3, attributes, stride, weights, lock ?? null, target, 1, ['Permissive'])
  } else {
    ;[indices] = MeshoptSimplifier.simplify(source, positions, 3, target, 1, ['Permissive'])
  }
  return compact(geometry, indices)
}
