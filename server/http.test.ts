// @vitest-environment node
// The two rules that keep other web pages out: /files serves only the characters' files the app loads and the clip
// library (never their records, journals or painted weights, nor anything outside), and a change needs x-rigsmith: 1
// or x-rigsmith-by. Also the router's NEXT, which leaves a request to the next route that matches.
import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { allowedWrite, handle, NEXT, route, send, servable } from './http.ts'

const req = (method: string, headers: Record<string, string> = {}): never => ({ method, headers }) as never

describe('servable', () => {
  it('serves the characters\' model files and the library', () => {
    expect(servable('characters/knight-abc123/rigged.glb')).toBe(true)
    expect(servable('characters/knight-abc123/textures/layers/a1b2c3d4.png')).toBe(true)
    expect(servable('characters/knight-abc123/garments/g1/model.glb')).toBe(true)
    expect(servable('library/clips/mixamo-Walking.glb')).toBe(true)
    expect(servable('library/creatures/horse/idle.glb')).toBe(true)
  })

  it('refuses the records, journals and painted weights', () => {
    for (const f of ['journal.jsonl', 'character.json', 'character.v1.json', 'character.v2.json', 'character.v3.json', 'weight_edits.json']) {
      expect(servable(`characters/knight-abc123/${f}`)).toBe(false)
    }
  })

  it('refuses paths that climb out with ..', () => {
    expect(servable('characters/knight-abc123/../../settings.json')).toBe(false)
    expect(servable('characters/../settings.json')).toBe(false)
    expect(servable('library/../trash/knight/character.json')).toBe(false)
    expect(servable('..\\settings.json')).toBe(false)
  })

  it('refuses everything outside characters/ and library/', () => {
    expect(servable('settings.json')).toBe(false)
    expect(servable('game/units.json')).toBe(false)
    expect(servable('trash/knight-abc123-2026/model.glb')).toBe(false)
    expect(servable('/etc/passwd')).toBe(false)
    // (a folder, not a file in it)
    expect(servable('characters/knight-abc123')).toBe(false)
    expect(servable('library')).toBe(false)
    expect(servable('characters//model.glb')).toBe(false)
  })
})

describe('allowedWrite', () => {
  it('lets reads through without a header', () => {
    expect(allowedWrite(req('GET'))).toBe(true)
  })

  it('takes x-rigsmith: 1 or x-rigsmith-by on a change', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(allowedWrite(req(method, { 'x-rigsmith': '1' }))).toBe(true)
      expect(allowedWrite(req(method, { 'x-rigsmith-by': 'agent' }))).toBe(true)
    }
  })

  it('refuses a change with neither', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(allowedWrite(req(method))).toBe(false)
      expect(allowedWrite(req(method, { 'content-type': 'application/json' }))).toBe(false)
      expect(allowedWrite(req(method, { 'x-rigsmith': '0' }))).toBe(false)
      expect(allowedWrite(req(method, { 'x-rigsmith-by': '  ' }))).toBe(false)
    }
  })
})

describe('handle', () => {
  interface Answer { status: number, body: Record<string, unknown> }
  async function call (method: string, url: string, headers: Record<string, string> = {}): Promise<Answer> {
    const request = Object.assign(Readable.from([]), { method, url, headers })
    const answer: Answer = { status: 0, body: {} }
    const res = {
      headersSent: false,
      writeHead (status: number) { answer.status = status; this.headersSent = true },
      end (text?: string) { answer.body = text === undefined ? {} : JSON.parse(text) as Record<string, unknown> },
    }
    await handle(request as never, res as never)
    return answer
  }

  route('POST', /^\/api\/test-next$/, async () => NEXT)
  route('POST', /^\/api\/test-next$/, async (_req, res) => { send(res, 200, { second: true }) })

  it('answers 403 to a change without the header, before any route', async () => {
    expect((await call('POST', '/api/test-next')).status).toBe(403)
  })

  it('goes on to the next matching route when a handler answers NEXT', async () => {
    expect(await call('POST', '/api/test-next', { 'x-rigsmith': '1' })).toEqual({ status: 200, body: { second: true } })
  })

  it('answers 404 to an unknown endpoint', async () => {
    expect((await call('GET', '/api/no-such-thing')).status).toBe(404)
  })
})
