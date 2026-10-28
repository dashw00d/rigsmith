// Lifted skin (the Rig step's "Fix weights", the Lift brush: src/engine/weightpaint.ts lift): a vertex's rest position
// moved off the skin under it (a cape pulled off the body), written into a rig's POSITION in place (the same accessor,
// so the rest of the file stays byte for byte). Kept per character (shape_edits.json) with where each vertex was before
// it was lifted, and written again after each rig: a fresh rig is made from the unlifted model, so each lift finds its
// vertices there by that first position (a re-import that moved or dropped them leaves the lift out).
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { characterDir } from './workspace.ts'

export type Vec3 = [number, number, number]
export interface ShapeEdit { mesh: number, vertex: number, from: Vec3, to: Vec3 }

interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: Array<{ mesh?: number, skin?: number, children?: number[] }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>
  accessors: Array<{ bufferView: number, byteOffset?: number, componentType: number, count: number, min?: number[], max?: number[] }>
  bufferViews: Array<{ byteOffset?: number, byteStride?: number }>
}

interface Positions { count: number, at: (v: number) => Vec3, set: (v: number, p: Vec3) => void, accessor: Gltf['accessors'][number] }

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
        parts.push({
          count: a.count,
          accessor: a,
          at: v => [glb.readFloatLE(base + v * stride), glb.readFloatLE(base + v * stride + 4), glb.readFloatLE(base + v * stride + 8)],
          set: (v, p) => { for (let k = 0; k < 3; k++) glb.writeFloatLE(p[k], base + v * stride + k * 4) },
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
export async function writeShapes (glbPath: string, edits: ShapeEdit[], byIndex = false): Promise<number> {
  let glb: Buffer<ArrayBuffer> = await readFile(glbPath)
  const { gltf, parts, jsonLength } = open(glb)
  let written = 0
  if (byIndex) {
    for (const e of edits) {
      const part = parts[e.mesh]
      if (part === undefined || e.vertex >= part.count) continue
      part.set(e.vertex, e.to); written++
    }
  } else {
    parts.forEach((part, mesh) => {
      const mine = edits.filter(e => e.mesh === mesh)
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
      const moves: Array<[number, Vec3]> = []
      for (const e of mine) {
        const [cx, cy, cz] = e.from.map(x => Math.floor(x / cell))
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
          for (const v of grid.get(`${cx + a},${cy + b},${cz + c}`) ?? []) {
            const p = part.at(v)
            if (Math.hypot(p[0] - e.from[0], p[1] - e.from[1], p[2] - e.from[2]) <= tol) moves.push([v, e.to])
          }
        }
      }
      const done = new Set<number>()
      for (const [v, to] of moves) { if (done.has(v)) continue; done.add(v); part.set(v, to); written++ }
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

/** Keep these lifts beside the earlier ones: a vertex lifted again keeps where it first was. */
export async function keepShapeEdits (id: string, edits: ShapeEdit[]): Promise<number> {
  const all: Record<string, ShapeEdit> = existsSync(shapesFile(id)) ? JSON.parse(await readFile(shapesFile(id), 'utf8')) as Record<string, ShapeEdit> : {}
  for (const e of edits) {
    const k = `${e.mesh}:${e.vertex}`
    all[k] = { ...e, from: all[k]?.from ?? e.from }
  }
  await writeFile(shapesFile(id), JSON.stringify(all))
  return Object.keys(all).length
}

/** Forget the lifts: the rig's vertices put back where they were, the record emptied. Returns the vertices put back. */
export async function dropShapeEdits (id: string, rigPath: string): Promise<number> {
  const edits = await shapeEdits(id)
  let n = 0
  if (edits.length > 0 && existsSync(rigPath)) n = await writeShapes(rigPath, edits.map(e => ({ ...e, to: e.from })), true)
  if (existsSync(shapesFile(id))) await writeFile(shapesFile(id), '{}')
  return n
}
