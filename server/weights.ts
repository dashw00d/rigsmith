// Painted weights (the Rig step's "Fix weights", src/engine/weightpaint.ts) written into a rig, in place: JOINTS_0 /
// WEIGHTS_0 of its skinned primitives (the same accessors, so the rest of the file stays byte for byte), by vertex and
// bone name. Kept per character (weight_edits.json) and written again after each rig, so a re-rig keeps them.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { characterDir } from './workspace.ts'

export interface WeightEdit { mesh: number, vertex: number, weights: Array<[string, number]> }

interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: Array<{ name?: string, mesh?: number, skin?: number, children?: number[] }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>
  skins: Array<{ joints: number[] }>
  accessors: Array<{ bufferView: number, byteOffset?: number, componentType: number, count: number, normalized?: boolean }>
  bufferViews: Array<{ byteOffset?: number, byteStride?: number }>
}
const SIZE: Record<number, number> = { 5121: 1, 5123: 2, 5126: 4 }
// (three.js's PropertyBinding.sanitizeNodeName: the bone names the app knows)
const sanitize = (name: string): string => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '')

function write (buf: Buffer, type: number, offset: number, value: number, normalized: boolean): void {
  if (type === 5126) buf.writeFloatLE(value, offset)
  else if (type === 5121) buf.writeUInt8(normalized ? Math.round(value * 255) : value, offset)
  else if (type === 5123) buf.writeUInt16LE(normalized ? Math.round(value * 65535) : value, offset)
  else throw new Error(`component type ${type}`)
}

/** Write edits into a GLB's skin; the skinned primitives counted as the app counts its skinned meshes (scene order,
 * depth first). Returns the vertices written. */
export async function writeWeights (glbPath: string, edits: WeightEdit[]): Promise<number> {
  const glb = await readFile(glbPath)
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf
  const bin = 20 + jsonLength + 8
  const parts: Array<{ node: number, prim: { attributes: Record<string, number> } }> = []
  const visit = (n: number): void => {
    const node = gltf.nodes[n]
    if (node.mesh !== undefined && node.skin !== undefined) for (const prim of gltf.meshes[node.mesh].primitives) parts.push({ node: n, prim })
    for (const c of node.children ?? []) visit(c)
  }
  for (const n of gltf.scenes[gltf.scene ?? 0].nodes) visit(n)
  let written = 0
  for (const e of edits) {
    const part = parts[e.mesh]
    if (part === undefined) continue
    const joints = gltf.skins[gltf.nodes[part.node].skin!].joints.map(j => sanitize(gltf.nodes[j].name ?? ''))
    const ja = gltf.accessors[part.prim.attributes.JOINTS_0]; const wa = gltf.accessors[part.prim.attributes.WEIGHTS_0]
    if (e.vertex >= ja.count) continue
    const jv = gltf.bufferViews[ja.bufferView]; const wv = gltf.bufferViews[wa.bufferView]
    const jStride = jv.byteStride ?? SIZE[ja.componentType] * 4; const wStride = wv.byteStride ?? SIZE[wa.componentType] * 4
    const jBase = bin + (jv.byteOffset ?? 0) + (ja.byteOffset ?? 0) + e.vertex * jStride
    const wBase = bin + (wv.byteOffset ?? 0) + (wa.byteOffset ?? 0) + e.vertex * wStride
    const top = e.weights.map(([name, w]) => [joints.indexOf(name), w] as [number, number]).filter(([j, w]) => j >= 0 && w > 0).sort((a, b) => b[1] - a[1]).slice(0, 4)
    const total = top.reduce((t, [, w]) => t + w, 0)
    if (total <= 0) continue
    for (let k = 0; k < 4; k++) {
      write(glb, ja.componentType, jBase + k * SIZE[ja.componentType], top[k]?.[0] ?? 0, false)
      write(glb, wa.componentType, wBase + k * SIZE[wa.componentType], (top[k]?.[1] ?? 0) / total, wa.normalized === true)
    }
    written++
  }
  await writeFile(glbPath, glb)
  return written
}

const editsFile = (id: string): string => path.join(characterDir(id), 'weight_edits.json')

/** The character's painted weights, by part and vertex. */
export async function weightEdits (id: string): Promise<WeightEdit[]> {
  if (!existsSync(editsFile(id))) return []
  return Object.values(JSON.parse(await readFile(editsFile(id), 'utf8')) as Record<string, WeightEdit>)
}

/** Keep these edits (each vertex's latest) beside the character's earlier ones. */
export async function keepWeightEdits (id: string, edits: WeightEdit[]): Promise<number> {
  const all: Record<string, WeightEdit> = existsSync(editsFile(id)) ? JSON.parse(await readFile(editsFile(id), 'utf8')) as Record<string, WeightEdit> : {}
  for (const e of edits) all[`${e.mesh}:${e.vertex}`] = e
  await writeFile(editsFile(id), JSON.stringify(all))
  return Object.keys(all).length
}

export async function dropWeightEdits (id: string): Promise<void> {
  if (existsSync(editsFile(id))) await writeFile(editsFile(id), '{}')
}
