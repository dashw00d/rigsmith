// @vitest-environment node
// The Forge's routes through the server's router (no socket): no forge.json, a broken one, then the fixture's
// (server/forge/fixture.ts): a set with items, a stage run, a pick, an approve, the attempt's files, the queue's order
// and cancel, a batch run and a publish job. nvidia-smi is a script; nothing touches a GPU.
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { makeFixture, type Fixture } from '../forge/fixture.ts'
import type { ForgeView, QueueJob, SetView } from '../forge/types.ts'

const ws = mkdtempSync(path.join(tmpdir(), 'rigsmith-forge-routes-'))
process.env.RIGSMITH_WORKSPACE = ws
const smi = path.join(ws, 'nvidia-smi')
writeFileSync(smi, '#!/bin/sh\necho 16000\n')
chmodSync(smi, 0o755)
process.env.NVIDIA_SMI = smi

let http: typeof import('../http.ts')
let jobs: typeof import('../jobs.ts')
let store: typeof import('../forge/store.ts')
let fx: Fixture

beforeAll(async () => {
  fx = makeFixture()
  process.env.RIGSMITH_FORGE = path.join(fx.root, 'missing.json')
  await import('./forge.ts')
  http = await import('../http.ts')
  jobs = await import('../jobs.ts')
  store = await import('../forge/store.ts')
})
afterAll(async () => {
  await store.makeWritable(fx.root)
  rmSync(fx.root, { recursive: true, force: true })
  rmSync(ws, { recursive: true, force: true })
})

interface Answer { status: number, body: unknown, text: string, type?: string }
async function call (method: string, url: string, body?: unknown): Promise<Answer> {
  const bytes = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Readable.from(bytes) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { 'x-rigsmith': '1', 'content-type': 'application/json' } })
  return await new Promise((resolve, reject) => {
    let status = 200
    let type: string | undefined
    const chunks: Buffer[] = []
    const res = Object.assign(new Writable({ write (c: Buffer, _e: string, cb: () => void) { chunks.push(Buffer.from(c)); cb() } }), {
      headersSent: false,
      writeHead (s: number, h?: Record<string, string>) { status = s; type = h?.['content-type']; this.headersSent = true; return this },
    })
    res.on('finish', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let parsed: unknown = text
      try { parsed = JSON.parse(text) } catch { /* not JSON */ }
      resolve({ status, body: parsed, text, ...(type !== undefined ? { type } : {}) })
    })
    http.handle(req, res as unknown as ServerResponse, () => { reject(new Error('no route')) }).catch(reject)
  })
}

const board = async (): Promise<ForgeView> => (await call('GET', '/api/forge')).body as ForgeView

describe('the forge routes', () => {
  it('says so when the game has no forge.json, or a broken one', async () => {
    const none = await board()
    expect(none.config).toBeNull()
    expect(none.error).toMatch(/no forge\.json/)
    writeFileSync(path.join(fx.root, 'broken.json'), JSON.stringify({ schema: 1 }))
    process.env.RIGSMITH_FORGE = path.join(fx.root, 'broken.json')
    const broken = await board() as ForgeView & { problems?: string[] }
    expect(broken.problems).toContain('pipelines must name at least one pipeline')
    expect((await call('POST', '/api/forge/sets', { name: 'x', pipeline: 'outfit' })).status).toBe(409)
    process.env.RIGSMITH_FORGE = path.join(fx.repo, 'forge.json')
  })

  it('makes a set, runs a stage, picks, approves and serves an attempt\'s files', async () => {
    const made = await call('POST', '/api/forge/sets', { name: 'Gael hats', pipeline: 'outfit', items: [{ name: 'Hat A', id: 'hat_a', spec: { seed: 4, pieces: { HAT: 'felt' } } }] })
    expect(made.status).toBe(201)
    expect((made.body as SetView).items.map(i => i.id)).toEqual(['hat_a'])
    expect((await call('POST', '/api/forge/sets', { name: 'x', pipeline: 'nope' })).status).toBe(400)
    expect((await call('POST', '/api/forge/sets/gael_hats/items', { name: 'Hat B' })).status).toBe(201)

    const run = await call('POST', '/api/forge/sets/gael_hats/items/hat_a/run', { stage: 'sheet' })
    expect(run.status).toBe(202)
    expect((run.body as QueueJob[]).map(j => j.variant)).toEqual([0, 1])
    await vi.waitFor(async () => { expect((await board()).queue.every(j => j.status === 'done')).toBe(true) })
    expect((await call('POST', '/api/forge/sets/gael_hats/items/hat_a/run', { stage: 'bake' })).status).toBe(404)

    const picked = await call('POST', '/api/forge/sets/gael_hats/items/hat_a/pick', { stage: 'sheet', attempt: 'a002' })
    expect(picked.status).toBe(200)
    expect((picked.body as { selection: { attempt: string } }).selection.attempt).toBe('a002')
    expect((await call('POST', '/api/forge/sets/gael_hats/items/hat_a/pick', { stage: 'sheet', attempt: 'a009' })).status).toBe(404)

    const file = await call('GET', '/files/forge/gael_hats/hat_a/sheet/a002/out/hat_a/sheet.png')
    expect(file.status).toBe(200)
    expect(file.text).toMatch(/^sheet seed \d+ for hat_a\n$/)
    expect(file.type).toBe('image/png')
    expect((await call('GET', '/files/forge/gael_hats/hat_a/sheet/a002/log.txt')).text).toMatch(/painted/)
    expect((await call('GET', '/files/forge/gael_hats/hat_a/sheet/a002/work/guide.png')).status).toBe(404)
    expect((await call('GET', '/files/forge/gael_hats/hat_a/sheet/a002/out/../../../../../../forge.json')).status).toBe(404)

    // (through to the first gate: prepare, then cut, which waits to be approved)
    await call('POST', '/api/forge/sets/gael_hats/items/hat_a/run', { stage: 'prepare', through: 'gate' })
    await vi.waitFor(async () => { expect((await board()).queue.filter(j => j.stage === 'cut' && j.status === 'done')).toHaveLength(1) })
    const approved = await call('POST', '/api/forge/sets/gael_hats/items/hat_a/approve', { stage: 'cut' })
    expect((approved.body as { set: SetView }).set.items[0].stages.map(s => s.ready)).toEqual([true, true, true, false])
  })

  it('runs a batch, takes a new order, cancels, and publishes as a job', async () => {
    const batch = await call('POST', '/api/forge/sets/gael_hats/run', { stage: 'prepare' })
    expect((batch.body as QueueJob[]).map(j => j.item)).toEqual(['hat_a', 'hat_b'])
    expect((await call('POST', '/api/forge/queue/reorder', { ids: 'x' })).status).toBe(400)
    expect((await call('POST', '/api/forge/queue/abcdef/cancel')).status).toBe(404)
    await vi.waitFor(async () => { expect((await board()).queue.every(j => j.status !== 'queued' && j.status !== 'running')).toBe(true) })
    const done = (await board()).queue.find(j => j.status === 'done')!
    expect((await call('POST', `/api/forge/queue/${done.id}/cancel`)).status).toBe(409)

    await call('POST', '/api/forge/sets/gael_hats/items/hat_a/run', { stage: 'finish' })
    await vi.waitFor(async () => { expect((await board()).queue.some(j => j.stage === 'finish' && j.status === 'done')).toBe(true) })
    const job = (await call('POST', '/api/forge/sets/gael_hats/publish', { items: ['hat_a'], character: null })).body as { id: string }
    await vi.waitFor(() => { expect(jobs.getJob(job.id)?.status).toBe('done') })
    expect(jobs.getJob(job.id)?.result?.summary).toBe('Published 1 of 1')
  })
})
