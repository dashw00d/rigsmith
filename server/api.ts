// HTTP API: characters, jobs (SSE), library, settings, exports, and workspace file serving.
import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { enqueue, events, type Job, listJobs, runBlender, runCodex } from './jobs.ts'
import { mapPainting, optimizeSkin, torchPython, validateSkin } from './skinopt.ts'
import { categoryOf, queryLibrary } from './library.ts'
import { editId, saveCreatureClip, saveEdit, type SavedEdit } from './clipedits.ts'
import { journal, note as note_, record } from './journal.ts'
import { swapImages } from './glbimages.ts'
import { extentY, transformGlb } from './glbtransform.ts'
import { exportUnits, gameSlots, gameStatus, saveUnits, units, type UnitSpec } from './game.ts'
import { dropWeightEdits, keepWeightEdits, publishRig, weightEdits, writeWeights, type WeightEdit } from './weights.ts'
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

/** Who made a change: a tool names itself in the x-rigsmith-by header (an agent: "agent"); the app sends none. */
const by = (req: IncomingMessage): string => {
  const h = req.headers['x-rigsmith-by']
  const who = (Array.isArray(h) ? h[0] : h)?.trim()
  return who !== undefined && /^[\w .:-]{1,40}$/.test(who) ? who : 'app'
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
  // (the joints found at the character's finger level: all of them unless it was set lower)
  const { result } = await runBlender('jobs/inspect.py', ['--input', path.join(dir, character.source.file), '--out', dir, '--overrides', texturesDir(id), '--ground', '--fingers', character.fingers ?? 'full', '--scale', String(character.scale ?? 1)],
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

/** A creature template's bundled clips (static/<template.animations>), if it has any. */
async function templateAnimations (template: string): Promise<string | undefined> {
  try {
    const spec = JSON.parse(await readFile(path.join(ROOT, 'static', 'templates', `${template}.json`), 'utf8')) as { animations?: string }
    const file = spec.animations === undefined ? undefined : path.join(ROOT, 'static', spec.animations)
    return file !== undefined && existsSync(file) ? file : undefined
  } catch {
    return undefined
  }
}

/** The clips a person's weights are always trained on: the unit's own (what the game plays) and the Rig step's tests
 * (arms over the head, a squat, fists: what shows a bad rig), whatever the library draw. */
async function trainedClips (character: Character): Promise<string[]> {
  const tests = JSON.parse(await readFile(path.join(ROOT, 'static', 'templates', 'tests.json'), 'utf8')) as Record<string, Array<{ id: string, url?: string }>>
  const own = (character.animations ?? []).map(a => a.clipId)
  return [...new Set([...own, ...(tests.human ?? []).filter(t => t.url === undefined).map(t => t.id)])]
}

async function runRig (id: string, update: Update): Promise<void> {
  const character = (await getCharacter(id))!
  await updateCharacter(id, c => { c.status = 'rigging' })
  const dir = characterDir(id)
  // Keep the last working rig until building, optimization and painting all finish.
  const output = path.join(dir, `rigging-${randomBytes(6).toString('hex')}.glb`)
  const alternative = output.replace(/\.glb$/, '-heat.glb')
  const beforeOptimize = output.replace(/\.glb$/, '-before-optimize.glb')
  try {
    const args = ['--input', path.join(dir, character.source.file), '--output', output,
      '--fingers', character.fingers ?? 'full', '--overrides', texturesDir(id), '--scale', String(character.scale ?? 1)]
    const creature = character.template !== undefined && character.template !== 'human'
    if (!creature || character.template === 'horse') args.push('--native-output', alternative)
    if (character.joints !== undefined) {
      const jointsFile = path.join(dir, 'joints.json')
      // (joints placed at a lower finger level (one chain for the four fingers, kept as the index) rigged with all the
      // fingers: the index traced again with the others, never the middle of a mitten taken for it)
      const placed = { ...character.joints }
      if ((character.fingers ?? 'full') === 'full' && placed.LeftHandMiddle1 === undefined) {
        for (const name of Object.keys(placed)) if (/^(Left|Right)HandIndex[1-4]$/.test(name)) delete placed[name]
      }
      await writeJson(jointsFile, placed)
      args.push('--joints', jointsFile)
    }
    if (creature) args.push('--template', path.join(ROOT, 'static', 'templates', `${character.template!}.json`))
    // Pose-optimized weights after Blender (when PyTorch is around), for humanoids (trained on the library). Not for
    // creatures: on a horse trained on its template's own clips it lowered its own objective while the walk got worse
    // (mean worst stretch 0.20 -> 0.31, 40 -> 189 vertices past double length) and tore flaps at the front legs and the
    // flank (2026-10-26); their heat weights stay. RIGSMITH_OPTIMIZE_CREATURES=1 brings it back to try.
    const templateClips = creature ? await templateAnimations(character.template!) : undefined
    const optimize = torchPython() !== null && (!creature || (process.env.RIGSMITH_OPTIMIZE_CREATURES === '1' && templateClips !== undefined))
    const share = optimize ? 0.45 : 0.85
    const started = Date.now()
    const { result } = await runBlender('autorig/rig.py', args, (progress, message) => { update({ progress: progress * share, message }) })
    const r = result as { joints: Record<string, Vec3>, seconds: number, method: string, warnings: string[] }
    // Re-import can reorder/split vertices. Follow the old bind surface instead
    // of writing a saved brush stroke onto unrelated new vertex numbers.
    const savedPainting = await weightEdits(id)
    const previous = character.files.rigged === undefined ? undefined : path.join(dir,character.files.rigged)
    if (savedPainting.length > 0 && (previous === undefined || !existsSync(previous))) throw new Error('The previous rig is required to preserve its painted weights')
    const painted = savedPainting.length === 0 ? [] : await mapPainting(output,previous!,savedPainting)
    if (painted.length > 0) {
      const n = await writeWeights(output, painted)
      r.warnings.push(`${n} painted vertices put back (Fix weights; Forget the painting to drop them)`)
    }
    if (existsSync(alternative)) {
      if (painted.length > 0) await writeWeights(alternative, await mapPainting(alternative,previous!,savedPainting))
      update({ progress: share, message: 'Comparing regional and volume heat weights' })
      const quality = await validateSkin(output, alternative, character.template ?? 'human')
      if (quality.retained) r.method = 'native-heat'
      else if (quality.hybrid === true) r.method += '+hybrid-heat'
    }
    if (character.files.rigged !== undefined && existsSync(path.join(dir, character.files.rigged))) {
      update({ progress: share + 0.05, message: 'Checking deformation against the previous weights' })
      const quality = await validateSkin(output, path.join(dir, character.files.rigged), character.template ?? 'human')
      if (!quality.compared) r.warnings.push(`Previous weights could not be compared: ${quality.reason ?? 'the bind surface or bone set changed'}`)
      if (quality.retained || quality.hybrid === true) {
        r.method += '+retained-weights'
        r.warnings.push(quality.retained ? 'Used the previous weights as the starting skin: they deform better on the test animations with these joint placements' : 'Used previous weights on some surface islands: they deform better on every test animation with these joint placements')
      }
    }
    if (optimize) {
      // Refine the best available skin, including native heat and previous paint,
      // rather than optimizing a regional candidate that may then be discarded.
      await copyFile(output, beforeOptimize)
      try {
        await optimizeSkin(output, (progress, message) => { update({ progress: 0.55 + 0.4 * progress, message }) }, templateClips, await trainedClips(character))
        if (painted.length > 0) await writeWeights(output, painted)
        update({ progress: 0.96, message: 'Checking the refined weights on deformation tests' })
        const quality = await validateSkin(output, beforeOptimize, character.template ?? 'human')
        if (!quality.retained) r.method += quality.hybrid === true ? '+hybrid-optimized' : '+pose-optimized'
      } catch (error) {
        // A failed optimizer or validation cannot replace the accepted heat skin.
        await copyFile(beforeOptimize, output)
        r.warnings.push(`weights not pose-optimized: ${(error as Error).message.slice(0, 200)}`)
      }
    }
    // A comparison can select a previous skin; authored paint still wins.
    if (painted.length > 0) await writeWeights(output,painted)
    if (JSON.stringify(await weightEdits(id)) !== JSON.stringify(savedPainting)) throw new Error('Painting changed while rigging; the previous rig has been kept. Rig again to include the new painting')
    r.seconds = Math.round((Date.now() - started) / 100) / 10
    await publishRig(id,output,path.join(dir,'rigged.glb'),painted)
    await updateCharacter(id, c => {
      c.status = 'rigged'
      c.files.rigged = 'rigged.glb'
      c.revision = (c.revision ?? 0) + 1
      if (JSON.stringify(c.joints) === JSON.stringify(character.joints)) c.joints = r.joints
      else r.warnings.push('Placements changed during rigging; rig again to use the latest joints')
      if (c.stats !== undefined) c.stats.bones = Object.keys(r.joints).length
      c.rigReport = { method: r.method, seconds: r.seconds, warnings: r.warnings }
    })
  } finally {
    await rm(output, { force: true })
    await rm(alternative, { force: true })
    await rm(beforeOptimize, { force: true })
  }
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
/**
 * A texture changed (textures/ overrides): put it into the character's files. A rig only needs its images swapped,
 * never rigging again (its bones, weights and painting stay as they are): a painted texture straight into the files
 * (`direct`); a fill or a restore through the model made again (Blender's import does the overrides), then its images
 * into the rig. A character not rigged yet just gets its model made again.
 */
async function refreshOutputs (id: string, update: Update, direct = false): Promise<void> {
  const before = (await getCharacter(id))!
  const dir = characterDir(id)
  const rigged = before.kind === 'mesh' && before.status === 'rigged' && before.files.rigged !== undefined ? path.join(dir, before.files.rigged) : null
  const model = before.files.model !== undefined && before.files.model.endsWith('.glb') ? path.join(dir, before.files.model) : null
  if (direct && rigged !== null && existsSync(rigged)) {
    update({ progress: 0.6, message: 'Putting the texture into the rig' })
    await swapImages(rigged, texturesDir(id))
    if (model !== null && existsSync(model)) await swapImages(model, texturesDir(id))
    await updateCharacter(id, c => { c.revision = (c.revision ?? 0) + 1; c.files.thumbnail = undefined })
    return
  }
  update({ progress: 0.6, message: 'Updating preview' })
  await runInspect(id, () => {}, true)
  if (rigged !== null && existsSync(rigged)) {
    update({ progress: 0.85, message: 'Putting the texture into the rig' })
    const fresh = (await getCharacter(id))!
    const made = fresh.files.model !== undefined ? path.join(dir, fresh.files.model) : undefined
    await swapImages(rigged, texturesDir(id), made)
    await updateCharacter(id, c => { c.revision = (c.revision ?? 0) + 1 })
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
    await refreshOutputs(character.id, update, true)
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
  const allowed: Array<keyof Character> = ['name', 'joints', 'jointsEdited', 'markers', 'fingers', 'animations', 'scripts', 'props', 'garments', 'mount', 'skins', 'boneMap', 'handPoses']
  let before: Character | null = null
  const character = await updateCharacter(id, c => {
    before = structuredClone(c)
    for (const key of allowed) {
      if (!(key in patch)) continue
      // (null takes the field off: a mount given up)
      if (patch[key] === null) delete (c as unknown as Record<string, unknown>)[key]
      else (c as unknown as Record<string, unknown>)[key] = patch[key]
    }
  })
  // (in the journal, by who made it: the app, or a tool naming itself)
  await record(id, by(req), before, character)
  // (every open page takes it: a page holding an older copy would otherwise save that back over it)
  events.emit('character', character)
  send(res, 200, character)
})

// The character's journal: every change, who made it, when (server/journal.ts); a note is a line anyone can add.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/journal$/, async (req, res, [id], url) => {
  send(res, 200, await journal(id, Number(url.searchParams.get('last') ?? 200)))
})
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/journal$/, async (req, res, [id]) => {
  const { note } = await readJsonBody<{ note?: string }>(req)
  if (typeof note !== 'string' || note.trim() === '') throw new HttpError(400, 'A note is text')
  await note_(id, by(req), note.trim(), true)
  events.emit('journal', id)
  send(res, 201, { ok: true })
})

// The game's side of a character (Rigsmith's units, server/game.ts): its unit and the clip names the game plays for it.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/game$/, async (req, res, [id]) => {
  send(res, 200, await gameSlots(id))
})

// Painted weights (the Rig step's Fix weights): written into the rig and kept for the next re-rig; DELETE forgets them.
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/weights$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character?.files.rigged === undefined || character.kind !== 'mesh') throw new HttpError(400, 'Only a Rigsmith rig can be painted')
  if (character.status === 'rigging') throw new HttpError(409, 'Wait for rigging to finish before painting weights')
  const { edits } = await readJsonBody<{ edits?: WeightEdit[] }>(req)
  if (!Array.isArray(edits) || edits.length === 0) throw new HttpError(400, 'No weights to write')
  const written = await writeWeights(path.join(characterDir(id), character.files.rigged), edits)
  const kept = await keepWeightEdits(id, edits)
  await note_(id, by(req), `weights painted: ${written} vertices (${kept} kept for re-rigs)`)
  const after = await updateCharacter(id, c => { c.revision = (c.revision ?? 0) + 1 })
  events.emit('character', after)
  send(res, 200, { written, kept })
})
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/weights$/, async (req, res, [id]) => {
  if ((await getCharacter(id))?.status === 'rigging') throw new HttpError(409, 'Wait for rigging to finish before forgetting painting')
  await dropWeightEdits(id)
  await note_(id, by(req), 'painted weights forgotten (the next rig makes them afresh)')
  send(res, 200, { ok: true })
})

// The game's models, read only (the scale room sets a unit against them): what there is, and each file.
route('GET', /^\/api\/game\/models$/, async (req, res) => {
  const repo = (await getSettings()).gameRepo
  const kinds: Record<string, string[]> = {}
  for (const kind of ['units', 'buildings', 'props']) {
    try { kinds[kind] = (await readdir(path.join(repo, 'assets', 'models', kind))).filter(f => f.endsWith('.glb')).map(f => f.slice(0, -4)).sort() } catch { kinds[kind] = [] }
  }
  let visualScale = 1
  try { visualScale = (JSON.parse(await readFile(path.join(repo, 'data', 'visual.json'), 'utf8')) as { units?: { visual_scale?: number } }).units?.visual_scale ?? 1 } catch { /* (no game data: as modelled) */ }
  send(res, 200, { ...kinds, visualScale })
})
route('GET', /^\/api\/game\/models\/(units|buildings|props)\/([\w-]+)\.glb$/, async (req, res, [kind, name]) => {
  const file = path.join((await getSettings()).gameRepo, 'assets', 'models', kind, `${name}.glb`)
  if (!existsSync(file)) throw new HttpError(404, 'No such model')
  res.writeHead(200, { 'content-type': 'model/gltf-binary', 'cache-control': 'no-store' })
  createReadStream(file).pipe(res)
})

// Rigsmith's game units: each with the game's own entry and whether they differ (what Export would write).
route('GET', /^\/api\/game$/, async (req, res) => { send(res, 200, await gameStatus()) })
// One unit's entry (null takes it off), journaled on its character (and its companion's).
route('PUT', /^\/api\/game\/units\/([a-z0-9_]+)$/, async (req, res, [name]) => {
  const entry = await readJsonBody<UnitSpec | null>(req)
  if (entry !== null && (typeof entry.character !== 'string' || !Array.isArray(entry.clips) || typeof entry.height !== 'number')) throw new HttpError(400, 'A unit needs a character, a height and its clips')
  const spec = await units()
  const before = spec.units[name] ?? null
  if (entry === null) delete spec.units[name]
  else spec.units[name] = entry
  await saveUnits(spec)
  const who = by(req)
  for (const id of new Set([before?.character, entry?.character, before?.companion?.character, entry?.companion?.character].filter((x): x is string => x !== undefined))) {
    if (await getCharacter(id) === null) continue
    const changed = entry === null ? 'off the game' : before === null ? 'added' : Object.keys({ ...before, ...entry }).filter(k => JSON.stringify(before[k]) !== JSON.stringify(entry[k])).map(k => `${k} -> ${JSON.stringify(entry[k] ?? null)}`).join(', ')
    if (changed !== '') await note_(id, who, `game unit ${name}: ${changed}`)
  }
  events.emit('game', name)
  send(res, 200, await gameStatus())
})
// Export units into the game (its units.json entry, then its build): the one way Rigsmith writes into the game's repo.
route('POST', /^\/api\/game\/export$/, async (req, res) => {
  const { units: names } = await readJsonBody<{ units?: string[] }>(req)
  if (!Array.isArray(names) || names.length === 0 || !names.every(n => /^[a-z0-9_]+$/.test(n))) throw new HttpError(400, 'Name the units to export')
  const who = by(req)
  const job = enqueue('export', `Export to the game · ${names.join(', ')}`, undefined, async (job, update) => {
    let lines = 0
    const reports = await exportUnits(names, line => { lines++; update({ progress: Math.min(0.95, lines / 40), message: line.slice(0, 120) }) })
    const spec = await units()
    for (const r of reports) {
      const id = spec.units[r.unit]?.character
      const strides = r.walkStride != null ? `walk ${r.walkStride}${r.runStride != null ? `, run ${r.runStride}` : ''}` : 'no walk'
      if (id !== undefined && await getCharacter(id) !== null) await note_(id, who, `exported to the game as ${r.unit} (${strides}${r.holdsFailed.length > 0 ? `; ${r.holdsFailed.length} holds failed` : ''})`)
    }
    update({ progress: 1, message: reports.map(r => `${r.unit}: walk ${r.walkStride ?? '-'}, run ${r.runStride ?? '-'}${r.holdsFailed.length > 0 ? `, ${r.holdsFailed.length} holds failed` : ''}`).join('; ') })
    events.emit('game', names.join(','))
  })
  send(res, 202, job)
})

route('DELETE', /^\/api\/characters\/([a-z0-9-]+)$/, async (req, res, [id]) => {
  await deleteCharacter(id)
  events.emit('removed', id)
  send(res, 200, { ok: true })
})

// Creature template fitted along the mesh's medial skeleton (tools/creature_fit.py); 422 when the
// mesh doesn't read as that body type (the client then uses the bounding-box fit).
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fit-template$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  const { template } = JSON.parse((await readBody(req)).toString() || '{}') as { template?: string }
  if (template === undefined || !/^[a-z]+$/.test(template)) throw new HttpError(400, 'Bad template')
  const python = path.join(ROOT, '.venv', 'bin', 'python')
  const model = character.files.model === undefined ? null : path.join(characterDir(id), character.files.model)
  if (model === null || !existsSync(python)) throw new HttpError(422, 'Skeleton fit unavailable')
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(python, [path.join(ROOT, 'tools', 'creature_fit.py'), model, path.join(ROOT, 'static', 'templates', `${template}.json`)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('close', code => {
      if (code === 0) resolve(stdout)
      else reject(new HttpError(422, stderr.trim().split('\n').pop() ?? 'fit failed'))
    })
  })
  send(res, 200, JSON.parse(out))
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/rig$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  if (character.kind !== 'mesh') throw new HttpError(400, 'Only unrigged meshes need rigging')
  send(res, 202, rig(character))
})

// Fit a new finger level before displaying its markers, at the user's current wrists.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fingers$/, async (req, res, [id]) => {
  const { fingers, redetect } = await readJsonBody<{ fingers: Character['fingers'], redetect?: boolean }>(req)
  if (!['none', 'one', 'two', 'full'].includes(fingers ?? '')) throw new HttpError(400, 'Bad finger level')
  const before = await getCharacter(id)
  if (before === null) throw new HttpError(404, 'No such character')
  if ((before.template ?? 'human') !== 'human') throw new HttpError(400, 'Finger levels apply to people')
  const dir = characterDir(id)
  const file = path.join(dir, `finger-joints-${randomBytes(6).toString('hex')}.json`)
  try {
    const placed = { ...before.joints }
    // Index is the centre of a mitten at reduced levels, but an actual index
    // finger at full level. Its old chain cannot be reused across that switch.
    const changesIndex = (before.fingers === 'full') !== (fingers === 'full')
    if (changesIndex) for (const name of Object.keys(placed)) if (/^(Left|Right)HandIndex[1-4]$/.test(name)) delete placed[name]
    // (detected again: every finger traced afresh from the mesh, the body's joints kept)
    if (redetect === true) for (const name of Object.keys(placed)) if (/^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[1-4]$/.test(name)) delete placed[name]
    await writeJson(file, placed)
    const { result } = await runBlender('autorig/rig.py', ['--input', path.join(dir, before.source.file),
      '--joints', file, '--fingers', fingers!, '--placements-only', '--scale', String(before.scale ?? 1)], () => {})
    const c = await updateCharacter(id, c => {
      if (JSON.stringify(c.joints) !== JSON.stringify(before.joints) || c.fingers !== before.fingers) {
        throw new HttpError(409, 'Placements changed while fitting fingers; try again with the latest joints')
      }
      c.fingers = fingers
      c.joints = (result as { joints: Record<string, Vec3> }).joints
      c.jointsEdited = true
      if (changesIndex && c.markers !== undefined) {
        for (const name of Object.keys(c.markers.base)) if (/^(Left|Right)HandIndex[1-4]$/.test(name)) delete c.markers.base[name]
        delete c.markers.positions.index_tip_l; delete c.markers.positions.index_tip_r
      }
    })
    await record(id, by(req), before, c)
    events.emit('character', c)
    send(res, 200, c)
  } finally {
    await rm(file, { force: true })
  }
})

// Choose the skeleton template. Re-rigging an imported rigged model turns it back into a mesh to rig.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/template$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ template: string, joints?: Record<string, Vec3>, fingers?: Character['fingers'] }>(req)
  if (!/^[a-z]+$/.test(body.template)) throw new HttpError(400, 'Bad template')
  const character = await updateCharacter(id, c => {
    // A different skeleton family can't play the previous set's clips.
    if ((c.template ?? 'human') !== body.template) c.animations = []
    c.template = body.template
    // (a rigged import becomes a mesh for Rigsmith's own rig: its skin and weights go, its skeleton placed the joints)
    if (c.kind === 'rigged') { c.kind = 'mesh'; c.files.rigged = undefined; c.status = 'ready'; c.rigPreset = undefined }
    if (body.fingers !== undefined) c.fingers = body.fingers
    if (body.template === 'human' && body.joints !== undefined) {
      // a person's joints read off its original rig: where its joints start, and where Reset takes them back to
      c.joints = body.joints
      c.autoJoints = body.joints
      c.jointsEdited = true
    } else if (body.template === 'human') {
      c.joints = c.autoJoints
      c.jointsEdited = false
    } else if (body.joints !== undefined) {
      c.joints = body.joints
      c.jointsEdited = true
    }
    if (c.status === 'rigged') c.status = 'ready'
    // (markers belong to the joints they were seeded from: a new fit seeds them again)
    delete c.markers
  })
  send(res, 200, character)
})

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/reimport$/, async (req, res, [id]) => {
  const character = await getCharacter(id)
  if (character === null) throw new HttpError(404, 'No such character')
  send(res, 202, inspect(character))
})

// Size and floor (Import → Size): the character resized to `height` (else as it is) and stood on the floor, in place.
// Its files are moved as they are (a rig keeps its weights and painting: server/glbtransform.ts), and everything kept
// in its units with them: joints, markers, prop places and sizes, a pull's hold on its hand, clips' ground. Every
// later import and rig of it does the same (its `scale`, then the floor).
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fit$/, async (req, res, [id]) => {
  const { height } = await readJsonBody<{ height?: number }>(req)
  const before = await getCharacter(id)
  if (before === null) throw new HttpError(404, 'No such character')
  if (listJobs().some(j => j.characterId === id && (j.status === 'queued' || j.status === 'running'))) throw new HttpError(409, `${before.name} is busy; try again when its job is done`)
  const dir = characterDir(id)
  const files = [before.files.rigged, before.files.model].filter((f, i, all): f is string => f !== undefined && f.endsWith('.glb') && all.indexOf(f) === i).map(f => path.join(dir, f))
  if (files.length === 0) throw new HttpError(400, 'No model to resize yet')
  // (measured on the rig if it has one: what's shown and exported)
  const extents = await Promise.all(files.map(async f => extentY(await readFile(f))))
  const now = extents[0].max - extents[0].min
  if (!(now > 0)) throw new HttpError(400, 'The model has no height')
  const s = height === undefined ? 1 : height / now
  if (!(s > 0.01 && s < 100) || (height !== undefined && !(height > 0))) throw new HttpError(400, 'Give a height between 1% and 100× its size')
  const moves = extents.map(e => [0, -e.min * s, 0] as [number, number, number])
  if (Math.abs(s - 1) < 1e-6 && moves.every(m => Math.abs(m[1]) < 1e-5)) { send(res, 200, before); return }
  for (const [i, f] of files.entries()) await transformGlb(f, s, moves[i])
  const d = moves[0]
  const at = (p: [number, number, number]): [number, number, number] => [p[0] * s + d[0], p[1] * s + d[1], p[2] * s + d[2]]
  const all = <T extends [number, number, number]>(o: Record<string, T> | undefined): Record<string, [number, number, number]> | undefined =>
    o === undefined ? undefined : Object.fromEntries(Object.entries(o).map(([k, v]) => [k, at(v)]))
  const c = await updateCharacter(id, c => {
    c.scale = (c.scale ?? 1) * s
    if (c.joints !== undefined) c.joints = all(c.joints)
    if (c.autoJoints !== undefined) c.autoJoints = all(c.autoJoints)
    if (c.markers !== undefined) c.markers = { ...c.markers, base: all(c.markers.base)!, positions: all(c.markers.positions)! }
    c.garments = c.garments?.map(g => ({
      ...g, position: at(g.position), scale: g.scale * s,
      ...(g.anchor !== undefined ? { anchor: at(g.anchor) } : {}),
      ...(g.pulls !== undefined ? { pulls: g.pulls.map(p => ({ ...p, grip: p.grip.map(v => v * s) as [number, number, number] })) } : {}),
    }))
    c.animations = c.animations.map(a => (a.lift !== undefined ? { ...a, lift: a.lift * s } : a))
    if (c.stats !== undefined) c.stats = { ...c.stats, height: c.stats.height * s }
    c.revision = (c.revision ?? 0) + 1
    c.files.thumbnail = undefined
  })
  await record(id, by(req), before, c)
  events.emit('character', c)
  send(res, 200, c)
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

/** How many views a capture has (its views.json). */
async function viewCount (dir: string): Promise<number> {
  try {
    const list = JSON.parse(await readFile(path.join(dir, 'views.json'), 'utf8')) as { views?: unknown[] }
    return Array.isArray(list.views) ? list.views.length : 0
  } catch { return 0 }
}
/** Each view's result-N file, or null where it has none yet. */
const resultsOf = (files: string[], views: number): Array<string | null> =>
  Array.from({ length: views }, (_, i) => files.find(f => new RegExp(`^result-${i + 1}\\.(png|jpe?g|webp)$`, 'i').test(f)) ?? null)

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
    const views = files.includes('views.json') ? await viewCount(path.join(root, pid)) : 0
    const hasResult = views > 0 ? resultsOf(files, views).every(r => r !== null) : files.some(f => /^result\.(png|jpe?g|webp)$/i.test(f))
    return { id: pid, createdAt: info.birthtimeMs || info.mtimeMs, hasResult, views: Math.max(views, 1), complete: views > 0 || (files.includes('camera.json') && files.includes('mask.png')) }
  }))
  send(res, 200, out.filter(p => p.complete).sort((a, b) => b.createdAt - a.createdAt).slice(0, 12))
})

route('GET', /^\/api\/characters\/([a-z0-9-]+)\/projections\/([a-z0-9-]+)$/, async (req, res, [id, pid]) => {
  const dir = projectionDir(id, pid)
  const files = existsSync(dir) ? await readdir(dir) : []
  // (a capture of several views is ready when every view has its result-N)
  const views = files.includes('views.json') ? await viewCount(dir) : 0
  const results = views > 0 ? resultsOf(files, views) : [files.find(f => /^result\.(png|jpe?g|webp)$/i.test(f)) ?? null]
  const ready = results.every(r => r !== null)
  let resultVersion: number | null = null
  if (ready) resultVersion = Math.max(...await Promise.all((results as string[]).map(async r => (await stat(path.join(dir, r))).mtimeMs)))
  send(res, 200, { path: dir, files, result: ready ? results[0] : null, results: ready ? results : null, views: Math.max(views, 1), resultVersion })
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
    const views = existsSync(path.join(dir, 'views.json')) ? await viewCount(dir) : 0
    const images = views > 0 ? Array.from({ length: views }, (_, i) => [`view-${i + 1}-flat.png`, `view-${i + 1}-mask.png`]).flat() : ['flat.png', 'mask.png', 'color.png']
    await runCodex(dir, prompt, images, message => { update({ message }) })
    const files = await readdir(dir)
    if (views > 0) {
      const missing = resultsOf(files, views).flatMap((r, i) => (r === null ? [`result-${i + 1}.png`] : []))
      if (missing.length > 0) throw new Error(`Codex finished without writing ${missing.join(', ')}`)
    } else if (!files.some(f => /^result\.(png|jpe?g|webp)$/i.test(f))) throw new Error('Codex finished without writing result.png')
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
  // (the kind it is added as: a prop on a bone, clothing, or a part pinned to the body; clothing unless said)
  const kind = url.searchParams.get('kind')
  const mode: Garment['mode'] = kind === 'prop' || kind === 'rigid' ? 'rigid' : kind === 'part' ? 'part' : 'clothing'
  const garment: Garment = {
    id: gid, name: path.basename(name).replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '), status: 'importing',
    mode, policy: 'body', bone: mode === 'rigid' ? 'RightHand' : 'Head', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1, hideBody: false,
  }
  await updateCharacter(id, c => { c.garments = [...(c.garments ?? []), garment] })
  await note_(id, by(req), `gear ${garment.name}: imported from ${path.basename(name)}`)
  enqueue('garment', `Import ${garment.name}`, id, async (job, update) => {
    try {
      // (its own animations kept: a mechanism's moving parts play while it is worn)
      await runBlender('jobs/inspect.py', ['--input', source, '--out', dir, '--animations'], (progress, message) => { update({ progress, message }) })
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

// A clothing piece's painted weights (the Outfit step's brushes), kept beside its model and laid over the weights it
// takes from the body on every load: merged by mesh and vertex, its count on the garment (which reloads it).
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([a-z0-9]+)\/weights$/, async (req, res, [id, gid]) => {
  const character = await getCharacter(id)
  const garment = character?.garments?.find(g => g.id === gid)
  if (character === null || garment === undefined) throw new HttpError(404, 'No such garment')
  const { edits } = await readJsonBody<{ edits?: Array<{ mesh: number, vertex: number, weights: Array<[string, number]> }> }>(req)
  if (!Array.isArray(edits) || edits.length === 0) throw new HttpError(400, 'No weights to write')
  const file = path.join(characterDir(id), 'garments', gid, 'weights.json')
  const kept = new Map<string, { mesh: number, vertex: number, weights: Array<[string, number]> }>()
  if (existsSync(file)) for (const e of JSON.parse(await readFile(file, 'utf8')) as Array<{ mesh: number, vertex: number, weights: Array<[string, number]> }>) kept.set(`${e.mesh}:${e.vertex}`, e)
  for (const e of edits) {
    if (!Number.isInteger(e.mesh) || !Number.isInteger(e.vertex) || !Array.isArray(e.weights)) throw new HttpError(400, 'Bad weight edit')
    kept.set(`${e.mesh}:${e.vertex}`, e)
  }
  await writeJson(file, [...kept.values()])
  const after = await updateCharacter(id, c => {
    const g = c.garments?.find(x => x.id === gid)
    if (g !== undefined) g.painted = kept.size
  })
  await note_(id, by(req), `gear ${garment.name}: weights painted on ${edits.length} vertices (${kept.size} kept)`)
  events.emit('character', after)
  send(res, 200, { written: edits.length, kept: kept.size })
})
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/garments\/([a-z0-9]+)\/weights$/, async (req, res, [id, gid]) => {
  const character = await getCharacter(id)
  const garment = character?.garments?.find(g => g.id === gid)
  if (character === null || garment === undefined) throw new HttpError(404, 'No such garment')
  await rm(path.join(characterDir(id), 'garments', gid, 'weights.json'), { force: true })
  const after = await updateCharacter(id, c => {
    const g = c.garments?.find(x => x.id === gid)
    if (g !== undefined) delete g.painted
  })
  await note_(id, by(req), `gear ${garment.name}: painted weights forgotten`)
  events.emit('character', after)
  send(res, 200, { ok: true })
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
  // Deleted elsewhere (another tab, the API): drop it from every open page.
  const onRemoved = (id: string): void => { res.write(`event: removed\ndata: ${JSON.stringify(id)}\n\n`) }
  // Changed elsewhere (another tab, a tool through the API): every open page takes the new copy.
  const onCharacter = (c: Character): void => { res.write(`event: character\ndata: ${JSON.stringify(c)}\n\n`) }
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  events.on('job', onJob)
  events.on('removed', onRemoved)
  events.on('character', onCharacter)
  const onJournal = (id: string): void => { res.write(`event: journal\ndata: ${JSON.stringify(id)}\n\n`) }
  events.on('journal', onJournal)
  const onGame = (name: string): void => { res.write(`event: game\ndata: ${JSON.stringify(name)}\n\n`) }
  events.on('game', onGame)
  req.on('close', () => { clearInterval(ping); events.off('job', onJob); events.off('removed', onRemoved); events.off('character', onCharacter); events.off('journal', onJournal); events.off('game', onGame) })
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

// A clip made in the animation editor: into the library as a new clip (server/clipedits.ts), as a job.
route('POST', /^\/api\/library\/edits$/, async (req, res) => {
  const body = await readJsonBody<SavedEdit & { characterId?: string }>(req)
  if (typeof body.name !== 'string' || body.name.trim() === '') throw new HttpError(400, 'Name the clip')
  const id = await editId(body)
  const character = typeof body.characterId === 'string' && /^[a-z0-9-]+$/.test(body.characterId) ? body.characterId : undefined
  const job = enqueue('clip', `Save ${body.name.trim()} to the library`, character, async (job, update) => {
    await saveEdit(id, body, (progress, message) => { update({ progress, message }) })
  })
  send(res, 202, { id, job: job.id })
})

// A creature's clip made in the animation editor (a .glb on its template's skeleton): beside the bundled ones.
route('POST', /^\/api\/library\/creature-clips$/, async (req, res, _, url) => {
  const q = (k: string): string => url.searchParams.get(k) ?? ''
  let glb = await readBody(req, 64 * 1024 * 1024)
  try {
    // (with props=1 the body is the prop paths first: their JSON's length (4 bytes, little-endian), the JSON, then the .glb)
    let propPaths: unknown
    if (q('props') === '1') {
      const n = glb.length >= 4 ? glb.readUInt32LE(0) : -1
      if (n < 0 || 4 + n > glb.length) throw new Error('Bad prop paths')
      propPaths = JSON.parse(glb.subarray(4, 4 + n).toString('utf8'))
      glb = glb.subarray(4 + n)
    }
    send(res, 200, await saveCreatureClip({ rig: q('rig'), name: q('name'), base: q('base'), category: q('category') || (await categoryOf(q('base'))) || 'gesture', loop: q('loop') === '1', inPlace: q('inPlace') === '1', duration: Number(q('duration')) || 0, propPaths: propPaths as never }, glb))
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
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
  // Godot import script that wires distance LODs (see godot/rigsmith_lods.gd); kept current.
  await writeFile(path.join(settings.exportDir, 'rigsmith_lods.gd'), await readFile(path.join(ROOT, 'godot', 'rigsmith_lods.gd')))
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
