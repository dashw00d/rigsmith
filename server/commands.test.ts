// @vitest-environment node
// Commands and undo against a temp workspace: one entry per request (a batch all or nothing), undo by default and by
// seq, a redo, an undo refused because a later write changed the same entity, gear removed from a horse coming off its
// riders, a resized horse's riders' seats scaled with it, and the HTTP route with its header guard.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Command } from '../src/model/command-types.ts'
import type { Gear, Mount, Slot } from '../src/model/types.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-commands-'))
process.env.RIGSMITH_WORKSPACE = dir // read when store.ts is first imported
let store: typeof import('./store.ts')
let journal: typeof import('./journal.ts')
let commands: typeof import('./commands.ts')
let http: typeof import('./http.ts')

beforeAll(async () => {
  store = await import('./store.ts')
  journal = await import('./journal.ts')
  commands = await import('./commands.ts')
  http = await import('./http.ts')
  await store.ensureWorkspace()
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

let n = 0
const make = async (name: string): Promise<string> => (await store.createCharacter(`${name}.glb`, Buffer.from(`${name} ${n++}`))).id

const slot = (id: string, name: string): Slot => ({ id, name, clip: { id: 'mixamo-Walking' }, speed: 1, loop: true, inPlace: true, adjustments: [] })
const add = (id: string, name: string): Command => ({ type: 'slot.add', slot: slot(id, name) })

describe('commands', () => {
  let id = ''
  beforeAll(async () => { id = await make('Ranger') })

  it('applies a command as one undoable journal entry', async () => {
    const before = (await store.getCharacter(id))!
    const done = await commands.runCommands(id, [{ type: 'character.rename', name: 'Bold Ranger' }], { by: 'agent', cid: 'c-1' })
    expect(done.character).toMatchObject({ name: 'Bold Ranger', version: before.version + 1 })
    expect(done.entry).toMatchObject({ what: 'character.rename', by: 'agent', cid: 'c-1', touched: ['name'] })
    expect(done.entry!.changes.length).toBeGreaterThan(0)
    expect(done.entry!.undo).toBeDefined()
  })

  it('applies a batch as one entry', async () => {
    const entries = (await journal.readJournal(id)).length
    const done = await commands.runCommands(id, [add('aaaa0001', 'Walk'), add('aaaa0002', 'Run')])
    expect(done.character.clips.map(s => s.name)).toEqual(['Walk', 'Run'])
    expect(done.entry!.what).toBe('slot.add')
    expect(done.entry!.touched).toEqual(expect.arrayContaining(['slot:aaaa0001', 'slot:aaaa0002']))
    expect((await journal.readJournal(id)).length).toBe(entries + 1)
  })

  it('writes nothing of a batch when one of its commands fails', async () => {
    const before = (await store.getCharacter(id))!
    const entries = (await journal.readJournal(id)).length
    // (the second takes a name that is taken)
    await expect(commands.runCommands(id, [add('aaaa0003', 'Idle'), add('aaaa0004', 'Walk')])).rejects.toMatchObject({ status: 409 })
    const after = (await store.getCharacter(id))!
    expect(after.version).toBe(before.version)
    expect(after.clips.map(s => s.name)).toEqual(['Walk', 'Run'])
    expect((await journal.readJournal(id)).length).toBe(entries)
  })

  it('undoes the newest undoable entry, then redoes it by seq', async () => {
    const batch = (await journal.readJournal(id)).at(-1)!
    const undone = await commands.undo(id)
    expect(undone.character.clips).toEqual([])
    expect(undone.entry).toMatchObject({ what: 'undo', undoes: batch.seq })
    expect(undone.entry!.changes.every(line => line.startsWith('undone: '))).toBe(true)
    expect((await journal.readJournal(id)).find(e => e.seq === batch.seq)!.undoneBy).toBe(undone.entry!.seq)

    const redone = await commands.undo(id, undone.entry!.seq)
    expect(redone.character.clips.map(s => s.name)).toEqual(['Walk', 'Run'])
    expect(redone.entry).toMatchObject({ what: 'redo', undoes: undone.entry!.seq })
    const entries = await journal.readJournal(id)
    expect(entries.find(e => e.seq === batch.seq)!.undoneBy).toBeUndefined()
    expect(entries.find(e => e.seq === undone.entry!.seq)!.undoneBy).toBe(redone.entry!.seq)
  })

  it('refuses an undo whose entities were changed since, naming them', async () => {
    const first = (await commands.runCommands(id, [{ type: 'character.rename', name: 'X' }])).entry!
    await commands.runCommands(id, [{ type: 'character.rename', name: 'Y' }])
    const v = (await store.getCharacter(id))!.version
    await expect(commands.undo(id, first.seq)).rejects.toMatchObject({ status: 409, body: { conflicts: ['name'] } })
    expect((await store.getCharacter(id))!).toMatchObject({ name: 'Y', version: v })
  })

  it('refuses to undo what has no undo, or what is already undone', async () => {
    const created = (await journal.readJournal(id)).find(e => e.what === 'import')!
    await expect(commands.undo(id, created.seq)).rejects.toMatchObject({ status: 400 })
    const last = (await commands.runCommands(id, [{ type: 'character.rename', name: 'Z' }])).entry!
    await commands.undo(id, last.seq)
    await expect(commands.undo(id, last.seq)).rejects.toMatchObject({ status: 409 })
  })
})

describe('gear removed from a horse', () => {
  it('comes off the mount of every rider that wore it, journaled on the rider', async () => {
    const horse = await make('Horse')
    const rider = await make('Rider')
    const other = await make('Walker')
    const barding: Gear = {
      id: 'bbbb0001', name: 'Barding', status: 'ready', handles: [],
      attach: { kind: 'bone', bone: 'Spine', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
    }
    await store.updateCharacter(horse, c => { c.gear.push(barding) })
    const mount: Mount = { character: horse, bone: 'Spine', position: [0, 1, 0], rotation: [0, 0, 0], freeze: [], pose: {}, gear: ['bbbb0001'] }
    await store.updateCharacter(rider, c => { c.mount = mount })
    const untouched = (await store.getCharacter(other))!.version

    await commands.runCommands(horse, [{ type: 'gear.remove', id: 'bbbb0001' }], { by: 'app' })
    expect((await store.getCharacter(horse))!.gear).toEqual([])
    expect((await store.getCharacter(rider))!.mount!.gear).toEqual([])
    const last = (await journal.readJournal(rider)).at(-1)!
    expect(last.what).toBe('mount.update')
    expect(last.changes.some(line => line.includes('Barding'))).toBe(true)
    expect((await store.getCharacter(other))!.version).toBe(untouched)
  })
})

describe('a horse resized', () => {
  it('scales the seat of every rider on it, journaled on the rider', async () => {
    const horse = await make('Charger')
    const rider = await make('Knight')
    const elsewhere = await make('Hobbler')
    const mount = (character: string): Mount => ({ character, bone: 'Spine', position: [0.1, 0.5, -0.2], rotation: [0, 90, 0], freeze: ['Hips'], pose: {} })
    await store.updateCharacter(rider, c => { c.mount = mount(horse) })
    await store.updateCharacter(elsewhere, c => { c.mount = mount('some-other-horse') })
    const untouched = (await store.getCharacter(elsewhere))!.version

    await commands.ridersFollowResize(horse, 2, 'app')
    expect((await store.getCharacter(rider))!.mount).toMatchObject({ character: horse, position: [0.2, 1, -0.4], rotation: [0, 90, 0], freeze: ['Hips'] })
    const last = (await journal.readJournal(rider)).at(-1)!
    expect(last).toMatchObject({ what: 'mount.update', by: 'app' })
    expect(last.changes.some(line => line.includes('Charger resized'))).toBe(true)
    expect(last.undo).toBeDefined()
    expect((await store.getCharacter(elsewhere))!.version).toBe(untouched)
  })

  it('does nothing for a scale of 1', async () => {
    const horse = await make('Pony')
    const rider = await make('Child')
    await store.updateCharacter(rider, c => { c.mount = { character: horse, bone: 'Spine', position: [0, 1, 0], rotation: [0, 0, 0], freeze: [], pose: {} } })
    const version = (await store.getCharacter(rider))!.version
    await commands.ridersFollowResize(horse, 1)
    expect((await store.getCharacter(rider))!.version).toBe(version)
  })
})

describe('the HTTP routes', () => {
  interface Answer { status: number, body: Record<string, unknown> }
  async function call (method: string, url: string, body: unknown, headers: Record<string, string>): Promise<Answer> {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method, url, headers })
    const answer: Answer = { status: 0, body: {} }
    const res = {
      headersSent: false,
      writeHead (status: number) { answer.status = status; this.headersSent = true },
      end (text?: string) { answer.body = text === undefined ? {} : JSON.parse(text) as Record<string, unknown> },
    }
    await http.handle(req as never, res as never)
    return answer
  }

  it('refuses a change without the x-rigsmith header', async () => {
    const id = await make('Guard')
    const refused = await call('POST', `/api/characters/${id}/commands`, { command: { type: 'character.rename', name: 'Nope' } }, { 'content-type': 'application/json' })
    expect(refused.status).toBe(403)
    expect((await store.getCharacter(id))!.name).toBe('Guard')
  })

  it('answers the character and its entry, then undoes it', async () => {
    const id = await make('Scout')
    const done = await call('POST', `/api/characters/${id}/commands`, { command: { type: 'character.rename', name: 'Pathfinder' }, cid: 'c-9' }, { 'x-rigsmith': '1' })
    expect(done.status).toBe(200)
    expect(done.body).toMatchObject({ character: { name: 'Pathfinder' }, entry: { what: 'character.rename', cid: 'c-9' } })
    const undone = await call('POST', `/api/characters/${id}/undo`, {}, { 'x-rigsmith-by': 'agent' })
    expect(undone.status).toBe(200)
    expect(undone.body).toMatchObject({ character: { name: 'Scout' }, entry: { what: 'undo', by: 'agent' } })
  })

  it('answers a command error with its status', async () => {
    const id = await make('Bad')
    const bad = await call('POST', `/api/characters/${id}/commands`, { command: { type: 'no.such' } }, { 'x-rigsmith': '1' })
    expect(bad.status).toBe(400)
    expect(typeof bad.body.error).toBe('string')
  })
})
