// @vitest-environment node
// The look routes against a temp workspace: a repaint layer uploaded (on top, journaled, undoable; refused for an image
// the model files don't have, or a file that isn't a PNG) and projection captures (only a capture's own files written,
// listed once views.json is there, one result a view, results older than the last ask to Codex not counted). Then
// restart recovery: when a compose is due again (composeStale, against textures/.composed.json) and the fill working
// folders swept (sweepFills).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { writeGlb } from '../../src/engine/glb.ts'
import { makeRigged } from '../../src/model/fixtures.ts'
import type { Character, TextureLayer } from '../../src/model/types.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-look-'))
// (read when store.ts and jobs.ts are first imported: this workspace, and no real Blender for the compose job)
process.env.RIGSMITH_WORKSPACE = dir
process.env.BLENDER = 'false'
let handle: typeof import('../http.ts').handle
let look: typeof import('./look.ts')
let getJob: typeof import('../jobs.ts').getJob

const c = makeRigged()
const folder = path.join(dir, 'characters', c.id)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

/** A model file whose one embedded image is called `name`. */
function model (name: string): Uint8Array {
  return writeGlb({
    asset: { version: '2.0' },
    buffers: [{ byteLength: PNG.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: PNG.length }],
    images: [{ name, bufferView: 0, mimeType: 'image/png' }],
  }, new Uint8Array(PNG))
}

beforeAll(async () => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  writeFileSync(path.join(folder, 'model.glb'), model('Body'))
  writeFileSync(path.join(folder, 'rigged.glb'), model('Body'))
  handle = (await import('../http.ts')).handle
  look = await import('./look.ts')
  getJob = (await import('../jobs.ts')).getJob
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

// (each route's own reply)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function call (method: string, url: string, body?: Buffer | string): Promise<{ status: number, body: any }> {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { 'x-rigsmith': '1' } })
  let status = 0
  let text = ''
  const res = { headersSent: false } as { headersSent: boolean, writeHead: (s: number) => unknown, end: (t?: string) => void }
  res.writeHead = (s: number) => { status = s; res.headersSent = true; return res }
  res.end = (t?: string) => { text = t ?? '' }
  await handle(req, res as unknown as ServerResponse)
  return { status, body: text === '' ? null : JSON.parse(text) }
}

const of = `/api/characters/${c.id}`

describe('a repaint layer uploaded', () => {
  it('is refused for an image the model files don\'t have, naming the ones they do', async () => {
    const r = await call('POST', `${of}/look/layers?image=Cloak`, PNG)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/Body/)
    expect((await call('POST', `${of}/look/layers`, PNG)).status).toBe(400)
  })

  it('is refused when it isn\'t a PNG', async () => {
    expect((await call('POST', `${of}/look/layers?image=Body`, 'not an image')).status).toBe(400)
  })

  it('goes on top as a new repaint layer, journaled and undoable, and the texture is composed again', async () => {
    const first = await call('POST', `${of}/look/layers?image=Body&capture=p1abcdef&note=${encodeURIComponent('a purple stole')}`, PNG)
    expect(first.status).toBe(201)
    const layers = (first.body.character as Character).look.layers
    expect(layers).toHaveLength(1)
    expect(layers[0]).toMatchObject({ kind: 'repaint', image: 'Body', enabled: true, capture: 'p1abcdef', note: 'a purple stole' })
    expect(layers[0].file).toBe(`textures/layers/${layers[0].id}.png`)
    expect(readFileSync(path.join(folder, layers[0].file))).toEqual(PNG)
    expect(first.body.entry).toMatchObject({ what: 'look.layer.add' })
    expect((first.body.entry as { undo?: unknown }).undo).toBeDefined()
    expect(first.body.job).toMatchObject({ kind: 'compose' })

    const second = await call('POST', `${of}/look/layers?image=Body`, PNG)
    const both = (second.body.character as Character).look.layers
    expect(both.map(l => l.id)).toEqual([layers[0].id, expect.any(String)])
    expect(both[1].id).not.toBe(layers[0].id)
  })
})

describe('bare PNG route', () => {
  const skin = '../Bay dark'
  const valid = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]), Buffer.from('IHDR'), Buffer.alloc(17)])
  const bare = `${of}/look/bare/${encodeURIComponent(skin)}`
  beforeAll(async () => {
    const { updateCharacter } = await import('../store.ts')
    await updateCharacter(c.id, x => { x.look.skins = [{ name: skin, file: 'skins/bay.png' }] })
  })

  it('refuses missing skins, malformed names and non-PNG bodies without writing files', async () => {
    expect((await call('PUT', `${of}/look/bare/missing`, valid)).status).toBe(404)
    expect((await call('PUT', `${of}/look/bare/%ZZ`, valid)).status).toBe(400)
    expect((await call('PUT', bare, 'not png')).status).toBe(400)
    expect((await call('PUT', bare, Buffer.concat([valid.subarray(0, 12), Buffer.from('NOPE'), valid.subarray(16)]))).status).toBe(400)
    expect(existsSync(path.join(folder, 'skins', 'bare'))).toBe(false)
  })

  it('writes unique immutable files atomically and undo restores a prior reference', async () => {
    const { runCommands, undo } = await import('../commands.ts')
    const first = await call('PUT', bare, valid)
    const secondBytes = Buffer.concat([valid, Buffer.from('second')])
    const second = await call('PUT', bare, secondBytes)
    expect(first.status).toBe(200); expect(second.status).toBe(200)
    expect(first.body.path).toMatch(/^skins\/bare\/[A-Za-z0-9_-]+-[a-f0-9-]+\.png$/)
    expect(second.body.path).not.toBe(first.body.path)
    expect(readFileSync(path.join(folder, first.body.path))).toEqual(valid)
    expect(readFileSync(path.join(folder, second.body.path))).toEqual(secondBytes)
    expect(readdirSync(path.join(folder, 'skins', 'bare')).every(file => !file.endsWith('.tmp'))).toBe(true)
    await runCommands(c.id, [{ type: 'look.skin.bare', name: skin, file: first.body.path }])
    const replacement = await runCommands(c.id, [{ type: 'look.skin.bare', name: skin, file: second.body.path }])
    const restored = await undo(c.id, replacement.entry!.seq)
    expect(restored.character.look.skins!.find(s => s.name === skin)?.bare).toBe(first.body.path)
    expect(readFileSync(path.join(folder, first.body.path))).toEqual(valid)
    expect(readFileSync(path.join(folder, second.body.path))).toEqual(secondBytes)
  })
})

describe('projection captures', () => {
  const capture = `${of}/projections/p1abcdef`

  it('writes only a capture\'s own files', async () => {
    expect((await call('PUT', `${capture}/camera.json`, '{}')).status).toBe(400)
    expect((await call('PUT', `${capture}/view-1-depth.png`, PNG)).status).toBe(400)
    expect((await call('PUT', `${capture}/../character.json`, '{}')).status).not.toBe(200)
  })

  it('lists a capture once its views.json is there', async () => {
    for (const file of ['view-1-color.png', 'view-1-flat.png', 'view-1-mask.png', 'uvmask.png']) expect((await call('PUT', `${capture}/${file}`, PNG)).status).toBe(200)
    expect((await call('PUT', `${capture}/prompt.md`, '# Repaint request')).status).toBe(200)
    expect((await call('GET', `${of}/projections`)).body).toEqual([])
    await call('PUT', `${capture}/views.json`, JSON.stringify({ views: [{ name: 'front', camera: {} }, { name: 'back', camera: {} }], notes: 'a purple stole' }))
    const list = (await call('GET', `${of}/projections`)).body
    expect(list).toEqual([{ id: 'p1abcdef', createdAt: parseInt('1abcdef', 36), views: 2, notes: 'a purple stole', painted: 0, ready: false }])
  })

  it('is ready to preview only when every view has its result', async () => {
    let info = (await call('GET', capture)).body
    expect(info).toMatchObject({ views: 2, names: ['front', 'back'], results: [null, null], painted: 0, ready: false, resultVersion: null })
    await call('PUT', `${capture}/result-1.png`, PNG)
    info = (await call('GET', capture)).body
    expect(info).toMatchObject({ painted: 1, ready: false, resultVersion: null })
    await call('PUT', `${capture}/result-2.webp`, PNG)
    info = (await call('GET', capture)).body
    expect(info).toMatchObject({ painted: 2, ready: true })
    expect(info.resultVersion).toBeGreaterThan(0)
  })

  it('keeps one result a view, whatever kind of image replaces it', async () => {
    await call('PUT', `${capture}/result-1.jpg`, PNG)
    expect(existsSync(path.join(folder, 'projections', 'p1abcdef', 'result-1.png'))).toBe(false)
    const info = (await call('GET', capture)).body as unknown as { results: Array<{ file: string }> }
    expect(info.results[0].file).toBe('result-1.jpg')
  })

  it('doesn\'t count results older than the last ask to Codex', async () => {
    writeFileSync(path.join(folder, 'projections', 'p1abcdef', 'request.json'), JSON.stringify({ requestedAt: Date.now() + 60_000 }))
    const info = (await call('GET', capture)).body as unknown as { results: Array<{ fresh: boolean }>, painted: number, ready: boolean }
    expect(info.results.map(r => r.fresh)).toEqual([false, false])
    expect(info).toMatchObject({ painted: 0, ready: false })
  })

  it('asks Codex only once the views are captured', async () => {
    await call('PUT', `${of}/projections/p2abcdef/views.json`, JSON.stringify({ views: [{ name: 'front', camera: {} }] }))
    expect((await call('POST', `${of}/projections/p2abcdef/codex`)).status).toBe(400)
    expect((await call('GET', `${of}/projections/nothing1`)).status).toBe(404)
  })
})

// ---- after a restart --------------------------------------------------------------------------------------------

let made = 0

/** A character folder of its own: model files whose one image is Body, each layer's file (layers default to enabled
 * fills on Body), and textures/<name>.png for each of `composites`. */
function setup (layers: Array<Partial<TextureLayer>>, composites: string[] = []): { c: Character, folder: string } {
  const id = `stale-${++made}`
  const at = path.join(dir, 'characters', id)
  mkdirSync(path.join(at, 'textures', 'layers'), { recursive: true })
  writeFileSync(path.join(at, 'model.glb'), model('Body'))
  writeFileSync(path.join(at, 'rigged.glb'), model('Body'))
  const full = layers.map((l, i): TextureLayer => ({ id: `l${i}`, kind: 'fill', image: 'Body', file: `textures/layers/l${i}.png`, enabled: true, at: 0, ...l }))
  for (const l of full) writeFileSync(path.join(at, l.file), PNG)
  for (const name of composites) writeFileSync(path.join(at, 'textures', `${name}.png`), PNG)
  const c = makeRigged({ id, look: { layers: full } })
  writeFileSync(path.join(at, 'character.json'), JSON.stringify(c))
  return { c, folder: at }
}

/** textures/.composed.json as a finished compose leaves it: these layers (id, image, file), bottom to top. */
function record (folder: string, layers: TextureLayer[] | null): void {
  const list = layers === null ? null : layers.map(l => ({ id: l.id, image: l.image, file: l.file }))
  writeFileSync(path.join(folder, 'textures', '.composed.json'), JSON.stringify({ layers: list, at: 1 }))
}

const enabled = (c: Character): TextureLayer[] => c.look.layers.filter(l => l.enabled)

describe('a compose due again after a restart', () => {
  it('is not due for a character with no layers and nothing composed', async () => {
    const { c } = setup([])
    expect(await look.composeStale(c)).toBe(false)
  })

  it('is not due when the record holds the enabled layers and each image has its composite', async () => {
    const { c, folder } = setup([{}, { image: 'Body' }], ['Body'])
    record(folder, enabled(c))
    expect(await look.composeStale(c)).toBe(false)
  })

  it('is not due for a switched-off layer the record already leaves out', async () => {
    const { c, folder } = setup([{}, { enabled: false }], ['Body'])
    record(folder, enabled(c))
    expect(await look.composeStale(c)).toBe(false)
  })

  it('is due after a layer was switched off and the compose was lost', async () => {
    const { c, folder } = setup([{}, {}], ['Body'])
    record(folder, enabled(c))
    c.look.layers[1].enabled = false
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due after a layer was removed and the compose was lost', async () => {
    const { c, folder } = setup([{}, {}], ['Body'])
    record(folder, enabled(c))
    c.look.layers.pop()
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due after the last layer was removed and the compose was lost', async () => {
    const { c, folder } = setup([{}], ['Body'])
    record(folder, enabled(c))
    c.look.layers = []
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due after the layers were reordered and the compose was lost', async () => {
    const { c, folder } = setup([{}, {}], ['Body'])
    record(folder, enabled(c))
    c.look.layers.reverse()
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due when a compose was under way, or the record can\'t be read', async () => {
    const { c, folder } = setup([{}], ['Body'])
    record(folder, null)
    expect(await look.composeStale(c)).toBe(true)
    writeFileSync(path.join(folder, 'textures', '.composed.json'), '{ not json')
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due when an image with enabled layers has no composite', async () => {
    const { c, folder } = setup([{}])
    record(folder, enabled(c))
    expect(await look.composeStale(c)).toBe(true)
  })

  it('is due when there is no record while a fill or repaint is enabled', async () => {
    expect(await look.composeStale(setup([{}], ['Body']).c)).toBe(true)
    expect(await look.composeStale(setup([{ kind: 'repaint' }], ['Body']).c)).toBe(true)
  })

  it('is not due with no record and only the migration\'s snapshots, each over its composite', async () => {
    expect(await look.composeStale(setup([{ kind: 'snapshot' }], ['Body']).c)).toBe(false)
    // (but a snapshot whose composite is gone is)
    expect(await look.composeStale(setup([{ kind: 'snapshot' }]).c)).toBe(true)
  })

  it('is due with no record when a model image with no enabled layer still has a composite', async () => {
    expect(await look.composeStale(setup([{ kind: 'snapshot', enabled: false }], ['Body']).c)).toBe(true)
    // (a file for an image the model files don't have is no compose's to delete)
    expect(await look.composeStale(setup([], ['Cloak']).c)).toBe(false)
  })

  it('is not due when a compose would only fail: a layer lost its file, or names an image the model doesn\'t have', async () => {
    const lost = setup([{}], ['Body'])
    rmSync(path.join(lost.folder, lost.c.look.layers[0].file))
    expect(await look.composeStale(lost.c)).toBe(false)
    expect(await look.composeStale(setup([{ image: 'Cloak' }], ['Cloak']).c)).toBe(false)
  })

  it('is due after a compose that started and didn\'t finish (the record says one was under way)', async () => {
    const { c, folder } = setup([{}, {}], ['Body'])
    record(folder, [c.look.layers[0]])
    // (no Blender here: the compose fails once it has started on the files)
    const job = look.compose(c.id, c.name)
    await vi.waitFor(() => { expect(getJob(job.id)?.status).toBe('failed') }, { timeout: 10_000 })
    const after = JSON.parse(readFileSync(path.join(folder, 'textures', '.composed.json'), 'utf8')) as { layers: unknown }
    expect(after.layers).toBeNull()
    expect(await look.composeStale(c)).toBe(true)
  }, 15_000)
})

describe('fill working folders after a restart', () => {
  it('deletes the folders of fills cut off and nothing else', async () => {
    const { c, folder } = setup([{}])
    const layers = path.join(folder, 'textures', 'layers')
    mkdirSync(path.join(layers, '.fill-abc123'))
    writeFileSync(path.join(layers, '.fill-abc123', 'Body.png'), PNG)
    mkdirSync(path.join(layers, '.fill-def456'))
    mkdirSync(path.join(layers, 'keep'))
    writeFileSync(path.join(layers, '.fill-notafolder'), PNG)
    expect(await look.sweepFills(c.id)).toBe(2)
    expect(existsSync(path.join(layers, '.fill-abc123'))).toBe(false)
    expect(existsSync(path.join(layers, '.fill-def456'))).toBe(false)
    expect(existsSync(path.join(layers, 'keep'))).toBe(true)
    expect(existsSync(path.join(layers, '.fill-notafolder'))).toBe(true)
    expect(existsSync(path.join(folder, c.look.layers[0].file))).toBe(true)
    expect(await look.sweepFills(c.id)).toBe(0)
  })

  it('finds nothing to sweep for a character with no layers folder', async () => {
    const id = `stale-${++made}`
    mkdirSync(path.join(dir, 'characters', id), { recursive: true })
    expect(await look.sweepFills(id)).toBe(0)
  })
})
