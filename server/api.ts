// HTTP API: characters, jobs (SSE), library, settings, exports, and workspace file serving.
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { enqueue, events, type Job, listJobs, runBlender, runCodex } from './jobs.ts'
import { optimizeSkin, torchPython } from './skinopt.ts'
import { queryLibrary } from './library.ts'
import {
  type Character, characterDir, type Garment, type TextureImage, createCharacter, deleteCharacter, getCharacter, getSettings, listCharacters,
  ROOT, saveSettings, updateCharacter, type Vec3, WORKSPACE, writeJson,
} from './workspace.ts'

const MAX_UPLOAD = 512 * 1024 * 1024
const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.fbx': 'application/octet-stream',
}

class HttpError extends Error {
  status: number
  constructor (status: number, message: string) {
    super(message)
    this.status = status
  }
}

function send (res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readBody (req: IncomingMessage, limit = MAX_UPLOAD): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > limit) throw new HttpError(413, 'Upload too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

async function readJsonBody<T> (req: IncomingMessage): Promise<T> {
  const body = await readBody(req, 4 * 1024 * 1024)
  try {
    return JSON.parse(body.toString('utf8') || '{}') as T
  } catch {
    throw new HttpError(400, 'Invalid JSON')
  }
}

// ---- jobs ------------------------------------------------------------------------------------------

type Update = (patch: Partial<Job>) => void
const texturesDir = (id: string): string => path.join(characterDir(id), 'textures')

/** Import/inspect the source. With keepEdits, a re-run (e.g. after a texture fix) keeps rig state. */
async function runInspect (id: string, update: Update, keepEdits = false): Promise<void> {
  const character = (await getCharacter(id))!
  const dir = characterDir(id)
  const { result } = await runBlender('jobs/inspect.py', ['--input', path.join(dir, character.source.file), '--out', dir, '--overrides', texturesDir(id)],
    (progress, message) => { update({ progress, message }) })
  const r = result as { kind: Character['kind'], rigPreset: string | null, stats: Character['stats'], joints: Record<string, Vec3> | null, model: string | null, warnings: string[] }
  await updateCharacter(id, c => {
    c.kind = r.kind
    c.rigPreset = r.rigPreset ?? undefined
    c.stats = { ...r.stats!, bones: keepEdits && c.stats !== undefined ? c.stats.bones : r.stats!.bones }
    c.autoJoints = r.joints ?? undefined
    if (!keepEdits || c.jointsEdited !== true) { c.joints = r.joints ?? undefined; c.jointsEdited = false }
    c.fingers = c.fingers ?? 'full'
    if (r.model !== null) c.files.model = r.model
    c.files.thumbnail = undefined // re-captured from the fresh model
    c.revision = (c.revision ?? 0) + 1
    if (r.kind === 'rigged') { c.status = 'rigged'; c.files.rigged = r.model ?? undefined } else if (!keepEdits || c.status !== 'rigged') c.status = 'ready'
    if (!keepEdits) c.rigReport = r.warnings.length > 0 ? { method: 'import', seconds: 0, warnings: r.warnings } : undefined
    c.error = undefined
  })
}

async function runRig (id: string, update: Update): Promise<void> {
  const character = (await getCharacter(id))!
  const dir = characterDir(id)
  const args = ['--input', path.join(dir, character.source.file), '--output', path.join(dir, 'rigged.glb'),
    '--fingers', character.fingers ?? 'full', '--overrides', texturesDir(id)]
  const creature = character.template !== undefined && character.template !== 'human'
  if ((character.jointsEdited === true || creature) && character.joints !== undefined) {
    const jointsFile = path.join(dir, 'joints.json')
    await writeJson(jointsFile, character.joints)
    args.push('--joints', jointsFile)
  }
  if (creature) args.push('--template', path.join(ROOT, 'static', 'templates', `${character.template!}.json`))
  // Humanoids get pose-optimized weights after Blender (when PyTorch is around): Blender is the first 60%.
  const optimize = !creature && torchPython() !== null
  const share = optimize ? 0.6 : 1
  const started = Date.now()
  const { result } = await runBlender('autorig/rig.py', args, (progress, message) => { update({ progress: progress * share, message }) })
  const r = result as { joints: Record<string, Vec3>, seconds: number, method: string, warnings: string[] }
  if (optimize) {
    try {
      await optimizeSkin(path.join(dir, 'rigged.glb'), (progress, message) => { update({ progress: share + (1 - share) * progress, message }) })
      r.method += '+pose-optimized'
    } catch (error) {
      // The heat weights are a complete rig on their own; keep them and say what happened.
      r.warnings.push(`weights not pose-optimized: ${(error as Error).message.slice(0, 200)}`)
    }
    r.seconds = Math.round((Date.now() - started) / 100) / 10
  }
  await updateCharacter(id, c => {
    c.status = 'rigged'
    c.files.rigged = 'rigged.glb'
    c.revision = (c.revision ?? 0) + 1
    c.joints = r.joints
    if (c.stats !== undefined) c.stats.bones = Object.keys(r.joints).length
    c.rigReport = { method: r.method, seconds: r.seconds, warnings: r.warnings }
  })
}

async function failed (id: string, error: unknown): Promise<never> {
  await updateCharacter(id, c => { c.status = 'error'; c.error = (error as Error).message })
  throw error
}

function inspect (character: Character): Job {
  return enqueue('inspect', `Import ${character.name}`, character.id, async (job, update) => {
    try { await runInspect(character.id, update) } catch (error) { await failed(character.id, error) }
  })
}

function rig (character: Character): Job {
  return enqueue('rig', `Rig ${character.name}`, character.id, async (job, update) => {
    await updateCharacter(character.id, c => { c.status = 'rigging'; c.error = undefined })
    try { await runRig(character.id, update) } catch (error) { await failed(character.id, error) }
  })
}

/** Rebuild the preview (and the rig, if any) so a texture change reaches every output. */
async function refreshOutputs (id: string, update: Update): Promise<void> {
  const before = (await getCharacter(id))!
  update({ progress: 0.6, message: 'Updating preview' })
  await runInspect(id, () => {}, true)
  if (before.kind === 'mesh' && before.status === 'rigged') {
    update({ progress: 0.8, message: 'Re-applying the rig' })
    await runRig(id, () => {})
  }
}

function fillTexture (character: Character): Job {
  return enqueue('texture', `Fill holes · ${character.name}`, character.id, async (job, update) => {
    const dir = characterDir(character.id)
    const { result } = await runBlender('jobs/texture_fill.py', ['--input', path.join(dir, character.source.file), '--out', texturesDir(character.id)],
      (progress, message) => { update({ progress: progress * 0.6, message }) })
    const images = (result as { images: TextureImage[] }).images
    await updateCharacter(character.id, c => { c.texture = { filled: images.some(i => i.file !== null), images, at: Date.now() } })
    await refreshOutputs(character.id, update)
  })
}

function saveTexture (character: Character, name: string, bytes: Buffer, label: string): Job {
  return enqueue('texture', `${label} · ${character.name}`, character.id, async (job, update) => {
    await mkdir(texturesDir(character.id), { recursive: true })
    await writeFile(path.join(texturesDir(character.id), `${name}.png`), bytes)
    await updateCharacter(character.id, c => {
      c.texture = { filled: c.texture?.filled ?? false, images: c.texture?.images ?? [], at: Date.now(), painted: true }
    })
    await refreshOutputs(character.id, update)
  })
}

function revertTexture (character: Character): Job {
  return enqueue('texture', `Restore texture · ${character.name}`, character.id, async (job, update) => {
    await rm(texturesDir(character.id), { recursive: true, force: true })
    await updateCharacter(character.id, c => { if (c.texture !== undefined) { c.texture.filled = false; c.texture.painted = false } })
    await refreshOutputs(character.id, update)
  })
}

// ---- routes ----------------------------------------------------------------------------------------

type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>
const routes: Array<[string, RegExp, Handler]> = []
const route = (method: string, pattern: RegExp, handler: Handler): void => { routes.push([method, pattern, handler]) }

route('GET', /^\/api\/characters$/, async (req, res) => { send(res, 200, await listCharacters()) })

route('POST', /^\/api\/characters$/, async (req, res, _, url) => {
  const name = url.searchParams.get('name')
  if (name === null || !/\.(fbx|glb|gltf|obj|dae|zip)$/i.test(name)) throw new HttpError(400, 'Supported files: FBX, GLB, OBJ, DAE or ZIP')
  const bytes = await readBody(req)
  const character = await createCharacter(path.basename(name), bytes)
  if (character.status === 'importing' || character.status === 'error') inspect(character)
  send(res, 201, character)
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 200, character)
})

route('PATCH', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  const patch = await readJsonBody<Partial<Character>>(req)
  const allowed: Array<keyof Character> = ['name', 'joints', 'jointsEdited', 'fingers', 'animations', 'props', 'garments', 'boneMap']
  const character = await updateCharacter(id, c => {
    for (const key of allowed) if (key in patch) (c as unknown as Record<string, unknown>)[key] = patch[key]
  })
  send(res, 200, character)
})

route('DELETE', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  await deleteCharacter(id)
  send(res, 200, { ok: true })
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/rig$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  if (character.kind !== 'mesh') throw new HttpError(400, 'Only unrigged meshes need rigging')
  send(res, 202, rig(character))
})

// Choose the skeleton template. Re-rigging an imported rigged model turns it back into a mesh to rig.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/template$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ template: string, joints?: Record<string, Vec3> }>(req)
  if (!/^[a-z]+$/.test(body.template)) throw new HttpError(400, 'Bad template')
  const character = await updateCharacter(id, c => {
    // A different skeleton family can't play the previous set's clips.
    if ((c.template ?? 'human') !== body.template) c.animations = []
    c.template = body.template
    if (c.kind === 'rigged') { c.kind = 'mesh'; c.files.rigged = undefined; c.status = 'ready' }
    if (body.template === 'human') {
      c.joints = c.autoJoints
      c.jointsEdited = false
    } else if (body.joints !== undefined) {
      c.joints = body.joints
      c.jointsEdited = true
    }
    if (c.status === 'rigged') c.status = 'ready'
  })
  send(res, 200, character)
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/reimport$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 202, inspect(character))
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/texture\/fill$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 202, fillTexture(character))
})

// A painted texture from the browser (projection painting) replaces the current one everywhere.
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/textures\/([\w.-]+)$/, async (req, res, [id, name]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 202, saveTexture(character, name.replace(/\.png$/i, ''), await readBody(req), 'Apply painting'))
})

// Projection captures: a folder per capture with the view images, camera and prompt; result.* comes back.
const projectionDir = (id: string, pid: string): string => {
  if (!/^[a-z0-9-]+$/.test(pid)) throw new HttpError(400, 'Bad projection id')
  return path.join(characterDir(id), 'projections', pid)
}

route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([a-z0-9-]+)\/([\w.-]+\.(?:png|jpg|webp|json|md))$/, async (req, res, [id, pid, file]) => {
  const dir = projectionDir(id, pid)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, file), await readBody(req, 64 * 1024 * 1024))
  send(res, 200, { path: path.join(dir, file) })
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/projections$/, async (req, res, [id]) => {
  const root = path.join(characterDir(id), 'projections')
  const ids = existsSync(root) ? await readdir(root) : []
  const out = await Promise.all(ids.map(async pid => {
    const files = await readdir(path.join(root, pid))
    const info = await stat(path.join(root, pid))
    return { id: pid, createdAt: info.birthtimeMs || info.mtimeMs, hasResult: files.some(f => /^result\.(png|jpe?g|webp)$/i.test(f)), complete: files.includes('camera.json') && files.includes('mask.png') }
  }))
  send(res, 200, out.filter(p => p.complete).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12))
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([a-z0-9-]+)$/, async (req, res, [id, pid]) => {
  const dir = projectionDir(id, pid)
  const files = existsSync(dir) ? await readdir(dir) : []
  const result = files.find(f => /^result\.(png|jpe?g|webp)$/i.test(f))
  let resultVersion: number | null = null
  if (result !== undefined) resultVersion = (await stat(path.join(dir, result))).mtimeMs
  send(res, 200, { path: dir, files, result: result ?? null, resultVersion })
})

// Ask Codex (CLI, image generation) to paint result.png for a capture.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([a-z0-9-]+)\/codex$/, async (req, res, [id, pid]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  const dir = projectionDir(id, pid)
  if (!existsSync(path.join(dir, 'prompt.md'))) throw new HttpError(400, 'Capture the view first')
  const job = enqueue('codex', `Codex painting · ${character.name}`, id, async (job, update) => {
    update({ progress: 0.1, message: 'Codex is painting' })
    const prompt = await readFile(path.join(dir, 'prompt.md'), 'utf8')
    await runCodex(dir, prompt, ['flat.png', 'mask.png', 'color.png'], message => { update({ message }) })
    if (!(await readdir(dir)).some(f => /^result\.(png|jpe?g|webp)$/i.test(f))) throw new Error('Codex finished without writing result.png')
  })
  send(res, 202, job)
})

// Saved skeleton mappings (Mixamo bone -> rig bone), reusable across characters with the same rig.
const PRESETS = path.join(WORKSPACE, 'presets', 'skeletons')

route('GET', /^\/api\/skeleton-presets$/, async (req, res) => {
  const files = existsSync(PRESETS) ? (await readdir(PRESETS)).filter(f => f.endsWith('.json')) : []
  const presets = await Promise.all(files.map(async f => JSON.parse(await readFile(path.join(PRESETS, f), 'utf8')) as { name: string, map: Record<string, string> }))
  send(res, 200, presets.sort((a, b) => a.name.localeCompare(b.name)))
})

route('POST', /^\/api\/skeleton-presets$/, async (req, res) => {
  const body = await readJsonBody<{ name: string, map: Record<string, string> }>(req)
  const name = body.name.trim()
  if (name === '' || name.length > 60) throw new HttpError(400, 'Give the preset a name')
  await mkdir(PRESETS, { recursive: true })
  await writeJson(path.join(PRESETS, `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`), { name, map: body.map })
  send(res, 201, { ok: true })
})

// Open a workspace folder in the system file manager.
route('POST', /^\/api\/open$/, async (req, res) => {
  const { path: target } = await readJsonBody<{ path: string }>(req)
  const resolved = path.resolve(target)
  if (!resolved.startsWith(WORKSPACE + path.sep) && resolved !== (await getSettings()).exportDir) throw new HttpError(400, 'Only workspace folders')
  spawn('xdg-open', [resolved], { detached: true, stdio: 'ignore' }).unref()
  send(res, 200, { ok: true })
})

route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/texture\/fill$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 202, revertTexture(character))
})

// The user's own garment/accessory meshes: stored per character, normalized to GLB by Blender.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/garments$/, async (req, res, [id], url) => {
  const name = url.searchParams.get('name')
  if (name === null || !/\.(fbx|glb|gltf|obj|dae|zip)$/i.test(name)) throw new HttpError(400, 'Supported files: FBX, GLB, OBJ, DAE or ZIP')
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  const bytes = await readBody(req)
  const gid = randomBytes(4).toString('hex')
  const dir = path.join(characterDir(id), 'garments', gid)
  await mkdir(dir, { recursive: true })
  const source = path.join(dir, `source${path.extname(name).toLowerCase()}`)
  await writeFile(source, bytes)
  const garment: Garment = {
    id: gid, name: path.basename(name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), status: 'importing',
    mode: 'clothing', policy: 'body', bone: 'Head', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, hideBody: false,
  }
  await updateCharacter(id, c => { c.garments = [...(c.garments ?? []), garment] })
  enqueue('garment', `Import ${garment.name}`, id, async (job, update) => {
    try {
      await runBlender('jobs/inspect.py', ['--input', source, '--out', dir], (progress, message) => { update({ progress, message }) })
      await updateCharacter(id, c => {
        const g = c.garments?.find(x => x.id === gid)
        if (g !== undefined) { g.status = 'ready'; g.file = `garments/${gid}/model.glb` }
      })
    } catch (error) {
      await updateCharacter(id, c => {
        const g = c.garments?.find(x => x.id === gid)
        if (g !== undefined) { g.status = 'error'; g.error = (error as Error).message }
      })
      throw error
    }
  })
  send(res, 201, await getCharacter(id))
})

route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/thumbnail$/, async (req, res, [id]) => {
  const bytes = await readBody(req, 4 * 1024 * 1024)
  await writeFile(path.join(characterDir(id), 'thumbnail.webp'), bytes)
  const character = await updateCharacter(id, c => { c.files.thumbnail = 'thumbnail.webp'; c.thumbVersion = Date.now() })
  send(res, 200, character)
})

route('GET', /^\/api\/jobs$/, async (req, res) => { send(res, 200, listJobs()) })

route('GET', /^\/api\/events$/, async (req, res) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  res.write(`event: hello\ndata: ${JSON.stringify(listJobs())}\n\n`)
  const onJob = (job: Job): void => {
    res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`)
    if ((job.status === 'done' || job.status === 'failed') && job.characterId !== undefined) {
      void getCharacter(job.characterId).then(c => { if (c !== null) res.write(`event: character\ndata: ${JSON.stringify(c)}\n\n`) })
    }
  }
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  events.on('job', onJob)
  req.on('close', () => { clearInterval(ping); events.off('job', onJob) })
})

route('GET', /^\/api\/library$/, async (req, res, _, url) => {
  send(res, 200, await queryLibrary({
    category: url.searchParams.get('category') ?? undefined,
    query: url.searchParams.get('q') ?? undefined,
    source: url.searchParams.get('source') ?? undefined,
    rig: url.searchParams.get('rig') ?? undefined,
    page: Number(url.searchParams.get('page') ?? 0),
    pageSize: Number(url.searchParams.get('size') ?? 24),
  }))
})

route('GET', /^\/api\/settings$/, async (req, res) => { send(res, 200, await getSettings()) })
route('PATCH', /^\/api\/settings$/, async (req, res) => { send(res, 200, await saveSettings(await readJsonBody(req))) })

route('POST', /^\/api\/exports$/, async (req, res, _, url) => {
  const name = path.basename(url.searchParams.get('name') ?? '')
  if (!/^[\w .-]+\.(glb|fbx)$/i.test(name)) throw new HttpError(400, 'Bad export name')
  const settings = await getSettings()
  await mkdir(settings.exportDir, { recursive: true })
  const target = path.join(settings.exportDir, name)
  await writeFile(target, await readBody(req))
  send(res, 201, { path: target })
})

// Workspace files: /files/<relative path inside the workspace>.
route('GET', /^\/files\/(.+)$/, async (req, res, [relative]) => {
  const file = path.resolve(WORKSPACE, decodeURIComponent(relative))
  if (!file.startsWith(WORKSPACE + path.sep) || !existsSync(file)) throw new HttpError(404, 'Not found')
  const info = await stat(file)
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'content-length': info.size,
    'cache-control': 'no-cache',
    'last-modified': info.mtime.toUTCString(),
  })
  createReadStream(file).pipe(res)
})

export async function handle (req: IncomingMessage, res: ServerResponse, next?: () => void): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://local')
  if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/files/')) {
    next?.()
    return
  }
  for (const [method, pattern, handler] of routes) {
    const match = pattern.exec(url.pathname)
    if (match !== null && req.method === method) {
      try {
        await handler(req, res, match.slice(1), url)
      } catch (error) {
        const status = error instanceof HttpError ? error.status : 500
        if (!res.headersSent) send(res, status, { error: (error as Error).message })
        else res.end()
      }
      return
    }
  }
  send(res, 404, { error: 'Unknown endpoint' })
}

/** Characters left mid-import by a restart get re-inspected. */
export async function resumeInterrupted (): Promise<void> {
  for (const c of await listCharacters()) {
    if (c.status === 'importing') inspect(c)
    if (c.status === 'rigging') await updateCharacter(c.id, x => { x.status = 'ready' })
  }
}
