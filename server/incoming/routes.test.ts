import { createServer, type Server } from 'node:http'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
const workspace = await mkdtemp(path.join(tmpdir(), 'rigsmith-incoming-route-'))
process.env.RIGSMITH_WORKSPACE = workspace
const { incomingFixture } = await import('./fixture.ts')
const { handle } = await import('../http.ts')
await import('../routes/incoming.ts')
await import('../routes/characters.ts')
const { stopIncomingWatch } = await import('./watch.ts')
let server: Server; let url: string
beforeAll(async () => {
  await incomingFixture(path.join(workspace, 'incoming'))
  server = createServer((req, res) => { void handle(req, res) })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { stopIncomingWatch(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(workspace, { recursive: true, force: true }) })
it('lists, rejects, restores and serves delivery files over HTTP', async () => {
  const list = async () => await (await fetch(`${url}/api/incoming`)).json() as { pending: number }
  expect((await list()).pending).toBe(1)
  const send = async (action: string) => await fetch(`${url}/api/incoming/${action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-rigsmith': '1' }, body: JSON.stringify({ package: 'fixture', parts: ['piece'] }) })
  expect((await send('reject')).status).toBe(200); expect((await list()).pending).toBe(0)
  expect((await send('restore')).status).toBe(200); expect((await list()).pending).toBe(1)
  expect((await fetch(`${url}/files/incoming/fixture/parts/piece.glb`)).status).toBe(200)
  expect((await fetch(`${url}/files/incoming/fixture/%2e%2e%2fsettings.json`)).status).toBe(404)
})

it('forwards incoming watcher notifications on the event stream', async () => {
  const abort = new AbortController()
  const response = await fetch(`${url}/api/events`, { signal: abort.signal })
  const reader = response.body!.getReader()
  const first = await reader.read()
  expect(new TextDecoder().decode(first.value)).toContain('event: hello')
  const fixture = await incomingFixture(path.join(workspace, 'incoming'), 'new-delivery')
  const renamed = path.join(workspace, 'incoming', 'published')
  await rename(fixture, renamed)
  try {
    const result = await Promise.race([
      (async () => { let text = ''; while (!text.includes('event: incoming')) { const next = await reader.read(); if (next.done) break; text += new TextDecoder().decode(next.value) }; return text })(),
      new Promise<string>((_, reject) => { const timer = setTimeout(() => { reject(new Error('No incoming SSE')) }, 3000); timer.unref() }),
    ])
    expect(result).toContain('event: incoming')
  } finally { abort.abort(); await reader.cancel().catch(() => {}) }
})
