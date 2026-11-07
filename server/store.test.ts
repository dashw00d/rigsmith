// @vitest-environment node
// The store against a temp workspace: a v1 file migrated when first read (its v1 copy kept once, the texture copied to
// a layer, one journal entry), updateCharacter's versions, journal and events, the journal's legacy lines, settings,
// and the startup sweep of unused gear folders.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Character, Gear } from '../src/model/types.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-store-'))
process.env.RIGSMITH_WORKSPACE = dir // read when store.ts is first imported
let store: typeof import('./store.ts')
let journal: typeof import('./journal.ts')

beforeAll(async () => {
  store = await import('./store.ts')
  journal = await import('./journal.ts')
  await store.ensureWorkspace()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

const characterFile = (id: string, file = 'character.json'): string => path.join(dir, 'characters', id, file)

function put (id: string, files: Record<string, string | Buffer>): void {
  for (const [file, data] of Object.entries(files)) {
    mkdirSync(path.dirname(characterFile(id, file)), { recursive: true })
    writeFileSync(characterFile(id, file), data)
  }
}

const v1 = (id: string, name = 'Old Hand'): Record<string, unknown> => ({
  id, name, createdAt: 1, updatedAt: 2,
  source: { file: 'source/original.glb', originalName: 'old.glb', bytes: 10 },
  status: 'ready', kind: 'mesh', files: { model: 'model.glb' },
  joints: { Hips: [0, 1, 0], Spine: [0, 1.2, 0] },
  animations: [{ clipId: 'mixamo-Idle', name: 'Idle', inPlace: true, loop: true, speed: 1 }],
})

const gear = (id: string, name: string): Gear => ({
  id, name, status: 'ready', handles: [],
  attach: { kind: 'bone', bone: 'Spine', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
})

describe('migration on read', () => {
  const id = 'old-hand-aaaaaa'
  const png = Buffer.from('not really a png')

  it('migrates a v1 file in place, keeps its v1 copy, copies textures to layers and journals it', async () => {
    const original = JSON.stringify(v1(id))
    put(id, {
      'character.json': original,
      'textures/Body.png': png,
      'textures/Body.mask.png': 'mask',
      'journal.jsonl': JSON.stringify({ at: '2026-10-20T00:00:00.000Z', by: 'app', changes: ['clip Idle: added'] }) + '\n',
    })
    const c = (await store.getCharacter(id))!
    expect(c.schema).toBe(5)
    expect(c.clips.map(s => s.name)).toEqual(['Idle'])
    expect(c.skeleton.detected).toEqual({ Hips: [0, 1, 0], Spine: [0, 1.2, 0] })
    // (written back as schema 5, the v1 file beside it and no v2 one: it never was)
    expect(JSON.parse(readFileSync(characterFile(id), 'utf8')).schema).toBe(5)
    expect(readFileSync(characterFile(id, 'character.v1.json'), 'utf8')).toBe(original)
    expect(existsSync(characterFile(id, 'character.v2.json'))).toBe(false)
    // (one snapshot layer for the texture, not for its hole mask; copied, the original left where it was)
    expect(c.look.layers.map(l => [l.kind, l.image])).toEqual([['snapshot', 'Body']])
    expect(readFileSync(characterFile(id, c.look.layers[0].file))).toEqual(png)
    expect(existsSync(characterFile(id, 'textures/Body.png'))).toBe(true)

    const entries = await journal.readJournal(id)
    expect(entries.map(e => [e.seq, e.what])).toEqual([[-1, 'legacy'], [1, 'migrate']])
    expect(entries[0].changes).toEqual(['clip Idle: added'])
    expect(entries[1].undo).toBeUndefined()
  })

  it('reads a migrated file as it is', async () => {
    const again = (await store.getCharacter(id))!
    expect(again.version).toBe(1)
    expect((await journal.readJournal(id)).length).toBe(2)
    expect((await store.listCharacters()).map(c => c.id)).toContain(id)
  })

  it('keeps the first v1 copy when a v1 file is written over it again, and never hands out an older version', async () => {
    const first = readFileSync(characterFile(id, 'character.v1.json'), 'utf8')
    await store.updateCharacter(id, c => { c.name = 'Newer' })
    const before = (await store.getCharacter(id))!.version
    writeFileSync(characterFile(id), JSON.stringify(v1(id, 'Offline Edit')))
    const c = (await store.getCharacter(id))!
    expect(c.name).toBe('Offline Edit')
    expect(c.version).toBeGreaterThan(before)
    expect(readFileSync(characterFile(id, 'character.v1.json'), 'utf8')).toBe(first)
  })
})

describe('migration of a schema 2 file on read', () => {
  it('moves it to schema 5, keeps its v2 copy, and says when a cut slot couldn\'t be measured', async () => {
    const id = 'mid-age-bbbbbb'
    // (schema 2 as the v1 one migrates to, with an Attack whose blow timing cut keys and a hold)
    const v2 = { ...(await import('../src/model/migrate.ts')).migrateV1(v1(id, 'Mid Age')).character, clips: [{
      id: 'atk', name: 'Attack', clip: { id: 'mixamo-Stab' }, speed: 1, loop: false, inPlace: true, adjustments: [
        { id: 'b', kind: 'blowTiming', enabled: true, at: 0.45 },
        { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [{ u: 0.5, q: [0, 0, 0, 1] }] } },
      ],
    }] }
    const original = JSON.stringify(v2)
    put(id, { 'character.json': original })
    const c = (await store.getCharacter(id))!
    expect(c.schema).toBe(5)
    expect(c.clips[0]).toMatchObject({ time: { fit: { enabled: true, at: 0.45 } }, bones: { Spine: [{ u: 0.5 }] }, adjustments: [] })
    expect(readFileSync(characterFile(id, 'character.v2.json'), 'utf8')).toBe(original)
    expect(existsSync(characterFile(id, 'character.v1.json'))).toBe(false)
    // (no rig to measure its clip on: its phases kept, and the journal says so)
    const said = (await journal.readJournal(id)).flatMap(e => e.changes).join('\n')
    expect(said).toMatch(/not measured: Mid Age has no rig/)
    expect(said).toMatch(/couldn't be measured/)
  }, 60_000)
})

describe('migration of a schema 3 file on read', () => {
  it('moves it to schema 5 and keeps its v3 copy; holds whose clip can\'t be measured go with a note', async () => {
    const id = 'late-age-cccccc'
    const v2 = (await import('../src/model/migrate.ts')).migrateV1(v1(id, 'Late Age')).character
    const v3 = { ...v2, schema: 3, clips: [
      { id: 'idle', name: 'Idle', clip: { id: 'mixamo-Idle' }, speed: 1, loop: true, inPlace: true, adjustments: [] },
      { id: 'atk', name: 'Attack', clip: { id: 'mixamo-Stab' }, speed: 1, loop: false, inPlace: true, adjustments: [], time: { holds: [{ id: 'h', u: 0.5, seconds: 0.25 }] } },
    ] }
    const original = JSON.stringify(v3)
    put(id, { 'character.json': original })
    const c = (await store.getCharacter(id))!
    expect(c.schema).toBe(5)
    expect(c.clips[0]).toEqual(v3.clips[0])
    expect(c.clips[1].time).toBeUndefined()
    expect(readFileSync(characterFile(id, 'character.v3.json'), 'utf8')).toBe(original)
    expect(JSON.parse(readFileSync(characterFile(id), 'utf8')).schema).toBe(5)
    const said = (await journal.readJournal(id)).flatMap(e => e.changes).join('\n')
    expect(said).toMatch(/hold dropped/)
  }, 60_000)
})

describe('migration of a schema 4 file on read', () => {
  it('moves it to schema 5 and keeps its v4 copy; a dynamic character gets its folk section', async () => {
    const id = 'folk-four-dddddd'
    const v2 = (await import('../src/model/migrate.ts')).migrateV1(v1(id, 'Folk Four')).character
    const v4 = { ...v2, schema: 4, gear: [{ ...gear('g1', 'Outfit_mail_helm'), outfit: 'mail', tags: ['covers-hair'] }] }
    const original = JSON.stringify(v4)
    put(id, { 'character.json': original })
    const c = (await store.getCharacter(id))!
    expect(c.schema).toBe(5)
    expect(c.folk?.sets.map(s => [s.name, s.pieces, s.grants])).toEqual([['mail', ['g1'], ['covers-hair']]])
    expect(readFileSync(characterFile(id, 'character.v4.json'), 'utf8')).toBe(original)
    expect(existsSync(characterFile(id, 'character.v3.json'))).toBe(false)
    expect(JSON.parse(readFileSync(characterFile(id), 'utf8')).schema).toBe(5)
    const said = (await journal.readJournal(id)).flatMap(e => e.changes).join('\n')
    expect(said).toMatch(/outfit is a set/)
  }, 60_000)
})

describe('migrationContext', () => {
  const raw = async (id: string): Promise<Record<string, unknown>> => ({
    ...(await import('../src/model/migrate.ts')).migrateV1(v1(id, 'Measured')).character,
    clips: [{
      id: 'atk', name: 'Attack', clip: { id: 'mixamo-Stab' }, speed: 1, loop: false, inPlace: true, adjustments: [
        { id: 'b', kind: 'blowTiming', enabled: true, at: 0.45 },
        { id: 'k', kind: 'keys', enabled: true, bones: { Spine: [{ u: 0.5, q: [0, 0, 0, 1] }] } },
      ],
    }],
  })

  it('refuses a migration whose clip failed to measure, and takes one whose clip doesn\'t exist', async () => {
    const id = 'measured-cccccc'
    const r = await raw(id)
    put(id, { 'character.json': JSON.stringify(r) })
    // (the child crashed or timed out)
    await expect(store.migrationContext(id, r, async () => { throw new Error('timed out') })).rejects.toThrow(/could not be measured \(timed out\).*left at schema 2/)
    // (the clip failed to load: not missing)
    await expect(store.migrationContext(id, r, async () => ({ times: {}, problems: ['clip Attack: bad GLB'] }))).rejects.toThrow(/clips Attack could not be measured \(clip Attack: bad GLB\)/)
    // (the clip isn't there: migrated with its phases kept, said)
    const gone = await store.migrationContext(id, r, async () => ({ times: {}, problems: ['clip Attack: no clip file'], missing: ['atk'] }))
    expect(gone.notes).toEqual(['not measured: clip Attack: no clip file'])
    const measured = await store.migrationContext(id, r, async () => ({ times: { atk: { seconds: 2, blow: 0.6 } }, problems: [] }))
    expect(measured.ctx.clipTimes).toEqual({ atk: { seconds: 2, blow: 0.6 } })
  })
})

describe('updateCharacter', () => {
  let id = ''
  const heard: Array<{ character: Character, entry?: { seq: number } }> = []

  beforeAll(async () => {
    store.events.on('character', (x: { character: Character, entry?: { seq: number } }) => { heard.push(x) })
    id = (await store.createCharacter('Knight.glb', Buffer.from('knight bytes'))).id
  })

  it('creates a schema 5 character at version 1 with an import entry', async () => {
    const c = (await store.getCharacter(id))!
    expect(c).toMatchObject({ schema: 5, version: 1, name: 'Knight', status: 'importing', gear: [], clips: [] })
    expect((await journal.readJournal(id)).map(e => [e.seq, e.what])).toEqual([[1, 'import']])
  })

  it('bumps the version, journals with touched and undo, and tells open pages and hooks', async () => {
    const hooked: string[][] = []
    const off = store.afterChange('name', change => { hooked.push(change.touched) })
    const before = (await store.getCharacter(id))!
    const done = await store.commit(id, c => { c.name = 'Sir Knight' }, { by: 'agent', what: 'character.rename', changes: ['name: Knight -> Sir Knight'], undoable: true, cid: 'c-1' })
    off()
    expect(done.character.version).toBe(before.version + 1)
    expect(done.character.updatedAt).toBeGreaterThanOrEqual(before.updatedAt)
    expect(done.entry).toMatchObject({ seq: 2, by: 'agent', what: 'character.rename', changes: ['name: Knight -> Sir Knight'], touched: ['name'], cid: 'c-1' })
    expect(done.entry!.undo!.entities.map(e => [e.key, e.before])).toEqual([['name', 'Knight']])
    expect(heard.at(-1)).toEqual({ character: done.character, entry: done.entry })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(hooked).toEqual([['name']])
  })

  it('takes a returned document as well as an edited one', async () => {
    const c = await store.updateCharacter(id, c => ({ ...c, name: 'Returned' }), { what: 'character.rename' })
    expect(c.name).toBe('Returned')
    expect((await store.getCharacter(id))!.name).toBe('Returned')
  })

  it('does not journal housekeeping, and writes nothing for no change', async () => {
    const entries = (await journal.readJournal(id)).length
    const v = (await store.getCharacter(id))!.version
    await store.updateCharacter(id, c => { c.status = 'ready' })
    await store.updateCharacter(id, c => { c.thumbVersion = 5 }, { what: 'thumbnail', journal: false })
    expect((await store.getCharacter(id))!.version).toBe(v + 2)
    const same = await store.commit(id, () => {}, { what: 'nothing' })
    expect(same.entry).toBeNull()
    expect(same.character.version).toBe(v + 2)
    expect((await journal.readJournal(id)).length).toBe(entries)
  })

  it('writes nothing when the change throws', async () => {
    const v = (await store.getCharacter(id))!.version
    await expect(store.updateCharacter(id, c => { c.name = 'Lost'; throw new Error('no') })).rejects.toThrow('no')
    expect((await store.getCharacter(id))!).toMatchObject({ version: v, name: 'Returned' })
  })

  it('marks a failed job on the character and passes the error on', async () => {
    await expect(store.failCharacter(id, new Error('Blender fell over'))).rejects.toThrow('Blender fell over')
    expect((await store.getCharacter(id))!).toMatchObject({ status: 'error', error: 'Blender fell over' })
  })

  it('answers 404 for a character that is not there', async () => {
    await expect(store.updateCharacter('nobody-000000', () => {})).rejects.toMatchObject({ status: 404 })
  })
})

describe('journal', () => {
  it('derives undoneBy, an undo taken back (a redo) leaving its target live', () => {
    const e = (seq: number, undoes?: number): Parameters<typeof journal.withUndone>[0][number] =>
      ({ seq, at: '', by: 'app', what: 'x', changes: [], undo: { entities: [] }, ...(undoes !== undefined ? { undoes } : {}) })
    expect(journal.withUndone([e(1), e(2, 1)]).map(x => x.undoneBy)).toEqual([2, undefined])
    expect(journal.withUndone([e(1), e(2, 1), e(3, 2)]).map(x => x.undoneBy)).toEqual([undefined, 3, undefined])
    expect(journal.withUndone([e(1), e(2, 1), e(3, 2), e(4, 1)]).map(x => x.undoneBy)).toEqual([4, 3, undefined, undefined])
  })
})

describe('settings', () => {
  it('reads v1 settings as schema 2 and saves only what schema 2 has', async () => {
    writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ exportDir: '/tmp/x', exportFormat: 'glb', boneNames: 'mixamo', gameRepo: '/games/e' }))
    expect(await store.getSettings()).toEqual({ gameRepo: '/games/e' })
    const saved = await store.saveSettings({ gameRepo: '~/games/other', exportDir: '/nope' } as never)
    expect(saved.gameRepo.startsWith('~')).toBe(false)
    expect(JSON.parse(readFileSync(path.join(dir, 'settings.json'), 'utf8'))).toEqual({ gameRepo: saved.gameRepo })
  })
})

describe('orphan gear folders', () => {
  it('moves folders no gear uses and no undo could restore to the trash, and deletes nothing', async () => {
    const id = (await store.createCharacter('Trader.glb', Buffer.from('trader bytes'))).id
    await store.updateCharacter(id, c => { c.gear.push(gear('aaaa0001', 'Axe'), gear('aaaa0002', 'Bow')) })
    // (Bow removed undoably: its folder must stay, undo would bring it back)
    await store.updateCharacter(id, c => { c.gear = c.gear.filter(g => g.id !== 'aaaa0002') }, { what: 'gear.remove', undoable: true })
    put(id, { 'garments/aaaa0001/model.glb': 'axe', 'garments/aaaa0002/model.glb': 'bow', 'garments/aaaa0003/source.glb': 'left over' })
    expect(await store.sweepOrphanGarments()).toBe(1)
    expect(readdirSync(characterFile(id, 'garments')).sort()).toEqual(['aaaa0001', 'aaaa0002'])
    const trash = path.join(dir, 'trash', id, 'garments')
    const [moved] = readdirSync(trash)
    expect(moved.startsWith('aaaa0003-')).toBe(true)
    expect(readFileSync(path.join(trash, moved, 'source.glb'), 'utf8')).toBe('left over')
  })
})

describe('delete', () => {
  it('moves the folder to the trash and tells open pages', async () => {
    const id = (await store.createCharacter('Gone.glb', Buffer.from('gone bytes'))).id
    const removed: string[] = []
    store.events.on('removed', (x: string) => { removed.push(x) })
    await store.deleteCharacter(id)
    expect(await store.getCharacter(id)).toBeNull()
    expect(removed).toEqual([id])
    expect(readdirSync(path.join(dir, 'trash')).some(f => f.startsWith(`${id}-`))).toBe(true)
  })
})
