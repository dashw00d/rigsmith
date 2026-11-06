// The Node steps of the rig job around Blender (server/routes/skin.ts runRig), each a tool in tools/skin_opt run as
// its own process (killed when the job is cancelled):
//   validateSkin   two skins compared on the deformation tests; the better kept, whole or by surface island
//   mapPainting    the painting readdressed onto a rebuilt surface; checkPainting asks the same before rigging
//   optimizeSkin   pose-optimized weights: the fresh rig posed through a few hundred library poses, its weights fit on
//                  the GPU for minimal stretch, volume loss and limb wobble, then written back into the GLB. Needs a
//                  Python with PyTorch (the repo's .venv, or RIGSMITH_TORCH_PYTHON); skipped without one. The check
//                  after it leaves out every clip it trained on (optimizerExclude).
//   layers         the same tools fitting only the layers (a coat over the thigh, tools/skin_opt/layers.py): the points
//                  over another layer and a band round them, whatever skin won, so the coat stays over the legs in every
//                  pose; the rest of the body keeps its weights exactly. Checked like the optimizer, layers first.
// And the pure parts the job's report is made of: which clips the optimizer trains on, and the rig's decisions.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { RigDecision } from '../src/model/types.ts'
import { type GpuNeed, spawnJob, withGpu } from './jobs.ts'
import { ROOT } from './store.ts'
import type { WeightEdit } from './weights.ts'

const TOOLS = path.join(ROOT, 'tools', 'skin_opt')
// The repo's .venv (npm run setup:python), else an explicit override, else any older install.
const CANDIDATES = [process.env.RIGSMITH_TORCH_PYTHON, path.join(ROOT, '.venv', 'bin', 'python'), path.join(os.homedir(), 'dev/ml/make-it-animatable/.venv/bin/python')]
let found: string | null | undefined

export function torchPython (): string | null {
  if (found !== undefined) return found
  found = CANDIDATES.find(p => p !== undefined && p !== '' && existsSync(p) && spawnSync(p, ['-c', 'import torch'], { stdio: 'ignore' }).status === 0) ?? null
  return found
}

const cancelled = (signal: AbortSignal | undefined): Error => (signal?.reason instanceof Error ? signal.reason : new Error('Cancelled'))

async function run (command: string, args: string[], onLine?: (line: string) => void, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted === true) throw cancelled(signal)
  await new Promise<void>((resolve, reject) => {
    const child = spawnJob(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] }, signal)
    let err = ''
    let pending = ''
    child.stdout!.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split('\n'); pending = lines.pop() ?? ''
      for (const line of lines) if (line.trim() !== '') onLine?.(line)
    })
    child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString()).slice(-4000) })
    child.on('error', reject)
    child.on('close', code => {
      if (pending.trim() !== '') onLine?.(pending)
      if (signal?.aborted === true) reject(cancelled(signal))
      else if (code === 0) resolve()
      else reject(new Error(`${path.basename(args[0] ?? command)} failed: ${err.trim().split('\n').slice(-3).join(' ')}`))
    })
  })
}

/** What tools/skin_opt/validate.ts says of a candidate skin against a reference. */
export interface SkinCheck {
  /** False: they couldn't be compared (`reason`); the candidate stands. */
  compared: boolean
  /** The reference kept whole (written into the candidate). */
  retained: boolean
  /** The reference kept on some surface islands (`switched` of `islands`). */
  hybrid?: boolean
  reason?: string
  /** What the candidate did against the reference on the tests ("strained Air squat 15% more"). */
  why?: string
  switched?: number
  islands?: number
}

/** validate.ts's arguments. `exclude`: clips it mustn't score on (tools/lib/deformation.ts tops the set up instead). */
export function validateArgs (candidate: string, previous: string, template: string, exclude: string[] = [], layers = false): string[] {
  const args = [path.join(TOOLS, 'validate.ts'), candidate, previous, template, ...(layers ? ['--layers'] : [])]
  const ids = [...new Set(exclude)].filter(id => id !== '')
  return ids.length > 0 ? [...args, '--exclude', ids.join(',')] : args
}

/** Keep previous weights when the new skin regresses on the rig's deformation
 * tests. The comparison uses the new skeleton, so joint edits always take effect.
 * `exclude`: clips not to score on (after the pose optimizer, every clip it trained on: optimizerExclude). */
export async function validateSkin (candidate: string, previous: string, template: string, signal?: AbortSignal, options: { exclude?: string[], layers?: boolean } = {}): Promise<SkinCheck> {
  let result: SkinCheck | undefined
  await run(process.execPath, validateArgs(candidate, previous, template, options.exclude, options.layers === true), line => {
    if (line.startsWith('{')) result = JSON.parse(line) as SkinCheck
  }, signal)
  if (result === undefined) throw new Error('No skin validation result')
  return result
}

/** Resolve paint addresses against the old bind surface before writing anything
 * into a rebuilt skin. A failed mapping leaves the live rig and painting intact. */
export async function mapPainting (candidate: string, previous: string, painted: WeightEdit[], signal?: AbortSignal): Promise<WeightEdit[]> {
  if (painted.length === 0) return []
  // (in a folder of its own outside the character's: nothing left behind there if the process dies)
  const work = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-paint-'))
  const input = path.join(work, 'paint.json'), output = path.join(work, 'mapped.json')
  try {
    await writeFile(input, JSON.stringify(painted))
    await run(process.execPath, [path.join(TOOLS, 'painting.ts'), candidate, previous, input, output], undefined, signal)
    return JSON.parse(await readFile(output, 'utf8')) as WeightEdit[]
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** The painted bones a skeleton doesn't have (a re-rig at another finger level, another template). */
export function bonesMissing (painted: WeightEdit[], bones: Iterable<string>): string[] {
  const have = new Set(bones)
  const out = new Set<string>()
  for (const e of painted) for (const [bone, w] of e.weights) if (w > 0 && !have.has(bone)) out.add(bone)
  return [...out].sort()
}

/**
 * Before a rig with painting: will it carry over? The painted bones must be in the skeleton it will have (`bones`:
 * hierarchyOf's names) and the painted points must still lie on `model` (model.glb, what the rig is built from).
 * Null when it looks fine, else the reason (the route answers 409 with it).
 */
export async function checkPainting (model: string | null, previous: string, painted: WeightEdit[], bones: string[]): Promise<string | null> {
  if (painted.length === 0) return null
  const missing = bonesMissing(painted, bones)
  if (missing.length > 0) {
    const shown = missing.slice(0, 4).join(', ') + (missing.length > 4 ? ` and ${missing.length - 4} more` : '')
    return `The painted weights use bones this skeleton no longer has (${shown}): forget the painting first, or go back to the skeleton they were painted on`
  }
  if (model === null || !existsSync(model)) return null
  const work = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-paint-'))
  try {
    const input = path.join(work, 'paint.json')
    await writeFile(input, JSON.stringify(painted))
    let result: { ok: boolean, problem?: string } | undefined
    await run(process.execPath, [path.join(TOOLS, 'painting.ts'), '--check', model, previous, input], line => {
      if (line.startsWith('{')) result = JSON.parse(line) as typeof result
    })
    if (result === undefined || result.ok) return null
    return `${result.problem ?? 'The painting no longer fits the model'}: forget the painting first (Skin step) to rig it`
  } catch (error) {
    // (a check that couldn't run doesn't stop the rig: the rig's own mapping still refuses to lose painting)
    console.error('rigsmith: painting check failed:', error)
    return null
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

/** The library clips the optimizer always trains on: the character's own slots' clips and the Skin step's tests
 * (library ones; bundled clips with a url aren't in the library), never the benchmark's held-out clips
 * (tools/skin_opt/holdout.json), so tools/dev/bench.ts scores clips it hasn't seen. */
export function trainedIds (own: string[], tests: Array<{ id: string, url?: string }>, holdout: string[]): string[] {
  const out = new Set([...own, ...tests.filter(t => t.url === undefined).map(t => t.id)])
  for (const id of holdout) out.delete(id)
  return [...out]
}

/** The clips the check after the optimizer leaves out: every one it trained on, those it was asked to (`always`) and
 * those it drew (`posed`, what optimizeSkin returns), so the check scores motion the weights weren't fit to. */
export function optimizerExclude (always: string[], posed: string[] | null): string[] {
  return [...new Set([...always, ...(posed ?? [])])]
}

// The optimizer's fit takes its turn on the GPU lane (jobs.ts gpuTurn) with every other GPU job; it falls back to the
// CPU when the GPU is full anyway, so it asks for little ($RIGSMITH_SKINOPT_VRAM MiB).
export const SKINOPT_GPU: GpuNeed = { vram: Number(process.env.RIGSMITH_SKINOPT_VRAM ?? 3000), family: 'torch' }

/** Optimize the skin of a rigged GLB (a candidate, never a live rig: apply.ts refuses one) in place. Returns null when
 * no PyTorch is available, else the library clip ids it trained on (none when it trained on `clips`).
 * clips: train on this GLB's own animations (creature templates) instead of the humanoid library. always: library
 * clip ids trained on whatever the draw (trainedIds). */
export async function optimizeSkin (glb: string, onProgress: (progress: number, message: string) => void, clips?: string, always: string[] = [], signal?: AbortSignal, options: { onlyLayers?: boolean } = {}): Promise<string[] | null> {
  const python = torchPython()
  if (python === null) return null
  return await optimizeNow(python, glb, onProgress, clips, always, signal, options.onlyLayers === true)
}

async function optimizeNow (python: string, glb: string, onProgress: (progress: number, message: string) => void, clips: string | undefined, always: string[], signal: AbortSignal | undefined, onlyLayers: boolean): Promise<string[]> {
  if (signal?.aborted === true) throw cancelled(signal)
  const work = path.join(os.tmpdir(), 'rigsmith-skinopt', path.basename(path.dirname(glb)) + '-' + Date.now())
  await mkdir(work, { recursive: true })
  const prefix = path.join(work, 'skin')
  try {
    onProgress(0, clips === undefined ? 'Posing the rig through 256 library poses' : 'Posing the rig through its animations')
    await run(process.execPath, [path.join(TOOLS, 'pose_set.ts'), glb, prefix, '--poses', '256', ...(clips === undefined ? [] : ['--from', clips]), ...(clips === undefined && always.length > 0 ? ['--with', always.join(',')] : [])], undefined, signal)
    // (the clips it drew, beside the ones asked for: a template's own clips are named in its file, not library ids)
    const posed = clips === undefined ? (JSON.parse(await readFile(prefix + '.json', 'utf8')) as { clips?: string[] }).clips ?? [] : []
    const what = onlyLayers ? 'Fitting the layers' : 'Optimizing weights'
    onProgress(0.3, onlyLayers ? 'Starting to fit the layers' : 'Starting weight optimization')
    let device: string | undefined
    // (the whole fit leaves the layers to the pass after it, which fits nothing else)
    await withGpu({ label: onlyLayers ? 'Fitting the layers' : 'The skin optimizer' }, SKINOPT_GPU, signal, async () => {
      await run(python, [path.join(TOOLS, 'optimize.py'), prefix, '--iters', '300', ...(onlyLayers ? ['--only-layers'] : ['--w-layers', '0'])], line => {
        if (line.includes('using the CPU') || line === 'device cpu') device = 'CPU'
        else if (line === 'device cuda') device = 'GPU'
        if (line.startsWith('device ') && device !== undefined) onProgress(0.3, `${what} on the ${device}`)
        const m = /^it\s+(\d+)/.exec(line)
        if (m !== null) onProgress(0.3 + 0.6 * Number(m[1]) / 300, device === undefined ? what : `${what} on the ${device}`)
      }, signal)
    }, { onWait: why => { onProgress(0.3, why) } })
    onProgress(0.95, 'Writing weights')
    await run(process.execPath, [path.join(TOOLS, 'apply.ts'), glb, prefix, glb], undefined, signal)
    return posed
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

// ---- the rig report -----------------------------------------------------------------------------------------------

/** What each stage of a rig did (runRig fills it in as it goes); rigDecisions says it in words. */
export interface RigStages {
  /** The template ('human' or a creature's id) and its label for the words ('horse'). */
  template: string
  label: string
  /** Blender's weighting: 'regions' (a person's) or 'heat' (a creature's). */
  method: string
  /** Joints given to Blender (0: it detected them afresh), joints it added, and given joints it moved. */
  given: number
  added: string[]
  moved: string[]
  /** Blender's volume heat as a second candidate: not tried, not built (why), or compared. */
  volume?: { built: false, why: string } | { built: true, check: SkinCheck }
  /** The live rig's weights against the new ones: none, or compared. */
  previous?: SkinCheck
  /** The pose optimizer: skipped (why), failed (why), or run and checked against the skin before it. */
  optimizer: { ran: false, why: string } | { ran: true, failed: string } | { ran: true, check: SkinCheck }
  /** The layers fit after it (a coat kept over the legs): not run (why), failed (why), or run and checked. */
  layers?: { ran: false, why: string } | { ran: true, failed: string } | { ran: true, check: SkinCheck }
  /** Painted points put back (mapped from the previous rig). */
  painted: number
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`
const islandsText = (c: SkinCheck): string => c.switched !== undefined && c.islands !== undefined ? `${c.switched} of ${plural(c.islands, 'surface island')}` : 'some surface islands'

/** One decision per stage that ran, in order, each with what it chose and why. */
export function rigDecisions (s: RigStages): RigDecision[] {
  const out: RigDecision[] = []
  out.push(s.given === 0
    ? { stage: 'Joints', choice: 'Found by Blender', why: 'None were placed, so Blender detected them on the mesh' }
    : { stage: 'Joints', choice: 'As placed', why: `${plural(s.given, 'joint')} from the Skeleton step${s.added.length > 0 ? `; Blender added ${s.added.length}` : ''}${s.moved.length > 0 ? `; it moved ${s.moved.length}` : ''}` })
  out.push(s.method === 'regions'
    ? { stage: 'Weights', choice: 'Regional heat', why: 'Each part of the body weighted to its own bones by heat diffusion, blended at the borders' }
    : s.method === 'heat'
      ? { stage: 'Weights', choice: 'Bone heat', why: `The ${s.label} template's bones, by plain bone heat (no regions)` }
      : { stage: 'Weights', choice: s.method || 'Blender', why: 'As Blender weighted them' })
  if (s.volume !== undefined) {
    const v = s.volume
    const first = s.method === 'regions' ? 'Regional heat' : 'Bone heat'
    if (!v.built) out.push({ stage: 'Volume heat', choice: 'Not built', why: v.why })
    else if (!v.check.compared) out.push({ stage: 'Volume heat', choice: 'Not compared', why: v.check.reason ?? 'The two skins could not be compared' })
    else if (v.check.retained) out.push({ stage: 'Volume heat', choice: 'Volume heat', why: `${first} ${v.check.why ?? 'deformed worse on the tests'}` })
    else if (v.check.hybrid === true) out.push({ stage: 'Volume heat', choice: `${first}, volume heat on some parts`, why: `Volume heat deformed better on ${islandsText(v.check)}, on every test` })
    else out.push({ stage: 'Volume heat', choice: first, why: `${first} ${v.check.why ?? 'was no worse on the tests'}` })
  }
  if (s.previous !== undefined) {
    const p = s.previous
    if (!p.compared) out.push({ stage: 'Previous rig', choice: 'Not compared', why: p.reason ?? 'The bind surface or bone set changed' })
    else if (p.retained) out.push({ stage: 'Previous rig', choice: 'Previous weights kept', why: `The new weights ${p.why ?? 'deformed worse on the tests'}` })
    else if (p.hybrid === true) out.push({ stage: 'Previous rig', choice: 'New weights, previous on some parts', why: `The previous weights deformed better on ${islandsText(p)}, on every test` })
    else out.push({ stage: 'Previous rig', choice: 'New weights', why: `The new weights ${p.why ?? 'were no worse on the tests'}` })
  }
  const o = s.optimizer
  if (!o.ran) out.push({ stage: 'Pose optimizer', choice: 'Skipped', why: o.why })
  else if ('failed' in o) out.push({ stage: 'Pose optimizer', choice: 'Failed, not used', why: o.failed })
  else if (!o.check.compared) out.push({ stage: 'Pose optimizer', choice: 'Optimized', why: `Kept without a check: ${o.check.reason ?? 'it could not be compared'}` })
  else if (o.check.retained) out.push({ stage: 'Pose optimizer', choice: 'Reverted', why: `The optimized weights ${o.check.why ?? 'deformed worse on the tests'}` })
  else if (o.check.hybrid === true) out.push({ stage: 'Pose optimizer', choice: 'Optimized, except some parts', why: `The weights before it deformed better on ${islandsText(o.check)}, on every test` })
  else out.push({ stage: 'Pose optimizer', choice: 'Optimized', why: `The optimized weights ${o.check.why ?? 'were no worse on the tests'}` })
  const l = s.layers
  if (l !== undefined) {
    if (!l.ran) out.push({ stage: 'Layers', choice: 'Not fitted', why: l.why })
    else if ('failed' in l) out.push({ stage: 'Layers', choice: 'Failed, not used', why: l.failed })
    else if (!l.check.compared) out.push({ stage: 'Layers', choice: 'Fitted', why: `Kept without a check: ${l.check.reason ?? 'it could not be compared'}` })
    else if (l.check.retained) out.push({ stage: 'Layers', choice: 'Reverted', why: `The fitted weights ${l.check.why ?? 'deformed worse on the tests'}` })
    else if (l.check.hybrid === true) out.push({ stage: 'Layers', choice: 'Fitted, except some parts', why: `The weights before it deformed better on ${islandsText(l.check)}, on every test` })
    else out.push({ stage: 'Layers', choice: 'Fitted', why: `The fitted weights ${l.check.why ?? 'were no worse on the tests'}` })
  }
  if (s.painted > 0) out.push({ stage: 'Painting', choice: 'Put back', why: `${plural(s.painted, 'painted point')} from the previous rig, moved onto the new surface and written last, so they win` })
  return out
}

/** The short code of what won (kept for the game's build record): Blender's method, then each stage's choice. */
export function rigMethod (s: RigStages): string {
  let method = s.method
  if (s.volume?.built === true && s.volume.check.compared) {
    if (s.volume.check.retained) method = 'native-heat'
    else if (s.volume.check.hybrid === true) method += '+hybrid-heat'
  }
  if (s.previous?.compared === true && (s.previous.retained || s.previous.hybrid === true)) method += '+retained-weights'
  const o = s.optimizer
  if (o.ran && 'check' in o && !o.check.retained) method += o.check.hybrid === true ? '+hybrid-optimized' : '+pose-optimized'
  const l = s.layers
  if (l?.ran === true && 'check' in l && !l.check.retained) method += '+layers'
  return method
}
