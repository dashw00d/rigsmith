// @vitest-environment node
// The Forge's queue: lanes, variants, picking, running through to the first gate, reorder, cancel, the events'
// throttle and ETA, and a restart (running jobs interrupted, their attempts set aside, resumable ones carried on).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFixture, type Fixture } from './fixture.ts'
import type { ForgeConfig, ForgeEvent, Manifest, QueueJob } from './types.ts'

// (the workspace store.ts reads at import: an empty one of the test's own, gone after it)
const ws = process.env.RIGSMITH_WORKSPACE === undefined ? mkdtempSync(path.join(tmpdir(), 'rigsmith-forge-ws-')) : null
if (ws !== null) process.env.RIGSMITH_WORKSPACE = ws
afterAll(() => { if (ws !== null) rmSync(ws, { recursive: true, force: true }) })
let config: typeof import('./config.ts')
let store: typeof import('./store.ts')
let queue: typeof import('./queue.ts')

beforeAll(async () => {
  config = await import('./config.ts')
  store = await import('./store.ts')
  queue = await import('./queue.ts')
})

let fx: Fixture
let cfg: ForgeConfig
let s: import('./store.ts').ForgeStore
let events: ForgeEvent[]
let gpuAtOnce: number
let gpuMax: number
const queues: Array<import('./queue.ts').ForgeQueue> = []

const fakeGpu = (async (_job: unknown, _need: unknown, _signal: unknown, fn: () => Promise<unknown>) => {
  gpuAtOnce++
  gpuMax = Math.max(gpuMax, gpuAtOnce)
  try { return await fn() } finally { gpuAtOnce-- }
}) as typeof import('../jobs.ts').withGpu

function make (o: Partial<import('./queue.ts').QueueOptions> = {}): import('./queue.ts').ForgeQueue {
  const q = new queue.ForgeQueue({ store: s, config: async () => cfg, emit: e => { events.push(e) }, gpu: fakeGpu, ...o })
  queues.push(q)
  return q
}

beforeEach(async () => {
  fx = makeFixture()
  cfg = config.parseConfig(fx.raw, fx.repo)
  s = new store.ForgeStore(cfg.store)
  events = []
  gpuAtOnce = 0
  gpuMax = 0
  await s.createSet({ id: 'gael', name: 'Gael hats', pipeline: 'outfit' })
  await s.createItem('gael', { id: 'hat_a', name: 'Hat A', spec: { seed: 7 } })
  await s.createSet({ id: 'misc', name: 'Misc', pipeline: 'slow' })
  await s.createItem('misc', { id: 'x', name: 'X' })
})
afterEach(async () => {
  for (const q of queues.splice(0)) for (const j of q.list()) await q.cancel(j.id)
  for (const q of queues) await q.idle()
  await store.makeWritable(fx.root)
  rmSync(fx.root, { recursive: true, force: true })
})

const saved = (): QueueJob[] => (JSON.parse(readFileSync(path.join(fx.store, 'queue.json'), 'utf8')) as { jobs: QueueJob[] }).jobs

describe('the forge queue', () => {
  it('makes one job per variant, runs the GPU lane one at a time, and leaves a pick gate to a person', async () => {
    const q = make()
    const jobs = await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'sheet' })
    expect(jobs.map(j => [j.lane, j.variant, j.label])).toEqual([['gpu', 0, 'Sheet · Hat A (1/2)'], ['gpu', 1, 'Sheet · Hat A (2/2)']])
    await q.idle()
    expect(jobs.map(j => j.status)).toEqual(['done', 'done'])
    expect(gpuMax).toBe(1)
    expect(await s.attemptIds('gael', 'hat_a', 'sheet')).toEqual(['a001', 'a002'])
    expect(await s.selection('gael', 'hat_a', 'sheet')).toBeNull()
    expect(saved().map(j => j.status)).toEqual(['done', 'done'])
    expect(events.at(-1)?.job.status).toBe('done')
  })

  it('runs through the stages after a pick up to the next gate', async () => {
    const q = make()
    await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'sheet', variants: 1 })
    await q.idle()
    await s.select('gael', 'hat_a', 'sheet', 'a001', 'test')
    await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'prepare', through: 'gate' })
    await q.idle()
    expect(q.list().map(j => `${j.stage} ${j.status}`)).toEqual(['sheet done', 'prepare done', 'cut done'])
    expect((await s.selection('gael', 'hat_a', 'cut'))?.attempt).toBe('a001')
    expect(await s.attemptIds('gael', 'hat_a', 'finish')).toEqual([])
    // (approved, it goes on; a deterministic stage asked again reuses)
    await s.select('gael', 'hat_a', 'cut', 'a001', 'test', true)
    await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'finish' })
    await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'prepare' })
    await q.idle()
    expect(q.list().slice(-2).map(j => j.message)).toEqual(['Made a001', 'Reused a001 (same inputs and code)'])
  })

  it('says why a stage fails, and refuses what does not exist', async () => {
    const q = make()
    const [job] = await q.enqueue({ set: 'gael', item: 'hat_a', stage: 'prepare' })
    await q.idle()
    expect(job).toMatchObject({ status: 'failed', error: "Prepare can't run yet: Sheet: nothing picked yet" })
    await expect(q.enqueue({ set: 'gael', item: 'hat_a', stage: 'bake' })).rejects.toThrow(/no stage bake/)
    await expect(q.enqueue({ set: 'gael', item: 'nope', stage: 'sheet' })).rejects.toThrow(/no item nope/)
  })

  it('takes the queued jobs in a new order and cancels queued and running ones', async () => {
    const q = make({ cpu: 1 })
    const [slow] = await q.enqueue({ set: 'misc', item: 'x', stage: 'slow' })
    const [a] = await q.enqueue({ set: 'misc', item: 'x', stage: 'fail' })
    const [b] = await q.enqueue({ set: 'misc', item: 'x', stage: 'fail' })
    await vi.waitFor(() => { expect(slow.status).toBe('running') })
    await q.reorder([b.id])
    expect(q.list().map(j => j.id)).toEqual([slow.id, b.id, a.id])
    expect((await q.cancel(a.id))?.status).toBe('cancelled')
    await vi.waitFor(() => { expect(existsSync(path.join(s.attemptDir('misc', 'x', 'slow', 'a001'), 'work/pid'))).toBe(true) })
    await q.cancel(slow.id)
    await q.idle()
    expect([slow.status, b.status, a.status]).toEqual(['cancelled', 'failed', 'cancelled'])
    expect((await s.manifest('misc', 'x', 'slow', 'a001'))?.status).toBe('cancelled')
    expect(await q.cancel(slow.id)).toBeNull()
  })

  it('sends a busy job at about four events a second, its last always', async () => {
    const q = make({
      throttleMs: 250,
      run: async o => {
        for (let i = 1; i <= 50; i++) { o.onProgress?.(i / 50, `step ${i}`); o.onLog?.(`line ${i}`); await new Promise(resolve => setTimeout(resolve, 10)) }
        const { id } = await s.newAttempt(o.set, o.item, o.stage.id)
        const m: Manifest = { schema: 1, set: o.set, item: o.item, stage: o.stage.id, attempt: id, key: 'k', status: 'done', version: '1', cmd: [], params: {}, seed: 0, variant: 0, inputs: {}, spec: '', code: {}, outputs: {}, startedAt: Date.now() }
        await s.writeManifest({ ...m })
        return { manifest: { ...m }, reused: false }
      },
    })
    const [job] = await q.enqueue({ set: 'misc', item: 'x', stage: 'slow' })
    await q.idle()
    const mine = events.filter(e => e.job.id === job.id)
    // (~600 ms of progress: a handful of events, not fifty)
    expect(mine.length).toBeLessThan(12)
    expect(mine.length).toBeGreaterThan(2)
    const running = mine.filter(e => e.job.status === 'running' && e.logTail.length > 0)
    expect(running.at(-1)?.logTail.at(-1)).toMatch(/^line \d+$/)
    expect(running.some(e => e.eta !== null)).toBe(true)
    expect(mine.at(-1)?.job.status).toBe('done')
  })

  it('after a restart: a running job is interrupted, its attempt set aside, and a resumable one carried on in its work', async () => {
    // (as a server killed mid-run leaves it: the attempt started, the queue saying running)
    const { id, dir } = await s.newAttempt('misc', 'x', 'slow')
    writeFileSync(path.join(dir, 'work/started'), '')
    await s.writeManifest({ schema: 1, set: 'misc', item: 'x', stage: 'slow', attempt: id, key: 'k', status: 'running', version: '1', cmd: [], params: {}, seed: 0, variant: 0, inputs: {}, spec: '', code: {}, outputs: {}, startedAt: Date.now() })
    const b = await s.newAttempt('misc', 'x', 'never')
    const running = (stage: string, attempt: string): QueueJob => ({ id: `j-${stage}`, set: 'misc', item: 'x', stage, label: stage, lane: 'cpu', params: {}, variant: 0, status: 'running', createdAt: 1, startedAt: 2, progress: 0.3, message: 'Working', attempt })
    const waiting = { ...running('never', ''), id: 'j-waiting' }
    delete (waiting as Partial<QueueJob>).attempt
    writeFileSync(path.join(fx.store, 'queue.json'), JSON.stringify({ jobs: [running('slow', id), running('never', b.id), waiting] }))
    const q = make()
    await q.load()
    // (the one waiting for the GPU had made no attempt: back in line as it was; stopped here, it runs 30 s)
    const again = q.list().find(j => j.stage === 'never' && j.status !== 'interrupted')!
    expect(again.resume).toBeUndefined()
    await q.cancel(again.id)
    await q.idle()
    const jobs = q.list()
    expect(jobs.map(j => `${j.stage} ${j.status}`)).toEqual(['slow interrupted', 'never interrupted', 'never interrupted', 'slow done', 'never cancelled'])
    expect(jobs[3].resume).toBe('a001.partial')
    expect(await s.attemptIds('misc', 'x', 'slow')).toEqual(['a001.partial', 'a002'])
    expect(await s.attemptIds('misc', 'x', 'never')).toEqual(['a001.partial'])
    expect((await s.manifest('misc', 'x', 'slow', 'a001.partial'))?.status).toBe('interrupted')
    expect(readFileSync(path.join(s.attemptDir('misc', 'x', 'slow', 'a002'), 'out/x/slow.txt'), 'utf8')).toBe('carried on\n')
    expect((await s.manifest('misc', 'x', 'slow', 'a002'))?.resumed).toBe('a001.partial')
    const view = await store.setView(s, cfg, (await s.getSet('misc'))!)
    expect(view.items[0].stages[0].attempts.map(a => `${a.id} ${a.status}`)).toEqual(['a001.partial interrupted', 'a002 done'])
  })

  it('works out an ETA from progress, else from how long the stage took before', () => {
    const q = make()
    const now = Date.now()
    q.jobs = [
      { id: 'a', set: 's', item: 'i', stage: 'build', label: '', lane: 'gpu', params: {}, variant: 0, status: 'done', createdAt: 0, startedAt: now - 500_000, finishedAt: now - 400_000, progress: 1, message: '' },
      { id: 'b', set: 's', item: 'i', stage: 'build', label: '', lane: 'gpu', params: {}, variant: 0, status: 'running', createdAt: 0, startedAt: now - 30_000, progress: 0, message: '' },
    ]
    expect(q.eta(q.jobs[1])).toBe(70)
    q.jobs[1].progress = 0.25
    expect(q.eta(q.jobs[1])).toBe(90)
  })
})
