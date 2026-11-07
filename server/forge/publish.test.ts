// @vitest-environment node
// Publish: the picked attempts copied into the game's folder (later stages over earlier), the roster entry, the hashes
// taken once a batch, and into the character through a fake of the upload route and the commands: new pieces worn,
// a piece it has already given only its new model.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Command } from '../../src/model/command-types.ts'
import type { Character, Gear } from '../../src/model/types.ts'
import { makeFixture, type Fixture } from './fixture.ts'
import type { ForgeConfig } from './types.ts'

process.env.RIGSMITH_WORKSPACE ??= mkdtempSync(path.join(tmpdir(), 'rigsmith-forge-ws-'))
let config: typeof import('./config.ts')
let store: typeof import('./store.ts')
let runner: typeof import('./runner.ts')
let pub: typeof import('./publish.ts')

beforeAll(async () => {
  config = await import('./config.ts')
  store = await import('./store.ts')
  runner = await import('./runner.ts')
  pub = await import('./publish.ts')
})

let fx: Fixture
let cfg: ForgeConfig
let s: import('./store.ts').ForgeStore

beforeEach(async () => {
  fx = makeFixture()
  cfg = config.parseConfig(fx.raw, fx.repo)
  s = new store.ForgeStore(cfg.store)
  await s.createSet({ id: 'gael', name: 'Gael hats', pipeline: 'outfit' })
})
afterEach(async () => {
  await store.makeWritable(fx.root)
  rmSync(fx.root, { recursive: true, force: true })
})

/** An item run through every stage, each picked (the cut approved). */
async function finished (id: string, pieces: Record<string, string>): Promise<void> {
  await s.createItem('gael', { id, name: id, spec: { id, culture: 'Gaels', seed: 3, pieces } })
  const pipeline = cfg.pipelines.outfit
  for (const st of pipeline.stages) {
    const { manifest } = await runner.runStage({ store: s, config: cfg, pipeline, set: 'gael', item: id, stage: st, seed: 5 })
    await s.select('gael', id, st.id, manifest.attempt, 'test', true)
  }
}

function fakeSink (gear: Gear[]): { sink: import('./publish.ts').CharacterSink, uploads: string[], batches: Command[][] } {
  const c = { id: 'folk', name: 'Folk', gear, source: { file: 'source/original.glb' } } as unknown as Character
  const uploads: string[] = []
  const batches: Command[][] = []
  let n = 0
  return {
    uploads, batches,
    sink: {
      character: async () => structuredClone(c),
      upload: async (_id, file, name, from) => {
        uploads.push(`${name} ${from ?? '-'} ${path.basename(path.dirname(path.dirname(file)))}/${path.basename(file)}`)
        const id = `g${++n}`
        c.gear.push({ id, name: name.replace(/\.glb$/, ''), status: 'ready', model: `garments/${id}/model.glb`, handles: [], attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...(from !== undefined ? { from } : {}) })
      },
      commands: async (_id, commands) => { batches.push(commands) },
      sourceFile: () => path.join(fx.root, 'nowhere.glb'),
    },
  }
}

const worn: Gear = {
  id: 'old1', name: 'Outfit_hat_a_leg_L', status: 'ready', model: 'garments/old1/model.glb', handles: [], from: 'emberhold:gear/Outfit_hat_a_leg_L',
  attach: { kind: 'skin', policy: 'lower', place: { position: [0.1, 0.2, 0.3], rotation: [0, 0, 0], scale: 0.5 }, hideBody: true },
}

describe('publish', () => {
  it('copies the picked attempts into the game, puts the roster entry in and takes the hashes once', async () => {
    await finished('hat_a', { HAT: 'a felt hat' })
    await finished('hat_b', { HAIR: 'wild hair' })
    // (a file the game has already, read-only as an attempt's are: replaced)
    mkdirSync(path.join(fx.repo, 'gear/hat_a'), { recursive: true })
    writeFileSync(path.join(fx.repo, 'gear/roster.json'), JSON.stringify({ about: 'x', outfits: [{ id: 'hat_a', seed: 1 }, { id: 'other' }] }))
    const report = await pub.publish({ config: cfg, store: s, set: 'gael', character: null })
    expect(report.items).toEqual([{ id: 'hat_a', into: 'gear/hat_a', files: 7 }, { id: 'hat_b', into: 'gear/hat_b', files: 7 }])
    const dir = path.join(fx.repo, 'gear/hat_a')
    expect(readFileSync(path.join(dir, 'sheet.png'), 'utf8')).toBe('sheet seed 5 for hat_a\n')
    // (finish's pieces over cut's)
    expect(readFileSync(path.join(dir, 'pieces/head.glb'), 'utf8')).toMatch(/head\nfinished\n$/)
    expect(JSON.parse(readFileSync(path.join(dir, 'forge.json'), 'utf8'))).toMatchObject({ set: 'gael', item: 'hat_a', stages: { sheet: 'a001', cut: 'a001', finish: 'a001' } })
    const roster = JSON.parse(readFileSync(path.join(fx.repo, 'gear/roster.json'), 'utf8')) as { about: string, outfits: Array<Record<string, unknown>> }
    expect(roster.about).toBe('x')
    expect(roster.outfits.map(o => o.id)).toEqual(['hat_a', 'other', 'hat_b'])
    expect(roster.outfits[0]).toEqual({ id: 'hat_a', culture: 'Gaels', seed: 3, pieces: { HAT: 'a felt hat' } })
    expect(report.hashes).toBe('ran')
    expect(readFileSync(path.join(fx.repo, 'hashes.log'), 'utf8')).toBe('hashed\n')
    expect(existsSync(path.join(s.itemDir('gael', 'hat_a'), 'published.json'))).toBe(true)
    // (published again: the copies replace what is there)
    await pub.publish({ config: cfg, store: s, set: 'gael', items: ['hat_a'], character: null })
    expect(readFileSync(path.join(fx.repo, 'hashes.log'), 'utf8')).toBe('hashed\nhashed\n')
  })

  it("skips an item that isn't finished, saying why, and publishes nothing then", async () => {
    await s.createItem('gael', { id: 'hat_c', name: 'Hat C' })
    const report = await pub.publish({ config: cfg, store: s, set: 'gael', character: null })
    expect(report).toEqual({ items: [{ id: 'hat_c', skipped: "Sheet isn't picked" }], roster: false, hashes: 'nothing published' })
    await expect(pub.publish({ config: cfg, store: s, set: 'gael', items: ['nope'] })).rejects.toThrow(/no item nope/)
  })

  it('wears new pieces in one batch and gives a piece already worn only its new model', async () => {
    await finished('hat_a', { HAT: 'a felt hat' })
    const { sink, uploads, batches } = fakeSink([worn])
    const report = await pub.publish({ config: cfg, store: s, set: 'gael', character: 'folk', sink })
    expect(report.character).toEqual({ id: 'folk', added: ['Outfit_hat_a_head', 'Outfit_hat_a_leg_R'], replaced: ['Outfit_hat_a_leg_L'], skipped: [] })
    expect(uploads[0]).toBe('Outfit_hat_a_head.glb emberhold:gear/Outfit_hat_a_head hat_a/head.glb')
    expect(uploads[1]).toMatch(/^Outfit_hat_a_leg_L__forge_\w+\.glb - hat_a\/leg_L\.glb$/)
    expect(batches).toHaveLength(1)
    const place = worn.attach.place
    expect(batches[0]).toEqual([
      { type: 'gear.attach', id: 'g1', attach: { kind: 'skin', policy: 'head', place, hideBody: true } },
      { type: 'gear.update', id: 'g1', patch: { outfit: 'hat_a', tags: ['covers-hair'] } },
      { type: 'gear.update', id: 'old1', patch: { model: 'garments/g2/model.glb' } },
      { type: 'gear.remove', id: 'g2' },
      { type: 'gear.attach', id: 'g3', attach: { kind: 'skin', policy: 'lower', place, hideBody: true } },
      { type: 'gear.update', id: 'g3', patch: { outfit: 'hat_a' } },
    ])
  })

  it("leaves out an outfit's head when it is hair", async () => {
    await finished('hat_b', { HAIR: 'wild hair' })
    const { sink, uploads } = fakeSink([])
    const report = await pub.publish({ config: cfg, store: s, set: 'gael', character: 'folk', sink })
    expect(report.character?.added).toEqual(['Outfit_hat_b_leg_L', 'Outfit_hat_b_leg_R'])
    expect(uploads).toHaveLength(2)
  })

  it("places the body's metres in the character's rest space, from the two models' bounds", async () => {
    const glb = (file: string, min: number[], max: number[]): string => {
      const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ min, max, count: 0, type: 'VEC3', componentType: 5126 }] }).padEnd(4 * Math.ceil(200 / 4)))
      const head = Buffer.alloc(20)
      head.writeUInt32LE(0x46546c67, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(20 + json.length, 8); head.writeUInt32LE(json.length, 12); head.writeUInt32LE(0x4e4f534a, 16)
      const p = path.join(fx.root, file)
      writeFileSync(p, Buffer.concat([head, json]))
      return p
    }
    const body = await pub.glbBounds(glb('body.glb', [-0.4, 0, -0.2], [0.4, 1.8, 0.2]))
    const char = await pub.glbBounds(glb('char.glb', [-0.2, -0.5, -0.1], [0.2, 0.4, 0.1]))
    expect(pub.placementOf(body, char)).toEqual({ position: [0, -0.5, 0], rotation: [0, 0, 0], scale: 0.5 })
  })
})
