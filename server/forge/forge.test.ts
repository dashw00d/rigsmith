// @vitest-environment node
// The Forge's config, store and runner, with small shell stages in a temp repo (server/forge/fixture.ts): attempts never
// overwritten, inputs linked or copied, outputs checked, moved and made read-only, the key and staleness, reuse.
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { makeFixture, type Fixture } from './fixture.ts'

process.env.RIGSMITH_WORKSPACE ??= mkdtempSync(path.join(tmpdir(), 'rigsmith-forge-ws-'))
let config: typeof import('./config.ts')
let store: typeof import('./store.ts')
let runner: typeof import('./runner.ts')

beforeAll(async () => {
  config = await import('./config.ts')
  store = await import('./store.ts')
  runner = await import('./runner.ts')
})

let fx: Fixture
let cfg: import('./types.ts').ForgeConfig
let s: import('./store.ts').ForgeStore

beforeEach(async () => {
  fx = makeFixture()
  cfg = config.parseConfig(fx.raw, fx.repo)
  s = new store.ForgeStore(cfg.store)
})
afterEach(async () => {
  await store.makeWritable(fx.root)
  rmSync(fx.root, { recursive: true, force: true })
})

const outfit = (): import('./types.ts').ForgePipeline => cfg.pipelines.outfit
const stage = (id: string): import('./types.ts').ForgeStage => outfit().stages.find(x => x.id === id)!
async function anItem (): Promise<void> {
  await s.createSet({ id: 'gael', name: 'Gael hats', pipeline: 'outfit' })
  await s.createItem('gael', { id: 'hat_a', name: 'Hat A', spec: { id: 'hat_a', seed: 7, pieces: { HAT: 'a felt hat' } } })
}
const run = async (id: string, o: Partial<import('./runner.ts').RunOptions> = {}): Promise<import('./runner.ts').RunResult> =>
  await runner.runStage({ store: s, config: cfg, pipeline: outfit(), set: 'gael', item: 'hat_a', stage: stage(id), ...o })

describe('forge.json', () => {
  it('reads a good file, the store resolved in the repo', async () => {
    expect(cfg.store).toBe(path.join(fx.repo, 'store'))
    expect(cfg.pipelines.outfit.stages.map(x => x.id)).toEqual(['sheet', 'prepare', 'cut', 'finish'])
    expect(stage('sheet').gpu).toEqual({ vram: 100, family: 'comfy' })
    const loaded = await config.loadConfig(fx.repo)
    expect(loaded?.pipelines.slow.stages).toHaveLength(3)
    expect(await config.loadConfig(path.join(fx.root, 'nowhere'))).toBeNull()
  })

  it('names every problem of a broken one', () => {
    const raw = JSON.parse(JSON.stringify(fx.raw)) as { pipelines: { outfit: { stages: Array<Record<string, unknown>> } }, schema: number }
    raw.schema = 2
    raw.pipelines.outfit.stages[1].inputs = { sheet: { stage: 'later' } }
    raw.pipelines.outfit.stages[2].cmd = ['sh', '{in.nope}', '{wat}']
    raw.pipelines.outfit.stages[3].gate = 'maybe'
    raw.pipelines.outfit.stages[3].outputs = ['../escape']
    raw.pipelines.outfit.stages.push({ id: 'sheet', cmd: ['x'], outputs: ['y'] })
    let error: unknown
    try { config.parseConfig(raw, fx.repo) } catch (e) { error = e }
    expect(error).toBeInstanceOf(config.ForgeConfigError)
    const problems = (error as InstanceType<typeof config.ForgeConfigError>).problems.join('\n')
    expect(problems).toMatch(/schema must be 1/)
    expect(problems).toMatch(/comes from later, which isn't an earlier stage/)
    expect(problems).toMatch(/\{in\.nope\} but has no input nope/)
    expect(problems).toMatch(/\{wat\}, which isn't a placeholder/)
    expect(problems).toMatch(/gate is one of/)
    expect(problems).toMatch(/an output is a path inside/)
    expect(problems).toMatch(/its id is taken/)
  })

  it('refuses a cache on a generative stage', () => {
    const raw = JSON.parse(JSON.stringify(fx.raw)) as { pipelines: { outfit: { stages: Array<Record<string, unknown>> } } }
    raw.pipelines.outfit.stages[0].cache = true
    expect(() => config.parseConfig(raw, fx.repo)).toThrow(/never reused/)
  })
})

describe('the store', () => {
  it('makes sets and items with ids from their names, never reusing one', async () => {
    const a = await s.createSet({ name: 'Gael Hats!', pipeline: 'outfit' })
    const b = await s.createSet({ name: 'Gael hats', pipeline: 'outfit' })
    expect([a.id, b.id]).toEqual(['gael_hats', 'gael_hats_2'])
    const i = await s.createItem(a.id, { name: 'Felt hat', spec: { x: 1 } })
    expect(i.id).toBe('felt_hat')
    expect((await s.items(a.id)).map(x => x.id)).toEqual(['felt_hat'])
    expect((await s.sets()).map(x => x.id)).toEqual(['gael_hats', 'gael_hats_2'])
    await expect(s.createItem('nope', { name: 'x' })).rejects.toThrow(/No set/)
    expect(() => s.itemDir('gael_hats', '../x')).toThrow(/isn't an id/)
  })

  it('numbers attempts and never makes one twice', async () => {
    await anItem()
    const a = await s.newAttempt('gael', 'hat_a', 'sheet')
    const b = await s.newAttempt('gael', 'hat_a', 'sheet')
    expect([a.id, b.id]).toEqual(['a001', 'a002'])
    expect(existsSync(path.join(a.dir, 'work')) && existsSync(path.join(a.dir, 'out'))).toBe(true)
    expect(await s.attemptIds('gael', 'hat_a', 'sheet')).toEqual(['a001', 'a002'])
  })

  it('keys an attempt by everything that made it', () => {
    const k = { version: '1', cmd: ['a'], params: { x: 1, y: 2 }, seed: 1, spec: 's', inputs: {}, code: { 'a.py': 'h' } }
    expect(store.attemptKey(k)).toBe(store.attemptKey({ ...k, params: { y: 2, x: 1 } }))
    expect(store.attemptKey(k)).not.toBe(store.attemptKey({ ...k, code: { 'a.py': 'g' } }))
    expect(store.attemptKey(k)).not.toBe(store.attemptKey({ ...k, seed: 2 }))
  })
})

describe('a stage run', () => {
  it('stages its inputs, checks and moves its outputs, makes out/ read-only and records it', async () => {
    await anItem()
    const progress: string[] = []
    const logs: string[] = []
    const { manifest, reused } = await run('sheet', { onProgress: (p, m) => { progress.push(`${p} ${m}`) }, onLog: l => { logs.push(l) }, seed: 42 })
    expect(reused).toBe(false)
    expect(manifest).toMatchObject({ status: 'done', attempt: 'a001', seed: 42, stage: 'sheet' })
    expect(progress).toEqual(['0.5 Painting'])
    expect(logs).toContain('painted')
    const dir = s.attemptDir('gael', 'hat_a', 'sheet', 'a001')
    expect(readFileSync(path.join(dir, 'out/hat_a/sheet.png'), 'utf8')).toBe('sheet seed 42 for hat_a\n')
    expect(existsSync(path.join(dir, 'work/hat_a/sheet.png'))).toBe(false)
    expect(lstatSync(path.join(dir, 'work/guide.png')).isSymbolicLink()).toBe(true)
    expect(statSync(path.join(dir, 'out/hat_a/sheet.png')).mode & 0o222).toBe(0)
    expect(Object.keys(manifest.outputs)).toEqual(['hat_a/sheet.png'])
    expect(manifest.inputs.guide).toEqual({ file: 'guide.png', hash: await store.hashFile(path.join(fx.repo, 'guide.png')) })
    expect(Object.keys(manifest.code)).toEqual(['tools/sheet.sh'])
    expect(readFileSync(path.join(dir, 'log.txt'), 'utf8')).toMatch(/\+ sh tools\/sheet\.sh .* 42 hat_a/)
    const spec = JSON.parse(readFileSync(path.join(dir, 'spec.json'), 'utf8')) as Record<string, unknown>
    expect(spec).toMatchObject({ item: 'hat_a', seed: 42, spec: { seed: 7 } })
    // (a generation never reuses: another run is another attempt, its own seed)
    const again = await run('sheet')
    expect(again.manifest.attempt).toBe('a002')
    expect(again.manifest.seed).not.toBe(42)
  })

  it("won't run before its inputs are picked, and runs from the pick", async () => {
    await anItem()
    await expect(run('prepare')).rejects.toThrow(/Sheet: nothing picked yet/)
    await run('sheet', { seed: 1 })
    await run('sheet', { seed: 2 })
    await s.select('gael', 'hat_a', 'sheet', 'a002', 'test')
    const { manifest } = await run('prepare')
    expect(manifest.inputs.sheet).toMatchObject({ stage: 'sheet', attempt: 'a002' })
    const out = s.attemptDir('gael', 'hat_a', 'prepare', 'a001')
    expect(readFileSync(path.join(out, 'out/hat_a/views/front.png'), 'utf8')).toBe('sheet seed 2 for hat_a\nfront\n')
    expect(manifest.result).toEqual({ views: 1 })
  })

  it('reuses a deterministic attempt of the same key, and runs again when its code changed', async () => {
    await anItem()
    await run('sheet', { seed: 1 })
    await s.select('gael', 'hat_a', 'sheet', 'a001', 'test')
    const first = await run('prepare')
    await s.select('gael', 'hat_a', 'prepare', 'a001', 'test')
    const second = await run('prepare')
    expect(second).toMatchObject({ reused: true, manifest: { attempt: 'a001' } })
    writeFileSync(path.join(fx.repo, 'tools/prepare.sh'), readFileSync(path.join(fx.repo, 'tools/prepare.sh'), 'utf8') + '\n# changed\n')
    const third = await run('prepare')
    expect(third.reused).toBe(false)
    expect(third.manifest.attempt).toBe('a002')
    expect(third.manifest.key).not.toBe(first.manifest.key)
  })

  it('works out why an attempt is stale', async () => {
    await anItem()
    await run('sheet', { seed: 1 })
    await run('sheet', { seed: 2 })
    await s.select('gael', 'hat_a', 'sheet', 'a001', 'test')
    await run('prepare')
    await s.select('gael', 'hat_a', 'prepare', 'a001', 'test')
    const view = async (): Promise<import('./types.ts').SetView> => await store.setView(s, cfg, (await s.getSet('gael'))!)
    expect((await view()).items[0].stages[1].attempts[0].stale).toEqual([])
    await s.select('gael', 'hat_a', 'sheet', 'a002', 'test')
    writeFileSync(path.join(fx.repo, 'tools/prepare.sh'), 'echo changed\n')
    const v = await view()
    expect(v.items[0].stages[1].attempts[0].stale).toEqual(['sheet: made from a001, a002 is picked now', 'tools/prepare.sh changed'])
    // (the sheet attempts themselves follow from the guide and their code as they are)
    expect(v.items[0].stages[0].attempts.map(a => a.stale)).toEqual([[], []])
    expect(v.items[0].stages.map(x => x.ready)).toEqual([true, true, false, false])
    expect(v.items[0].stages[2].blocked).toBeNull()
    expect(v.items[0].stages[3].blocked).toBe('Cut: it has not run yet')
    await s.updateItem('gael', 'hat_a', i => { i.spec = { ...i.spec, seed: 8 } })
    expect((await view()).items[0].stages[0].attempts[0].stale).toEqual(['the spec of Hat A changed'])
  })

  it('splits the item into pieces, copies inputs for a stage that changes them, and deletes a scratch work/', async () => {
    await anItem()
    await run('sheet', { seed: 3 })
    await s.select('gael', 'hat_a', 'sheet', 'a001', 'test')
    await run('prepare')
    await s.select('gael', 'hat_a', 'prepare', 'a001', 'test')
    const cut = await run('cut')
    expect(Object.keys(cut.manifest.outputs)).toEqual(['hat_a/pieces/head.glb', 'hat_a/pieces/leg_L.glb', 'hat_a/pieces/leg_R.glb'])
    expect((await s.getItem('gael', 'hat_a'))?.pieces).toEqual(['head', 'leg_L', 'leg_R'])
    expect(existsSync(path.join(s.attemptDir('gael', 'hat_a', 'cut', 'a001'), 'work'))).toBe(false)
    // (approve gate: picked is not enough)
    await s.select('gael', 'hat_a', 'cut', 'a001', 'test')
    await expect(run('finish')).rejects.toThrow(/Cut: a001 isn't approved yet/)
    await s.select('gael', 'hat_a', 'cut', 'a001', 'test', true)
    await run('finish')
    const cutOut = path.join(s.attemptDir('gael', 'hat_a', 'cut', 'a001'), 'out/hat_a/pieces/head.glb')
    const finished = path.join(s.attemptDir('gael', 'hat_a', 'finish', 'a001'), 'out/hat_a/pieces/head.glb')
    expect(readFileSync(cutOut, 'utf8')).not.toMatch(/finished/)
    expect(readFileSync(finished, 'utf8')).toMatch(/head\nfinished\n$/)
  })

  it('fails with what the command said, and when it skips an output', async () => {
    await s.createSet({ id: 'misc', name: 'Misc', pipeline: 'slow' })
    await s.createItem('misc', { id: 'x', name: 'X' })
    const slow = cfg.pipelines.slow
    const go = async (id: string): Promise<unknown> => await runner.runStage({ store: s, config: cfg, pipeline: slow, set: 'misc', item: 'x', stage: slow.stages.find(x => x.id === id)! })
    await expect(go('fail')).rejects.toThrow(/exited with 3: Error: the shape is broken/)
    const m = await s.manifest('misc', 'x', 'fail', 'a001')
    expect(m).toMatchObject({ status: 'failed' })
    const missing = { ...slow.stages[1], id: 'quiet', cmd: ['sh', '-c', 'true'], outputs: ['nothing.txt'] }
    await expect(runner.runStage({ store: s, config: cfg, pipeline: slow, set: 'misc', item: 'x', stage: missing })).rejects.toThrow(/without writing nothing\.txt/)
  })

  it('is killed, process group and all, when cancelled', async () => {
    await s.createSet({ id: 'misc', name: 'Misc', pipeline: 'slow' })
    await s.createItem('misc', { id: 'x', name: 'X' })
    const slow = cfg.pipelines.slow
    const controller = new AbortController()
    const started = Date.now()
    const p = runner.runStage({ store: s, config: cfg, pipeline: slow, set: 'misc', item: 'x', stage: slow.stages[0], signal: controller.signal })
    const pidFile = path.join(s.attemptDir('misc', 'x', 'slow', 'a001'), 'work/pid')
    while (!existsSync(pidFile)) await new Promise(resolve => setTimeout(resolve, 10))
    controller.abort(new Error('Cancelled'))
    await expect(p).rejects.toThrow('Cancelled')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect((await s.manifest('misc', 'x', 'slow', 'a001'))?.status).toBe('cancelled')
  })

  it('fills placeholders', () => {
    expect(runner.fill('{work}/{item}-{in.sheet}-{nope}', { work: '/w', item: 'i', 'in.sheet': '/s' })).toBe('/w/i-/s-{nope}')
  })
})
