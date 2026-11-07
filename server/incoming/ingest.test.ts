// @vitest-environment node
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { makeCharacter, makeGear } from '../../src/model/fixtures.ts'
import type { Character, Gear } from '../../src/model/types.ts'
import type { Command } from '../../src/model/command-types.ts'

const ws = await mkdtemp(path.join(tmpdir(), 'rigsmith-ingest-'))
process.env.RIGSMITH_WORKSPACE = ws
const { ingest, validateAccept } = await import('./ingest.ts')
const { listIncoming } = await import('./read.ts')
const { getCharacter } = await import('../store.ts')
const { runCommands, undo } = await import('../commands.ts')
const { readJournal } = await import('../journal.ts')
afterAll(async () => { await rm(ws, { recursive: true, force: true }) })
const place = { position: [0.1, 0.2, 0.3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: 0.5 }
const body = (id: string, gear: Gear[] = []): Character => makeCharacter({ id, gear, folk: { sets: [{ id: 'base', name: 'Base', pieces: [], tags: [], grants: [] }], pools: [], kinds: [], stances: [] } })
async function putCharacter (c: Character): Promise<void> { const dir = path.join(ws, 'characters', c.id); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'character.json'), JSON.stringify(c)) }
async function delivery (id: string, parts: Array<{ id: string, type: 'piece' | 'skin' | 'clothes', from?: string, set?: string, slots?: string[] }>): Promise<void> {
  const dir = path.join(ws, 'incoming', id); await mkdir(dir, { recursive: true })
  const manifest = []
  for (const part of parts) {
    const data = part.type === 'piece' ? Buffer.from(`file-${part.id}`) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64'), file = `${part.id}.${part.type === 'piece' ? 'glb' : 'png'}`
    await writeFile(path.join(dir, file), data)
    manifest.push({ ...part, name: part.id, file, sha256: createHash('sha256').update(data).digest('hex'), ...(part.type === 'piece' ? { policy: 'upper', tags: ['covers-hair'] } : {}) })
  }
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ schema: 1, id, at: '2026-11-07T00:00:00Z', tool: 'test', space: 'v6', parts: manifest, sets: [{ id: 'set-a', name: 'Set A', pieces: ['coat'], tags: ['culture:norse'] }] }))
}
function fake (fail = false) {
  let n = 0
  const batches: Command[][] = []
  return {
    batches,
    character: getCharacter,
    upload: async (_id: string, _bytes: Buffer, name: string, from?: string): Promise<Gear> => {
      if (fail) throw new Error('import failed')
      const id = `new${++n}`
      const dir = path.join(ws, 'characters', _id, 'garments', id)
      await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'model.glb'), 'model')
      return makeGear({ id, name: name.replace(/\.glb$/, ''), from, model: `garments/${id}/model.glb`, attach: { kind: 'skin', policy: 'body', place } })
    },
    commands: async (id: string, make: (c: Character) => Command[]) => { const result = await runCommands(id, c => { const batch = make(c); batches.push(batch); return batch }, { what: 'incoming.accept' }); return result.entry?.seq },
    placement: async () => place,
  }
}
it('adds a tagged piece to a set and copies clothes and skin in one undoable entry', async () => {
  const c = body('test-add'); await putCharacter(c)
  await delivery('add', [{ id: 'coat', type: 'piece', set: 'set-a' }, { id: 'cloth', type: 'clothes', slots: ['top'] }, { id: 'skin', type: 'skin' }])
  await ingest({ package: 'add', parts: ['coat', 'cloth', 'skin'], character: c.id }, { sink: fake() })
  const next = (await getCharacter(c.id))!
  expect(next.gear[0]).toMatchObject({ name: 'coat', tags: ['covers-hair'], attach: { policy: 'upper', place } })
  expect(next.folk?.sets.find(s => s.id === 'set-a')).toMatchObject({ id: 'set-a', pieces: ['new1'], tags: ['culture:norse'] })
  expect(next.look.cloth?.[0].slots).toEqual(['top'])
  expect((await readFile(path.join(ws, 'characters', c.id, next.look.skins![0].file))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect((await readFile(path.join(ws, 'characters', c.id, next.look.clothes![0].file))).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect((await readJournal(c.id)).filter(e => e.what === 'incoming.accept')).toHaveLength(1)
  expect((await listIncoming()).packages.find(p => p.id === 'add')?.parts.map(p => p.status)).toEqual(['accepted', 'accepted', 'accepted'])
  expect((await listIncoming(next)).packages.find(p => p.id === 'add')?.parts.find(p => p.id === 'coat')?.acceptedGear).toBe('new1')
  expect((await listIncoming(body('other'))).packages.find(p => p.id === 'add')?.parts.find(p => p.id === 'coat')?.acceptedGear).toBeUndefined()
  const undoneEntry = await undo(c.id)
  const undone = (await getCharacter(c.id))!
  expect(undone.gear).toHaveLength(0); expect(undone.look.skins).toBeUndefined(); expect(undone.look.clothes).toBeUndefined()
  expect((await listIncoming()).packages.find(p => p.id === 'add')?.parts.map(p => p.status)).toEqual(['pending', 'pending', 'pending'])
  expect((await listIncoming(undone)).packages.find(p => p.id === 'add')?.parts.find(p => p.id === 'coat')?.acceptedGear).toBeUndefined()
  await undo(c.id, undoneEntry.entry!.seq)
  expect((await listIncoming()).packages.find(p => p.id === 'add')?.parts.map(p => p.status)).toEqual(['accepted', 'accepted', 'accepted'])
})
it('replacement must undo its model change', async () => {
  const old = makeGear({ id: 'old', name: 'old', from: 'emberhold:gear/coat', model: 'garments/old/model.glb', attach: { kind: 'skin', policy: 'lower', place } })
  const c = body('test-update', [old]); await putCharacter(c); await delivery('update', [{ id: 'coat', type: 'piece', from: old.from }])
  const importer = fake()
  await ingest({ package: 'update', parts: ['coat'], character: c.id }, { sink: importer })
  expect(importer.batches[0]).toEqual([expect.objectContaining({ type: 'gear.update', id: 'old' })])
  const next = (await getCharacter(c.id))!
  expect(next.gear).toHaveLength(1); expect(next.gear[0].model).toMatch(/^garments\/old\/incoming-.*\.glb$/); expect(next.gear[0].attach).toEqual(old.attach)
  expect((await readJournal(c.id)).at(-1)?.changes.join(' ')).toContain('new mesh')
  const undone = await undo(c.id)
  expect((await getCharacter(c.id))!.gear[0]).toMatchObject({ model: old.model, attach: old.attach })
  await undo(c.id, undone.entry!.seq)
  expect((await getCharacter(c.id))!.gear[0]).toMatchObject({ model: next.gear[0].model, attach: old.attach })
})
it.fails('replacement disables old painted weights and undo restores them with the old model', async () => {
  const old = makeGear({ id: 'old', name: 'old', painted: 2, from: 'emberhold:gear/painted', model: 'garments/old/model.glb', attach: { kind: 'skin', policy: 'lower', place } })
  const c = body('test-painted-update', [old]); await putCharacter(c)
  const dir = path.join(ws, 'characters', c.id, 'garments', old.id)
  await mkdir(dir, { recursive: true })
  const weights = '[{"mesh":0,"vertex":1,"weights":[["Hips",1]]}]'
  await writeFile(path.join(dir, 'weights.json'), weights)
  await delivery('painted-update', [{ id: 'coat', type: 'piece', from: old.from }])
  await ingest({ package: 'painted-update', parts: ['coat'], character: c.id }, { sink: fake() })
  const next = (await getCharacter(c.id))!.gear[0]
  expect(next.painted ?? 0).toBe(0)
  expect(next.model).not.toBe(old.model)
  const undone = await undo(c.id)
  expect((await getCharacter(c.id))!.gear[0]).toMatchObject({ model: old.model, painted: 2 })
  expect(await readFile(path.join(dir, 'weights.json'), 'utf8')).toBe(weights)
  await undo(c.id, undone.entry!.seq)
  expect((await getCharacter(c.id))!.gear[0].painted ?? 0).toBe(0)
})
it('leaves a failed import pending and does not journal it', async () => {
  const c = body('test-fail'); await putCharacter(c); await delivery('fail', [{ id: 'coat', type: 'piece' }])
  await expect(ingest({ package: 'fail', parts: ['coat'], character: c.id }, { sink: fake(true) })).rejects.toThrow('import failed')
  expect((await listIncoming()).packages.find(p => p.id === 'fail')?.parts[0].status).toBe('pending')
  expect(await readJournal(c.id)).toHaveLength(0)
})
it('replacing a skin drops the old bare texture and retains omitted metadata', async () => {
  const c = body('test-skin')
  c.look.skins = [{ name: 'skin', file: 'skins/old.png', bare: 'skins/bare/old.png', hair: '#123456', tags: ['elder'] }]
  await putCharacter(c); await delivery('skin-update', [{ id: 'skin', type: 'skin' }])
  expect((await listIncoming(c)).packages.find(p => p.id === 'skin-update')?.parts[0].effect).toBe('update')
  await ingest({ package: 'skin-update', parts: ['skin'], character: c.id }, { sink: fake() })
  expect((await getCharacter(c.id))!.look.skins![0]).toMatchObject({ name: 'skin', hair: '#123456', tags: ['elder'] })
  expect((await getCharacter(c.id))!.look.skins![0].bare).toBeUndefined()
  await undo(c.id)
  expect((await getCharacter(c.id))!.look.skins).toEqual(c.look.skins)
})
it('honors an explicit replacement even when the source identity is new', async () => {
  const old = makeGear({ id: 'old', name: 'old', model: 'garments/old/model.glb', attach: { kind: 'skin', policy: 'lower', place } })
  const c = body('test-chosen', [old]); await putCharacter(c)
  await delivery('chosen', [{ id: 'coat', type: 'piece', from: 'emberhold:gear/new' }])
  await expect(validateAccept({ package: 'chosen', parts: ['coat'], character: c.id, replace: { coat: 'old' } })).resolves.toBeUndefined()
  const importer = fake()
  await ingest({ package: 'chosen', parts: ['coat'], character: c.id, replace: { coat: 'old' } }, { sink: importer })
  expect((await getCharacter(c.id))!.gear[0]).toMatchObject({ id: 'old', from: 'emberhold:gear/new', attach: old.attach })
  expect(importer.batches).toHaveLength(1)
})
