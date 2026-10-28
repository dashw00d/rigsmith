// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('./workspace.ts', () => ({ characterDir: () => state.dir }))
import { dropShapeEdits, keepShapeEdits, shapeEdits, writeShapes, type ShapeEdit } from './shapes.ts'

beforeEach(async () => { state.dir = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-shapes-')) })
afterEach(async () => { await rm(state.dir, { recursive: true, force: true }) })

// A GLB of one skinned primitive with these vertex positions (float, tightly packed).
function glb (points: number[][]): Buffer {
  const bin = Buffer.alloc(points.length * 12)
  points.forEach((p, v) => p.forEach((x, k) => bin.writeFloatLE(x, v * 12 + k * 4)))
  const gltf = {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'body', mesh: 0, skin: 0 }, { name: 'Hips' }],
    skins: [{ joints: [1] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: points.length, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 1] }],
  }
  const json = Buffer.from(JSON.stringify(gltf).padEnd(Math.ceil(JSON.stringify(gltf).length / 4) * 4, ' '))
  const out = Buffer.alloc(12 + 8 + json.length + 8 + bin.length)
  out.write('glTF', 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(out, 28 + json.length)
  return out
}
function read (b: Buffer): { points: number[][], min: number[], max: number[] } {
  const n = b.readUInt32LE(12); const g = JSON.parse(b.subarray(20, 20 + n).toString()) as { accessors: Array<{ count: number, min: number[], max: number[] }> }
  const bin = 28 + n
  return { points: Array.from({ length: g.accessors[0].count }, (_, v) => [0, 1, 2].map(k => b.readFloatLE(bin + v * 12 + k * 4))), min: g.accessors[0].min, max: g.accessors[0].max }
}
const file = (name: string): string => path.join(state.dir, name)

describe('lifted skin', () => {
  it('writes a lift where the app painted it, the bounds following', async () => {
    await writeFile(file('rigged.glb'), glb([[0, 0, 0], [0, 1, 0.1], [0.5, 0.5, 0]]))
    expect(await writeShapes(file('rigged.glb'), [{ mesh: 0, vertex: 1, from: [0, 1, 0.1], to: [0, 1, 0.3] }], true)).toBe(1)
    const r = read(await readFile(file('rigged.glb')))
    expect(r.points[1][2]).toBeCloseTo(0.3)
    expect(r.max[2]).toBeCloseTo(0.3)
    expect(r.points[0]).toEqual([0, 0, 0])
  })

  it('finds a lift\'s vertices on a fresh rig by where they were, whatever their order (a split seam\'s every copy)', async () => {
    await writeFile(file('fresh.glb'), glb([[0.5, 0.5, 0], [0, 1, 0.1], [0, 0, 0], [0, 1, 0.1]]))
    const lifts: ShapeEdit[] = [{ mesh: 0, vertex: 0, from: [0, 1, 0.1], to: [0, 1, 0.25] }]
    expect(await writeShapes(file('fresh.glb'), lifts)).toBe(2)
    const r = read(await readFile(file('fresh.glb')))
    expect(r.points[1][2]).toBeCloseTo(0.25); expect(r.points[3][2]).toBeCloseTo(0.25)
    expect(r.points[0]).toEqual([0.5, 0.5, 0])
    // (a vertex nowhere near where it was lifted from is left)
    expect(await writeShapes(file('fresh.glb'), [{ mesh: 0, vertex: 0, from: [9, 9, 9], to: [0, 0, 0] }])).toBe(0)
  })

  it('keeps where a vertex first was through later lifts, and forgetting puts it back', async () => {
    await writeFile(file('rigged.glb'), glb([[0, 0, 0], [0, 1, 0.1]]))
    await keepShapeEdits('x', [{ mesh: 0, vertex: 1, from: [0, 1, 0.1], to: [0, 1, 0.2] }])
    await keepShapeEdits('x', [{ mesh: 0, vertex: 1, from: [0, 1, 0.2], to: [0, 1, 0.3] }])
    expect(await shapeEdits('x')).toEqual([{ mesh: 0, vertex: 1, from: [0, 1, 0.1], to: [0, 1, 0.3] }])
    await writeShapes(file('rigged.glb'), await shapeEdits('x'), true)
    expect(await dropShapeEdits('x', file('rigged.glb'))).toBe(1)
    expect(read(await readFile(file('rigged.glb'))).points[1][2]).toBeCloseTo(0.1)
    expect(await shapeEdits('x')).toEqual([])
  })
})
