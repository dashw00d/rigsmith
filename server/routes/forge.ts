// The Forge's routes (docs/dressing-plan.md Phase 4): the board's state, sets and items, running a stage, picking and
// approving attempts, publishing, the queue's order and cancel, its events, and the attempts' files (read-only).
// Everything is read from the game's forge.json (server/forge/config.ts) and its store; the queue lives as long as the
// server and picks up after a restart (resumeForge, at startup).
import { createReadStream, existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { ForgeConfigError, findStage, ID, loadConfig } from '../forge/config.ts'
import { publish } from '../forge/publish.ts'
import { ForgeQueue } from '../forge/queue.ts'
import { ForgeStore, setView } from '../forge/store.ts'
import type { ForgeConfig, ForgeView } from '../forge/types.ts'
import { by, CONTENT_TYPES, HttpError, readJsonBody, route, send } from '../http.ts'
import { enqueue, gpuConfig, gpuState } from '../jobs.ts'
import { events } from '../store.ts'

interface Forge { config: ForgeConfig, store: ForgeStore, queue: ForgeQueue }
let forge: Forge | null = null

/** The game's Forge as forge.json has it now (a new store when the file moved it); 409 when the game has none or
 * its file is broken (every problem named). */
async function current (): Promise<Forge> {
  let config: ForgeConfig | null
  try { config = await loadConfig() } catch (error) {
    if (error instanceof ForgeConfigError) throw new HttpError(409, error.message, { problems: error.problems })
    throw error
  }
  if (config === null) throw new HttpError(409, "The game has no forge.json: the Forge needs one in the game's repo")
  if (config.comfy !== undefined) gpuConfig.comfyUrl = config.comfy
  if (forge === null || forge.store.root !== config.store) {
    const store = new ForgeStore(config.store)
    const queue = new ForgeQueue({
      store,
      config: async () => (await loadConfig()) ?? config,
      emit: e => { events.emit('forge', e) },
    })
    forge = { config, store, queue }
    await queue.load()
  }
  forge.config = config
  return forge
}

/** At startup: the queue read back (jobs a restart cut off interrupted, resumable ones carried on). Quiet without a
 * forge.json. */
export async function resumeForge (): Promise<void> {
  try { await current() } catch (error) {
    if (!(error instanceof HttpError && error.status === 409 && !('problems' in (error.body ?? {})))) console.error('rigsmith: the Forge did not start:', error)
  }
}

/** The store and queue's plain errors as answers: what's missing is 404, the rest a refusal. */
async function answer<T> (fn: () => Promise<T>): Promise<T> {
  try { return await fn() } catch (error) {
    if (error instanceof HttpError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new HttpError(/^No |has no (item|stage|attempt)/.test(message) ? 404 : 400, message)
  }
}

const text = (x: unknown, what: string): string => {
  if (typeof x !== 'string' || x.trim() === '') throw new HttpError(400, `Name the ${what}`)
  return x.trim()
}
const optionalId = (x: unknown): string | undefined => {
  if (x === undefined) return undefined
  if (typeof x !== 'string' || !ID.test(x)) throw new HttpError(400, 'An id is lowercase letters, digits, - and _')
  return x
}
const spec = (x: unknown): Record<string, unknown> => {
  if (x === undefined) return {}
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new HttpError(400, 'A spec is an object')
  return x as Record<string, unknown>
}

async function view (f: Forge): Promise<ForgeView & { gpu: ReturnType<typeof gpuState> }> {
  const sets = await Promise.all((await f.store.sets()).map(async s => await setView(f.store, f.config, s)))
  const { repo, store, character, pipelines } = f.config
  return { config: { repo, store, ...(character !== undefined ? { character } : {}), pipelines }, sets, queue: f.queue.list(), gpu: gpuState() }
}

route('GET', /^\/api\/forge$/, async (req, res) => {
  let f: Forge
  try { f = await current() } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      send(res, 200, { config: null, error: error.message, ...(error.body ?? {}), sets: [], queue: [], gpu: gpuState() })
      return
    }
    throw error
  }
  send(res, 200, await view(f))
})

// What the board hears: 'forge' (a job's progress, ETA and log tail, about four a second) and 'gpu' (the GPU lane).
route('GET', /^\/api\/forge\/events$/, async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const write = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  write('gpu', gpuState())
  const listeners: Array<[string, (x: unknown) => void]> = ['forge', 'gpu'].map(event => [event, x => { write(event, x) }])
  for (const [event, fn] of listeners) events.on(event, fn)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    for (const [event, fn] of listeners) events.off(event, fn)
  })
})

// A set: {name, pipeline, id?, note?, items?: [{name, id?, spec?}]}.
route('POST', /^\/api\/forge\/sets$/, async (req, res) => {
  const f = await current()
  const body = await readJsonBody<{ name?: unknown, pipeline?: unknown, id?: unknown, note?: unknown, items?: unknown }>(req)
  const pipeline = text(body.pipeline, 'pipeline')
  if (f.config.pipelines[pipeline] === undefined) throw new HttpError(400, `The game's forge.json has no ${pipeline} pipeline (it has ${Object.keys(f.config.pipelines).join(', ')})`)
  const items = body.items === undefined ? [] : Array.isArray(body.items) ? body.items as Array<Record<string, unknown>> : null
  if (items === null) throw new HttpError(400, 'items is a list')
  const id = optionalId(body.id)
  const set = await answer(async () => await f.store.createSet({ name: text(body.name, 'set'), pipeline, ...(id !== undefined ? { id } : {}), ...(typeof body.note === 'string' ? { note: body.note } : {}) }))
  for (const i of items) {
    const iid = optionalId(i.id)
    await f.store.createItem(set.id, { name: text(i.name, 'item'), spec: spec(i.spec), ...(iid !== undefined ? { id: iid } : {}) })
  }
  send(res, 201, await setView(f.store, f.config, set))
})

route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/items$/, async (req, res, [sid]) => {
  const f = await current()
  const body = await readJsonBody<{ name?: unknown, id?: unknown, spec?: unknown }>(req)
  const id = optionalId(body.id)
  await answer(async () => await f.store.createItem(sid, { name: text(body.name, 'item'), spec: spec(body.spec), ...(id !== undefined ? { id } : {}) }))
  const set = await f.store.getSet(sid)
  send(res, 201, await setView(f.store, f.config, set!))
})

interface RunBody { stage?: unknown, params?: unknown, variants?: unknown, through?: unknown, items?: unknown }

function runArgs (body: RunBody): { stage: string, params?: Record<string, unknown>, variants?: number, through?: string } {
  const out: { stage: string, params?: Record<string, unknown>, variants?: number, through?: string } = { stage: text(body.stage, 'stage') }
  if (body.params !== undefined) out.params = spec(body.params)
  if (body.variants !== undefined) {
    if (!Number.isInteger(body.variants)) throw new HttpError(400, 'variants is a whole number')
    out.variants = body.variants as number
  }
  if (body.through !== undefined) out.through = text(body.through, 'stage to run through')
  return out
}

// Run a stage of an item: {stage, params?, variants?, through?: 'gate' | a stage}. 202 with the jobs queued.
route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/items\/([a-z0-9_-]+)\/run$/, async (req, res, [sid, iid]) => {
  const f = await current()
  const args = runArgs(await readJsonBody<RunBody>(req))
  send(res, 202, await answer(async () => await f.queue.enqueue({ set: sid, item: iid, ...args, by: by(req) })))
})

// A batch: the stage for every item of the set (or those named), e.g. "10 Gael hats" through to the first gate.
route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/run$/, async (req, res, [sid]) => {
  const f = await current()
  const body = await readJsonBody<RunBody>(req)
  const args = runArgs(body)
  const items = body.items === undefined ? (await f.store.items(sid)).map(i => i.id) : Array.isArray(body.items) ? body.items.map(i => text(i, 'item')) : null
  if (items === null) throw new HttpError(400, 'items is a list of item ids')
  const jobs = []
  for (const item of items) jobs.push(...await answer(async () => await f.queue.enqueue({ set: sid, item, ...args, by: by(req) })))
  send(res, 202, jobs)
})

async function itemStage (f: Forge, sid: string, iid: string, stageId: unknown): Promise<string> {
  const set = await f.store.getSet(sid)
  if (set === null) throw new HttpError(404, `No set is called ${sid}`)
  if (await f.store.getItem(sid, iid) === null) throw new HttpError(404, `${set.name} has no item ${iid}`)
  const stage = findStage(f.config, set.pipeline, text(stageId, 'stage'))
  if (stage === undefined) throw new HttpError(404, `The ${set.pipeline} pipeline has no stage ${String(stageId)}`)
  return stage.id
}

// Pick an attempt: {stage, attempt}. The stages after it now follow from it (theirs go stale when they were made
// from another).
route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/items\/([a-z0-9_-]+)\/pick$/, async (req, res, [sid, iid]) => {
  const f = await current()
  const body = await readJsonBody<{ stage?: unknown, attempt?: unknown }>(req)
  const stage = await itemStage(f, sid, iid, body.stage)
  const selection = await answer(async () => await f.store.select(sid, iid, stage, text(body.attempt, 'attempt'), by(req)))
  send(res, 200, { selection, set: await setView(f.store, f.config, (await f.store.getSet(sid))!) })
})

// Approve: {stage, attempt?} (default the one picked). For gates that ask for it (approve, align, mask).
route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/items\/([a-z0-9_-]+)\/approve$/, async (req, res, [sid, iid]) => {
  const f = await current()
  const body = await readJsonBody<{ stage?: unknown, attempt?: unknown }>(req)
  const stage = await itemStage(f, sid, iid, body.stage)
  const attempt = body.attempt !== undefined ? text(body.attempt, 'attempt') : (await f.store.selection(sid, iid, stage))?.attempt
  if (attempt === undefined) throw new HttpError(409, 'Nothing is picked to approve')
  const selection = await answer(async () => await f.store.select(sid, iid, stage, attempt, by(req), true))
  send(res, 200, { selection, set: await setView(f.store, f.config, (await f.store.getSet(sid))!) })
})

// Publish {items?, character?: id | null}: a job (Activity shows it), one at a time.
route('POST', /^\/api\/forge\/sets\/([a-z0-9_-]+)\/publish$/, async (req, res, [sid]) => {
  const f = await current()
  const body = await readJsonBody<{ items?: unknown, character?: unknown }>(req)
  const set = await f.store.getSet(sid)
  if (set === null) throw new HttpError(404, `No set is called ${sid}`)
  const items = body.items === undefined ? undefined : Array.isArray(body.items) ? body.items.map(i => text(i, 'item')) : null
  if (items === null) throw new HttpError(400, 'items is a list of item ids')
  const character = body.character === undefined ? undefined : body.character === null ? null : text(body.character, 'character')
  const who = by(req)
  // (no character lock: the pieces' own imports take it, and would wait on this job forever)
  const job = enqueue('forge-publish', `Publish · ${set.name}`, undefined, async (job, update, signal) => {
    const report = await publish({
      config: f.config, store: f.store, set: sid, by: who, signal,
      ...(items !== undefined ? { items } : {}), ...(character !== undefined ? { character } : {}),
      onProgress: (progress, message) => { update({ progress, message }) },
    })
    const n = report.items.filter(i => i.skipped === undefined).length
    const summary = `Published ${n} of ${report.items.length}${report.character !== undefined ? `; ${report.character.added.length} new pieces, ${report.character.replaced.length} replaced` : ''}`
    update({ message: summary, result: { set: sid, summary, report: report as unknown as Record<string, unknown> } })
    events.emit('forge-published', { set: sid, report })
  }, { lock: 'none', exclusive: 'forge-publish' })
  send(res, 202, job)
})

route('POST', /^\/api\/forge\/queue\/reorder$/, async (req, res) => {
  const f = await current()
  const { ids } = await readJsonBody<{ ids?: unknown }>(req)
  if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) throw new HttpError(400, 'ids lists the queued jobs in their new order')
  send(res, 200, await f.queue.reorder(ids as string[]))
})

route('POST', /^\/api\/forge\/queue\/([0-9a-f]+)\/cancel$/, async (req, res, [id]) => {
  const f = await current()
  const job = f.queue.list().find(j => j.id === id)
  if (job === undefined) throw new HttpError(404, 'No such job')
  const done = await f.queue.cancel(id)
  if (done === null) throw new HttpError(409, `That job has already ${job.status === 'done' ? 'finished' : job.status}`)
  send(res, 200, done)
})

// An attempt's files, read-only: /files/forge/<set>/<item>/<stage>/<attempt>/(out/...|log.txt|manifest.json|spec.json)
const FILE = /^\/files\/forge\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/([a-z0-9_-]+)\/(a\d{3,}(?:\.partial)?)\/((?:out\/.+)|log\.txt|manifest\.json|spec\.json)$/
const TYPES: Record<string, string> = { ...CONTENT_TYPES, '.txt': 'text/plain; charset=utf-8', '.log': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml' }

route('GET', /^\/files\/forge\/(.+)$/, async (req, res, _m, url) => {
  let decoded: string
  try { decoded = decodeURIComponent(url.pathname) } catch { throw new HttpError(400, 'Bad path') }
  const m = FILE.exec(decoded)
  if (m === null || decoded.split('/').includes('..')) throw new HttpError(404, 'Not found')
  const f = await current()
  const [, sid, iid, stage, attempt, rel] = m
  const dir = f.store.attemptDir(sid, iid, stage, attempt)
  const file = path.resolve(dir, rel)
  if (!file.startsWith(dir + path.sep) || !existsSync(file)) throw new HttpError(404, 'Not found')
  const info = await stat(file)
  if (!info.isFile()) throw new HttpError(404, 'Not found')
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': rel.startsWith('out/') ? 'max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
})
