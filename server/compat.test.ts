// @vitest-environment node
// The deprecated v1 layer against a temp workspace: reads answer the v1 view unless the request says schema 2; the v1
// view's status shows the character's job (the game's scripts poll it: a re-import never changes the schema 2
// status); a PATCH of anything but the v1 arrays is 410, naming the key; a v1 POST /rig waits for the file job before
// it, a schema 2 one doesn't.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Job } from '../src/model/types.ts'

// (toV1 as it is, watched: what view() hands it)
vi.mock('../src/model/legacy.ts', async original => {
  const m = await original<typeof import('../src/model/legacy.ts')>()
  return { ...m, toV1: vi.fn(m.toV1) }
})

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-compat-'))
process.env.RIGSMITH_WORKSPACE = dir // read when store.ts is first imported
let store: typeof import('./store.ts')
let http: typeof import('./http.ts')
let compat: typeof import('./compat.ts')
let jobs: typeof import('./jobs.ts')
let legacy: typeof import('../src/model/legacy.ts')

beforeAll(async () => {
  store = await import('./store.ts')
  http = await import('./http.ts')
  compat = await import('./compat.ts')
  jobs = await import('./jobs.ts')
  legacy = await import('../src/model/legacy.ts')
  await import('./routes/characters.ts')
  // (stands in for the rig route of server/routes/skin.ts, registered after compat's as api.ts does: says whether a
  // file job was still on the character when the request got here)
  http.route('POST', /^\/api\/characters\/([a-z0-9-]+)\/rig$/, async (_req, res, [id]) => {
    http.send(res, 202, { busy: jobs.busy(id, 'files')?.kind ?? null })
  })
  await store.ensureWorkspace()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
const make = async (name: string): Promise<string> => {
  const id = (await store.createCharacter(`${name}.glb`, Buffer.from(`${name} ${n++}`))).id
  await store.updateCharacter(id, c => { c.status = 'rigged'; c.files.rigged = 'rigged.glb' })
  return id
}

interface Answer { status: number, body: Record<string, unknown> & { error?: string } }
async function call (method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<Answer> {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const req = Object.assign(Readable.from(chunks), { method, url, headers })
  const answer: Answer = { status: 0, body: {} }
  const res = {
    headersSent: false,
    writeHead (status: number) { answer.status = status; this.headersSent = true },
    end (text?: string) { answer.body = text === undefined ? {} : JSON.parse(text) as Answer['body'] },
  }
  await http.handle(req as never, res as never)
  return answer
}

const V2 = { 'x-rigsmith-schema': '2' }

/** A job on the character that runs until `release()`. */
function hold (id: string, kind: string): { job: Job, release: () => void, done: Promise<void> } {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let finish!: () => void
  const done = new Promise<void>(resolve => { finish = resolve })
  const job = jobs.enqueue(kind, `Test ${kind}`, id, async () => { await gate; finish() }, { lock: 'files' })
  return { job, release, done }
}

async function until (ok: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

const settled = (job: Job): boolean => job.status !== 'queued' && job.status !== 'running'

describe('reads', () => {
  it('answers the v1 view without x-rigsmith-schema', async () => {
    const id = await make('Archer')
    const one = await call('GET', `/api/characters/${id}`)
    expect(one.status).toBe(200)
    expect(one.body).toMatchObject({ id, name: 'Archer', status: 'rigged', animations: [] })
    expect(one.body.schema).toBeUndefined()
    expect(one.body.skeleton).toBeUndefined()
    const list = await call('GET', '/api/characters')
    const mine = (list.body as unknown as Array<Record<string, unknown>>).find(c => c.id === id)!
    expect(mine).toMatchObject({ id, animations: [] })
    expect(mine.schema).toBeUndefined()
  })

  it('answers the document (schema 4) with x-rigsmith-schema: 2, 3 or 4', async () => {
    const id = await make('Lancer')
    const one = await call('GET', `/api/characters/${id}`, V2)
    expect(one.body).toMatchObject({ id, schema: 4, status: 'rigged', clips: [], gear: [] })
    expect(one.body.animations).toBeUndefined()
    const list = await call('GET', '/api/characters', V2)
    expect((list.body as unknown as Array<Record<string, unknown>>).find(c => c.id === id)).toMatchObject({ schema: 4 })
    const three = await call('GET', `/api/characters/${id}`, { ...V2, 'x-rigsmith-schema': '3' })
    expect(three.body).toMatchObject({ id, schema: 4 })
    const four = await call('GET', `/api/characters/${id}`, { ...V2, 'x-rigsmith-schema': '4' })
    expect(four.body).toMatchObject({ id, schema: 4 })
  })
})

describe('the v1 status', () => {
  it('shows a re-import while it runs, then the status again; schema 2 never shows it', async () => {
    const id = await make('Smith')
    const { job, release, done } = hold(id, 'reimport')
    await until(() => job.status === 'running')
    const v1 = await call('GET', `/api/characters/${id}`)
    expect(vi.mocked(legacy.toV1)).toHaveBeenLastCalledWith(expect.objectContaining({ id }), expect.anything(), { kind: 'reimport', status: 'running' })
    expect(v1.body.status).toBe('importing')
    expect((await call('GET', `/api/characters/${id}`, V2)).body.status).toBe('rigged')
    release()
    await done
    await until(() => settled(job))
    await call('GET', `/api/characters/${id}`)
    expect(vi.mocked(legacy.toV1)).toHaveBeenLastCalledWith(expect.objectContaining({ id }), expect.anything(), null)
    expect((await call('GET', `/api/characters/${id}`)).body.status).toBe('rigged')
  })

  it('shows a rig queued behind another job as rigging', async () => {
    const id = await make('Mason')
    const first = hold(id, 'compose')
    const rig = hold(id, 'rig')
    await until(() => first.job.status === 'running')
    expect(rig.job.status).toBe('queued')
    expect(compat.jobOf(id)).toEqual({ kind: 'rig', status: 'queued' })
    expect((await call('GET', `/api/characters/${id}`)).body.status).toBe('rigging')
    first.release()
    rig.release()
    await until(() => settled(first.job) && settled(rig.job))
  })
})

describe('jobOf', () => {
  const job = (o: Partial<Job>): Job => ({ id: 'x', kind: 'compose', label: '', characterId: 'a', status: 'running', progress: 0, message: '', createdAt: 1, ...o })

  it('is null when nothing works on the character', () => {
    expect(compat.jobOf('a', [])).toBeNull()
    expect(compat.jobOf('a', [job({ status: 'done' }), job({ status: 'failed', kind: 'rig' }), job({ characterId: 'b' })])).toBeNull()
  })

  it('picks an import or a rig first, then a running job, then the oldest', () => {
    expect(compat.jobOf('a', [job({ kind: 'compose' }), job({ kind: 'rig', status: 'queued' })])).toEqual({ kind: 'rig', status: 'queued' })
    expect(compat.jobOf('a', [job({ kind: 'rig', status: 'queued', createdAt: 2 }), job({ kind: 'reimport', status: 'queued', createdAt: 1 })])).toEqual({ kind: 'reimport', status: 'queued' })
    expect(compat.jobOf('a', [job({ kind: 'texture', status: 'queued' }), job({ kind: 'compose', status: 'running' })])).toEqual({ kind: 'compose', status: 'running' })
  })
})

describe('PATCH', () => {
  it('takes the v1 arrays as one batch and answers the v1 view', async () => {
    const id = await make('Ranger')
    const done = await call('PATCH', `/api/characters/${id}`, { 'x-rigsmith-by': 'agent' }, {
      animations: [{ clipId: 'mixamo-Walking', name: 'Walk', inPlace: true, loop: true, speed: 1 }],
    })
    expect(done.status).toBe(200)
    expect(done.body.animations).toMatchObject([{ clipId: 'mixamo-Walking', name: 'Walk' }])
    expect((await store.getCharacter(id))!.clips.map(s => s.name)).toEqual(['Walk'])
  })

  it('answers 410 naming any other key, and changes nothing', async () => {
    const id = await make('Herald')
    const version = (await store.getCharacter(id))!.version
    const gone = await call('PATCH', `/api/characters/${id}`, { 'x-rigsmith-by': 'agent' }, { name: 'Renamed', animations: [] })
    expect(gone.status).toBe(410)
    expect(gone.body.error).toContain('name')
    expect(gone.body.error).toContain(`/api/characters/${id}/commands`)
    const joints = await call('PATCH', `/api/characters/${id}`, { 'x-rigsmith': '1' }, { joints: {} })
    expect(joints.status).toBe(410)
    expect(joints.body.error).toContain('joints')
    expect((await store.getCharacter(id))!).toMatchObject({ name: 'Herald', version })
  })
})

describe('POST /rig', () => {
  it('waits, for a v1 client, until the file job before it is done', async () => {
    const id = await make('Reaver')
    const { job, release } = hold(id, 'reimport')
    await until(() => job.status === 'running')
    let answered = false
    const pending = call('POST', `/api/characters/${id}/rig`, { 'x-rigsmith-by': 'agent' }).then(a => { answered = true; return a })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(answered).toBe(false)
    release()
    const answer = await pending
    expect(answer).toEqual({ status: 202, body: { busy: null } })
  })

  it('goes straight on for a schema 2 client', async () => {
    const id = await make('Warden')
    const { job, release } = hold(id, 'reimport')
    await until(() => job.status === 'running')
    expect(await call('POST', `/api/characters/${id}/rig`, { 'x-rigsmith': '1', ...V2 })).toEqual({ status: 202, body: { busy: 'reimport' } })
    release()
    await until(() => settled(job))
  })

  it('stops waiting after the time it is given', async () => {
    const id = await make('Sentry')
    const { job, release } = hold(id, 'fit')
    await until(() => job.status === 'running')
    expect(await compat.filesIdle(id, 20)).toBe(false)
    const idle = compat.filesIdle(id, 2000)
    release()
    expect(await idle).toBe(true)
  })
})
