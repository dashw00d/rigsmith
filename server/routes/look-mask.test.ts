// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { PNG } from 'pngjs'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { makeRigged } from '../../src/model/fixtures.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-mask-'))
const previous = process.env.RIGSMITH_WORKSPACE
process.env.RIGSMITH_WORKSPACE = dir
const c = makeRigged({ id: 'mask-fixture', look: { layers: [], cloth: [{ id: 'layer', name: 'Shirt', slots: ['top'], file: 'shirt.png' }] } })
const folder = path.join(dir, 'characters', c.id)
let handle: typeof import('../http.ts').handle
beforeAll(async () => {
  mkdirSync(folder, { recursive: true })
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  handle = (await import('../http.ts')).handle
  await import('./look.ts')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }); if (previous === undefined) delete process.env.RIGSMITH_WORKSPACE; else process.env.RIGSMITH_WORKSPACE = previous })

const image = (value: number): Buffer => { const p = new PNG({ width: 2, height: 2 }); p.data.fill(value); return PNG.sync.write(p) }
async function put (id: string, bytes: Buffer): Promise<{ status: number, body: { path?: string, error?: string } }> {
  const req = Readable.from([bytes]) as unknown as IncomingMessage
  Object.assign(req, { method: 'PUT', url: `/api/characters/${c.id}/look/cloth/${id}/mask`, headers: { 'x-rigsmith': '1' } })
  let status = 0; let text = ''
  const res = { headersSent: false, writeHead (s: number) { status = s; this.headersSent = true; return this }, end (s = '') { text = s } }
  await handle(req, res as unknown as ServerResponse)
  return { status, body: JSON.parse(text) }
}

it('writes immutable content-versioned masks and reuses identical bytes', async () => {
  const a = image(40); const b = image(180)
  const first = await put('layer', a); const second = await put('layer', b); const again = await put('layer', a)
  expect(first.status).toBe(200); expect(second.status).toBe(200)
  expect(first.body.path).toMatch(/^cloth\/layer\.mask\.[0-9a-f]{8}\.png$/)
  expect(second.body.path).not.toBe(first.body.path)
  expect(again.body.path).toBe(first.body.path)
  expect(readFileSync(path.join(folder, first.body.path!))).toEqual(a)
  expect(readFileSync(path.join(folder, second.body.path!))).toEqual(b)
})

it('refuses unknown layers, invalid PNGs and symlinked cloth folders', async () => {
  expect((await put('missing', image(40))).status).toBe(404)
  expect((await put('layer', Buffer.from('not png'))).status).toBe(400)
  rmSync(path.join(folder, 'cloth'), { recursive: true, force: true })
  const outside = path.join(dir, 'outside'); mkdirSync(outside)
  symlinkSync(outside, path.join(folder, 'cloth'))
  expect((await put('layer', image(40))).status).not.toBe(200)
})

it('never overwrites a different file with the same eight-character hash name', async () => {
  rmSync(path.join(folder, 'cloth'), { recursive: true, force: true })
  mkdirSync(path.join(folder, 'cloth'))
  const bytes = image(99); const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
  const target = path.join(folder, 'cloth', `layer.mask.${hash}.png`)
  writeFileSync(target, 'already here')
  expect((await put('layer', bytes)).status).toBe(409)
  expect(readFileSync(target, 'utf8')).toBe('already here')
})
