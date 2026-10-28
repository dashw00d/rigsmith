// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const state = vi.hoisted(() => ({ dir:'', onRename: null as ((to: string) => void) | null }))
vi.mock('./store.ts',() => ({ characterDir:() => state.dir }))
// (rename through a hook: a test can watch the order of the moves, or make one fail)
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => { state.onRename?.(to); await fs.rename(from, to) }
  return { ...fs, rename, default: { ...fs, rename } }
})
import { checkEdits, dropWeightEdits, keepWeightEdits, publishRig, savePainting, skinnedParts, weightEdits, writeWeights } from './weights.ts'
import { accessor, type Glb, readGlb, writeGlb } from '../src/engine/glb.ts'

beforeEach(async () => { state.dir = await mkdtemp(path.join(os.tmpdir(),'rigsmith-paint-publish-')) })
afterEach(async () => { state.onRename = null; await rm(state.dir,{recursive:true,force:true}) })
const file = (name: string): string => path.join(state.dir,name)
const painting = [{mesh:0,vertex:5,weights:[['Hand',1]] as Array<[string,number]>}]

describe('rig and paint publication', () => {
  it('publishes the remapped paint record with the new rig and clears stale addresses', async () => {
    await writeFile(file('rigged.glb'),'old rig')
    await writeFile(file('weight_edits.json'),'{"0:2":{"mesh":0,"vertex":2,"weights":[["Hand",1]]}}')
    await writeFile(file('candidate.glb'),'new rig')
    await publishRig('test',file('candidate.glb'),file('rigged.glb'),painting)
    expect(await readFile(file('rigged.glb'),'utf8')).toBe('new rig')
    expect(JSON.parse(await readFile(file('weight_edits.json'),'utf8'))).toEqual({'0:5':painting[0]})
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb','weight_edits.json'])
  })

  it('restores the old rig if the paint record cannot be published', async () => {
    await writeFile(file('rigged.glb'),'old rig')
    await writeFile(file('candidate.glb'),'new rig')
    // An existing directory cannot be replaced by rename(file,directory).
    await mkdir(file('weight_edits.json'))
    await writeFile(file('weight_edits.json/sentinel'),'untouched')
    await expect(publishRig('test',file('candidate.glb'),file('rigged.glb'),painting)).rejects.toThrow()
    expect(await readFile(file('rigged.glb'),'utf8')).toBe('old rig')
    expect(await readFile(file('weight_edits.json/sentinel'),'utf8')).toBe('untouched')
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb','weight_edits.json'])
  })

  it('does not create a painting record when no painting exists', async () => {
    await writeFile(file('candidate.glb'),'new rig')
    await publishRig('test',file('candidate.glb'),file('rigged.glb'),[])
    expect(await readdir(state.dir)).toEqual(['rigged.glb'])
  })
})

describe('painted weights from a request', () => {
  const parts = [{ count: 10, joints: ['Hips', 'LeftArm'] }, { count: 0, joints: ['Hips'] }]

  it('keeps edits that name a vertex and bones the rig has, each vertex once', () => {
    const out = checkEdits(parts, [
      { mesh: 0, vertex: 9, weights: [['Hips', 0.25], ['LeftArm', 0.75]] },
      { mesh: 0, vertex: 9, weights: [['Hips', 1]], extra: true },
    ])
    expect(out).toEqual([{ mesh: 0, vertex: 9, weights: [['Hips', 1]] }])
  })

  it('refuses edits out of range or malformed', () => {
    expect(() => checkEdits(parts, [])).toThrow('No weights')
    expect(() => checkEdits(parts, [{ mesh: 2, vertex: 0, weights: [['Hips', 1]] }])).toThrow('no skinned mesh 2')
    expect(() => checkEdits(parts, [{ mesh: -1, vertex: 0, weights: [['Hips', 1]] }])).toThrow('no skinned mesh')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 10, weights: [['Hips', 1]] }])).toThrow('no vertex 10')
    expect(() => checkEdits(parts, [{ mesh: 1, vertex: 0, weights: [['Hips', 1]] }])).toThrow('no vertex 0')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 1.5, weights: [['Hips', 1]] }])).toThrow('whole numbers')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 1, weights: [['Spine', 1]] }])).toThrow('no bone Spine')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 1, weights: [['Hips', -1]] }])).toThrow('from 0 up')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 1, weights: [['Hips', 0]] }])).toThrow('every weight is 0')
    expect(() => checkEdits(parts, [{ mesh: 0, vertex: 1, weights: [] }])).toThrow('no weights')
  })

  it('counts skinned primitives in scene order, depth first, as the app does', () => {
    const glb: Glb = {
      bin: null,
      json: {
        asset: { version: '2.0' },
        scene: 0,
        scenes: [{ nodes: [0, 3] }],
        nodes: [
          { name: 'Armature', children: [1, 2] },
          { name: 'Body', mesh: 0, skin: 0 },
          { name: 'mixamorig:Hips' },
          { name: 'Prop', mesh: 1 },
        ],
        meshes: [
          { primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }, { attributes: { POSITION: 3 } }] },
          { primitives: [{ attributes: { POSITION: 0 } }] },
        ],
        skins: [{ joints: [2] }],
        accessors: [{ count: 4, componentType: 5126, type: 'VEC3' }, { count: 4, componentType: 5121, type: 'VEC4' },
          { count: 4, componentType: 5126, type: 'VEC4' }, { count: 7, componentType: 5126, type: 'VEC3' }],
      },
    }
    expect(skinnedParts(glb)).toEqual([
      { count: 4, joints: ['mixamorigHips'], attributes: { JOINTS_0: 1, WEIGHTS_0: 2 } },
      { count: 0, joints: ['mixamorigHips'], attributes: {} },
    ])
  })

  it('keeps each vertex\'s latest edit and forgets them all', async () => {
    expect(await keepWeightEdits('test', [{ mesh: 0, vertex: 1, weights: [['Hips', 1]] }])).toBe(1)
    expect(await keepWeightEdits('test', [{ mesh: 0, vertex: 1, weights: [['Spine', 1]] }, { mesh: 0, vertex: 2, weights: [['Hips', 1]] }])).toBe(2)
    expect((await weightEdits('test')).map(e => e.weights[0][0])).toEqual(['Spine', 'Hips'])
    expect(await dropWeightEdits('test')).toBe(2)
    expect(await weightEdits('test')).toEqual([])
  })
})

/** A rig: one skinned triangle bound to Hips (joint 0), Spine (joint 1) its child. */
function rig (): Uint8Array {
  const bin = new Uint8Array(96)
  const data = new DataView(bin.buffer)
  for (const [v, xyz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0]].entries()) xyz.forEach((x, k) => { data.setFloat32(v * 12 + k * 4, x, true) })
  for (let v = 0; v < 3; v++) data.setFloat32(48 + v * 16, 1, true)
  return writeGlb({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, skin: 0 }, { name: 'Hips', children: [2] }, { name: 'Spine' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    skins: [{ joints: [1, 2] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 48 }],
    buffers: [{ byteLength: 96 }],
  }, bin)
}

/** Vertex v's skin in a rig file: [joint, weight] pairs with weight. */
async function skinOf (file: string, v: number): Promise<Array<[number, number]>> {
  const glb = readGlb(new Uint8Array(await readFile(file)))
  const joints = accessor(glb, 1); const weights = accessor(glb, 2)
  return [0, 1, 2, 3].map(k => [joints.get(v, k), weights.get(v, k)] as [number, number]).filter(([, w]) => w > 0)
}

const stroke = [{ mesh: 0, vertex: 1, weights: [['Spine', 0.75], ['Hips', 0.25]] as Array<[string, number]> }]
const same = async (file: string, bytes: Uint8Array): Promise<boolean> => Buffer.compare(await readFile(file), Buffer.from(bytes)) === 0

describe('painted weights written into a rig', () => {
  it('replaces the file whole: the weights written, every other byte as it was, nothing left beside it', async () => {
    const before = rig()
    await writeFile(file('rigging-1.glb'), before)
    expect(await writeWeights(file('rigging-1.glb'), stroke)).toBe(1)
    expect(await skinOf(file('rigging-1.glb'), 1)).toEqual([[1, 0.75], [0, 0.25]])
    expect(await skinOf(file('rigging-1.glb'), 0)).toEqual([[0, 1]])
    expect((await readFile(file('rigging-1.glb'))).length).toBe(before.length)
    expect(await readdir(state.dir)).toEqual(['rigging-1.glb'])
  })

  it('saves painting into the live rig with its record kept first', async () => {
    await writeFile(file('rigged.glb'), rig())
    const order: string[] = []
    state.onRename = to => { order.push(path.basename(to)) }
    expect(await savePainting('test', file('rigged.glb'), stroke)).toEqual({ written: 1, kept: 1 })
    expect(order).toEqual(['weight_edits.json', 'rigged.glb'])
    expect(await skinOf(file('rigged.glb'), 1)).toEqual([[1, 0.75], [0, 0.25]])
    expect(await weightEdits('test')).toEqual(stroke)
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb', 'weight_edits.json'])
  })

  it('leaves the rig as it was when the record cannot be kept', async () => {
    const before = rig()
    await writeFile(file('rigged.glb'), before)
    await writeFile(file('weight_edits.json'), '{}')
    state.onRename = to => { if (path.basename(to) === 'weight_edits.json') throw new Error('disk full') }
    await expect(savePainting('test', file('rigged.glb'), stroke)).rejects.toThrow('disk full')
    expect(await same(file('rigged.glb'), before)).toBe(true)
    expect(await readFile(file('weight_edits.json'), 'utf8')).toBe('{}')
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb', 'weight_edits.json'])
  })

  it('puts the record back when the rig cannot be replaced', async () => {
    const before = rig()
    const record = '{"0:2":{"mesh":0,"vertex":2,"weights":[["Hips",1]]}}'
    await writeFile(file('rigged.glb'), before)
    await writeFile(file('weight_edits.json'), record)
    state.onRename = to => { if (path.basename(to) === 'rigged.glb') throw new Error('disk full') }
    await expect(savePainting('test', file('rigged.glb'), stroke)).rejects.toThrow('disk full')
    expect(await same(file('rigged.glb'), before)).toBe(true)
    expect(await readFile(file('weight_edits.json'), 'utf8')).toBe(record)
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb', 'weight_edits.json'])
  })

  it('and removes a record it made when there was none', async () => {
    await writeFile(file('rigged.glb'), rig())
    state.onRename = to => { if (path.basename(to) === 'rigged.glb') throw new Error('disk full') }
    await expect(savePainting('test', file('rigged.glb'), stroke)).rejects.toThrow('disk full')
    expect(await readdir(state.dir)).toEqual(['rigged.glb'])
  })
})
