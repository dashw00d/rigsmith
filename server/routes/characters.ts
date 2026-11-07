// Characters as a whole: list, read, import an upload, delete, thumbnail, the journal and its notes; settings; the event
// stream every open page listens to; workspace files; opening a folder; jobs. Reads of characters answer the v1 view
// unless the request asks for schema 2 (server/compat.ts).
import { spawn } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import { readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Character, JournalEntry, Settings } from '../../src/model/types.ts'
import type { GameSpec } from '../../src/model/unit.ts'
import { runCommands } from '../commands.ts'
import { view } from '../compat.ts'
import { currentHash, fileHash, libraryManifest, manifest } from '../files.ts'
import { by, CONTENT_TYPES, HttpError, readBody, readJsonBody, route, send, servable } from '../http.ts'
import { inspect } from '../inspect.ts'
import { busy, cancel, getJob, listJobs } from '../jobs.ts'
import { journal, note } from '../journal.ts'
import {
  CHARACTERS, characterDir, createCharacter, deleteCharacter, events, getCharacter, getSettings, listCharacters, readJson, saveSettings,
  UNITS_FILE, updateCharacter, WORKSPACE,
} from '../store.ts'

const IMPORTABLE = /\.(fbx|glb|gltf|obj|dae|zip)$/i
const THUMBNAIL = 'thumbnail.webp'

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

route('GET', /^\/api\/characters$/, async (req, res) => { send(res, 200, await view(req, await listCharacters())) })

route('GET', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => { send(res, 200, await view(req, await found(id))) })

// An upload: the character made (the same file again answers the one it made) and its import queued.
route('POST', /^\/api\/characters$/, async (req, res, _, url) => {
  const name = url.searchParams.get('name')
  if (name === null || !IMPORTABLE.test(name)) throw new HttpError(400, 'Supported files: FBX, GLB, OBJ, DAE or ZIP')
  const bytes = await readBody(req)
  const character = await createCharacter(path.basename(name), bytes, by(req))
  if ((character.status === 'importing' || character.status === 'error') && busy(character.id) === undefined) inspect(character)
  send(res, 201, await view(req, character))
})

// Its folder goes to workspace/trash. Refused (409) while a rider sits on it, a game unit names it or a job works on it,
// unless ?force=1: then its jobs are cancelled and its riders get off.
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id], url) => {
  const c = await found(id)
  const riders = (await listCharacters()).filter(x => x.mount?.character === id)
  const spec = await readJson<GameSpec>(UNITS_FILE, { units: {} })
  const units = Object.entries(spec.units ?? {}).filter(([, u]) => u.character === id || u.companion?.character === id).map(([name]) => name)
  const job = busy(id)
  if (url.searchParams.get('force') !== '1' && (riders.length > 0 || units.length > 0 || job !== undefined)) {
    const why = [
      riders.length > 0 ? `ridden by ${riders.map(r => r.name).join(', ')}` : '',
      units.length > 0 ? `game unit ${units.join(', ')}` : '',
      job !== undefined ? `busy (${job.label})` : '',
    ].filter(Boolean)
    throw new HttpError(409, `${c.name} is ${why.join('; ')}`, { riders: riders.map(r => r.id), units, busy: job ?? null })
  }
  for (const j of listJobs()) if (j.characterId === id) cancel(j.id)
  for (const r of riders) {
    await runCommands(r.id, x => x.mount?.character === id ? [{ type: 'mount.set', mount: null }] : [], {
      by: by(req), what: 'mount.set', changes: [`${c.name} was deleted`],
    })
  }
  await deleteCharacter(id)
  send(res, 200, { ok: true })
})

// The list's picture, rendered by the browser. Housekeeping: not journaled.
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/thumbnail$/, async (req, res, [id]) => {
  await found(id)
  const bytes = await readBody(req, 4 * 1024 * 1024)
  await writeFile(path.join(characterDir(id), THUMBNAIL), bytes)
  const character = await updateCharacter(id, c => { c.files.thumbnail = THUMBNAIL; c.thumbVersion = Date.now() }, { what: 'thumbnail', journal: false })
  send(res, 200, await view(req, character))
})

// The character's journal: every change, who made it, when (server/journal.ts); a note is a line anyone can add.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/journal$/, async (req, res, [id], url) => {
  await found(id)
  send(res, 200, await journal(id, Number(url.searchParams.get('last') ?? 200)))
})
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/journal$/, async (req, res, [id]) => {
  await found(id)
  const { note: text } = await readJsonBody<{ note?: string }>(req)
  if (typeof text !== 'string' || text.trim() === '') throw new HttpError(400, 'A note is text')
  const entry: JournalEntry = await note(id, by(req), text.trim().slice(0, 4000), true)
  send(res, 201, { ok: true, entry })
})

route('GET', /^\/api\/settings$/, async (req, res) => { send(res, 200, await getSettings()) })
route('PATCH', /^\/api\/settings$/, async (req, res) => {
  const patch = await readJsonBody<Partial<Settings>>(req)
  if (patch.gameRepo !== undefined && typeof patch.gameRepo !== 'string') throw new HttpError(400, 'gameRepo is a path')
  if (patch.handPoses !== undefined && !Array.isArray(patch.handPoses)) throw new HttpError(400, 'handPoses is a list')
  send(res, 200, await saveSettings(patch))
})

// The files a character's page may load, by path inside its folder -> content hash (server/files.ts); the page asks
// for each as /files/...?h=<hash> and hears `files` events after.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/files$/, async (req, res, [id]) => {
  await found(id)
  send(res, 200, await manifest(id))
})
// Every character's list picture's hash, by id (the list shows them before any character's manifest is asked for).
route('GET', /^\/api\/thumbnails$/, async (req, res) => {
  const out: Record<string, string> = {}
  const ids = existsSync(CHARACTERS) ? await readdir(CHARACTERS) : []
  await Promise.all(ids.map(async id => {
    const hash = await fileHash(id, THUMBNAIL)
    if (hash !== null) out[id] = hash
  }))
  send(res, 200, out)
})
// The same for the clip library (clips/, creatures/), by path inside library/.
route('GET', /^\/api\/library\/files$/, async (req, res) => { send(res, 200, await libraryManifest()) })

// What every open page hears: 'hello' (the jobs) on connecting, then 'job', 'character' { character, entry? },
// 'removed', 'journal', 'game', 'files' { character, changed } (server/files.ts), and the Forge's 'forge' and 'gpu'
// (server/forge, server/jobs.ts gpuTurn) as they happen.
route('GET', /^\/api\/events$/, async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  const write = (event: string, data: unknown): void => { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`) }
  write('hello', listJobs())
  const listeners: Array<[string, (x: unknown) => void]> = ['job', 'removed', 'journal', 'game', 'files', 'forge', 'gpu', 'incoming'].map(event => [event, x => { write(event, x) }])
  // (modules not yet ported emit the bare document)
  listeners.push(['character', x => { write('character', typeof x === 'object' && x !== null && 'character' in x ? x : { character: x }) }])
  for (const [event, fn] of listeners) events.on(event, fn)
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    for (const [event, fn] of listeners) events.off(event, fn)
  })
})

// Workspace files the app loads: /files/<path inside the workspace>, characters' files and the library only
// (server/http.ts servable). Asked for by the hash it holds now (?h=, the manifest's), it is kept by the browser for
// good: that URL never names other bytes. Without one, or by a hash it no longer holds (a page that hasn't heard the
// change yet), it is sent as it is now and not kept, so an old URL can never hold the new bytes.
route('GET', /^\/files\/(.+)$/, async (req, res, [relative], url) => {
  let decoded: string
  try { decoded = decodeURIComponent(relative) } catch { throw new HttpError(400, 'Bad path') }
  const file = path.resolve(WORKSPACE, decoded)
  const key = path.relative(WORKSPACE, file).split(path.sep).join('/')
  if (!file.startsWith(WORKSPACE + path.sep) || !servable(key) || !existsSync(file)) throw new HttpError(404, 'Not found')
  const info = await stat(file)
  if (!info.isFile()) throw new HttpError(404, 'Not found')
  const asked = url.searchParams.get('h')
  const hash = currentHash(key, info)
  const kept = asked !== null && hash === asked
  if (hash !== null && req.headers['if-none-match'] === `"${hash}"`) {
    res.writeHead(304, { etag: `"${hash}"`, 'cache-control': kept ? 'public, max-age=31536000, immutable' : 'no-cache' })
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': kept ? 'public, max-age=31536000, immutable' : asked !== null ? 'no-store' : 'no-cache',
    ...(hash !== null ? { etag: `"${hash}"` } : {}),
    'last-modified': info.mtime.toUTCString(),
  })
  createReadStream(file).pipe(res)
})

// Open a workspace folder in the system file manager.
route('POST', /^\/api\/open$/, async (req, res) => {
  const { path: target } = await readJsonBody<{ path?: unknown }>(req)
  if (typeof target !== 'string') throw new HttpError(400, 'Name a folder')
  const resolved = path.resolve(target)
  if (!resolved.startsWith(WORKSPACE + path.sep)) throw new HttpError(400, 'Only workspace folders')
  spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref()
  send(res, 200, { ok: true })
})

route('GET', /^\/api\/jobs$/, async (req, res) => { send(res, 200, listJobs()) })

route('POST', /^\/api\/jobs\/([0-9a-f]+)\/cancel$/, async (req, res, [id]) => {
  const job = getJob(id)
  if (job === undefined) throw new HttpError(404, 'No such job')
  const cancelled = cancel(id)
  if (cancelled === null) throw new HttpError(409, `That job has already ${job.status === 'done' ? 'finished' : job.status}`)
  send(res, 200, cancelled)
})
