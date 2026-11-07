import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { by, CONTENT_TYPES, HttpError, readJsonBody, route, send } from '../http.ts'
import { getCharacter, events, withFiles } from '../store.ts'
import { incomingDir, listIncoming, safeFile } from '../incoming/read.ts'
import { changeState, statusOf } from '../incoming/state.ts'
import { startIncomingWatch } from '../incoming/watch.ts'
import { enqueue } from '../jobs.ts'
import { ingest, validateAccept, type AcceptRequest } from '../incoming/ingest.ts'

void startIncomingWatch().catch(error => { console.error('rigsmith: incoming watcher:', error) })
route('GET', /^\/api\/incoming$/, async (_req, res, _params, url) => {
  const id = url.searchParams.get('character')
  const character = id === null ? null : await getCharacter(id)
  if (id !== null && character === null) throw new HttpError(404, 'No such character')
  send(res, 200, await listIncoming(character))
})
route('POST', /^\/api\/incoming\/accept$/, async (req, res) => {
  const body = await readJsonBody<AcceptRequest>(req)
  await validateAccept(body)
  const who = by(req)
  send(res, 202, enqueue('incoming', 'Accept incoming parts', body.character, async (_job, update, signal) => {
    await validateAccept(body)
    await withFiles(body.character, async () => await ingest(body, { by: who, signal, progress: (progress, message) => { update({ progress, message }) } }))
  }, { lock: 'files' }))
})
for (const action of ['reject', 'restore'] as const) route('POST', new RegExp(`^/api/incoming/${action}$`), async (req, res) => {
  const body = await readJsonBody<{ package?: unknown, parts?: unknown }>(req)
  if (typeof body.package !== 'string' || !Array.isArray(body.parts) || !body.parts.every(x => typeof x === 'string') || body.parts.length === 0) throw new HttpError(400, 'Name a package and its parts')
  const listing = await listIncoming()
  const pkg = listing.packages.find(p => p.id === body.package)
  if (!pkg) throw new HttpError(404, 'No such package')
  const parts = body.parts.map(id => pkg.parts.find(p => p.id === id))
  if (parts.some(p => p === undefined)) throw new HttpError(404, 'No such part')
  await changeState(async state => {
    for (const part of parts) if (part) {
      const record = state[`${pkg.id}/${part.id}`]
      const status = await statusOf(record, part.sha256)
      if (status !== (action === 'reject' ? 'pending' : 'rejected')) throw new HttpError(409, `${part.id}: already ${status}`)
    }
    for (const part of parts) if (part) {
    const key = `${pkg.id}/${part.id}`
    if (action === 'restore') delete state[key]
    else state[key] = { status: 'rejected', sha: part.sha256, at: new Date().toISOString() }
    }
  })
  const result = await listIncoming(); events.emit('incoming', { pending: result.pending }); send(res, 200, result)
})
route('GET', /^\/files\/incoming\/([^/]+)\/(.+)$/, async (_req, res, [encodedPkg, encodedFile]) => {
  let pkg: string; let relative: string
  try { pkg = decodeURIComponent(encodedPkg); relative = decodeURIComponent(encodedFile) } catch { throw new HttpError(400, 'Bad path') }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(pkg)) throw new HttpError(404, 'Not found')
  let file: string
  try { file = await safeFile(path.join(await incomingDir(), pkg), relative) } catch { throw new HttpError(404, 'Not found') }
  const info = await stat(file)
  res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'content-length': info.size, 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
})
