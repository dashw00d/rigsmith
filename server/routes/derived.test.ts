// @vitest-environment node
// A piece's derived data kept in its folder (server/routes/derived.ts): written by name, read back byte for byte, a
// name that isn't one or a piece that doesn't exist refused, only the newest few kept, and never in the files index.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeGear, makeRigged } from '../../src/model/fixtures.ts'

const dir = mkdtempSync(path.join(tmpdir(), 'rigsmith-derived-'))
process.env.RIGSMITH_WORKSPACE = path.join(dir, 'ws')
let handle: typeof import('../http.ts').handle
let manifest: typeof import('../files.ts').manifest

const c = makeRigged({ gear: [makeGear({ id: 'shirt', attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })] })
const folder = path.join(dir, 'ws', 'characters', c.id)
const name = (n: number): string => `${n.toString(16).padStart(16, '0')}-00000000000000ab-body-v1.bin`
const bytes = Buffer.from(new Uint32Array([0x31445352, 1, 0, 0, 7, 8, 9, 10]).buffer)

beforeAll(async () => {
  mkdirSync(path.join(folder, 'garments', 'shirt'), { recursive: true })
  writeFileSync(path.join(folder, 'character.json'), JSON.stringify(c))
  handle = (await import('../http.ts')).handle
  manifest = (await import('../files.ts')).manifest
  await import('./derived.ts')
})
afterAll(() => { rmSync(dir, { recursive: true, force: true }) })

async function call (method: string, url: string, body?: Buffer): Promise<{ status: number, raw: Buffer, headers: Record<string, unknown> }> {
  const req = Readable.from(body === undefined ? [] : [body]) as unknown as IncomingMessage
  Object.assign(req, { method, url, headers: { 'x-rigsmith': '1' } })
  let status = 0
  let raw = Buffer.alloc(0)
  let headers: Record<string, unknown> = {}
  const res = { headersSent: false } as { headersSent: boolean, writeHead: (s: number, h?: Record<string, unknown>) => unknown, end: (t?: string | Buffer) => void }
  res.writeHead = (s, h) => { status = s; headers = h ?? {}; res.headersSent = true; return res }
  res.end = (t) => { raw = t === undefined ? Buffer.alloc(0) : Buffer.from(t) }
  await handle(req, res as unknown as ServerResponse)
  return { status, raw, headers }
}

const at = (n: string, gid = 'shirt'): string => `/api/characters/${c.id}/garments/${gid}/derived/${n}`

describe('derived data on disk', () => {
  it('is read back as written, and not there before', async () => {
    expect((await call('GET', at(name(1)))).status).toBe(404)
    expect((await call('PUT', at(name(1)), bytes)).status).toBe(204)
    const r = await call('GET', at(name(1)))
    expect(r.status).toBe(200)
    expect(r.raw.equals(bytes)).toBe(true)
    expect(String(r.headers['cache-control'])).toContain('immutable')
    expect(existsSync(path.join(folder, 'garments', 'shirt', 'derived', name(1)))).toBe(true)
  })

  it('refuses a name that is not one, a piece that is not there, bytes that are not derived data', async () => {
    expect((await call('PUT', at('../../character.json'), bytes)).status).toBeGreaterThanOrEqual(400)
    expect((await call('PUT', at('nope.bin'), bytes)).status).toBe(400)
    expect((await call('PUT', at(name(2), 'ghost'), bytes)).status).toBe(404)
    expect((await call('PUT', at(name(2)), Buffer.from('abc'))).status).toBe(400)
  })

  it('keeps only the newest few per piece', async () => {
    const d = path.join(folder, 'garments', 'shirt', 'derived')
    for (let n = 10; n < 30; n++) {
      expect((await call('PUT', at(name(n)), bytes)).status).toBe(204)
      utimesSync(path.join(d, name(n)), new Date(1000 + n * 1000), new Date(1000 + n * 1000))
    }
    const left = readdirSync(d).sort()
    expect(left.length).toBe(12)
    expect(left).toContain(name(29))
    expect(left).not.toContain(name(10))
  })

  it('is not in the character\'s files index', async () => {
    const m = await manifest(c.id)
    expect(Object.keys(m).some(k => k.includes('/derived/'))).toBe(false)
  })
})
