// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ dir: '' }))
vi.mock('./workspace.ts', () => ({ characterDir: () => state.dir }))
import { dropShapeEdits, keepShapeEdits, shapeEdits, shapeReferences, writeShapes, type ShapeEdit } from './shapes.ts'

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

  it('resolves and forgets lifts on reordered vertices and every split seam copy', async () => {
    const edit: ShapeEdit = { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .25] }
    await keepShapeEdits('x', [edit])
    await writeFile(file('fresh.glb'), glb([[.5, .5, 0], [0, 1, .1], [0, 0, 0], [0, 1, .1]]))
    await writeShapes(file('fresh.glb'), [edit])
    const before = await readFile(file('fresh.glb'))
    const resolved = await shapeReferences('x', file('fresh.glb'))
    expect(resolved.map(e => e.vertex)).toEqual([1, 3])
    expect(resolved.every(e => e.from[2] === .1 && e.to[2] === .25)).toBe(true)
    expect(await readFile(file('fresh.glb'))).toEqual(before)
    expect(await shapeEdits('x')).toEqual([edit])
    expect(await dropShapeEdits('x', file('fresh.glb'))).toBe(2)
    const restored = read(await readFile(file('fresh.glb'))).points
    expect(restored[0]).toEqual([.5, .5, 0])
    expect(restored[1][2]).toBeCloseTo(.1)
    expect(restored[3][2]).toBeCloseTo(.1)
  })

  it('keeps the right origins and latest destinations when new vertex indices reuse older ones', async () => {
    await writeFile(file('shape_edits.json'), JSON.stringify({
      '0:0': { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .2] },
      '0:1': { mesh: 0, vertex: 1, from: [1, 1, .1], to: [1, 1, .2] },
    }))
    await keepShapeEdits('x', [
      { mesh: 0, vertex: 1, from: [0, 1, .1], to: [0, 1, .3] },
      { mesh: 0, vertex: 0, from: [1, 1, .1], to: [1, 1, .4] },
    ], [
      { mesh: 0, vertex: 1, from: [0, 1, .1], to: [0, 1, .2] },
      { mesh: 0, vertex: 0, from: [1, 1, .1], to: [1, 1, .2] },
    ])
    const kept = await shapeEdits('x')
    expect(kept).toHaveLength(2)
    expect(kept.find(e => e.from[0] === 0)).toEqual({ mesh: 0, vertex: 1, from: [0, 1, .1], to: [0, 1, .3] })
    expect(kept.find(e => e.from[0] === 1)).toEqual({ mesh: 0, vertex: 0, from: [1, 1, .1], to: [1, 1, .4] })
    await writeFile(file('fresh.glb'), glb([[1, 1, .1], [0, 1, .1], [0, 0, 0]]))
    expect(await writeShapes(file('fresh.glb'), kept)).toBe(2)
    const current = read(await readFile(file('fresh.glb'))).points
    expect(current[0][2]).toBeCloseTo(.4)
    expect(current[1][2]).toBeCloseTo(.3)
    expect((await shapeReferences('x', file('fresh.glb'))).map(e => e.vertex)).toEqual([0, 1])
  })

  it('does not infer another layer\'s origin merely because its position coincides with a saved destination', async () => {
    await keepShapeEdits('x', [
      { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .25] },
    ])
    await writeFile(file('rigged.glb'), glb([[0, 1, .25], [0, 1, .25], [0, 0, 0]]))
    expect((await shapeReferences('x', file('rigged.glb'))).map(e => e.vertex)).toEqual([0])
    await writeShapes(file('rigged.glb'), [{ mesh: 0, vertex: 1, from: [0, 1, .25], to: [0, 1, .3] }], true, await shapeEdits('x'))
    await keepShapeEdits('x', [{ mesh: 0, vertex: 1, from: [0, 1, .25], to: [0, 1, .3] }])
    const references = await shapeReferences('x', file('rigged.glb'))
    expect(references.find(e => e.vertex === 0)?.from[2]).toBe(.1)
    expect(references.find(e => e.vertex === 1)?.from[2]).toBe(.25)
    expect(await shapeEdits('x')).toHaveLength(2)
  })

  it('does not apply historical-index fallback to an unrelated vertex after re-rig', async () => {
    const edit: ShapeEdit = { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .2] }
    await keepShapeEdits('x', [edit])
    await writeFile(file('rigged.glb'), glb([[0, 1, .2], [0, 1, .1], [0, 0, 0]]))
    await writeShapes(file('rigged.glb'), [edit])
    expect((await shapeReferences('x', file('rigged.glb'))).map(e => e.vertex)).toEqual([1])
    expect(await dropShapeEdits('x', file('rigged.glb'))).toBe(1)
    expect(read(await readFile(file('rigged.glb'))).points[0][2]).toBeCloseTo(.2)
  })

  it('does not seed old addresses over actual re-rig references during a later save', async () => {
    const a: ShapeEdit = { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .3] }
    const b: ShapeEdit = { mesh: 0, vertex: 1, from: [0, 1, .2], to: [0, 1, .3] }
    await keepShapeEdits('x', [a, b])
    await writeFile(file('rigged.glb'), glb([[0, 1, .2], [0, 1, .1], [1, 1, .1], [0, 0, 0]]))
    await writeShapes(file('rigged.glb'), [a, b])
    const references = await shapeReferences('x', file('rigged.glb'))
    const edit: ShapeEdit = { mesh: 0, vertex: 2, from: [1, 1, .1], to: [1, 1, .2] }
    await writeShapes(file('rigged.glb'), [edit], true, await shapeEdits('x'))
    await keepShapeEdits('x', [edit], references)
    const after = await shapeReferences('x', file('rigged.glb'))
    expect(after.find(e => e.vertex === 0)?.from).toEqual(b.from)
    expect(after.find(e => e.vertex === 1)?.from).toEqual(a.from)
  })

  it('retains distinct legacy destination branches from coincident source coordinates', async () => {
    const a: ShapeEdit = { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .2] }
    const b: ShapeEdit = { mesh: 0, vertex: 1, from: [0, 1, .1], to: [0, 1, .3] }
    await writeFile(file('shape_edits.json'), JSON.stringify({ '0:0': a, '0:1': b }))
    await writeFile(file('rigged.glb'), glb([a.to, b.to, [1, 1, .1], [0, 0, 0]]))
    const references = await shapeReferences('x', file('rigged.glb'))
    const edit: ShapeEdit = { mesh: 0, vertex: 2, from: [1, 1, .1], to: [1, 1, .2] }
    await writeShapes(file('rigged.glb'), [edit], true, await shapeEdits('x'))
    await keepShapeEdits('x', [edit], references)
    expect((await shapeReferences('x', file('rigged.glb'))).map(e => e.vertex)).toEqual([0, 1, 2])
    expect(await dropShapeEdits('x', file('rigged.glb'))).toBe(3)
    const restored = read(await readFile(file('rigged.glb'))).points
    expect(restored[0][2]).toBeCloseTo(.1)
    expect(restored[1][2]).toBeCloseTo(.1)
  })

  it('leaves ambiguous coincident-source branches unassigned on a fresh rig', async () => {
    const edits: ShapeEdit[] = [
      { mesh: 0, vertex: 0, from: [0, 1, .1], to: [0, 1, .2] },
      { mesh: 0, vertex: 1, from: [0, 1, .1], to: [0, 1, .3] },
    ]
    await keepShapeEdits('x', edits)
    await writeFile(file('rigged.glb'), glb([[0, 1, .1], [0, 1, .2], [0, 0, 0]]))
    expect(await writeShapes(file('rigged.glb'), edits)).toBe(0)
    expect(await shapeReferences('x', file('rigged.glb'))).toEqual([])
    expect(await shapeEdits('x')).toHaveLength(2)
  })
})
