// The one GLB reader and writer: a binary glTF split into its JSON and its binary chunk, typed views of its accessors,
// its embedded images, and the rest skeleton its skin was bound in. Plain bytes in and out (no fs, no three.js), so the
// server, the tools and the browser share it.
//
// readGlb's `bin` is a view into the bytes it was given: writing through accessor() changes those bytes in place, so a
// caller that only rewrites values (painted weights, optimizer output) can save the original bytes and every other
// byte of the file stays as it was.
import type { Joints } from '../model/types.ts'

export interface GltfNode {
  name?: string
  children?: number[]
  mesh?: number
  skin?: number
  translation?: number[]
  rotation?: number[]
  scale?: number[]
  matrix?: number[]
  [k: string]: unknown
}

export interface GltfAccessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: string
  min?: number[]
  max?: number[]
  sparse?: unknown
  [k: string]: unknown
}

export interface GltfBufferView { buffer: number, byteOffset?: number, byteLength: number, byteStride?: number, [k: string]: unknown }

export interface GltfPrimitive { attributes: Record<string, number>, indices?: number, material?: number, targets?: Array<Record<string, number>>, [k: string]: unknown }

/** The parts of the glTF JSON the kernel reads; everything else is carried through untouched. */
export interface Gltf {
  asset: { version: string, [k: string]: unknown }
  scene?: number
  scenes?: Array<{ nodes?: number[], [k: string]: unknown }>
  nodes?: GltfNode[]
  meshes?: Array<{ name?: string, primitives: GltfPrimitive[], [k: string]: unknown }>
  skins?: Array<{ joints: number[], inverseBindMatrices?: number, skeleton?: number, [k: string]: unknown }>
  accessors?: GltfAccessor[]
  bufferViews?: GltfBufferView[]
  buffers?: Array<{ byteLength: number, uri?: string, [k: string]: unknown }>
  images?: Array<{ name?: string, bufferView?: number, uri?: string, mimeType?: string, [k: string]: unknown }>
  textures?: Array<{ source?: number, [k: string]: unknown }>
  materials?: Array<{ name?: string, pbrMetallicRoughness?: { baseColorTexture?: { index: number } }, [k: string]: unknown }>
  animations?: Array<{
    name?: string
    channels: Array<{ sampler: number, target: { node?: number, path: string } }>
    samplers: Array<{ input: number, output: number, interpolation?: string }>
  }>
  [k: string]: unknown
}

export interface Glb { json: Gltf, bin: Uint8Array | null }

const MAGIC = 0x46546C67 // 'glTF'
const JSON_CHUNK = 0x4E4F534A
const BIN_CHUNK = 0x004E4942

const pad4 = (n: number): number => (n + 3) & ~3

export function readGlb (bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== MAGIC) throw new Error('Not a GLB')
  const end = Math.min(view.getUint32(8, true), bytes.byteLength)
  let json: Gltf | null = null
  let bin: Uint8Array | null = null
  for (let at = 12; at + 8 <= end;) {
    const length = view.getUint32(at, true)
    const type = view.getUint32(at + 4, true)
    const body = bytes.subarray(at + 8, at + 8 + length)
    if (body.byteLength < length) throw new Error('A GLB cut short')
    if (type === JSON_CHUNK && json === null) json = JSON.parse(new TextDecoder().decode(body)) as Gltf
    else if (type === BIN_CHUNK && bin === null) bin = body
    at += 8 + pad4(length)
  }
  if (json === null) throw new Error('A GLB with no JSON chunk')
  return { json, bin }
}

/** The GLB of `json` and `bin`: the JSON padded with spaces, the binary chunk (if any) with zeros. `json` is written
 * as it is (a caller that changed the binary chunk's size sets buffers[0].byteLength). */
export function writeGlb (json: Gltf, bin: Uint8Array | null): Uint8Array {
  const text = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = pad4(text.byteLength)
  const binLength = bin === null ? 0 : pad4(bin.byteLength)
  const total = 12 + 8 + jsonLength + (bin === null ? 0 : 8 + binLength)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint32(0, MAGIC, true); view.setUint32(4, 2, true); view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true); view.setUint32(16, JSON_CHUNK, true)
  out.set(text, 20)
  out.fill(0x20, 20 + text.byteLength, 20 + jsonLength)
  if (bin !== null) {
    const at = 20 + jsonLength
    view.setUint32(at, binLength, true); view.setUint32(at + 4, BIN_CHUNK, true)
    out.set(bin, at + 8)
  }
  return out
}

// ---- accessors ----------------------------------------------------------------------------------------------------

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }
const BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
// (a normalized integer's 1.0)
const ONE: Record<number, number> = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 }
// (what an integer component holds: a value outside is refused, not wrapped into another joint index)
const RANGE: Record<number, [number, number]> = { 5120: [-128, 127], 5121: [0, 255], 5122: [-32768, 32767], 5123: [0, 65535], 5125: [0, 4294967295] }

export interface AccessorView {
  count: number
  /** Components per element (SCALAR 1 … MAT4 16). */
  size: number
  componentType: number
  normalized: boolean
  /** Component k of element i: a normalized integer as 0..1 (signed: -1..1), anything else as stored. */
  get (i: number, k: number): number
  /** Writes component k of element i in the file's own type (a normalized integer from 0..1, rounded; an integer
   * outside its type's range throws). */
  set (i: number, k: number, v: number): void
}

/** A typed view of accessor `index` over the binary chunk, its view's stride respected. Reads and writes go straight
 * to `glb.bin`. Sparse accessors and ones without a buffer view are refused. */
export function accessor (glb: Glb, index: number): AccessorView {
  const a = glb.json.accessors?.[index]
  if (a === undefined) throw new Error(`No accessor ${index}`)
  if (a.sparse !== undefined || a.bufferView === undefined) throw new Error(`Accessor ${index} is sparse or has no buffer view`)
  const bv = glb.json.bufferViews?.[a.bufferView]
  if (bv === undefined || bv.buffer !== 0 || glb.bin === null) throw new Error(`Accessor ${index} is not in the binary chunk`)
  const type = a.componentType
  const bytes = BYTES[type]
  if (bytes === undefined) throw new Error(`Accessor ${index}: component type ${type}`)
  const size = COMPONENTS[a.type] ?? 1
  const normalized = a.normalized === true && ONE[type] !== undefined
  const stride = bv.byteStride ?? bytes * size
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0)
  const data = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength)
  const at = (i: number, k: number): number => base + i * stride + k * bytes
  const raw = (o: number): number => {
    switch (type) {
      case 5120: return data.getInt8(o)
      case 5121: return data.getUint8(o)
      case 5122: return data.getInt16(o, true)
      case 5123: return data.getUint16(o, true)
      case 5125: return data.getUint32(o, true)
      default: return data.getFloat32(o, true)
    }
  }
  const write = (o: number, v: number): void => {
    switch (type) {
      case 5120: data.setInt8(o, v); break
      case 5121: data.setUint8(o, v); break
      case 5122: data.setInt16(o, v, true); break
      case 5123: data.setUint16(o, v, true); break
      case 5125: data.setUint32(o, v, true); break
      default: data.setFloat32(o, v, true)
    }
  }
  const one = ONE[type]
  const low = type === 5120 || type === 5122 ? -one : 0
  const range = RANGE[type] as [number, number] | undefined
  return {
    count: a.count,
    size,
    componentType: type,
    normalized,
    get: (i, k) => normalized ? Math.max(raw(at(i, k)) / one, -1) : raw(at(i, k)),
    set: (i, k, v) => {
      const x = normalized ? Math.min(Math.max(Math.round(v * one), low), one) : v
      if (range !== undefined && !(x >= range[0] && x <= range[1])) throw new Error(`Accessor ${index}: ${v} doesn't fit component type ${type}`)
      write(at(i, k), x)
    },
  }
}

// ---- images -------------------------------------------------------------------------------------------------------

/** An embedded image's bytes (a view into the binary chunk), or null for one by uri. */
export function imageBytes (glb: Glb, index: number): Uint8Array | null {
  const image = glb.json.images?.[index]
  if (image?.bufferView === undefined || glb.bin === null) return null
  const v = glb.json.bufferViews![image.bufferView]
  return glb.bin.subarray(v.byteOffset ?? 0, (v.byteOffset ?? 0) + v.byteLength)
}

/** The image the first base colour texture shows (a source with normal or roughness maps embeds those too), else the
 * first embedded image; null without one. */
export function baseColorImage (glb: Glb): number | null {
  const { materials, textures, images } = glb.json
  const texture = materials?.find(m => m.pbrMetallicRoughness?.baseColorTexture !== undefined)?.pbrMetallicRoughness?.baseColorTexture?.index
  const source = texture !== undefined ? textures?.[texture]?.source : undefined
  if (source !== undefined) return images?.[source]?.bufferView !== undefined ? source : null
  const first = images?.findIndex(i => i.bufferView !== undefined) ?? -1
  return first >= 0 ? first : null
}

/** Put `bytes` in place of embedded image `index`: the binary chunk is laid out again (its views in their order, each
 * 4-byte aligned), `glb.bin` replaced and buffers[0].byteLength set. */
export function setImageBytes (glb: Glb, index: number, bytes: Uint8Array, mimeType = 'image/png'): void {
  const image = glb.json.images?.[index]
  if (image?.bufferView === undefined || glb.bin === null) throw new Error(`Image ${index} is not embedded`)
  const views = glb.json.bufferViews!
  const old = glb.bin
  const order = views.map((_, i) => i).filter(i => views[i].buffer === 0)
    .sort((a, b) => (views[a].byteOffset ?? 0) - (views[b].byteOffset ?? 0))
  const pieces = order.map(i => i === image.bufferView ? bytes : old.subarray(views[i].byteOffset ?? 0, (views[i].byteOffset ?? 0) + views[i].byteLength))
  let at = 0
  for (const [n, i] of order.entries()) {
    at = pad4(at)
    views[i].byteOffset = at
    views[i].byteLength = pieces[n].byteLength
    at += pieces[n].byteLength
  }
  const bin = new Uint8Array(pad4(at))
  for (const [n, i] of order.entries()) bin.set(pieces[n], views[i].byteOffset)
  glb.bin = bin
  glb.json.buffers![0].byteLength = bin.byteLength
  image.mimeType = mimeType
}

// ---- skeleton -----------------------------------------------------------------------------------------------------

/** Where each joint's head was when the skin was bound (its inverse bind matrix taken back), by node name, in the
 * file's own space: the space character joints are in. A joint in several skins keeps its first; skins without
 * inverse binds and degenerate (zero-scale) matrices add nothing. */
export function bindJoints (glb: Glb): Joints {
  const out: Joints = {}
  const nodes = glb.json.nodes ?? []
  for (const skin of glb.json.skins ?? []) {
    if (skin.inverseBindMatrices === undefined) continue
    const ibm = accessor(glb, skin.inverseBindMatrices)
    skin.joints.forEach((node, j) => {
      const name = nodes[node]?.name
      if (name === undefined || Object.hasOwn(out, name)) return
      // (column-major: M = [A t]; the head p is what M takes to the joint's origin, A·p + t = 0)
      const m = (k: number): number => ibm.get(j, k)
      const head = solve3([[m(0), m(4), m(8)], [m(1), m(5), m(9)], [m(2), m(6), m(10)]], [-m(12), -m(13), -m(14)])
      if (head !== null) out[name] = head
    })
  }
  return out
}

/** x with a·x = b (Cramer's rule; a 3×3 row-major), or null when a is singular. */
function solve3 (a: number[][], b: number[]): [number, number, number] | null {
  const det = (m: number[][]): number =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const d = det(a)
  if (Math.abs(d) < 1e-12) return null
  const column = (c: number): number[][] => a.map((row, r) => row.map((v, k) => k === c ? b[r] : v))
  return [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d]
}
