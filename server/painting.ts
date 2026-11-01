// One body-paint save stages its shape, weights and both re-rig records before publication. Call under withFiles.
// Observed publication failures restore exact old files; failed rollback retains the staging directory for recovery.
import { existsSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readGlb } from '../src/engine/glb.ts'
import { mergeShapeEdits, shapeEdits, shapeReferences, type ShapeEdit, writeShapes } from './shapes.ts'
import { characterDir } from './store.ts'
import { checkEdits, skinnedParts, type SkinnedPart, type WeightEdit, writeWeights } from './weights.ts'

export interface BodyPainting { edits: WeightEdit[], lifts: ShapeEdit[], revision?: number }
export interface PaintingSaved { weighted: number, lifted: number, weightsKept: number, liftsKept: number }

/** Validate both halves before staging any file. Empty individual halves are allowed; an empty save is not. */
export function checkBodyPainting (parts: Array<Pick<SkinnedPart, 'count' | 'joints'>>, input: unknown): BodyPainting {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Painting must contain weights or lifts')
  const body = input as Record<string, unknown>
  const revision = body.revision
  if (revision !== undefined && (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0)) throw new Error('Painting revision must be a nonnegative whole number')
  const rawWeights = body.edits ?? [], rawLifts = body.lifts ?? []
  if (!Array.isArray(rawWeights) || !Array.isArray(rawLifts)) throw new Error('Weights and lifts must be arrays')
  if (rawWeights.length === 0 && rawLifts.length === 0) throw new Error('No painting to write')
  const edits = rawWeights.length > 0 ? checkEdits(parts, rawWeights) : []
  const lifts = new Map<string, ShapeEdit>()
  for (const [i, value] of rawLifts.entries()) {
    if (value === null || typeof value !== 'object') throw new Error(`lift ${i} is not a shape edit`)
    const { mesh, vertex, from, to } = value as Record<string, unknown>
    if (!Number.isInteger(mesh) || !Number.isInteger(vertex)) throw new Error(`lift ${i}: mesh and vertex must be whole numbers`)
    const part = parts[mesh as number]
    if (part === undefined || (mesh as number) < 0 || (vertex as number) < 0 || (vertex as number) >= part.count) throw new Error(`lift ${i}: the rig has no vertex ${String(mesh)}:${String(vertex)}`)
    const vector = (x: unknown): x is [number, number, number] => Array.isArray(x) && x.length === 3 && x.every(n =>
      typeof n === 'number' && Number.isFinite(n) && Number.isFinite(Math.fround(n)))
    if (!vector(from) || !vector(to)) throw new Error(`lift ${i}: positions must contain three finite float values`)
    lifts.set(`${mesh as number}:${vertex as number}`, { mesh: mesh as number, vertex: vertex as number, from: [...from], to: [...to] })
  }
  return { edits, lifts: [...lifts.values()], ...(revision === undefined ? {} : { revision: revision as number }) }
}

/** Publish a combined body stroke once. Character metadata/revision is updated by the caller only after success.
 * This rolls back filesystem errors in-process; the retained backups are also recoverable after a process crash. */
export async function saveBodyPainting (id: string, rigPath: string, input: BodyPainting, signal?: AbortSignal): Promise<PaintingSaved> {
  const originalRig = await readFile(rigPath)
  const { edits, lifts: requestedLifts } = checkBodyPainting(skinnedParts(readGlb(originalRig)), input)
  const dir = characterDir(id)
  const weightFile = path.join(dir, 'weight_edits.json'), shapeFile = path.join(dir, 'shape_edits.json')
  const [weightBefore, shapeBefore] = await Promise.all([
    existsSync(weightFile) ? readFile(weightFile) : null,
    existsSync(shapeFile) ? readFile(shapeFile) : null,
  ])
  const previousWeights = weightBefore === null ? {} : JSON.parse(weightBefore.toString()) as Record<string, WeightEdit>
  const previousLifts = await shapeEdits(id)
  const reference = requestedLifts.length > 0 ? await shapeReferences(id, rigPath) : []
  const origins = new Map(reference.map(e => [`${e.mesh}:${e.vertex}`, e.from]))
  // Resolve origin once for BOTH the GLB metadata and the sidecar. Legacy/stale `from` values must not make the
  // writer and record disagree, which would silently disable later reference loading and Forget lifts.
  const lifts = requestedLifts.map(e => ({ ...e, from: origins.get(`${e.mesh}:${e.vertex}`) ?? e.from }))
  const weights = { ...previousWeights }
  for (const edit of edits) weights[`${edit.mesh}:${edit.vertex}`] = edit
  const shapes = lifts.length > 0 ? mergeShapeEdits(previousLifts, lifts, reference) : null
  signal?.throwIfAborted()
  const staging = await mkdtemp(path.join(dir, '.painting-'))
  const candidate = path.join(staging, 'rigged.glb')
  const entries: Array<{ file: string, next: string, backup: string, existed: boolean }> = []
  const published: typeof entries = []
  let retain = false
  try {
    await writeFile(candidate, originalRig)
    const lifted = lifts.length > 0 ? await writeShapes(candidate, lifts, true, previousLifts) : 0
    const weighted = edits.length > 0 ? await writeWeights(candidate, edits) : 0
    const stage = async (file: string, bytes: Buffer | string, before: Buffer | null): Promise<void> => {
      const n = entries.length
      const next = path.join(staging, `${n}.next`), backup = path.join(staging, `${n}.before`)
      await writeFile(next, bytes)
      if (before !== null) await writeFile(backup, before)
      entries.push({ file, next, backup, existed: before !== null })
    }
    if (edits.length > 0) await stage(weightFile, JSON.stringify(weights), weightBefore)
    if (shapes !== null) await stage(shapeFile, JSON.stringify(shapes), shapeBefore)
    await stage(rigPath, await readFile(candidate), originalRig)
    // Names and exact backup locations survive a crash. No successful save leaves this directory behind.
    await writeFile(path.join(staging, 'recovery.json'), JSON.stringify(entries))
    signal?.throwIfAborted()
    for (const entry of entries) { await rename(entry.next, entry.file); published.push(entry) }
    return { weighted, lifted, weightsKept: Object.keys(weights).length, liftsKept: shapes === null ? previousLifts.length : Object.keys(shapes).length }
  } catch (error) {
    const errors: unknown[] = []
    for (const entry of published.toReversed()) {
      try {
        if (entry.existed) {
          const restored = entry.backup + '.restore'
          await copyFile(entry.backup, restored)
          await rename(restored, entry.file)
        } else await rm(entry.file, { force: true })
      } catch (rollback) { errors.push(rollback) }
    }
    if (errors.length > 0) {
      retain = true
      throw new AggregateError([error, ...errors], `Painting was not saved; recovery files retained at ${staging}`, { cause: error })
    }
    throw error
  } finally {
    if (!retain) {
      try { await rm(staging, { recursive: true, force: true }) }
      catch (cleanup) { console.warn(`rigsmith: temporary painting files remain at ${staging}`, cleanup) }
    }
  }
}
