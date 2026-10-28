// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { accessor, baseColorImage, bindJoints, imageBytes, readGlb, setImageBytes, writeGlb, type Gltf, type GltfBufferView } from './glb.ts'

/** Two joints' world matrices at bind: one moved, one moved, turned and scaled. */
const WORLD = [
  new THREE.Matrix4().makeTranslation(0.1, 0.9, -0.05),
  new THREE.Matrix4().compose(new THREE.Vector3(-0.3, 1.4, 0.2), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.4, -0.7, 1.1)), new THREE.Vector3(1.3, 1.3, 1.3)),
]

/** A tiny skinned GLB: positions and normals interleaved (stride 24), u8 joints, u8 normalized weights, inverse binds,
 * a 5-byte image (not a multiple of 4), then i8 normalized data after it. */
function tiny (): { json: Gltf, bin: Uint8Array } {
  const pieces: Uint8Array[] = []
  const views: GltfBufferView[] = []
  let at = 0
  const add = (bytes: Uint8Array, stride?: number): number => {
    at = (at + 3) & ~3
    views.push({ buffer: 0, byteOffset: at, byteLength: bytes.byteLength, ...(stride !== undefined ? { byteStride: stride } : {}) })
    pieces.push(bytes)
    at += bytes.byteLength
    return views.length - 1
  }
  const interleaved = new Float32Array([0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 1, 0, 0])
  const pn = add(new Uint8Array(interleaved.buffer), 24)
  const joints = add(Uint8Array.from([0, 1, 0, 0, 1, 0, 0, 0]))
  const weights = add(Uint8Array.from([255, 0, 0, 0, 128, 127, 0, 0]))
  const ibm = add(new Uint8Array(new Float32Array(WORLD.flatMap(m => m.clone().invert().toArray())).buffer))
  const image = add(Uint8Array.from([1, 2, 3, 4, 5]))
  const signed = add(Uint8Array.from([0x80, 0x7f, 0x00, 0xc0]))
  const bin = new Uint8Array((at + 3) & ~3)
  pieces.forEach((p, i) => { bin.set(p, views[i].byteOffset) })
  const json: Gltf = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, skin: 0 }, { name: 'Hips', children: [2] }, { name: 'Spine' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, JOINTS_0: 2, WEIGHTS_0: 3 }, material: 0 }] }],
    skins: [{ joints: [1, 2], inverseBindMatrices: 4 }],
    accessors: [
      { bufferView: pn, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: pn, byteOffset: 12, componentType: 5126, count: 3, type: 'VEC3' },
      { bufferView: joints, componentType: 5121, count: 2, type: 'VEC4' },
      { bufferView: weights, componentType: 5121, normalized: true, count: 2, type: 'VEC4' },
      { bufferView: ibm, componentType: 5126, count: 2, type: 'MAT4' },
      { bufferView: signed, componentType: 5120, normalized: true, count: 4, type: 'SCALAR' },
    ],
    bufferViews: views,
    buffers: [{ byteLength: bin.byteLength }],
    images: [{ name: 'skin', bufferView: image, mimeType: 'image/jpeg' }],
    textures: [{ source: 0 }],
    materials: [{ name: 'Main', pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
  }
  return { json, bin }
}

const viewBytes = (json: Gltf, bin: Uint8Array, v: number): number[] => {
  const view = json.bufferViews![v]
  return [...bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)]
}

describe('glb', () => {
  it('round-trips a GLB: the same JSON and binary chunk, chunks 4-byte aligned', () => {
    const { json, bin } = tiny()
    const bytes = writeGlb(json, bin)
    const dv = new DataView(bytes.buffer)
    expect(dv.getUint32(0, true)).toBe(0x46546C67)
    expect(dv.getUint32(8, true)).toBe(bytes.byteLength)
    expect(dv.getUint32(12, true) % 4).toBe(0)
    const back = readGlb(bytes)
    expect(back.json).toEqual(json)
    expect([...back.bin!]).toEqual([...bin])
    // (written again: byte for byte the same)
    expect([...writeGlb(back.json, back.bin)]).toEqual([...bytes])
  })

  it('writes a GLB without a binary chunk', () => {
    const back = readGlb(writeGlb({ asset: { version: '2.0' }, nodes: [{ name: 'a' }] }, null))
    expect(back.bin).toBeNull()
    expect(back.json.nodes).toEqual([{ name: 'a' }])
  })

  it('refuses what is not a GLB', () => {
    expect(() => readGlb(new TextEncoder().encode('{"asset":{"version":"2.0"}}'))).toThrow('Not a GLB')
  })

  it('reads and writes strided floats in place, leaving their neighbours alone', () => {
    const { json, bin } = tiny()
    const bytes = writeGlb(json, bin)
    const glb = readGlb(bytes)
    const position = accessor(glb, 0); const normal = accessor(glb, 1)
    expect(position.size).toBe(3)
    expect([0, 1, 2].map(k => position.get(1, k))).toEqual([1, 0, 0])
    expect([0, 1, 2].map(k => normal.get(2, k))).toEqual([1, 0, 0])
    position.set(1, 1, 0.25)
    expect(position.get(1, 1)).toBe(0.25)
    expect([0, 1, 2].map(k => normal.get(1, k))).toEqual([0, 0, 1])
    // (bin is a view of the bytes read: the file's own bytes changed, nothing else)
    expect(accessor(readGlb(bytes), 0).get(1, 1)).toBe(0.25)
  })

  it('normalizes integer components both ways', () => {
    const { json, bin } = tiny()
    const glb = readGlb(writeGlb(json, bin))
    const joints = accessor(glb, 2); const weights = accessor(glb, 3); const signed = accessor(glb, 5)
    expect(joints.normalized).toBe(false)
    expect([0, 1].map(k => joints.get(0, k))).toEqual([0, 1])
    expect(weights.get(0, 0)).toBe(1)
    expect(weights.get(1, 0)).toBeCloseTo(128 / 255, 6)
    weights.set(1, 0, 0.5); weights.set(1, 1, 0.5)
    expect(weights.get(1, 0)).toBeCloseTo(128 / 255, 6)
    weights.set(1, 2, 1.7)
    expect(weights.get(1, 2)).toBe(1)
    joints.set(1, 3, 7)
    expect(joints.get(1, 3)).toBe(7)
    // (an index the type can't hold is refused, not wrapped onto another joint)
    expect(() => { joints.set(1, 3, 300) }).toThrow()
    expect(joints.get(1, 3)).toBe(7)
    // (signed: -128 and -127 are both -1)
    expect([0, 1, 2, 3].map(i => signed.get(i, 0))).toEqual([-1, 1, 0, -64 / 127])
  })

  it('swaps an embedded image, every other view keeping its bytes', () => {
    const { json, bin } = tiny()
    const glb = readGlb(writeGlb(json, bin))
    expect(baseColorImage(glb)).toBe(0)
    expect([...imageBytes(glb, 0)!]).toEqual([1, 2, 3, 4, 5])
    const before = json.bufferViews!.map((_, v) => viewBytes(json, bin, v))
    const painted = Uint8Array.from({ length: 23 }, (_, i) => 100 + i)
    setImageBytes(glb, 0, painted)
    const back = readGlb(writeGlb(glb.json, glb.bin))
    expect([...imageBytes(back, 0)!]).toEqual([...painted])
    expect(back.json.images![0].mimeType).toBe('image/png')
    expect(back.json.buffers![0].byteLength).toBe(back.bin!.byteLength)
    back.json.bufferViews!.forEach((view, v) => {
      expect((view.byteOffset ?? 0) % 4).toBe(0)
      if (v !== json.images![0].bufferView) expect(viewBytes(back.json, back.bin!, v)).toEqual(before[v])
    })
    // (the accessors still read what they did)
    expect(accessor(back, 5).get(1, 0)).toBe(1)
  })

  it('finds the rest skeleton from the inverse binds', () => {
    const { json, bin } = tiny()
    const joints = bindJoints(readGlb(writeGlb(json, bin)))
    expect(Object.keys(joints)).toEqual(['Hips', 'Spine'])
    WORLD.forEach((m, i) => {
      const head = new THREE.Vector3().setFromMatrixPosition(m)
      const got = joints[i === 0 ? 'Hips' : 'Spine']
      got.forEach((v, k) => { expect(v).toBeCloseTo(head.getComponent(k), 5) })
    })
  })
})
