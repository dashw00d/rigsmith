// Gear routes: a model uploaded as gear (normalized to GLB by Blender, as a job) and a piece's painted weights.
//
// An upload is a gear.add command (journaled, undoable) of a piece 'importing', then a lock 'files' job runs
// inspect.py on garments/<gid>/source.* (its own animations kept for mechanisms; no human joint detection: it is worn,
// not a body) and marks the piece ready with its model, or errored. Those status writes are housekeeping. The query
// says what it is: `kind` prop (on a bone, the default for the game's scripts), clothing (on the skin) or part
// (pinned to a spot); `name` the file, whose stem is the piece's name as given; `bone` and `from` as given (a tool
// bringing in the game's own parts names them exactly; gear.add refuses a game part whose name is taken).
//
// Painted weights (garments/<gid>/weights.json; skin gear by bone name, pulled gear by 'PropRoot' / 'pull:<handle id>')
// are written by lock 'files' jobs under withFiles. Removing a piece never deletes its folder: undo can bring it back,
// and the store's orphan sweep moves folders nothing refers to into trash/.
import { gearWeightsFile } from '../../src/model/gearweights.ts'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Command } from '../../src/model/command-types.ts'
import { gearById, hierarchyOf } from '../../src/model/select.ts'
import type { Character, Gear, GearAttach, Placement } from '../../src/model/types.ts'
import { runCommands } from '../commands.ts'
import { view } from '../compat.ts'
import { by, HttpError, readBody, readJsonBody, route, send } from '../http.ts'
import { enqueue, type Job, runBlender } from '../jobs.ts'
import { characterDir, getCharacter, paths, readJson, updateCharacter, withFiles, writeJson, WORKSPACE } from '../store.ts'

/** A painted vertex of a piece: its mesh (the model's mesh order), and its weights by bone name or pull key. */
interface GearEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

const MODEL = /\.(fbx|glb|gltf|obj|dae|zip)$/i
const AT_REST: Placement = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

/** Its gear status written (housekeeping: not journaled); nothing when the piece is gone meanwhile. */
async function setStatus (id: string, gid: string, fn: (g: Gear) => void): Promise<void> {
  try {
    await updateCharacter(id, c => {
      const g = gearById(c, gid)
      if (g !== undefined) fn(g)
    })
  } catch { /* (the character deleted meanwhile) */ }
}

/** The import job of an uploaded piece (garments/<gid>/source.*): also what restart recovery queues again. */
export function importGarment (id: string, gid: string, name: string, source: string): Job {
  const dir = path.dirname(source)
  return enqueue('garment', `Import ${name}`, id, async (_job, update, signal) => {
    try {
      // (its own animations kept: a mechanism's moving parts play while it is worn)
      await runBlender('jobs/inspect.py', ['--input', source, '--out', dir, '--animations', '--no-joints'],
        (progress, text) => { update({ progress, message: text }) }, { signal })
      if (!existsSync(path.join(dir, 'model.glb'))) throw new Error('the import wrote no model (is there a mesh in it?)')
      await setStatus(id, gid, g => { g.status = 'ready'; g.model = `garments/${gid}/model.glb`; delete g.error })
    } catch (error) {
      const why = signal.aborted ? 'its import was cancelled' : message(error)
      await setStatus(id, gid, g => { if (g.status === 'importing') { g.status = 'error'; g.error = why } })
      throw error
    }
  }, { lock: 'files' })
}

/** Permit workspace aliases, but not symlinks within the workspace. */
export async function safeCharacterFolder (id: string, ...parts: string[]): Promise<string> {
  let dir = paths(id).dir
  const workspace = await realpath(WORKSPACE)
  if (await realpath(dir) !== path.join(workspace, path.relative(WORKSPACE, dir))) throw new Error('Character path contains a symlink')
  for (const part of parts) {
    if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new Error('Invalid character folder')
    dir = path.join(dir, part)
    await mkdir(dir).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
    const info = await lstat(dir)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Character folder is not a real directory')
  }
  return dir
}

/** Keep an uploaded source in a new private garment folder. */
async function writeUploadSource (id: string, gid: string, file: string, bytes: Buffer): Promise<string> {
  const dir = paths(id).garment(gid)
  await safeCharacterFolder(id, 'garments')
  await mkdir(dir)
  try {
    const source = path.join(dir, `source${path.extname(file).toLowerCase()}`)
    await writeFile(source, bytes, { flag: 'wx' })
    return source
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}

/** Stage and inspect a piece without changing the character. The caller owns the eventual command batch. */
export async function uploadPiece (id: string, bytes: Buffer, file: string, from?: string, signal?: AbortSignal): Promise<Gear> {
  if (!MODEL.test(file)) throw new HttpError(400, 'Supported files: FBX, GLB, OBJ, DAE or ZIP')
  const c = await found(id)
  const name = path.basename(file).replace(/\.[^.]+$/, '').trim()
  if (!name) throw new HttpError(400, 'The file needs a name')
  let gid = randomBytes(4).toString('hex')
  while (gearById(c, gid) !== undefined || existsSync(paths(id).garment(gid))) gid = randomBytes(4).toString('hex')
  const dir = paths(id).garment(gid)
  const source = await writeUploadSource(id, gid, file, bytes)
  try {
    await runBlender('jobs/inspect.py', ['--input', source, '--out', dir, '--animations', '--no-joints'], undefined, { signal })
    if (!existsSync(path.join(dir, 'model.glb'))) throw new Error('the import wrote no model (is there a mesh in it?)')
    return { id: gid, name, status: 'ready', handles: [], attach: { kind: 'skin', policy: 'body', place: AT_REST }, model: `garments/${gid}/model.glb`, ...(from ? { from } : {}) }
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}

/** How an upload is worn, from the route's `kind` (what the game's scripts and the app send): clothing unless said. */
function attachOf (c: Character, kind: string | null, bone: string | null): GearAttach {
  if (kind === 'part') return { kind: 'spot', place: AT_REST }
  if (kind !== 'prop' && kind !== 'rigid') return { kind: 'skin', policy: 'body', place: AT_REST }
  const joints = hierarchyOf(c).map(([j]) => j)
  // (a bone named is taken as it is: the reducer refuses one the skeleton lacks)
  const on = bone ?? (joints.includes('RightHand') ? 'RightHand' : joints.find(j => /Hand$/.test(j)) ?? joints[0])
  if (on === undefined) throw new HttpError(409, 'It has no joints to put gear on yet: place them first (Skeleton step)')
  return { kind: 'bone', bone: on, place: AT_REST }
}

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/garments$/, async (req, res, [id], url) => {
  const file = url.searchParams.get('name')
  if (file === null || !MODEL.test(file)) throw new HttpError(400, 'Supported files: FBX, GLB, OBJ, DAE or ZIP')
  const c = await found(id)
  const name = path.basename(file).replace(/\.[^.]+$/, '').trim()
  if (name === '') throw new HttpError(400, 'The file needs a name')
  const from = url.searchParams.get('from')
  const bytes = await readBody(req)
  let gid = randomBytes(4).toString('hex')
  while (gearById(c, gid) !== undefined || existsSync(paths(id).garment(gid))) gid = randomBytes(4).toString('hex')
  const gear: Gear = {
    id: gid, name, status: 'importing', handles: [],
    attach: attachOf(c, url.searchParams.get('kind'), url.searchParams.get('bone')),
    ...(from !== null && from !== '' ? { from } : {}),
  }
  // (the piece first, so a refusal leaves no files behind; its source written before its import is queued)
  const command: Command = { type: 'gear.add', gear }
  const done = await runCommands(id, [command], { by: by(req), what: 'gear.add', changes: [`gear ${name}: uploaded from ${path.basename(file)}`] })
  const added = done.character.gear.find(g => g.id === gid)
  let source: string
  try {
    source = await writeUploadSource(id, gid, file, bytes)
  } catch (error) {
    await setStatus(id, gid, g => { g.status = 'error'; g.error = `its upload couldn't be kept: ${message(error)}` })
    throw error
  }
  importGarment(id, gid, added?.name ?? name, source)
  send(res, 201, await view(req, await found(id)))
})

/** The piece and what its painted weights may be keyed by (null: any bone name). */
async function paintable (id: string, gid: string): Promise<{ c: Character, g: Gear, keys: Set<string> | null }> {
  const c = await found(id)
  const g = gearById(c, gid)
  if (g === undefined) throw new HttpError(404, 'No such gear')
  if (g.attach.kind === 'skin') return { c, g, keys: null }
  const pulls = g.handles.filter(h => h.kind === 'pull')
  if (g.attach.kind === 'bone' && pulls.length > 0) return { c, g, keys: new Set(['PropRoot', ...pulls.map(h => `pull:${h.id}`)]) }
  throw new HttpError(400, `${g.name} has no weights to paint: only gear on the skin, or with a pull, has them`)
}

function checkEdits (raw: unknown, keys: Set<string> | null): GearEdit[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new HttpError(400, 'No weights to write')
  return raw.map((e: unknown) => {
    const x = e as Partial<GearEdit> | null
    const ok = x !== null && typeof x === 'object' && Number.isInteger(x.mesh) && x.mesh! >= 0 && Number.isInteger(x.vertex) && x.vertex! >= 0 &&
      Array.isArray(x.weights) && x.weights.every(w => Array.isArray(w) && typeof w[0] === 'string' && typeof w[1] === 'number' && Number.isFinite(w[1]))
    if (!ok) throw new HttpError(400, 'Bad weight edit')
    const bad = keys === null ? undefined : x.weights!.find(([k]) => !keys.has(k))
    if (bad !== undefined) throw new HttpError(400, `Pulled gear is painted by PropRoot and pull:<handle id>, not ${bad[0]}`)
    return { mesh: x.mesh!, vertex: x.vertex!, weights: x.weights!.map(([k, w]): [string, number] => [k, w]) }
  })
}

// A piece's painted weights (skin gear's brushes, which parts of pulled gear follow its pulls), kept beside its model
// and laid over the weights it takes on every load: merged by mesh and vertex, its count on the piece (which reloads it).
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([A-Za-z0-9_-]+)\/weights$/, async (req, res, [id, gid]) => {
  const { c, g, keys } = await paintable(id, gid)
  const body = await readJsonBody<{ edits?: unknown }>(req)
  const edits = checkEdits(body.edits, keys)
  const who = by(req)
  send(res, 202, enqueue('paint', `Save ${g.name}'s painted weights`, c.id, async (_job, update, signal) => {
    update({ message: 'Writing the weights' })
    await withFiles(id, async () => {
      // (against the piece as it is now: its pulls may have changed since the request)
      const now = await paintable(id, gid)
      checkEdits(edits, now.keys)
      if (now.g.model !== g.model) throw new Error('The gear mesh changed while the painting was queued')
      signal.throwIfAborted()
      const file = path.join(characterDir(id), gearWeightsFile(now.g))
      const kept = new Map<string, GearEdit>()
      for (const e of await readJson<GearEdit[]>(file, [])) kept.set(`${e.mesh}:${e.vertex}`, e)
      for (const e of edits) kept.set(`${e.mesh}:${e.vertex}`, e)
      await mkdir(path.dirname(file), { recursive: true })
      await writeJson(file, [...kept.values()])
      await updateCharacter(id, x => {
        const piece = gearById(x, gid)
        if (piece === undefined || piece.model !== now.g.model) throw new Error('The gear mesh changed while saving its painting')
        piece.painted = kept.size
      }, { by: who, what: 'gear.weights', changes: [`gear ${now.g.name}: weights painted on ${edits.length} vertices (${kept.size} kept)`] })
    })
  }, { lock: 'files' }))
})

// Forget a piece's painting: it takes its unpainted weights again.
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([A-Za-z0-9_-]+)\/weights$/, async (req, res, [id, gid]) => {
  const c = await found(id)
  const g = gearById(c, gid)
  if (g === undefined) throw new HttpError(404, 'No such gear')
  const who = by(req)
  send(res, 202, enqueue('paint', `Forget ${g.name}'s painting`, c.id, async () => {
    await withFiles(id, async () => {
      const now = await paintable(id, gid)
      if (now.g.model !== g.model) throw new Error('The gear mesh changed while forgetting its painting')
      const file = path.join(characterDir(id), gearWeightsFile(now.g))
      const had = existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as unknown[]).length : 0
      await rm(file, { force: true })
      await updateCharacter(id, x => {
        const piece = gearById(x, gid)
        if (piece === undefined || piece.model !== now.g.model) throw new Error('The gear mesh changed while forgetting its painting')
        delete piece.painted
      }, { by: who, what: 'gear.weights', changes: [`gear ${g.name}: painted weights forgotten${had > 0 ? ` (${had} vertices)` : ''}`] })
    })
  }, { lock: 'files' }))
})
