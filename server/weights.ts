// Painted weights (the Skin step's weight painting, src/engine/weightpaint.ts) written into a rig: JOINTS_0 / WEIGHTS_0
// of its skinned primitives (the same accessors, so the rest of the file stays byte for byte), by vertex and bone name.
// Kept per character (weight_edits.json, keyed "mesh:vertex") and written again after each rig, so a re-rig keeps
// them. Every file here is replaced whole (written beside it as <file>.<hex>.tmp, then moved over it: the restart
// clean-up deletes strays), so a crash mid-save never cuts a rig or its record short. The callers that write a
// character's files hold its withFiles lock (server/store.ts).
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { accessor, type Glb, readGlb } from '../src/engine/glb.ts'
import { characterDir } from './store.ts'

/** A painted vertex: its skinned primitive (CharacterView.bodySkinned order: the file's skinned primitives in scene
 * order, depth first), the vertex, and its bones by name with their weights. */
export interface WeightEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

// (three.js's PropertyBinding.sanitizeNodeName: the bone names the app knows)
const sanitize = (name: string): string => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '')

/** One skinned primitive of a GLB: its vertex count, the bone names its JOINTS_0 indexes, and its skin accessors
 * (none on a primitive the file left unskinned). */
export interface SkinnedPart { count: number, joints: string[], attributes: { JOINTS_0?: number, WEIGHTS_0?: number, POSITION?: number } }

/** The skinned primitives as the app counts its skinned meshes (three.js makes every primitive of a skinned node one):
 * scene order, depth first. */
export function skinnedParts (glb: Glb): SkinnedPart[] {
  const { nodes = [], meshes = [], skins = [], scenes = [], accessors = [] } = glb.json
  const parts: SkinnedPart[] = []
  const visit = (n: number): void => {
    const node = nodes[n]
    if (node.mesh !== undefined && node.skin !== undefined) {
      const joints = skins[node.skin].joints.map(j => sanitize(nodes[j].name ?? ''))
      for (const prim of meshes[node.mesh].primitives) {
        const { JOINTS_0, WEIGHTS_0, POSITION } = prim.attributes
        const skinned = JOINTS_0 !== undefined && WEIGHTS_0 !== undefined
        parts.push({ count: skinned ? accessors[POSITION ?? JOINTS_0]?.count ?? 0 : 0, joints, attributes: skinned ? { JOINTS_0, WEIGHTS_0, POSITION } : {} })
      }
    }
    for (const c of node.children ?? []) visit(c)
  }
  for (const n of scenes[glb.json.scene ?? 0]?.nodes ?? []) visit(n)
  return parts
}

/**
 * Painted edits as a request sent them, checked against the rig they are for: each names a skinned primitive and a
 * vertex it has, and bones its skin has, with weights that are numbers from 0 up (some above 0). Throws (the route
 * answers 400) at the first that doesn't; returns them cleaned (each vertex once, its latest).
 */
export function checkEdits (parts: Array<Pick<SkinnedPart, 'count' | 'joints'>>, edits: unknown): WeightEdit[] {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('No weights to write')
  const out = new Map<string, WeightEdit>()
  for (const [i, e] of edits.entries()) {
    const at = `edit ${i}`
    if (typeof e !== 'object' || e === null) throw new Error(`${at} isn't a weight edit`)
    const { mesh, vertex, weights } = e as Record<string, unknown>
    if (!Number.isInteger(mesh) || !Number.isInteger(vertex)) throw new Error(`${at}: mesh and vertex must be whole numbers`)
    const part = parts[mesh as number]
    if (part === undefined || (mesh as number) < 0) throw new Error(`${at}: the rig has no skinned mesh ${String(mesh)} (it has ${parts.length})`)
    if ((vertex as number) < 0 || (vertex as number) >= part.count) throw new Error(`${at}: mesh ${String(mesh)} has no vertex ${String(vertex)} (it has ${part.count})`)
    if (!Array.isArray(weights) || weights.length === 0) throw new Error(`${at}: no weights`)
    const clean: Array<[string, number]> = []
    for (const w of weights) {
      if (!Array.isArray(w) || w.length !== 2 || typeof w[0] !== 'string' || typeof w[1] !== 'number' || !Number.isFinite(w[1]) || w[1] < 0) {
        throw new Error(`${at}: each weight must be [bone, a number from 0 up]`)
      }
      if (!part.joints.includes(w[0])) throw new Error(`${at}: the rig has no bone ${w[0]}`)
      clean.push([w[0], w[1]])
    }
    if (clean.every(([, w]) => w <= 0)) throw new Error(`${at}: every weight is 0`)
    out.set(`${mesh as number}:${vertex as number}`, { mesh: mesh as number, vertex: vertex as number, weights: clean })
  }
  return [...out.values()]
}

/** A temp file beside `file`, for it to be moved over it: <file>.<hex>.tmp. */
const tempBeside = (file: string): string => `${file}.${randomBytes(6).toString('hex')}.tmp`

/** `file` replaced whole or not at all: written beside it, then moved over it. */
async function replaceFile (file: string, data: Uint8Array | string): Promise<void> {
  const temp = tempBeside(file)
  try {
    await writeFile(temp, data)
    await rename(temp, file)
  } finally {
    await rm(temp, { force: true })
  }
}

/** Write edits into a GLB's bytes, in place; the skinned primitives counted as skinnedParts counts them. Edits naming
 * what the file doesn't have are skipped (check them first with checkEdits). Returns the vertices written. */
export function paintGlb (bytes: Uint8Array, edits: WeightEdit[]): number {
  const glb = readGlb(bytes)
  const parts = skinnedParts(glb)
  let written = 0
  for (const e of edits) {
    const part = parts[e.mesh]
    const { JOINTS_0, WEIGHTS_0 } = part?.attributes ?? {}
    if (JOINTS_0 === undefined || WEIGHTS_0 === undefined) continue
    // (in place in the file's bytes: the same accessors, so every other byte stays)
    const ja = accessor(glb, JOINTS_0); const wa = accessor(glb, WEIGHTS_0)
    if (e.vertex >= ja.count) continue
    const top = e.weights.map(([name, w]) => [part.joints.indexOf(name), w] as [number, number]).filter(([j, w]) => j >= 0 && w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((t, [, w]) => t + w, 0)
    if (total <= 0) continue
    for (let k = 0; k < 4; k++) {
      ja.set(e.vertex, k, top[k]?.[0] ?? 0)
      wa.set(e.vertex, k, (top[k]?.[1] ?? 0) / total)
    }
    written++
  }
  if (written > 0) weldSeams(glb, new Set(edits.map(e => `${e.mesh}:${e.vertex}`)))
  return written
}

/**
 * The copies of one point given one skin, in place: glTF splits a vertex wherever its UVs or material change, and every
 * weight pass here (the pose optimizer, painting put back by vertex) treats the copies as separate vertices, so they
 * drift apart and the surface cracks open along the seam when posed (Emberhold's base body along its head/neck border,
 * 2026-11-02). Vertices at the same rest position, across all skinned primitives, take their averaged weights (four
 * strongest bones, normalised); where some of them were just painted (`painted`, "part:vertex"), the painted copies'
 * weights, so painting one copy is never halved by its twin. Returns the points welded.
 */
export function weldSeams (glb: Glb, painted: ReadonlySet<string> = new Set()): number {
  const parts = skinnedParts(glb)
  const groups = new Map<string, Array<[number, number]>>()
  const views = parts.map(part => {
    const { JOINTS_0, WEIGHTS_0, POSITION } = part.attributes
    if (JOINTS_0 === undefined || WEIGHTS_0 === undefined || POSITION === undefined) return null
    return { j: accessor(glb, JOINTS_0), w: accessor(glb, WEIGHTS_0), p: accessor(glb, POSITION), joints: part.joints }
  })
  views.forEach((v, m) => {
    if (v === null) return
    for (let i = 0; i < v.p.count; i++) {
      // (exact positions: the copies a seam split are bit-identical; 1e-6 absorbs float noise, nothing more)
      const key = [0, 1, 2].map(k => Math.round(v.p.get(i, k) * 1e6)).join(',')
      const list = groups.get(key)
      if (list === undefined) groups.set(key, [[m, i]])
      else list.push([m, i])
    }
  })
  let welded = 0
  for (const members of groups.values()) {
    if (members.length < 2) continue
    const sum = new Map<string, number>()
    const fresh = members.filter(([m, i]) => painted.has(`${m}:${i}`))
    for (const [m, i] of fresh.length > 0 ? fresh : members) {
      const v = views[m]!
      for (let k = 0; k < 4; k++) {
        const w = v.w.get(i, k)
        if (w > 0) { const name = v.joints[v.j.get(i, k)]; sum.set(name, (sum.get(name) ?? 0) + w) }
      }
    }
    const top = [...sum.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((t, [, w]) => t + w, 0)
    if (total <= 0) continue
    let differs = false
    for (const [m, i] of members) {
      const v = views[m]!
      const want = top.map(([name, w]) => [v.joints.indexOf(name), w / total] as [number, number])
      if (want.some(([j]) => j < 0)) continue   // (a primitive bound to another skeleton: left as it is)
      for (let k = 0; k < 4; k++) {
        const [j, w] = want[k] ?? [0, 0]
        if (Math.abs(v.w.get(i, k) - w) > 1e-4 || (w > 0 && v.j.get(i, k) !== j)) differs = true
        v.j.set(i, k, j); v.w.set(i, k, w)
      }
    }
    if (differs) welded++
  }
  return welded
}

/** weldSeams on a GLB file, the file replaced whole when anything changed. Returns the points welded. */
export async function weldSeamsFile (glbPath: string): Promise<number> {
  const bytes = await readFile(glbPath)
  if (bytes.length < 12 || bytes.toString('latin1', 0, 4) !== 'glTF') return 0   // (not a GLB: nothing to weld)
  const welded = weldSeams(readGlb(bytes))
  if (welded > 0) await replaceFile(glbPath, bytes)
  return welded
}

/** Write edits into a GLB file's skin (paintGlb), the file replaced whole. Returns the vertices written. */
export async function writeWeights (glbPath: string, edits: WeightEdit[]): Promise<number> {
  const bytes = await readFile(glbPath)
  const written = paintGlb(bytes, edits)
  await replaceFile(glbPath, bytes)
  return written
}

const editsFile = (id: string): string => path.join(characterDir(id), 'weight_edits.json')

/** The character's painted weights, by part and vertex. */
export async function weightEdits (id: string): Promise<WeightEdit[]> {
  if (!existsSync(editsFile(id))) return []
  return Object.values(JSON.parse(await readFile(editsFile(id), 'utf8')) as Record<string, WeightEdit>)
}

/** Keep these edits (each vertex's latest) beside the character's earlier ones. Returns how many are kept. */
export async function keepWeightEdits (id: string, edits: WeightEdit[]): Promise<number> {
  const all: Record<string, WeightEdit> = existsSync(editsFile(id)) ? JSON.parse(await readFile(editsFile(id), 'utf8')) as Record<string, WeightEdit> : {}
  for (const e of edits) all[`${e.mesh}:${e.vertex}`] = e
  // (whole or not at all: a half-written record would pair old addresses with nothing)
  await replaceFile(editsFile(id), JSON.stringify(all))
  return Object.keys(all).length
}

/** Forget the painting: the record emptied (the live rig keeps the weights until the next rig). Returns how many there
 * were. */
export async function dropWeightEdits (id: string): Promise<number> {
  if (!existsSync(editsFile(id))) return 0
  const had = (await weightEdits(id)).length
  await replaceFile(editsFile(id), '{}')
  return had
}

/**
 * Save painting into a character's live rig (`glbPath`): the edits written into the GLB and kept in
 * weight_edits.json. The new GLB is written beside the rig, then the record is kept, then the GLB moved over the rig:
 * a crash on the way leaves the rig whole (at worst with strokes in the record it hasn't taken yet, which the next rig
 * puts back), never painted past its record or cut short. A rig that can't be replaced puts the record back as it was.
 * Returns the vertices written and how many edits the record keeps.
 */
export async function savePainting (id: string, glbPath: string, edits: WeightEdit[]): Promise<{ written: number, kept: number }> {
  const bytes = await readFile(glbPath)
  const written = paintGlb(bytes, edits)
  const record = editsFile(id)
  const before = existsSync(record) ? await readFile(record, 'utf8') : null
  const temp = tempBeside(glbPath)
  try {
    await writeFile(temp, bytes)
    const kept = await keepWeightEdits(id, edits)
    try {
      await rename(temp, glbPath)
    } catch (error) {
      try {
        if (before === null) await rm(record, { force: true })
        else await replaceFile(record, before)
      } catch (rollback) {
        throw new AggregateError([error, rollback], 'The painting was not saved, and its record could not be put back', { cause: rollback })
      }
      throw error
    }
    return { written, kept }
  } finally {
    await rm(temp, { force: true })
  }
}

/** Publish a completed rig together with its remapped painting. Roll back the
 * rig if publishing its paint record fails; old vertex addresses must never be
 * paired with a new topology. Temporary paths belong to this rig job. */
export async function publishRig (id: string, candidate: string, destination: string, painted: WeightEdit[]): Promise<void> {
  await weldSeamsFile(candidate)   // (every rig, painted or not: a seam's copies share one skin)
  if (painted.length === 0) { await rename(candidate,destination); return }
  const paint = editsFile(id), staged = candidate + '.paint.json', backup = candidate + '.previous.glb'
  const previousRig = existsSync(destination)
  let rigPublished = false, keepBackup = false
  try {
    const record = Object.fromEntries(painted.map(e => [`${e.mesh}:${e.vertex}`,e]))
    await writeFile(staged,JSON.stringify(record))
    if (previousRig) await copyFile(destination,backup)
    await rename(candidate,destination); rigPublished = true
    await rename(staged,paint)
  } catch (error) {
    if (rigPublished) {
      try {
        if (previousRig) await rename(backup,destination)
        else await rm(destination,{force:true})
      } catch (rollback) {
        keepBackup = true
        throw new AggregateError([error,rollback],`Rig publication failed; recovery rig retained at ${backup}`,{cause:rollback})
      }
    }
    throw error
  } finally {
    await rm(staged,{force:true}); if (!keepBackup) await rm(backup,{force:true})
  }
}
