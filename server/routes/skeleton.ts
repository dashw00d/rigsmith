// Skeleton routes (DESIGN.md §2.2): the generators that write `skeleton.detected`, each a 'files' job (one at a time per
// character, cancellable) that ends in one undoable journal entry:
//   POST /fingers        a finger level, or the fingers detected again (blender/autorig/rig.py --placements-only)
//   POST /template       another skeleton family (a creature fit along the mesh, or back to the person's detection)
//   POST /fit-template   the creature template fitted to the mesh again (the placements stay on top)
//   POST /convert        a rigged import put on the Rigsmith rig (its joints read off its own skeleton by the app)
// and the saved skeleton mappings (Mixamo bone -> a foreign rig's bone) shared by every character. What each generator
// does to the document is server/routes/skeleton-policy.ts; these run the work and hand it the result inside the lock.
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { CORE_JOINTS, fingerLevelOf } from '../../src/engine/mixamo.ts'
import { templateName } from '../../src/engine/templates.ts'
import { phaseOf } from '../../src/model/select.ts'
import { TEMPLATE_PARENTS } from '../../src/model/skeletons.ts'
import type { FingerLevel, Joints } from '../../src/model/types.ts'
import { by, HttpError, readJsonBody, route, send } from '../http.ts'
import { enqueue, runBlender, spawnJob, type Update } from '../jobs.ts'
import { type Character, characterDir, getCharacter, ROOT, updateCharacter, WORKSPACE, writeJson } from '../store.ts'
import { applyConvert, applyFingerTrace, applyRefit, applyTemplate, assertLevelUnlocked, humanSeed, LEVEL_NAMES, traceInput } from './skeleton-policy.ts'
import { assertUnlocked } from './skin.ts'

const LEVELS: readonly FingerLevel[] = ['none', 'one', 'two', 'three', 'full']

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

const isLevel = (v: unknown): v is FingerLevel => typeof v === 'string' && (LEVELS as readonly string[]).includes(v)
const known = (template: string): boolean => template === 'human' || TEMPLATE_PARENTS[template] !== undefined

/** Joints from a request: names to finite [x, y, z]. */
function jointsFrom (v: unknown, what = 'joints'): Joints {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, `Bad ${what}`)
  const out: Joints = {}
  for (const [name, p] of Object.entries(v as Record<string, unknown>)) {
    if (!/^[\w.:-]{1,80}$/.test(name) || !Array.isArray(p) || p.length !== 3 || !p.every(x => typeof x === 'number' && Number.isFinite(x))) {
      throw new HttpError(400, `Bad ${what}: ${name.slice(0, 80)}`)
    }
    out[name] = [p[0], p[1], p[2]]
  }
  return out
}

/** Why the skeleton of this character can't be changed now, if it can't. */
function refusal (c: Character): HttpError | null {
  if (c.source.kind === 'animation') return new HttpError(400, 'This file holds only an animation: there is no body to place a skeleton in')
  if (c.status === 'importing') return new HttpError(409, 'Wait for the import to finish')
  return null
}

/** A generator's write: one undoable entry, whose lines `fn` gives. */
async function generate (id: string, who: string, what: string, fn: (c: Character) => string[]): Promise<void> {
  const changes: string[] = []
  await updateCharacter(id, c => { changes.push(...fn(c)) }, { by: who, what, changes, undoable: true })
}

/** Run blender/autorig/rig.py --placements-only: the joints it would rig with. `given`: the joints to keep (written to
 * a temp file the restart clean-up knows: finger-joints-<hex>.json); null: detected afresh from the mesh. */
async function placements (c: Character, level: FingerLevel, given: Joints | null, update: Update, signal: AbortSignal, share: [number, number]): Promise<Joints> {
  const dir = characterDir(c.id)
  const file = path.join(dir, `finger-joints-${randomBytes(6).toString('hex')}.json`)
  try {
    const args = ['--input', path.join(dir, c.source.file), '--fingers', level, '--placements-only', '--scale', String(c.source.scale)]
    if (given !== null) {
      await writeJson(file, given)
      args.push('--joints', file)
    }
    const { result } = await runBlender('autorig/rig.py', args, (p, message) => { update({ progress: share[0] + p * (share[1] - share[0]), message }) }, { signal })
    return jointsFrom((result as { joints?: unknown }).joints ?? {}, 'joints from Blender')
  } finally {
    await rm(file, { force: true })
  }
}

/** A creature template fitted along the mesh's own skeleton (tools/creature_fit.py: legs on their columns, the tail
 * along its branch), or why it couldn't be (no Python set up, or the mesh doesn't read as that body). */
async function creatureFit (c: Character, template: string, signal: AbortSignal): Promise<{ joints: Joints, notes: string[] }> {
  const python = path.join(ROOT, '.venv', 'bin', 'python')
  const model = c.files.model === undefined ? null : path.join(characterDir(c.id), c.files.model)
  if (model === null || !existsSync(model)) throw new Error('the model is not imported yet')
  if (!existsSync(python)) throw new Error('the fit along the mesh needs the Python setup (npm run setup:python)')
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawnJob(python, [path.join(ROOT, 'tools', 'creature_fit.py'), model, path.join(ROOT, 'static', 'templates', `${template}.json`)],
      { stdio: ['ignore', 'pipe', 'pipe'] }, signal)
    let stdout = ''
    let stderr = ''
    child.stdout!.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr!.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', error => { reject(error) })
    child.on('close', code => {
      if (signal.aborted) reject(signal.reason instanceof Error ? signal.reason : new Error('Cancelled'))
      else if (code === 0) resolve(stdout)
      else reject(new Error(stderr.trim().split('\n').pop() || `the fit exited with code ${code}`))
    })
  })
  const parsed = JSON.parse(out) as { joints?: unknown, notes?: unknown }
  return { joints: jointsFrom(parsed.joints, 'fit'), notes: Array.isArray(parsed.notes) ? parsed.notes.filter((n): n is string => typeof n === 'string') : [] }
}

/** The fit along the mesh, else the app's fit to the model's bounds (`fallback`), else a failure saying why. */
async function fitOrFallback (c: Character, template: string, fallback: Joints | undefined, update: Update, signal: AbortSignal): Promise<{ joints: Joints, how: string, notes: string[] }> {
  update({ progress: 0.1, message: `Fitting the ${templateName(template)} skeleton` })
  try {
    const fit = await creatureFit(c, template, signal)
    return { joints: fit.joints, how: 'along the mesh', notes: fit.notes }
  } catch (error) {
    if (signal.aborted) throw error
    const why = (error as Error).message
    if (fallback === undefined) throw new Error(`The ${templateName(template)} skeleton couldn't be fitted: ${why}`, { cause: error })
    return { joints: fallback, how: 'to the model\'s bounds', notes: [`skeleton: not fitted along the mesh (${why}): fitted to the model's bounds; drag its joints into place`] }
  }
}

// ---- fingers ----------------------------------------------------------------------------------------------------

// A finger level, or the fingers detected again: every finger traced afresh from the mesh at the wrists as placed
// (rig.py --placements-only from the skeleton without its fingers). The trace replaces the detected fingers; placements
// that no longer mean what they meant are set aside (skeleton-policy.ts applyFingerTrace). A new level is refused while
// a rig's weights are locked (it changes the bones); detecting them again at the same level is not.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fingers$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ fingers?: unknown, redetect?: unknown }>(req)
  if (!isLevel(body.fingers)) throw new HttpError(400, 'Bad finger level')
  const level = body.fingers
  const redetect = body.redetect === true
  const c = await found(id)
  const refused = refusal(c)
  if (refused !== null) throw refused
  if (c.skeleton.template !== 'human') throw new HttpError(400, 'Finger levels are for a person\'s skeleton')
  if (phaseOf(c).phase === 'needs-conversion') throw new HttpError(409, 'It is rigged elsewhere: convert it to the Rigsmith rig first')
  if (redetect && level === 'none') throw new HttpError(400, 'At no fingers there are none to detect')
  if (!redetect && level === c.skeleton.fingerLevel) throw new HttpError(400, `It has ${LEVEL_NAMES[level]} already`)
  // (a new level changes a rigged character's bones: not while its weights are locked; checked again in the lock)
  assertLevelUnlocked(c, level)
  const who = by(req)
  const label = redetect ? `Detect ${c.name}'s fingers again` : `${c.name}: ${LEVEL_NAMES[level]}`
  send(res, 202, enqueue('fingers', label, id, async (_job, update, signal) => {
    const now = await found(id)
    const from = now.skeleton.fingerLevel
    if (now.skeleton.template !== 'human') throw new Error('It is no longer on a person\'s skeleton')
    // (queued behind another change to the same level: nothing left to do)
    if (!redetect && from === level) return
    // (locked while it was queued: no trace run for nothing)
    assertLevelUnlocked(now, level)
    const input = traceInput(now)
    update({ progress: 0.05, message: redetect ? 'Detecting the fingers' : 'Tracing the fingers' })
    const result = await placements(now, level, input, update, signal, [0.05, 0.95])
    update({ progress: 0.95, message: 'Saving' })
    await generate(id, who, 'fingers', x => applyFingerTrace(x, { level, redetect, from, input, result }))
  }, { lock: 'files' }))
})

// ---- template ---------------------------------------------------------------------------------------------------

// Another skeleton family. To a creature: its template fitted to the mesh (along the mesh, else the app's fit to the
// bounds in `joints`). To a person: the import's own detection (its fingers traced again at the level when they were
// found at another), or the joints given (a rigged import's own skeleton), else a detection afresh. Placements, set-aside
// placements, markers and the clips (another family's) are cleared. Refused while a rig's weights are locked.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/template$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ template?: unknown, joints?: unknown, fingers?: unknown }>(req)
  const template = body.template
  if (typeof template !== 'string' || !/^[a-z]+$/.test(template) || !known(template)) throw new HttpError(400, 'No such template')
  if (body.fingers !== undefined && !isLevel(body.fingers)) throw new HttpError(400, 'Bad finger level')
  const fingers = body.fingers as FingerLevel | undefined
  const given = body.joints === undefined ? undefined : jointsFrom(body.joints)
  const c = await found(id)
  const refused = refusal(c)
  if (refused !== null) throw refused
  if (c.files.rigged !== undefined) assertUnlocked(c)
  if (template === c.skeleton.template) {
    throw new HttpError(400, template === 'human' ? 'It is on a person\'s skeleton already' : `It is on the ${templateName(template)} skeleton already: refit it instead`)
  }
  if (template === 'human' && given === undefined && phaseOf(c).phase === 'needs-conversion') {
    throw new HttpError(409, 'It is rigged elsewhere: convert it, so its own skeleton gives the joints')
  }
  const who = by(req)
  send(res, 202, enqueue('template', `${c.name}: ${templateName(template)} skeleton`, id, async (_job, update, signal) => {
    const now = await found(id)
    let detected: Joints | undefined
    const notes: string[] = []
    if (template !== 'human') {
      const fit = await fitOrFallback(now, template, given, update, signal)
      detected = fit.joints
      notes.push(...fit.notes)
    } else if (given !== undefined) {
      detected = given
    } else {
      const level = fingers ?? now.skeleton.fingerLevel
      const seed = humanSeed(now, level)
      if (!seed.trace) detected = seed.joints
      else {
        update({ progress: 0.05, message: Object.keys(seed.joints).length > 0 ? 'Tracing the fingers' : 'Detecting the joints' })
        detected = await placements(now, level, Object.keys(seed.joints).length > 0 ? seed.joints : null, update, signal, [0.05, 0.95])
        notes.push(Object.keys(seed.joints).length > 0 ? 'skeleton: the import\'s detection, its fingers traced again at this level' : 'skeleton: joints detected afresh from the mesh')
      }
    }
    update({ progress: 0.95, message: 'Saving' })
    await generate(id, who, 'template', x => {
      if (x.files.rigged !== undefined) assertUnlocked(x)
      return [...applyTemplate(x, template, detected, { fingers: template === 'human' ? fingers ?? (given !== undefined ? fingerLevelOf(given) : undefined) : undefined }), ...notes]
    })
  }, { lock: 'files' }))
})

// The creature template the character is on, fitted to the mesh again (`joints`: the app's fit to the model's bounds,
// for a mesh that doesn't read as that body). The fit becomes the detected joints; the placements stay on top.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/fit-template$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ template?: unknown, joints?: unknown }>(req)
  const c = await found(id)
  const refused = refusal(c)
  if (refused !== null) throw refused
  const template = c.skeleton.template
  if (body.template !== undefined && body.template !== template) throw new HttpError(409, `It is on the ${templateName(template)} skeleton now`)
  if (template === 'human' || TEMPLATE_PARENTS[template] === undefined) throw new HttpError(400, 'Only a creature template is fitted')
  const given = body.joints === undefined ? undefined : jointsFrom(body.joints)
  const who = by(req)
  send(res, 202, enqueue('template', `Refit ${c.name}'s ${templateName(template)} skeleton`, id, async (_job, update, signal) => {
    const now = await found(id)
    if (now.skeleton.template !== template) throw new Error(`It is on the ${templateName(now.skeleton.template)} skeleton now`)
    const fit = await fitOrFallback(now, template, given, update, signal)
    update({ progress: 0.95, message: 'Saving' })
    await generate(id, who, 'template', x => {
      if (x.skeleton.template !== template) throw new HttpError(409, 'The template changed meanwhile')
      return [...applyRefit(x, fit.joints, fit.how), ...fit.notes]
    })
  }, { lock: 'files' }))
})

// ---- convert ----------------------------------------------------------------------------------------------------

// A rigged import put on the Rigsmith rig: the joints its own skeleton has (read by the app off the loaded rest
// skeleton, by Mixamo name through its bone map) become the detected joints, at the finger level its hands have. Its
// files stay as they are until it is rigged here.
route('POST', /^\/api\/characters\/([a-z0-9-]+)\/convert$/, async (req, res, [id]) => {
  const body = await readJsonBody<{ joints?: unknown, fingers?: unknown }>(req)
  if (body.joints === undefined) throw new HttpError(400, 'Give the joints its skeleton has')
  const joints = jointsFrom(body.joints)
  if (body.fingers !== undefined && !isLevel(body.fingers)) throw new HttpError(400, 'Bad finger level')
  const level = (body.fingers as FingerLevel | undefined) ?? fingerLevelOf(joints)
  const missing = CORE_JOINTS.filter(j => joints[j] === undefined)
  if (missing.length > 0) throw new HttpError(400, `Its skeleton doesn't give ${missing.join(', ')}: map them first`)
  const c = await found(id)
  const refused = refusal(c)
  if (refused !== null) throw refused
  if (c.source.kind !== 'rigged') throw new HttpError(400, 'Only a model rigged elsewhere is converted')
  if (c.files.rigged !== undefined) assertUnlocked(c)
  const who = by(req)
  send(res, 202, enqueue('convert', `Convert ${c.name} to the Rigsmith rig`, id, async (_job, update) => {
    update({ progress: 0.5, message: 'Converting' })
    await generate(id, who, 'convert', x => {
      if (x.files.rigged !== undefined) assertUnlocked(x)
      return applyConvert(x, joints, level)
    })
  }, { lock: 'files' }))
})

// ---- saved skeleton mappings ------------------------------------------------------------------------------------

// Mixamo bone -> a foreign rig's bone, reusable across characters with the same rig (workspace/presets/skeletons/).
const PRESETS = path.join(WORKSPACE, 'presets', 'skeletons')

route('GET', /^\/api\/skeleton-presets$/, async (_req, res) => {
  const files = existsSync(PRESETS) ? (await readdir(PRESETS)).filter(f => f.endsWith('.json')) : []
  const presets = (await Promise.all(files.map(async f => {
    try {
      return JSON.parse(await readFile(path.join(PRESETS, f), 'utf8')) as { name: string, map: Record<string, string> }
    } catch {
      return null
    }
  }))).filter((p): p is { name: string, map: Record<string, string> } => p !== null && typeof p.name === 'string')
  send(res, 200, presets.sort((a, b) => a.name.localeCompare(b.name)))
})

route('POST', /^\/api\/skeleton-presets$/, async (req, res) => {
  const body = await readJsonBody<{ name?: unknown, map?: unknown }>(req)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (name === '' || name.length > 60) throw new HttpError(400, 'Give the preset a name')
  const map = body.map
  if (map === null || typeof map !== 'object' || Array.isArray(map) || !Object.values(map).every(v => typeof v === 'string')) throw new HttpError(400, 'Bad mapping')
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'preset'
  await mkdir(PRESETS, { recursive: true })
  await writeJson(path.join(PRESETS, `${slug}.json`), { name, map })
  send(res, 201, { ok: true })
})
