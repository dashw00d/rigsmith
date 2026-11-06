// Skin routes: the rig job (Blender's heat weights, then the Node steps around it: server/skinopt.ts), painted body
// weights, and the weight lock every one of them honours.
//
// The rig job builds a candidate beside the live rig (rigging-<hex>.glb; restart recovery deletes strays), carries the
// painting over to it, compares it with Blender's volume heat and with the live rig's weights on the deformation tests,
// runs the pose optimizer, puts the painting back last, then publishes it (rigged.glb and the remapped painting
// together, under withFiles) and writes what each stage decided into skin.report. It reads the effective skeleton
// (select.jointsOf) and never touches the user's overrides: joints Blender had to complete go into skeleton.detected.
//
// Body painting (PUT /painting) saves weights and Lift together as one 'files' job. PUT/DELETE /weights remain for
// existing clients. Both records are kept for re-rigs; server/painting.ts stages the combined save before publication.
// A gear piece's painting is the gear routes'
// (server/routes/gear.ts).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { readGlb } from '../../src/engine/glb.ts'
import { hierarchyOf, jointsOf } from '../../src/model/select.ts'
import type { Character, Joints, RigReport } from '../../src/model/types.ts'
import { by, HttpError, readJsonBody, route, send } from '../http.ts'
import { busy, enqueue, type Job, runBlender, type Update } from '../jobs.ts'
import {
  checkPainting, mapPainting, optimizerExclude, optimizeSkin, rigDecisions, rigMethod, type RigStages, torchPython, trainedIds,
  validateSkin,
} from '../skinopt.ts'
import { characterDir, getCharacter, paths, readJson, ROOT, updateCharacter, withFiles, writeJson } from '../store.ts'
import { checkEdits, dropWeightEdits, publishRig, savePainting, skinnedParts, type WeightEdit, weightEdits, writeWeights } from '../weights.ts'
import { dropShapeEdits, shapeEdits, shapeReferences, writeShapes } from '../shapes.ts'
import { checkBodyPainting, saveBodyPainting } from '../painting.ts'
import { applyRig, assertUnlocked, jointsBack, rigRefusal } from './skin-policy.ts'
import { textureOverrides } from './look.ts'

export { assertUnlocked, rigRefusal }

async function found (id: string): Promise<Character> {
  const c = await getCharacter(id)
  if (c === null) throw new HttpError(404, 'No such character')
  return c
}

/** A creature template's label and bundled clips (static/<template.animations>), if it has them. */
async function templateInfo (template: string): Promise<{ label: string, animations?: string }> {
  const spec = await readJson<{ label?: string, animations?: string } | null>(path.join(ROOT, 'static', 'templates', `${template}.json`), null)
  const file = spec?.animations === undefined ? undefined : path.join(ROOT, 'static', spec.animations)
  return { label: (spec?.label ?? template).toLowerCase(), animations: file !== undefined && existsSync(file) ? file : undefined }
}

/** The clips a person's weights are always trained on: the slots' own (what the game plays) and the Skin step's tests
 * (arms over the head, a squat, fists: what shows a bad rig), whatever the library draw, but never the held-out clips
 * the benchmark scores on. */
async function trainedClips (c: Character): Promise<string[]> {
  const tests = await readJson<Record<string, Array<{ id: string, url?: string }>>>(path.join(ROOT, 'static', 'templates', 'tests.json'), {})
  const holdout = await readJson<{ clips?: string[] }>(path.join(ROOT, 'tools', 'skin_opt', 'holdout.json'), {})
  return trainedIds(c.clips.map(s => s.clip.id), tests.human ?? [], holdout.clips ?? [])
}

async function runRig (id: string, who: string, update: Update, signal: AbortSignal): Promise<void> {
  const character = await found(id)
  assertUnlocked(character)
  const dir = characterDir(id)
  const { template, fingerLevel } = character.skeleton
  const creature = template !== 'human'
  const hierarchy = hierarchyOf(character).map(([j]) => j)
  const input = jointsOf(character)
  const info = creature ? await templateInfo(template) : { label: 'person' }
  // Keep the last working rig until building, optimization and painting all finish.
  const output = path.join(dir, `rigging-${randomBytes(6).toString('hex')}.glb`)
  const alternative = output.replace(/\.glb$/, '-heat.glb')
  const beforeOptimize = output.replace(/\.glb$/, '-before-optimize.glb')
  const beforeLayers = output.replace(/\.glb$/, '-before-layers.glb')
  // (the joints handed to Blender, outside the character's folder until the rig is published)
  const work = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-rig-'))
  const started = Date.now()
  try {
    // (only composites made on this very source, with paint layers behind them: never an old body's texture)
    const overrides = await textureOverrides(id, who)
    const args = ['--input', path.join(dir, character.source.file), '--output', output, '--fingers', fingerLevel,
      ...(overrides !== null ? ['--overrides', overrides] : []), '--scale', String(character.source.scale)]
    // (Blender's volume heat as a second candidate: for people and the horse, where the tests can tell them apart)
    const native = !creature || template === 'horse'
    if (native) args.push('--native-output', alternative)
    const given = Object.keys(input).length
    if (given > 0) {
      const jointsFile = path.join(work, 'joints.json')
      await writeJson(jointsFile, input)
      args.push('--joints', jointsFile)
    }
    if (creature) args.push('--template', path.join(ROOT, 'static', 'templates', `${template}.json`))
    // Pose-optimized weights after Blender (when PyTorch is around), for humanoids (trained on the library). Not for
    // creatures: on a horse trained on its template's own clips it lowered its own objective while the walk got worse
    // (mean worst stretch 0.20 -> 0.31, 40 -> 189 vertices past double length) and tore flaps at the front legs and the
    // flank; their heat weights stay. RIGSMITH_OPTIMIZE_CREATURES=1 brings it back to try.
    const templateClips = creature ? info.animations : undefined
    const torch = torchPython()
    const optimize = torch !== null && (!creature || (process.env.RIGSMITH_OPTIMIZE_CREATURES === '1' && templateClips !== undefined))
    const share = optimize ? 0.45 : 0.85
    const { result } = await runBlender('autorig/rig.py', args, (progress, message) => { update({ progress: progress * share, message }) }, { signal })
    const r = result as { joints: Joints, method?: string, warnings?: string[] }
    const warnings = [...(r.warnings ?? [])]
    const { added, moved, warning } = jointsBack(hierarchy, input, r.joints)
    if (warning !== null) warnings.push(warning)
    const stages: RigStages = {
      template, label: info.label, method: r.method ?? '', given, added, moved, painted: 0,
      optimizer: optimize ? { ran: false, why: '' }
        : torch === null ? { ran: false, why: 'No PyTorch here (npm run setup:python sets it up)' }
          : { ran: false, why: 'Creatures keep their heat weights: on the horse the optimizer made the walk worse' },
    }

    // Lifted skin (Fix weights' Lift) back on the fresh rig first, so the painting below finds the surface it was
    // painted on: each lift by where its vertices were before it.
    const lifts = await shapeEdits(id)
    if (lifts.length > 0) {
      const n = await writeShapes(output, lifts)
      if (existsSync(alternative)) await writeShapes(alternative, lifts)
      warnings.push(n >= lifts.length ? `${n} lifted vertices put back (Fix weights' Lift)` : `${n} of ${lifts.length} lifted vertices put back: the rest are not where they were lifted from (Forget the lifts to drop them)`)
    }

    // Re-import can reorder/split vertices. Follow the old bind surface instead
    // of writing a saved brush stroke onto unrelated new vertex numbers.
    const savedPainting = await weightEdits(id)
    const previous = character.files.rigged === undefined ? undefined : path.join(dir, character.files.rigged)
    const hasPrevious = previous !== undefined && existsSync(previous)
    if (savedPainting.length > 0 && !hasPrevious) throw new Error('The previous rig is required to preserve its painted weights')
    update({ message: savedPainting.length > 0 ? 'Carrying the painting over' : 'Checking the weights' })
    const painted = savedPainting.length === 0 ? [] : await mapPainting(output, previous!, savedPainting, signal)
    if (painted.length > 0) await writeWeights(output, painted)
    stages.painted = painted.length

    if (native) {
      if (existsSync(alternative)) {
        if (painted.length > 0) await writeWeights(alternative, await mapPainting(alternative, previous!, savedPainting, signal))
        update({ progress: share, message: 'Comparing regional and volume heat weights' })
        stages.volume = { built: true, check: await validateSkin(output, alternative, template, signal) }
      } else {
        const why = warnings.find(w => w.startsWith('Alternative heat skin unavailable'))
        stages.volume = { built: false, why: why ?? 'Blender could not build it on this mesh' }
      }
    }
    // (never the previous rig's weights: kept whenever they strained the tests a little less, they carried every old
    // script's, brush's and fit's weights into each fresh rig, Forget and Start over included, so nothing old ever went
    // (the designer, 2026-11-01: "the old stuff poisoning current stuff for weeks"). A rig is the auto-rig's weights and
    // the saved painting; the previous rig only says where that painting goes.)
    if (optimize) {
      // Refine the best available skin, including native heat and previous paint,
      // rather than optimizing a regional candidate that may then be discarded.
      await copyFile(output, beforeOptimize)
      try {
        const always = creature ? [] : await trainedClips(character)
        const posed = await optimizeSkin(output, (progress, message) => { update({ progress: 0.55 + 0.4 * progress, message }) }, templateClips, always, signal)
        if (painted.length > 0) await writeWeights(output, painted)
        update({ progress: 0.96, message: 'Checking the refined weights on deformation tests' })
        // (scored on clips it didn't train on: the ones it did are swapped for other library clips, PLAN §4 bug 7)
        stages.optimizer = { ran: true, check: await validateSkin(output, beforeOptimize, template, signal, { exclude: optimizerExclude(always, posed) }) }
      } catch (error) {
        if (signal.aborted) throw error
        // A failed optimizer or validation cannot replace the accepted heat skin.
        await copyFile(beforeOptimize, output)
        const message = (error as Error).message.slice(0, 200)
        stages.optimizer = { ran: true, failed: message }
        warnings.push(`weights not pose-optimized: ${message}`)
      }
    }
    if (optimize && !creature) {
      // The layers (a coat over the thigh) fitted on whatever skin won, nothing else moving; kept when it keeps them
      // apart (tools/skin_opt/selection.ts: a stretch can be painted out, a thigh through a coat can't).
      await copyFile(output, beforeLayers)
      try {
        const always = await trainedClips(character)
        const posed = await optimizeSkin(output, (progress, message) => { update({ progress: 0.96 + 0.02 * progress, message }) }, undefined, always, signal, { onlyLayers: true })
        if (painted.length > 0) await writeWeights(output, painted)
        update({ progress: 0.98, message: 'Checking the layers on deformation tests' })
        stages.layers = { ran: true, check: await validateSkin(output, beforeLayers, template, signal, { exclude: optimizerExclude(always, posed), layers: true }) }
      } catch (error) {
        if (signal.aborted) throw error
        await copyFile(beforeLayers, output)
        const message = (error as Error).message.slice(0, 200)
        stages.layers = { ran: true, failed: message }
        warnings.push(`layers not fitted: ${message}`)
      }
    }
    // A comparison can select a previous skin; authored paint still wins.
    if (painted.length > 0) await writeWeights(output, painted)
    if (painted.length > 0) warnings.push(`${painted.length} painted vertices put back (Skin step: Forget the painting to drop them)`)
    signal.throwIfAborted()

    const report: RigReport = {
      method: rigMethod(stages),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      warnings,
      decisions: rigDecisions(stages),
    }
    const changes: string[] = []
    update({ progress: 0.99, message: 'Publishing the rig' })
    await withFiles(id, async () => {
      if (JSON.stringify(await weightEdits(id)) !== JSON.stringify(savedPainting)) throw new Error('Painting changed while rigging; the previous rig has been kept. Rig again to include the new painting')
      // (the lock looked at again under the store lock, just before the rig replaces the live one)
      await updateCharacter(id, async c => {
        assertUnlocked(c)
        signal.throwIfAborted()
        const lines = applyRig(c, { input, result: r.joints, report, painted: painted.length })
        await publishRig(id, output, path.join(dir, 'rigged.glb'), painted)
        changes.push(...lines)
      }, { by: who, what: 'rig', changes })
      // (kept beside the rig: the joints it was built from, which tools/verify_autorig.py --joints rig rigs again)
      if (given > 0) await writeJson(path.join(dir, 'joints.json'), input).catch(() => {})
    })
  } finally {
    await rm(output, { force: true })
    await rm(alternative, { force: true })
    await rm(beforeOptimize, { force: true })
    await rm(beforeLayers, { force: true })
    await rm(work, { recursive: true, force: true })
  }
}

/** The rig as a job. A failure or a cancel leaves the character as it was (a rig it had stays), says why in `error`
 * and the journal. */
function rig (c: Character, who: string): Job {
  return enqueue('rig', `Rig ${c.name}`, c.id, async (_job, update, signal) => {
    let before: Character['status'] = c.status
    await updateCharacter(c.id, x => { before = x.status; x.status = 'rigging'; delete x.error })
    try {
      await runRig(c.id, who, update, signal)
    } catch (error) {
      const message = signal.aborted ? 'the rig was cancelled' : (error as Error).message
      try {
        await updateCharacter(c.id, x => {
          x.status = before !== 'rigging' ? before : x.files.rigged !== undefined ? 'rigged' : 'ready'
          x.error = message
        }, { by: who, what: 'rig', changes: [signal.aborted ? 'rig cancelled: nothing changed' : `rig failed (nothing changed): ${message}`] })
      } catch { /* (deleted meanwhile: the job's own error says more) */ }
      throw error
    }
  }, { lock: 'files' })
}

route('POST', /^\/api\/characters\/([a-z0-9-]+)\/rig$/, async (req, res, [id]) => {
  const c = await found(id)
  const refused = rigRefusal(c)
  if (refused !== null) throw new HttpError(refused.status, refused.message)
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  // (painting that can't come over stops the rig at its end, minutes later: said now instead)
  const painted = await weightEdits(id)
  if (painted.length > 0) {
    const previous = c.files.rigged === undefined ? null : path.join(characterDir(id), c.files.rigged)
    if (previous === null || !existsSync(previous)) throw new HttpError(409, 'The painted weights need the rig they were painted on, which is gone: forget the painting first (Skin step)')
    const model = c.files.model === undefined ? null : path.join(characterDir(id), c.files.model)
    const problem = await checkPainting(model, previous, painted, hierarchyOf(c).map(([j]) => j))
    if (problem !== null) throw new HttpError(409, problem)
  }
  send(res, 202, rig(c, by(req)))
})

// ---- painted body weights -----------------------------------------------------------------------------------------

/** Why a character's body can't be painted now, if it can't. */
function paintRefusal (c: Character): HttpError | null {
  if (c.files.rigged === undefined || (c.source.kind !== 'mesh' && c.skeleton.converted !== true)) return new HttpError(400, 'Only a Rigsmith rig can be painted')
  if (c.status === 'rigging') return new HttpError(409, 'Wait for rigging to finish')
  return null
}

async function rigParts (c: Character): Promise<ReturnType<typeof skinnedParts>> {
  return skinnedParts(readGlb(new Uint8Array(await readFile(path.join(characterDir(c.id), c.files.rigged!)))))
}

// Save painting: the edits (vertices of CharacterView.bodySkinned's meshes) written into rigged.glb and kept for the
// next rig. 400 for an edit the rig doesn't have; 409 while locked or while another of its file jobs runs.
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/painting$/, async (req, res, [id]) => {
  const c = await found(id)
  const refused = paintRefusal(c)
  if (refused !== null) throw refused
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  let painting
  try { painting = checkBodyPainting(await rigParts(c), await readJsonBody(req)) }
  catch (error) { throw new HttpError(400, (error as Error).message) }
  if (painting.revision !== undefined && painting.revision !== (c.revision ?? 0)) throw new HttpError(409, 'The rig changed while painting; reload it before saving')
  const who = by(req)
  send(res, 202, enqueue('paint', `Save ${c.name}'s painting`, id, async (_job, update, signal) => {
    update({ message: 'Saving the weights and lifts together' })
    await withFiles(id, async () => {
      const now = await found(id)
      const refusedNow = paintRefusal(now)
      if (refusedNow !== null) throw refusedNow
      assertUnlocked(now)
      if (painting.revision !== undefined && painting.revision !== (now.revision ?? 0)) throw new HttpError(409, 'The rig changed while painting; reload it before saving')
      const saved = await saveBodyPainting(id, path.join(characterDir(id), now.files.rigged!), painting, signal)
      await updateCharacter(id, x => {
        x.revision = (x.revision ?? 0) + 1
        if (painting.edits.length > 0) x.skin.painted = saved.weightsKept
      }, { by: who, what: 'weights', changes: [`painting saved: ${saved.weighted} weighted, ${saved.lifted} lifted vertices`] })
    })
  }, { lock: 'files' }))
})
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/weights$/, async (req, res, [id]) => {
  const c = await found(id)
  const refused = paintRefusal(c)
  if (refused !== null) throw refused
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  const body = await readJsonBody<{ edits?: unknown }>(req)
  let edits: WeightEdit[]
  try {
    edits = checkEdits(await rigParts(c), body.edits)
  } catch (error) {
    throw new HttpError(400, (error as Error).message)
  }
  const who = by(req)
  send(res, 202, enqueue('paint', `Save ${c.name}'s painted weights`, id, async (_job, update, signal) => {
    update({ message: 'Writing the weights into the rig' })
    await withFiles(id, async () => {
      const now = await found(id)
      const refusedNow = paintRefusal(now)
      if (refusedNow !== null) throw refusedNow
      assertUnlocked(now)
      // (against the rig as it is now: one rebuilt since the request would have other vertices)
      checkEdits(await rigParts(now), edits)
      signal.throwIfAborted()
      // (the rig replaced whole, its record kept first: a crash mid-save never cuts a hand-fixed rig short)
      const { written, kept } = await savePainting(id, path.join(characterDir(id), now.files.rigged!), edits)
      await updateCharacter(id, x => {
        x.revision = (x.revision ?? 0) + 1
        x.skin.painted = kept
      }, { by: who, what: 'weights', changes: [`weights painted: ${written} vertices (${kept} kept for re-rigs)`] })
    })
  }, { lock: 'files' }))
})

// Lifted skin (Fix weights' Lift): rest positions written into rigged.glb and kept for the next rig
// (shape_edits.json, with where each vertex first was); DELETE puts them back.
route('GET', /^\/api\/characters\/([a-z0-9-]+)\/shape$/, async (_req, res, [id]) => {
  await withFiles(id, async () => {
    const c = await found(id)
    send(res, 200, c.files.rigged === undefined ? [] : await shapeReferences(id, path.join(characterDir(id), c.files.rigged)))
  })
})
route('PUT', /^\/api\/characters\/([a-z0-9-]+)\/shape$/, async (req, res, [id]) => {
  const c = await found(id)
  const refused = paintRefusal(c)
  if (refused !== null) throw refused
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  const { edits } = await readJsonBody<{ edits?: unknown }>(req)
  let painting
  try { painting = checkBodyPainting(await rigParts(c), { lifts: edits }) }
  catch (error) { throw new HttpError(400, (error as Error).message) }
  const who = by(req)
  send(res, 202, enqueue('paint', `Save ${c.name}'s lifted skin`, id, async (_job, update, signal) => {
    update({ message: 'Writing the lifts into the rig' })
    await withFiles(id, async () => {
      const now = await found(id)
      const refusedNow = paintRefusal(now)
      if (refusedNow !== null) throw refusedNow
      assertUnlocked(now)
      const rigPath = path.join(characterDir(id), now.files.rigged!)
      const saved = await saveBodyPainting(id, rigPath, painting, signal)
      await updateCharacter(id, x => { x.revision = (x.revision ?? 0) + 1 },
        { by: who, what: 'weights', changes: [`skin lifted: ${saved.lifted} vertices (${saved.liftsKept} kept for re-rigs)`] })
    })
  }, { lock: 'files' }))
})
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/shape$/, async (req, res, [id]) => {
  const c = await found(id)
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  const who = by(req)
  send(res, 202, enqueue('paint', `Forget ${c.name}'s lifts`, id, async () => {
    await withFiles(id, async () => {
      const now = await found(id)
      assertUnlocked(now)
      const n = await dropShapeEdits(id, path.join(characterDir(id), now.files.rigged ?? 'rigged.glb'))
      await updateCharacter(id, x => { x.revision = (x.revision ?? 0) + 1 }, { by: who, what: 'weights', changes: [`lifts forgotten: ${n} vertices put back`] })
    })
  }, { lock: 'files' }))
})

// Forget the painting: weight_edits.json emptied, so the next rig makes those weights afresh. The live rig keeps the
// painted weights until then.
route('DELETE', /^\/api\/characters\/([a-z0-9-]+)\/weights$/, async (req, res, [id]) => {
  const c = await found(id)
  assertUnlocked(c)
  const running = busy(id, 'files')
  if (running !== undefined) throw new HttpError(409, `Wait for ${running.label} to finish`)
  const who = by(req)
  send(res, 202, enqueue('paint', `Forget ${c.name}'s painting`, id, async () => {
    await withFiles(id, async () => {
      assertUnlocked(await found(id))
      const had = await dropWeightEdits(id)
      await updateCharacter(id, x => { delete x.skin.painted }, {
        by: who, what: 'weights',
        changes: [had > 0 ? `painting forgotten (${had} points): the rig keeps their weights until the next rig` : 'painting forgotten (there was none)'],
      })
    })
  }, { lock: 'files' }))
})
