// Lifted skin (the Rig step's "Fix weights", the Lift brush: src/engine/weightpaint.ts lift): a vertex's rest position
// moved off the skin under it (a cape pulled off the body), written into a rig's existing POSITION accessor. Other
// attribute buffers stay unchanged; sparse primitive extras retain original references at current vertex indices.
// Kept per character (shape_edits.json, keyed by mesh and original position) with where each point was before
// it was lifted, and written again after each rig: a fresh rig is made from the unlifted model, so each lift finds its
// vertices there by that first position (a re-import that moved or dropped them leaves the lift out).
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { characterDir } from './workspace.ts'

export type Vec3 = [number, number, number]
export interface ShapeEdit { mesh: number, vertex: number, from: Vec3, to: Vec3 }
interface LiftReference { from: Vec3, to: Vec3 }

interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: Array<{ mesh?: number, skin?: number, children?: number[] }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number>, extras?: Record<string, unknown> & { rigsmithLift?: Record<string, LiftReference> } }> }>
  accessors: Array<{ bufferView: number, byteOffset?: number, componentType: number, count: number, min?: number[], max?: number[] }>
  bufferViews: Array<{ byteOffset?: number, byteStride?: number }>
}

interface Positions {
  count: number
  at: (v: number) => Vec3
  set: (v: number, p: Vec3) => void
  reference: (v: number) => LiftReference | undefined
  hasReferences: boolean
  resetReferences: () => void
  remember: (v: number, from: Vec3, to: Vec3) => void
  accessor: Gltf['accessors'][number]
}

/** A GLB's skinned primitives' positions, counted as the app counts its skinned meshes (scene order, depth first). */
function open (glb: Buffer): { gltf: Gltf, parts: Positions[], jsonLength: number } {
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf
  const bin = 20 + jsonLength + 8
  const parts: Positions[] = []
  const visit = (n: number): void => {
    const node = gltf.nodes[n]
    if (node.mesh !== undefined && node.skin !== undefined) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        const a = gltf.accessors[prim.attributes.POSITION]
        if (a.componentType !== 5126) throw new Error('Only float positions can be lifted')
        const view = gltf.bufferViews[a.bufferView]
        const stride = view.byteStride ?? 12
        const base = bin + (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
        const references = prim.extras?.rigsmithLift ?? {}
        parts.push({
          count: a.count,
          accessor: a,
          at: v => [glb.readFloatLE(base + v * stride), glb.readFloatLE(base + v * stride + 4), glb.readFloatLE(base + v * stride + 8)],
          set: (v, p) => { for (let k = 0; k < 3; k++) glb.writeFloatLE(p[k], base + v * stride + k * 4) },
          reference: v => references[v],
          hasReferences: prim.extras?.rigsmithLift !== undefined,
          resetReferences: () => {
            for (const key of Object.keys(references)) delete references[key]
            ;(prim.extras ??= {}).rigsmithLift = references
          },
          remember: (v, from, to) => {
            references[v] = { from, to }
            ;(prim.extras ??= {}).rigsmithLift = references
          },
        })
      }
    }
    for (const c of node.children ?? []) visit(c)
  }
  for (const n of gltf.scenes[gltf.scene ?? 0].nodes) visit(n)
  return { gltf, parts, jsonLength }
}

/** The JSON chunk again with the parts' bounds (a loader takes its bounding box from them), padded to its length. */
function bounds (glb: Buffer<ArrayBuffer>, gltf: Gltf, parts: Positions[], jsonLength: number): Buffer<ArrayBuffer> {
  for (const part of parts) {
    const min: Vec3 = [Infinity, Infinity, Infinity]; const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (let v = 0; v < part.count; v++) { const p = part.at(v); for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k]); max[k] = Math.max(max[k], p[k]) } }
    part.accessor.min = min; part.accessor.max = max
  }
  const text = JSON.stringify(gltf)
  // (the bounds are as long as before or nearly: when the new text doesn't fit, the chunk is rebuilt)
  if (Buffer.byteLength(text) <= jsonLength) {
    glb.write(text.padEnd(jsonLength, ' '), 20, 'utf8')
    return glb
  }
  const padded = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4, ' '), 'utf8')
  const rest = glb.subarray(20 + jsonLength)
  const out = Buffer.alloc(20 + padded.length + rest.length)
  glb.copy(out, 0, 0, 12)
  out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(padded.length, 12)
  out.writeUInt32LE(0x4E4F534A, 16)
  padded.copy(out, 20)
  rest.copy(out, 20 + padded.length)
  return out
}

/** Write lifts into a rig. `byIndex`: the rig the app painted on (each vertex where the edit names it); else a fresh
 * rig, each lift's vertices found where they were before it (`from`, within a hair: every vertex of a split seam).
 * Returns the vertices written. */
export async function writeShapes (glbPath: string, edits: ShapeEdit[], byIndex = false, reference: ShapeEdit[] = []): Promise<number> {
  let glb: Buffer<ArrayBuffer> = await readFile(glbPath)
  const { gltf, parts, jsonLength } = open(glb)
  // Upgrade older files' matched references while their historical addresses are still known. Re-rigs write the
  // newly found addresses below. Keeping this beside POSITION avoids guessing which coincident layer moved.
  if (!byIndex) for (const part of parts) part.resetReferences()
  for (const e of byIndex ? reference : []) {
    const part = parts[e.mesh]
    if (part !== undefined && !part.hasReferences && e.vertex >= 0 && e.vertex < part.count && positionKey(part.at(e.vertex)) === positionKey(e.to)) part.remember(e.vertex, e.from, e.to)
  }
  let written = 0
  if (byIndex) {
    for (const e of edits) {
      const part = parts[e.mesh]
      if (part === undefined || e.vertex >= part.count) continue
      const old = part.reference(e.vertex)
      const from = old !== undefined && positionKey(part.at(e.vertex)) === positionKey(old.to) &&
        (positionKey(e.from) === positionKey(old.from) || positionKey(e.from) === positionKey(old.to)) ? old.from : e.from
      part.remember(e.vertex, from, e.to)
      part.set(e.vertex, e.to); written++
    }
  } else {
    parts.forEach((part, mesh) => {
      const candidates = edits.filter(e => e.mesh === mesh)
      const destinations = new Map<string, Set<string>>()
      for (const e of candidates) {
        const key = sourceKey(e)
        if (!destinations.has(key)) destinations.set(key, new Set())
        destinations.get(key)!.add(positionKey(e.to))
      }
      // Distinct old vertices can have coincident source positions but different authored destinations. The fresh
      // topology supplies no identity for that branch; retain its sidecar instead of arbitrarily choosing one.
      const mine = candidates.filter(e => destinations.get(sourceKey(e))!.size === 1)
      if (mine.length === 0) return
      // (a grid of the rig's vertices, a cell a little wider than the match)
      let lo = Infinity; let hi = -Infinity
      for (let v = 0; v < part.count; v++) { const y = part.at(v)[1]; lo = Math.min(lo, y); hi = Math.max(hi, y) }
      const tol = 1e-5 * Math.max(hi - lo, 1e-6)
      const cell = tol * 4
      const key = (p: Vec3): string => `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)},${Math.floor(p[2] / cell)}`
      const grid = new Map<string, number[]>()
      for (let v = 0; v < part.count; v++) { const k = key(part.at(v)); (grid.get(k) ?? grid.set(k, []).get(k)!).push(v) }
      // (all matches first: a lift must not land on a vertex another lift already moved)
      const moves: Array<[number, ShapeEdit]> = []
      for (const e of mine) {
        const [cx, cy, cz] = e.from.map(x => Math.floor(x / cell))
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
          for (const v of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
            const p = part.at(v)
            if (Math.hypot(p[0] - e.from[0], p[1] - e.from[1], p[2] - e.from[2]) <= tol) moves.push([v, e])
          }
        }
      }
      const done = new Set<number>()
      for (const [v, e] of moves) { if (done.has(v)) continue; done.add(v); part.remember(v, e.from, e.to); part.set(v, e.to); written++ }
    })
  }
  glb = bounds(glb, gltf, parts, jsonLength)
  await writeFile(glbPath, glb)
  return written
}

const shapesFile = (id: string): string => path.join(characterDir(id), 'shape_edits.json')

/** The character's lifts, by part and vertex. */
export async function shapeEdits (id: string): Promise<ShapeEdit[]> {
  if (!existsSync(shapesFile(id))) return []
  return Object.values(JSON.parse(await readFile(shapesFile(id), 'utf8')) as Record<string, ShapeEdit>)
}

const positionKey = (p: Vec3): string => p.map(x => Math.fround(x)).join(',')
const sourceKey = (e: ShapeEdit): string => `${e.mesh}:${positionKey(e.from)}`
const recordKey = (e: ShapeEdit): string => `${sourceKey(e)}:${positionKey(e.to)}`

/** Saved references addressed to the current rig. Re-rig writes the actual matched addresses into primitive extras.
 * Older files use their exact historical index/destination; positional guessing could merge coincident layers. */
export async function shapeReferences (id: string, rigPath: string): Promise<ShapeEdit[]> {
  const edits = await shapeEdits(id)
  if (edits.length === 0 || !existsSync(rigPath)) return []
  const { parts } = open(await readFile(rigPath))
  const sources = new Set(edits.map(recordKey))
  const out: ShapeEdit[] = []
  parts.forEach((part, mesh) => {
    const legacy = new Map(edits.filter(e => e.mesh === mesh).map(e => [e.vertex, e]))
    for (let vertex = 0; vertex < part.count; vertex++) {
      const to = part.at(vertex); const stored = part.reference(vertex)
      const candidate = stored === undefined ? undefined : { mesh, vertex, ...stored }
      const edit = part.hasReferences ? (candidate !== undefined && sources.has(recordKey(candidate)) ? candidate : undefined) : legacy.get(vertex)
      if (edit !== undefined && positionKey(to) === positionKey(edit.to) &&
        (stored === undefined || positionKey(stored.to) === positionKey(to))) out.push({ mesh, vertex, from: [...edit.from], to })
    }
  })
  return out
}

/** Merge lifts without changing files; staged painting saves use the same original-position lineage rules. */
export function mergeShapeEdits (previous: ShapeEdit[], edits: ShapeEdit[], reference?: ShapeEdit[]): Record<string, ShapeEdit> {
  // Source coordinates and destination branches survive re-rig vertex reordering. Normalize legacy keys on write,
  // so a new index cannot steal another point's origin and an old destination cannot win the next re-rig.
  const all = new Map(previous.map(edit => [recordKey(edit), edit]))
  const current = new Map(reference?.map(edit => [`${edit.mesh}:${edit.vertex}`, edit]))
  for (const e of edits) {
    // Older clients started a new session at the saved destination. Retain that lineage only when it identifies
    // one original source; current clients already send the original reference in `from`.
    const prior = current.get(`${e.mesh}:${e.vertex}`) ?? (reference === undefined ? previous.find(old =>
      old.mesh === e.mesh && old.vertex === e.vertex && (positionKey(old.from) === positionKey(e.from) || positionKey(old.to) === positionKey(e.from))) : undefined)
    const kept = { ...e, from: prior?.from ?? e.from }
    if (prior !== undefined) all.delete(recordKey(prior))
    all.set(recordKey(kept), kept)
  }
  return Object.fromEntries(all)
}

/** Keep these lifts beside the earlier ones: a vertex lifted again keeps where it first was. */
export async function keepShapeEdits (id: string, edits: ShapeEdit[], reference?: ShapeEdit[]): Promise<number> {
  const record = mergeShapeEdits(await shapeEdits(id), edits, reference)
  await writeFile(shapesFile(id), JSON.stringify(record))
  return Object.keys(record).length
}

/** Forget the lifts: the rig's vertices put back where they were, the record emptied. Returns the vertices put back. */
export async function dropShapeEdits (id: string, rigPath: string): Promise<number> {
  const edits = await shapeReferences(id, rigPath)
  let n = 0
  if (edits.length > 0 && existsSync(rigPath)) n = await writeShapes(rigPath, edits.map(e => ({ ...e, to: e.from })), true)
  if (existsSync(shapesFile(id))) await writeFile(shapesFile(id), '{}')
  return n
}
