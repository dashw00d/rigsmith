// @vitest-environment node
// Real HTTP requests and background jobs, with only synthetic files in a private workspace. Importing the routes
// registers them without starting the app's recovery work, Blender, or any live character jobs.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { accessor, readGlb, writeGlb } from '../../src/engine/glb.ts'
import { makeRigged } from '../../src/model/fixtures.ts'
import type { Character, Job, Vec3 } from '../../src/model/types.ts'
import type { BodyPainting } from '../painting.ts'
import type { ShapeEdit } from '../shapes.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-painting-http-'))
const previousWorkspace = process.env.RIGSMITH_WORKSPACE
// store.ts reads this at import time; keep all server imports below the assignment.
process.env.RIGSMITH_WORKSPACE = dir
let store: typeof import('../store.ts')
let server: Server
let origin = ''
let c: Character
let folder = ''
let nextCharacter = 0

/** One skinned triangle, initially all Hips; Spine is the other available joint. */
function rig (): Uint8Array {
  const bin = new Uint8Array(96)
  const data = new DataView(bin.buffer)
  for (const [v, xyz] of [[0, 0, 0], [1, 0, 0], [0, 1, 0]].entries()) xyz.forEach((x, k) => { data.setFloat32(v * 12 + k * 4, x, true) })
  for (let v = 0; v < 3; v++) data.setFloat32(48 + v * 16, 1, true)
  return writeGlb({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0, 1] }],
    nodes: [{ name: 'Body', mesh: 0, skin: 0 }, { name: 'Hips', children: [2] }, { name: 'Spine' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, JOINTS_0: 1, WEIGHTS_0: 2 } }] }],
    skins: [{ joints: [1, 2] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5121, count: 3, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 3, type: 'VEC4' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 12 }, { buffer: 0, byteOffset: 48, byteLength: 48 }],
    buffers: [{ byteLength: 96 }],
  }, bin)
}

beforeAll(async () => {
  const { handle } = await import('../http.ts')
  await import('./skin.ts')
  await import('./characters.ts') // /api/jobs and the schema-4 character read
  store = await import('../store.ts')
  server = createServer((req, res) => { void handle(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('HTTP test server has no TCP address')
  origin = `http://127.0.0.1:${address.port}`
})

beforeEach(() => {
  c = makeRigged({ id: `painting-http-${++nextCharacter}`, revision: 7 })
  folder = path.join(dir, 'characters', c.id)
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  writeFileSync(path.join(folder, 'rigged.glb'), rig())
})

afterAll(async () => {
  if (server !== undefined) await new Promise<void>((resolve, reject) => { server.close(error => { if (error !== undefined) reject(error); else resolve() }) })
  rmSync(dir, { recursive: true, force: true })
  if (previousWorkspace === undefined) delete process.env.RIGSMITH_WORKSPACE
  else process.env.RIGSMITH_WORKSPACE = previousWorkspace
})

const of = (): string => `/api/characters/${c.id}`
const file = (name: string): string => path.join(folder, name)
const json = <T>(name: string): T => JSON.parse(readFileSync(file(name), 'utf8')) as T
const snapshot = (): Record<string, Buffer> => Object.fromEntries(readdirSync(folder).map(name => [name, readFileSync(file(name))]))
const painting = (): BodyPainting => ({
  revision: c.revision,
  edits: [{ mesh: 0, vertex: 1, weights: [['Spine', .75], ['Hips', .25]] }],
  lifts: [{ mesh: 0, vertex: 1, from: [1, 0, 0], to: [1, 0, .02] }],
})

async function call<T> (method: string, url: string, body?: unknown): Promise<{ status: number, body: T }> {
  const response = await fetch(origin + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-rigsmith': '1', 'x-rigsmith-schema': '4' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() as T }
}

async function jobs (): Promise<Job[]> {
  const response = await call<Job[]>('GET', '/api/jobs')
  expect(response.status).toBe(200)
  return response.body.filter(job => job.characterId === c.id)
}

async function finished (id: string): Promise<Job> {
  let job: Job | undefined
  await vi.waitFor(async () => {
    job = (await jobs()).find(candidate => candidate.id === id)
    expect(job).toBeDefined()
    expect(['done', 'failed', 'cancelled']).toContain(job?.status)
  }, { timeout: 3000, interval: 10 })
  return job!
}

async function save (url: string, body: unknown): Promise<Job> {
  const accepted = await call<Job>('PUT', url, body)
  expect(accepted.status).toBe(202)
  expect(accepted.body).toMatchObject({ kind: 'paint', characterId: c.id })
  const done = await finished(accepted.body.id)
  expect(done.status, done.error).toBe('done')
  return done
}

function deferred (): { promise: Promise<void>, resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('body painting over HTTP', () => {
  it('publishes weights and lifts in one paint job, keeps both records, and advances the revision once', async () => {
    const oldWeight = { mesh: 0, vertex: 0, weights: [['Hips', 1]] }
    writeFileSync(file('weight_edits.json'), JSON.stringify({ '0:0': oldWeight }))
    const payload = painting()
    await save(`${of()}/painting`, payload)

    const glb = readGlb(readFileSync(file('rigged.glb')))
    expect(accessor(glb, 0).get(1, 2)).toBeCloseTo(.02, 7)
    expect(accessor(glb, 1).get(1, 0)).toBe(1)
    expect(accessor(glb, 2).get(1, 0)).toBe(.75)
    expect(accessor(glb, 2).get(1, 1)).toBe(.25)
    expect(accessor(glb, 2).get(0, 0)).toBe(1)
    expect(json('weight_edits.json')).toEqual({ '0:0': oldWeight, '0:1': payload.edits[0] })
    expect(Object.values(json<Record<string, ShapeEdit>>('shape_edits.json'))).toEqual(payload.lifts)
    const references = await call<ShapeEdit[]>('GET', `${of()}/shape`)
    expect(references.status).toBe(200)
    expect(references.body).toHaveLength(1)
    expect(references.body[0].from).toEqual([1, 0, 0])
    expect(references.body[0].to[2]).toBeCloseTo(.02, 7)
    const character = await call<Character>('GET', of())
    expect(character.status).toBe(200)
    expect(character.body.revision).toBe(c.revision! + 1)
    expect(character.body.skin.painted).toBe(2)
    expect((await jobs()).map(job => job.kind)).toEqual(['paint'])
    expect(readdirSync(folder).sort()).toEqual(['character.json', 'journal.jsonl', 'rigged.glb', 'shape_edits.json', 'weight_edits.json'])
  })

  it('rejects a stale expected revision before enqueueing or changing any file', async () => {
    const before = snapshot()
    const response = await call<{ error: string }>('PUT', `${of()}/painting`, { ...painting(), revision: c.revision! - 1 })
    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/rig changed.*reload/i)
    expect(await jobs()).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it.each(['painting', 'shape'])('rejects malformed lifts in PUT /%s before enqueueing or writing', async endpoint => {
    const payload = painting()
    payload.lifts[0].vertex = -1
    const before = snapshot()
    const response = await call<{ error: string }>('PUT', `${of()}/${endpoint}`, endpoint === 'shape' ? { edits: payload.lifts } : payload)
    expect(response.status).toBe(400)
    expect(response.body.error).toMatch(/no vertex/)
    expect(await jobs()).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it.each(['painting', 'shape'])('honours the skin lock for PUT /%s without a job or file changes', async endpoint => {
    c.skin.locked = true
    writeFileSync(file('character.json'), JSON.stringify(c))
    const before = snapshot()
    const payload = painting()
    const response = await call<{ error: string }>('PUT', `${of()}/${endpoint}`, endpoint === 'shape' ? { edits: payload.lifts } : payload)
    expect(response.status).toBe(409)
    expect(response.body.error).toMatch(/weights are locked/)
    expect(await jobs()).toEqual([])
    expect(snapshot()).toEqual(before)
  })

  it('checks the expected revision again after an accepted job acquires the file lock', async () => {
    const entered = deferred(), release = deferred()
    const held = store.withFiles(c.id, async () => {
      entered.resolve()
      await release.promise
      await store.updateCharacter(c.id, character => { character.revision = (character.revision ?? 0) + 1 }, { what: 'test', journal: false })
      return snapshot()
    })
    await entered.promise
    let accepted: { status: number, body: Job }
    try {
      accepted = await call<Job>('PUT', `${of()}/painting`, painting())
      expect(accepted.status).toBe(202)
    } finally { release.resolve() }
    const afterEarlierWriter = await held
    const done = await finished(accepted.body.id)
    expect(done.status).toBe('failed')
    expect(done.error).toMatch(/rig changed.*reload/i)
    expect(snapshot()).toEqual(afterEarlierWriter)
    expect(json<Character>('character.json').revision).toBe(c.revision! + 1)
  })

  it('keeps the original lift reference for legacy shape saves with a stale intermediate from', async () => {
    const lift = painting().lifts[0]
    for (const [from, to] of [
      [[1, 0, 0], [1, 0, .02]],
      [[1, 0, 0], [1, 0, .03]],
      [[1, 0, .02], [1, 0, .04]],
    ] as Array<[Vec3, Vec3]>) await save(`${of()}/shape`, { edits: [{ ...lift, from, to }] })

    const kept = Object.values(json<Record<string, ShapeEdit>>('shape_edits.json'))
    expect(kept).toEqual([{ ...lift, from: [1, 0, 0], to: [1, 0, .04] }])
    const references = await call<ShapeEdit[]>('GET', `${of()}/shape`)
    expect(references.body).toHaveLength(1)
    expect(references.body[0].from).toEqual([1, 0, 0])
    expect(references.body[0].to[2]).toBeCloseTo(.04, 7)
    expect(json<Character>('character.json').revision).toBe(c.revision! + 3)
    const removed = await call<Job>('DELETE', `${of()}/shape`)
    expect(removed.status).toBe(202)
    expect((await finished(removed.body.id)).status).toBe('done')
    expect(accessor(readGlb(readFileSync(file('rigged.glb'))), 0).get(1, 2)).toBe(0)
    expect((await call<ShapeEdit[]>('GET', `${of()}/shape`)).body).toEqual([])
  })

  it('waits for the file lock before reading the rig and its lift references', async () => {
    const entered = deferred(), release = deferred(), requested = deferred()
    const held = store.withFiles(c.id, async () => { entered.resolve(); await release.promise })
    await entered.promise
    let settled = false
    server.once('request', requested.resolve)
    const reading = call<ShapeEdit[]>('GET', `${of()}/shape`).then(response => { settled = true; return response })
    try {
      await requested.promise
      await delay(25)
      expect(settled).toBe(false)
    } finally { release.resolve() }
    await held
    expect(await reading).toEqual({ status: 200, body: [] })
  })
})
