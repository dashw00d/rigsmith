// @vitest-environment node
// After a restart (server/api.ts resumeInterrupted) against a temp workspace: a rig cut off goes back to the rig it had
// (rigged when files.rigged is on disk, else ready) with a journal line; the files killed jobs leave are deleted and
// nothing else; a texture whose files don't hold its layers is composed again. Then DELETE /api/characters/:id: 409
// { riders, units, busy } while ridden, named by a game unit or busy, and ?force=1, which deletes anyway and gets the
// riders off.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Job, Mount } from '../src/model/types.ts'

// (no Blender: imports aren't inspected again, and whether a texture is due is said here)
vi.mock('./inspect.ts', async original => ({ ...await original<typeof import('./inspect.ts')>(), resumeImports: vi.fn() }))
vi.mock('./routes/look.ts', async original => ({
  ...await original<typeof import('./routes/look.ts')>(),
  composeStale: vi.fn(async () => false),
  compose: vi.fn(),
}))

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-resume-'))
process.env.RIGSMITH_WORKSPACE = dir // read when store.ts is first imported
let store: typeof import('./store.ts')
let journal: typeof import('./journal.ts')
let api: typeof import('./api.ts')
let jobs: typeof import('./jobs.ts')
let look: typeof import('./routes/look.ts')
let inspect: typeof import('./inspect.ts')

beforeAll(async () => {
  store = await import('./store.ts')
  journal = await import('./journal.ts')
  api = await import('./api.ts')
  jobs = await import('./jobs.ts')
  look = await import('./routes/look.ts')
  inspect = await import('./inspect.ts')
  await store.ensureWorkspace()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
/** A character done importing (so nothing would inspect it again). */
const make = async (name: string, status: 'ready' | 'rigging' | 'rigged' = 'ready'): Promise<string> => {
  const id = (await store.createCharacter(`${name}.glb`, Buffer.from(`${name} ${n++}`))).id
  await store.updateCharacter(id, c => { c.status = status; c.files.model = 'model.glb' })
  return id
}

describe('restart recovery', () => {
  beforeEach(() => { vi.mocked(look.compose).mockClear(); vi.mocked(look.composeStale).mockClear() })

  it('calls off a rig cut off, keeping the rig on disk, with a journal line', async () => {
    const id = await make('Knight', 'rigging')
    await store.updateCharacter(id, c => { c.files.rigged = 'rigged.glb' })
    writeFileSync(path.join(store.characterDir(id), 'rigged.glb'), 'glb')
    await api.resumeInterrupted()
    expect(await store.getCharacter(id)).toMatchObject({ status: 'rigged', error: 'the rig was interrupted' })
    const last = (await journal.readJournal(id)).at(-1)!
    expect(last).toMatchObject({ by: 'server', what: 'rig' })
    expect(last.changes.join(' ')).toMatch(/interrupted.*previous rig is kept/)
  })

  it('goes back to ready when there is no rig on disk', async () => {
    const id = await make('Squire', 'rigging')
    // (named, but the file is gone)
    await store.updateCharacter(id, c => { c.files.rigged = 'rigged.glb' })
    await api.resumeInterrupted()
    expect(await store.getCharacter(id)).toMatchObject({ status: 'ready', error: 'the rig was interrupted' })
    const last = (await journal.readJournal(id)).at(-1)!
    expect(last).toMatchObject({ by: 'server', what: 'rig' })
    expect(last.changes.join(' ')).toContain('interrupted')
    expect(last.changes.join(' ')).not.toContain('previous rig')
  })

  it('leaves a character that was not rigging as it was', async () => {
    const id = await make('Page', 'rigged')
    const before = (await store.getCharacter(id))!
    await api.resumeInterrupted()
    expect((await store.getCharacter(id))!.version).toBe(before.version)
  })

  it('deletes the files killed jobs leave behind, and nothing else', async () => {
    const id = await make('Yeoman', 'rigged')
    const folder = store.characterDir(id)
    const stray = [
      'rigging-0a1b2c3d.glb', 'rigging-0a1b2c3d-heat.glb', 'rigging-0a1b2c3d-before-optimize.glb', 'rigging-0a1b2c3d.glb.paint.json',
      'finger-joints-0a1b2c3d.json', 'rigged.glb.4242.tmp', 'rigged.glb.paint-0a1b2c3d.tmp', 'rigged.glb.fit-0a1b2c3d.tmp',
      'model.glb.4242.tmp',
    ]
    const kept = ['rigged.glb', 'model.glb', 'rigging-0a1b2c3d.glb.previous.glb', 'joints.json', 'rigged.glb.bak', 'weight_edits.json']
    for (const f of [...stray, ...kept]) writeFileSync(path.join(folder, f), 'x')
    await api.resumeInterrupted()
    const left = readdirSync(folder)
    for (const f of stray) expect(left).not.toContain(f)
    for (const f of kept) expect(left).toContain(f)
  })

  it('names the stray files by pattern', () => {
    expect(api.STRAY.test('rigged.glb.123.tmp')).toBe(true)
    expect(api.STRAY.test('rigged.glb.paint-ab12.tmp')).toBe(true)
    expect(api.STRAY.test('rigged.glb')).toBe(false)
    expect(api.STRAY.test('rigged.glb.tmp')).toBe(false)
    expect(api.STRAY.test('model.glb.123.tmp')).toBe(true)
    expect(api.STRAY.test('weight_edits.json.123.tmp')).toBe(false)
    expect(api.STRAY.test('rigging-abc.glb.previous.glb')).toBe(false)
    expect(api.STRAY.test('character.json.ab12cd34.tmp')).toBe(false)
  })

  it('composes again a texture whose files do not hold its layers, and only that', async () => {
    const due = await make('Bard', 'rigged')
    const fine = await make('Monk', 'rigged')
    vi.mocked(look.composeStale).mockImplementation(async c => c.id === due)
    await api.resumeInterrupted()
    const asked = vi.mocked(look.composeStale).mock.calls.map(([c]) => c.id)
    expect(asked).toEqual(expect.arrayContaining([due, fine]))
    expect(vi.mocked(look.compose).mock.calls).toEqual([[due, 'Bard']])
    vi.mocked(look.composeStale).mockImplementation(async () => false)
  })

  it('hands the characters to the import resume', async () => {
    await api.resumeInterrupted()
    expect(vi.mocked(inspect.resumeImports)).toHaveBeenCalled()
  })
})

describe('DELETE /api/characters/:id', () => {
  interface Answer { status: number, body: Record<string, unknown> }
  async function del (id: string, force = false): Promise<Answer> {
    const req = Object.assign(Readable.from([]), { method: 'DELETE', url: `/api/characters/${id}${force ? '?force=1' : ''}`, headers: { 'x-rigsmith': '1' } })
    const answer: Answer = { status: 0, body: {} }
    const res = {
      headersSent: false,
      writeHead (status: number) { answer.status = status; this.headersSent = true },
      end (text?: string) { answer.body = text === undefined ? {} : JSON.parse(text) as Record<string, unknown> },
    }
    await api.handle(req as never, res as never)
    return answer
  }

  const seat = (horse: string): Mount => ({ character: horse, bone: 'Spine', position: [0, 1, 0], rotation: [0, 0, 0], freeze: [], pose: {} })

  /** A job on the character that runs until cancelled. */
  function busy (id: string): Job {
    return jobs.enqueue('fit', 'Test resize', id, async (_job, _update, signal) => {
      await new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason as Error) }) })
    }, { lock: 'files' })
  }

  async function until (ok: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out')
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }

  it('refuses (409) while a rider sits on it, naming the riders', async () => {
    const horse = await make('Mare')
    const rider = await make('Rider')
    await store.updateCharacter(rider, c => { c.mount = seat(horse) })
    const refused = await del(horse)
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ riders: [rider], units: [], busy: null })
    expect(String(refused.body.error)).toContain('Rider')
    expect(await store.getCharacter(horse)).not.toBeNull()
  })

  it('refuses (409) while a game unit names it, as unit or companion', async () => {
    const id = await make('Footman')
    const horse = await make('Stallion')
    mkdirSync(path.dirname(store.UNITS_FILE), { recursive: true })
    writeFileSync(store.UNITS_FILE, JSON.stringify({ units: { footman: { character: id }, lancer: { character: 'x', companion: { character: horse } } } }))
    try {
      expect(await del(id)).toMatchObject({ status: 409, body: { riders: [], units: ['footman'], busy: null } })
      expect(await del(horse)).toMatchObject({ status: 409, body: { units: ['lancer'] } })
    } finally {
      rmSync(store.UNITS_FILE, { force: true })
    }
  })

  it('refuses (409) while a job works on it, naming the job', async () => {
    const id = await make('Archer')
    const job = busy(id)
    await until(() => job.status === 'running')
    const refused = await del(id)
    expect(refused.status).toBe(409)
    expect(refused.body).toMatchObject({ riders: [], units: [], busy: { id: job.id, kind: 'fit', status: 'running' } })
    jobs.cancel(job.id)
    await until(() => job.status === 'cancelled')
  })

  it('with ?force=1 deletes anyway: its jobs cancelled, its riders on foot (journaled on them)', async () => {
    const horse = await make('Gelding')
    const rider = await make('Hussar')
    await store.updateCharacter(rider, c => { c.mount = seat(horse) })
    const job = busy(horse)
    await until(() => job.status === 'running')
    const done = await del(horse, true)
    expect(done).toEqual({ status: 200, body: { ok: true } })
    await until(() => job.status === 'cancelled')
    expect(await store.getCharacter(horse)).toBeNull()
    expect(existsSync(store.characterDir(horse))).toBe(false)
    expect(readdirSync(store.TRASH).some(f => f.startsWith(`${horse}-`))).toBe(true)
    expect((await store.getCharacter(rider))!.mount).toBeUndefined()
    const last = (await journal.readJournal(rider)).at(-1)!
    expect(last.what).toBe('mount.set')
    expect(last.changes.join(' ')).toContain('Gelding was deleted')
  })

  it('deletes at once what nothing holds', async () => {
    const id = await make('Peasant')
    expect(await del(id)).toEqual({ status: 200, body: { ok: true } })
    expect(await store.getCharacter(id)).toBeNull()
  })
})
