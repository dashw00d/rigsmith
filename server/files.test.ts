// @vitest-environment node
// The content index against a temp workspace: a character's manifest (only what the app may load), a file changed on
// disk heard by the watcher and told as a `files` event with its new hash, touch, a folder gone, the library's clips,
// a character.json written by someone else read again (and one the store wrote not), and /files served immutable only
// by the hash the file holds now.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeCharacter } from '../src/model/fixtures.ts'
import type { FilesChanged } from './files.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-files-'))
process.env.RIGSMITH_WORKSPACE = dir // read when store.ts is first imported
let files: typeof import('./files.ts')
let store: typeof import('./store.ts')
let http: typeof import('./http.ts')

const ID = 'knight-abc123'
const at = (...parts: string[]): string => path.join(dir, 'characters', ID, ...parts)
function put (file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** The next `files` event for `character` that names `file` (or times out). */
async function heard (character: string | null, file: string, ms = 3000): Promise<FilesChanged> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { store.events.off('files', on); reject(new Error(`no files event for ${file}`)) }, ms)
    function on (e: FilesChanged): void {
      if (e.character !== character || !(file in e.changed)) return
      clearTimeout(timer)
      store.events.off('files', on)
      resolve(e)
    }
    store.events.on('files', on)
  })
}

// (the current schema, whatever it is: makeCharacter follows it)
const character = makeCharacter({ id: ID, name: 'Knight', version: 3 })

beforeAll(async () => {
  put(at('character.json'), JSON.stringify(character))
  put(at('model.glb'), 'model one')
  put(at('skins', 'a.png'), 'skin a')
  put(at('journal.jsonl'), '')
  put(at('weight_edits.json'), '{}')
  put(path.join(dir, 'library', 'clips', 'walk.glb'), 'walk')
  put(path.join(dir, 'library', 'manifest.json'), '{}')
  store = await import('./store.ts')
  files = await import('./files.ts')
  http = await import('./http.ts')
  await import('./routes/characters.ts')
  store.onWritten(files.written)
  await files.startFiles()
})
afterAll(async () => {
  await files.stopFiles()
  store.onWritten(null)
  rmSync(dir, { recursive: true, force: true })
})

describe('the manifest', () => {
  it('lists what the app may load by content hash, not the records', async () => {
    const m = await files.manifest(ID)
    expect(Object.keys(m).sort()).toEqual(['model.glb', 'skins/a.png'])
    expect(m['model.glb']).toBe(await files.hashFile(at('model.glb')))
    expect(m['model.glb']).toMatch(/^[0-9a-f]{16}$/)
  })

  it('lists the library\'s clips', async () => {
    const m = await files.libraryManifest()
    expect(Object.keys(m)).toEqual(['clips/walk.glb'])
  })

  it('answers nothing for a bad id', async () => {
    expect(await files.manifest('../x')).toEqual({})
  })
})

describe('changes on disk', () => {
  it('hears a file written over (as GIMP does) and tells its new hash', async () => {
    const was = (await files.manifest(ID))['skins/a.png']
    const event = heard(ID, 'skins/a.png')
    put(at('skins', 'a.png'), 'skin a, repainted')
    const e = await event
    expect(e.changed['skins/a.png']).not.toBe(was)
    expect((await files.manifest(ID))['skins/a.png']).toBe(e.changed['skins/a.png'])
  })

  it('hears a file renamed into place and a new folder', async () => {
    const event = heard(ID, 'garments/g1/model.glb')
    put(at('garments', 'g1', 'model.glb.part'), 'gear')
    renameSync(at('garments', 'g1', 'model.glb.part'), at('garments', 'g1', 'model.glb'))
    expect((await event).changed['garments/g1/model.glb']).toMatch(/^[0-9a-f]{16}$/)
  })

  it('tells a folder gone as its files gone', async () => {
    const event = heard(ID, 'garments/g1/model.glb')
    rmSync(at('garments', 'g1'), { recursive: true })
    expect((await event).changed['garments/g1/model.glb']).toBeNull()
    expect((await files.manifest(ID))['garments/g1/model.glb']).toBeUndefined()
  })

  it('touch reads the named files at once', async () => {
    writeFileSync(at('model.glb'), 'model two')
    const changed = await files.touch(ID, ['model.glb'])
    expect(changed['model.glb']).toBe(await files.hashFile(at('model.glb')))
    // (the same bytes again: nothing changed)
    expect(await files.touch(ID, ['model.glb'])).toEqual({})
  })

  it('hears a library clip', async () => {
    const event = heard(null, 'clips/walk.glb')
    put(path.join(dir, 'library', 'clips', 'walk.glb'), 'walk, edited')
    expect((await event).changed['clips/walk.glb']).toBe(await files.hashFile(path.join(dir, 'library', 'clips', 'walk.glb')))
  })
})

describe('the record', () => {
  it('reads a character.json someone else wrote again, past the version handed out', async () => {
    await store.getCharacter(ID)
    const seen: unknown[] = []
    files.onRecordChanged(async id => { seen.push(id); await store.adopt(id) })
    const event = new Promise<{ character: { name: string, version: number } }>(resolve => {
      const on = (e: { character: { name: string, version: number } }): void => {
        if (e.character.name !== 'Renamed') return
        store.events.off('character', on); resolve(e)
      }
      store.events.on('character', on)
    })
    // (an older version than the store handed out)
    put(at('character.json'), JSON.stringify({ ...character, name: 'Renamed', version: 2 }))
    const e = await event
    expect(seen).toEqual([ID])
    expect(e.character.version).toBe(4)
    files.onRecordChanged(null)
  })

  it('doesn\'t take the store\'s own writes for someone else\'s', async () => {
    const seen: string[] = []
    files.onRecordChanged(async id => { seen.push(id) })
    await store.updateCharacter(ID, c => { c.name = 'Written here' })
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(seen).toEqual([])
    files.onRecordChanged(null)
  })
})

describe('/files', () => {
  interface Served { status: number, headers: Record<string, unknown>, body: string }
  async function get (url: string, headers: Record<string, string> = {}): Promise<Served> {
    const request = Object.assign(Readable.from([]), { method: 'GET', url, headers })
    const out: Served = { status: 0, headers: {}, body: '' }
    const res = Object.assign(new PassThrough(), {
      headersSent: false,
      writeHead (status: number, h: Record<string, unknown>) { out.status = status; out.headers = h; this.headersSent = true },
    })
    const chunks: Buffer[] = []
    res.on('data', (c: Buffer) => chunks.push(c))
    const done = new Promise(resolve => res.on('finish', resolve))
    await http.handle(request as never, res as never)
    if (out.status === 200) await done
    out.body = Buffer.concat(chunks).toString()
    return out
  }

  it('serves a file asked for by its hash immutable', async () => {
    const hash = (await files.manifest(ID))['model.glb']
    const r = await get(`/files/characters/${ID}/model.glb?h=${hash}`)
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toContain('immutable')
    expect(r.body).toBe('model two')
  })

  it('serves a file asked for by a hash it no longer holds as it is, kept by nobody', async () => {
    const r = await get(`/files/characters/${ID}/model.glb?h=0000000000000000`)
    expect(r.status).toBe(200)
    expect(r.headers['cache-control']).toBe('no-store')
    expect(r.body).toBe('model two')
  })

  it('serves one asked for without a hash to be checked again each time', async () => {
    const r = await get(`/files/characters/${ID}/model.glb`)
    expect(r.headers['cache-control']).toBe('no-cache')
    expect(r.headers.etag).toBe(`"${(await files.manifest(ID))['model.glb']}"`)
  })

  it('answers 304 to an etag that still holds', async () => {
    const hash = (await files.manifest(ID))['model.glb']
    expect((await get(`/files/characters/${ID}/model.glb`, { 'if-none-match': `"${hash}"` })).status).toBe(304)
  })

  it('answers the manifest route', async () => {
    const r = await get(`/api/characters/${ID}/files`)
    expect(r.status).toBe(200)
  })
})
