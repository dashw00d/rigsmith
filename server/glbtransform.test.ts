// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { extentY, transformedGlb, transformGlb } from './glbtransform.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-glbtransform-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A skinned GLB as our rigs are: an Armature (identity) holding the mesh and a root bone with a child bone. */
function rig (): { glb: Buffer, verts: number[][], root: { t: number[], q: number[] }, child: { t: number[], q: number[] } } {
  const verts = [[0.1, -0.5, 0.0], [0.2, 0.4, 0.1], [-0.1, 0.0, 0.3]]
  const root = { t: [0.0, -0.1, 0.05], q: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, 0.2, -0.1)).toArray() }
  const child = { t: [0.0, 0.3, 0.0], q: new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.4, 0.1, 0.2)).toArray() }
  const w0 = new THREE.Matrix4().compose(new THREE.Vector3(...root.t), new THREE.Quaternion(...root.q), new THREE.Vector3(1, 1, 1))
  const w1 = w0.clone().multiply(new THREE.Matrix4().compose(new THREE.Vector3(...child.t), new THREE.Quaternion(...child.q), new THREE.Vector3(1, 1, 1)))
  const ibm = [w0.clone().invert(), w1.clone().invert()].flatMap(m => m.toArray())
  const pos = new Float32Array(verts.flat()); const inv = new Float32Array(ibm)
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(inv.buffer)])
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ name: 'Armature', children: [1, 2] }, { name: 'Mesh', mesh: 0, skin: 0 }, { name: 'root', translation: root.t, rotation: root.q, children: [3] }, { name: 'child', translation: child.t, rotation: child.q }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    skins: [{ joints: [2, 3], inverseBindMatrices: 1 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [-0.1, -0.5, 0], max: [0.2, 0.4, 0.3] }, { bufferView: 1, componentType: 5126, count: 2, type: 'MAT4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: inv.byteLength }],
    buffers: [{ byteLength: bin.length }],
  }
  let json = Buffer.from(JSON.stringify(gltf)); if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)])
  const out = Buffer.alloc(28 + json.length + bin.length)
  out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(out, 28 + json.length)
  return { glb: out, verts, root, child }
}

/** Where each vertex lands with the bones turned (skinned to bone `k` by `weights`), as glTF skins it: W·IBM·v. */
function skinned (glb: Buffer, turn: THREE.Quaternion): THREE.Vector3[] {
  const n = glb.readUInt32LE(12); const g = JSON.parse(glb.subarray(20, 20 + n).toString()); const bin = glb.subarray(28 + n)
  const f = (i: number): number[] => { const a = g.accessors[i]; const v = g.bufferViews[a.bufferView]; return Array.from(new Float32Array(bin.buffer.slice(bin.byteOffset + v.byteOffset, bin.byteOffset + v.byteOffset + v.byteLength))) }
  const pos = f(0); const ibm = f(1)
  const local = (node: { translation: number[], rotation: number[] }, extra = new THREE.Quaternion()): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(...node.translation), new THREE.Quaternion(...node.rotation).multiply(extra), new THREE.Vector3(1, 1, 1))
  const w0 = local(g.nodes[2]); const w1 = w0.clone().multiply(local(g.nodes[3], turn))
  const m = new THREE.Matrix4().fromArray(ibm.slice(16, 32))
  return [0, 1, 2].map(i => new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]).applyMatrix4(w1.clone().multiply(m)))
}

describe('a rig resized and moved in place', () => {
  it('skins every pose exactly as before, resized and moved', async () => {
    const { glb } = rig()
    const file = path.join(dir, 'rigged.glb')
    await writeFile(file, glb)
    const s = 1.7; const d: [number, number, number] = [0, 0.85, 0]
    const turn = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.6, -0.2, 0.4))
    const before = skinned(glb, turn)
    await transformGlb(file, s, d)
    const after = skinned(await readFile(file), turn)
    after.forEach((p, i) => expect(p.distanceTo(before[i].clone().multiplyScalar(s).add(new THREE.Vector3(...d)))).toBeLessThan(1e-5))
    expect(extentY(await readFile(file)).min).toBeCloseTo(-0.5 * s + 0.85, 5)
  })

  it('moves an unskinned model by its top nodes', async () => {
    const { glb } = rig()
    const n = glb.readUInt32LE(12); const g = JSON.parse(glb.subarray(20, 20 + n).toString())
    expect(extentY(glb).min).toBeCloseTo(-0.5, 6)
    delete g.skins; delete g.nodes[1].skin
    const json = Buffer.from(JSON.stringify(g).padEnd(Math.ceil(JSON.stringify(g).length / 4) * 4, ' '))
    const bin = glb.subarray(28 + n)
    const out = Buffer.alloc(28 + json.length + bin.length)
    out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8); out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
    out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(out, 28 + json.length)
    const file = path.join(dir, 'model.glb')
    await writeFile(file, out)
    await transformGlb(file, 2, [0, 1, 0])
    expect(extentY(await readFile(file)).min).toBeCloseTo(0, 6)
  })

  it('leaves the bytes it was given as they were, and refuses a rig whose clips move its bones', () => {
    const { glb } = rig()
    const copy = Buffer.from(glb)
    const out = transformedGlb(glb, 2, [0, 1, 0])
    expect(Buffer.compare(glb, copy)).toBe(0)
    expect(extentY(out).min).toBeCloseTo(0, 6)
    const n = glb.readUInt32LE(12); const g = JSON.parse(glb.subarray(20, 20 + n).toString())
    g.animations = [{ channels: [{ sampler: 0, target: { node: 3, path: 'translation' } }], samplers: [{ input: 0, output: 0 }] }]
    const json = Buffer.from(JSON.stringify(g).padEnd(Math.ceil(JSON.stringify(g).length / 4) * 4, ' '))
    const bin = glb.subarray(28 + n)
    const moved = Buffer.alloc(28 + json.length + bin.length)
    moved.writeUInt32LE(0x46546C67, 0); moved.writeUInt32LE(2, 4); moved.writeUInt32LE(moved.length, 8); moved.writeUInt32LE(json.length, 12); moved.writeUInt32LE(0x4E4F534A, 16); json.copy(moved, 20)
    moved.writeUInt32LE(bin.length, 20 + json.length); moved.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(moved, 28 + json.length)
    expect(() => transformedGlb(moved, 2, [0, 0, 0])).toThrow(/not resized in place/)
  })
})
