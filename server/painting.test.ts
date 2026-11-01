// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { accessor, readGlb, writeGlb } from '../src/engine/glb.ts'

const state = vi.hoisted(() => ({ dir: '', renameHook: null as ((to: string) => void) | null, cleanupHook: null as ((file: string) => void) | null }))
vi.mock('./store.ts', () => ({ characterDir: () => state.dir }))
vi.mock('./workspace.ts', () => ({ characterDir: () => state.dir }))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  const rename = async (from: string, to: string): Promise<void> => { state.renameHook?.(to); await fs.rename(from, to) }
  const rm: typeof fs.rm = async (file, options) => { if (typeof file === 'string') state.cleanupHook?.(file); await fs.rm(file, options) }
  return { ...fs, rename, rm, default: { ...fs, rename, rm } }
})
import { checkBodyPainting, saveBodyPainting } from './painting.ts'
import { dropShapeEdits, shapeReferences } from './shapes.ts'

function rig (): Uint8Array {
  const bin = new Uint8Array(96); const data = new DataView(bin.buffer)
  for (const [v, xyz] of [[0,0,0], [1,0,0], [0,1,0]].entries()) xyz.forEach((x, k) => data.setFloat32(v * 12 + k * 4, x, true))
  for (let v = 0; v < 3; v++) data.setFloat32(48 + v * 16, 1, true)
  return writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, skin: 0 }, { name: 'Hips', children: [2] }, { name: 'Spine' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }], skins: [{ joints: [1, 2] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' }, { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 48 }],
    buffers: [{ byteLength: 96 }],
  }, bin)
}
const file = (name: string): string => path.join(state.dir, name)
const painting = () => ({
  edits: [{ mesh: 0, vertex: 1, weights: [['Spine', .75], ['Hips', .25]] as Array<[string, number]> }],
  lifts: [{ mesh: 0, vertex: 1, from: [1,0,0] as [number,number,number], to: [1,0,.02] as [number,number,number] }],
})
const snapshot = async (): Promise<Record<string, Buffer>> => Object.fromEntries(await Promise.all((await readdir(state.dir)).map(async n => [n, await readFile(file(n))])))

beforeEach(async () => {
  state.dir = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-paint-bundle-'))
  await writeFile(file('rigged.glb'), rig())
})
afterEach(async () => { state.renameHook = null; state.cleanupHook = null; vi.restoreAllMocks(); await rm(state.dir, { recursive: true, force: true }) })

describe('combined body painting publication', () => {
  it('writes shapes and weights together, with both re-rig records and stable lift references', async () => {
    const saved = await saveBodyPainting('test', file('rigged.glb'), painting())
    expect(saved).toEqual({ weighted: 1, lifted: 1, weightsKept: 1, liftsKept: 1 })
    const glb = readGlb(new Uint8Array(await readFile(file('rigged.glb'))))
    expect(accessor(glb, 0).get(1, 2)).toBeCloseTo(.02, 7)
    expect(accessor(glb, 1).get(1, 0)).toBe(1)
    expect(accessor(glb, 2).get(1, 0)).toBe(.75)
    expect(JSON.parse(await readFile(file('weight_edits.json'), 'utf8'))['0:1']).toEqual(painting().edits[0])
    expect((await shapeReferences('test', file('rigged.glb')))[0].from).toEqual([1,0,0])
    const again = painting(); again.lifts[0].from = [1,0,.02]; again.lifts[0].to = [1,0,.03]
    await saveBodyPainting('test', file('rigged.glb'), again)
    expect((await shapeReferences('test', file('rigged.glb')))[0].from).toEqual([1,0,0])
    expect((await readdir(state.dir)).sort()).toEqual(['rigged.glb', 'shape_edits.json', 'weight_edits.json'])
  })

  it.each(['weight_edits.json', 'shape_edits.json', 'rigged.glb'])('restores all three exact files when publication of %s fails', async failing => {
    await writeFile(file('weight_edits.json'), '{\n "old": {"mesh":0,"vertex":2,"weights":[["Hips",1]]}\n}')
    await writeFile(file('shape_edits.json'), '{\n}')
    const before = await snapshot()
    state.renameHook = to => { if (to === file(failing)) { state.renameHook = null; throw new Error('disk full') } }
    await expect(saveBodyPainting('test', file('rigged.glb'), painting())).rejects.toThrow('disk full')
    expect(await snapshot()).toEqual(before)
  })

  it('removes newly created records when a combined save fails before the rig is published', async () => {
    const before = await snapshot()
    state.renameHook = to => { if (to === file('rigged.glb')) { state.renameHook = null; throw new Error('rig publish failed') } }
    await expect(saveBodyPainting('test', file('rigged.glb'), painting())).rejects.toThrow('rig publish failed')
    expect(await snapshot()).toEqual(before)
  })

  it.each(['edits', 'lifts'] as const)('does not rewrite the other sidecar for a %s-only save', async half => {
    await writeFile(file('shape_edits.json'), '{\n}')
    await writeFile(file('weight_edits.json'), '{\n}')
    const untouched = half === 'edits' ? 'shape_edits.json' : 'weight_edits.json'
    const before = await readFile(file(untouched))
    const payload = painting(); payload[half === 'edits' ? 'lifts' : 'edits'] = []
    await saveBodyPainting('test', file('rigged.glb'), payload)
    expect(await readFile(file(untouched))).toEqual(before)
  })

  it('validates both halves and cancellation before changing any live file', async () => {
    const before = await snapshot(); const invalid = painting(); invalid.lifts[0].vertex = -1
    await expect(saveBodyPainting('test', file('rigged.glb'), invalid)).rejects.toThrow('no vertex')
    const controller = new AbortController(); controller.abort()
    await expect(saveBodyPainting('test', file('rigged.glb'), painting(), controller.signal)).rejects.toThrow()
    expect(await snapshot()).toEqual(before)
  })

  it('keeps the canonical origin when a legacy caller sends a stale intermediate from position', async () => {
    const first = painting(); await saveBodyPainting('test', file('rigged.glb'), first)
    const second = painting(); second.lifts[0].to = [1,0,.03]; await saveBodyPainting('test', file('rigged.glb'), second)
    const third = painting(); third.lifts[0].from = [1,0,.02]; third.lifts[0].to = [1,0,.04]
    await saveBodyPainting('test', file('rigged.glb'), third)
    const refs = await shapeReferences('test', file('rigged.glb'))
    expect(refs).toHaveLength(1)
    expect(refs[0].from).toEqual([1,0,0])
    expect(await dropShapeEdits('test', file('rigged.glb'))).toBe(1)
    const restored = readGlb(new Uint8Array(await readFile(file('rigged.glb'))))
    expect(accessor(restored, 0).get(1, 2)).toBe(0)
  })

  it('reports successful publication even when temporary-file cleanup fails', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    state.cleanupHook = file => { if (path.basename(file).startsWith('.painting-')) throw new Error('cleanup unavailable') }
    await expect(saveBodyPainting('test', file('rigged.glb'), painting())).resolves.toMatchObject({ weighted: 1, lifted: 1 })
    expect(warning).toHaveBeenCalledTimes(1)
    expect((await shapeReferences('test', file('rigged.glb')))[0].from).toEqual([1,0,0])
    expect(accessor(readGlb(new Uint8Array(await readFile(file('rigged.glb')))), 2).get(1, 0)).toBe(.75)
  })

  it('retains exact recovery backups if restoring a published record also fails', async () => {
    await writeFile(file('weight_edits.json'), '{}')
    const original = await readFile(file('rigged.glb'))
    state.renameHook = to => {
      if (to === file('rigged.glb') || to === file('shape_edits.json')) throw new Error('persistent storage failure')
      if (to === file('weight_edits.json')) {
        state.renameHook = next => { if (next === file('shape_edits.json') || next === file('weight_edits.json')) throw new Error('persistent storage failure') }
      }
    }
    await expect(saveBodyPainting('test', file('rigged.glb'), painting())).rejects.toThrow('recovery files retained')
    expect(await readFile(file('rigged.glb'))).toEqual(original)
    const folder = (await readdir(state.dir)).find(name => name.startsWith('.painting-'))!
    expect(folder).toBeDefined()
    const manifest = JSON.parse(await readFile(file(`${folder}/recovery.json`), 'utf8')) as Array<{ backup: string }>
    expect(await readFile(manifest[0].backup, 'utf8')).toBe('{}')
    expect(await readFile(manifest.at(-1)!.backup)).toEqual(original)
  })
})

describe('body paint request checks', () => {
  const parts = [{ count: 3, joints: ['Hips', 'Spine'] }]
  it.each([null, {}, { lifts: 'bad' }, { lifts: [{ ...painting().lifts[0], vertex: 3 }] },
    { lifts: [{ ...painting().lifts[0], to: [0, Infinity, 0] }] }, { lifts: [{ ...painting().lifts[0], from: [0, 1e40, 0] }] },
    { lifts: [{ ...painting().lifts[0], from: [0, 0] }] }, { edits: [{ mesh: 0, vertex: 1, weights: [['WrongBone', 1]] }] },
    { ...painting(), revision: -1 }, { ...painting(), revision: 1.5 },
  ])('rejects malformed or empty painting %#', input => { expect(() => checkBodyPainting(parts, input)).toThrow() })
})
