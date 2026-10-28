// A character's model files resized and moved in place (Import → Size: a height, stood on the floor), without
// importing or rigging again: a rig keeps its weights, its painting, everything but where and how big it is.
//
// p' = s·p + d for every rest point (s uniform, d a move). An unskinned file just has its scene's top nodes moved. A
// skinned one has its skin and skeleton moved themselves (the vertices, the root bones' places, every bone's offset
// from its parent, and the inverse binds: W' = S·W·s⁻¹ so W'⁻¹ = s·W⁻¹·S⁻¹), which three.js and Godot read alike.
import { readFile, rename, writeFile } from 'node:fs/promises'

type Mat = number[]
interface Node { name?: string, children?: number[], mesh?: number, skin?: number, translation?: number[], rotation?: number[], scale?: number[], matrix?: Mat }
interface Gltf {
  scene?: number
  scenes: Array<{ nodes: number[] }>
  nodes: Node[]
  meshes?: Array<{ primitives: Array<{ attributes: Record<string, number>, targets?: Array<Record<string, number>> }> }>
  skins?: Array<{ joints: number[], inverseBindMatrices?: number }>
  accessors: Array<{ bufferView?: number, byteOffset?: number, componentType: number, count: number, type: string, min?: number[], max?: number[], sparse?: unknown }>
  bufferViews: Array<{ byteOffset?: number, byteStride?: number }>
  animations?: Array<{ channels: Array<{ target: { node?: number, path: string } }> }>
}

const identity = (n: Node): boolean =>
  n.matrix === undefined &&
  (n.translation ?? [0, 0, 0]).every(v => Math.abs(v) < 1e-9) &&
  (n.scale ?? [1, 1, 1]).every(v => Math.abs(v - 1) < 1e-9) &&
  (n.rotation ?? [0, 0, 0, 1]).every((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) < 1e-9)

function open (glb: Buffer): { gltf: Gltf, bin: Buffer, jsonLength: number } {
  if (glb.readUInt32LE(0) !== 0x46546C67) throw new Error('Not a GLB')
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf
  const start = 20 + jsonLength + 8
  return { gltf, bin: glb.subarray(start, start + glb.readUInt32LE(20 + jsonLength)), jsonLength }
}

/** A float accessor's values, read and written in place (its stride respected). */
function floats (gltf: Gltf, bin: Buffer, index: number): { count: number, size: number, get: (i: number, k: number) => number, set: (i: number, k: number, v: number) => void } {
  const a = gltf.accessors[index]
  if (a.sparse !== undefined || a.bufferView === undefined) throw new Error('A sparse accessor: not resized in place')
  if (a.componentType !== 5126) throw new Error('A quantized accessor: not resized in place')
  const size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type] ?? 1
  const view = gltf.bufferViews[a.bufferView]
  const stride = view.byteStride ?? size * 4
  const base = (view.byteOffset ?? 0) + (a.byteOffset ?? 0)
  return { count: a.count, size, get: (i, k) => bin.readFloatLE(base + i * stride + k * 4), set: (i, k, v) => { bin.writeFloatLE(v, base + i * stride + k * 4) } }
}

/** The lowest and highest the model's surface reaches (rest; y up), from its meshes' extents. */
export function extentY (glb: Buffer): { min: number, max: number } {
  const { gltf } = open(glb)
  const parent = new Map<number, number>()
  gltf.nodes.forEach((n, i) => { for (const c of n.children ?? []) parent.set(c, i) })
  let min = Infinity; let max = -Infinity
  gltf.nodes.forEach((n, i) => {
    if (n.mesh === undefined) return
    // (a skinned mesh's points are where its skin puts them: its node's own place doesn't count)
    let up = 0; let k = 1
    if (n.skin === undefined) {
      for (let at: number | undefined = i; at !== undefined; at = parent.get(at)) {
        const m = gltf.nodes[at]
        if (m.matrix !== undefined || (m.rotation !== undefined && !identity({ rotation: m.rotation }))) throw new Error('A turned model: measure it by importing it again')
        up = up * (m.scale?.[1] ?? 1) + (m.translation?.[1] ?? 0); k *= m.scale?.[1] ?? 1
      }
    }
    for (const p of gltf.meshes?.[n.mesh].primitives ?? []) {
      const a = gltf.accessors[p.attributes.POSITION]
      if (a.min === undefined || a.max === undefined) continue
      min = Math.min(min, a.min[1] * k + up); max = Math.max(max, a.max[1] * k + up)
    }
  })
  if (!Number.isFinite(min)) throw new Error('No mesh to measure')
  return { min, max }
}

/** The file resized by `s` about its origin, then moved by `d` (written over itself). */
export async function transformGlb (file: string, s: number, d: [number, number, number]): Promise<void> {
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('Bad scale')
  const glb = await readFile(file)
  const { gltf, bin } = open(glb)
  const roots = gltf.scenes[gltf.scene ?? 0].nodes
  const skins = gltf.skins ?? []
  if (skins.length === 0) {
    // (no skin: the scene's top nodes moved, the meshes as they are)
    for (const r of roots) {
      const n = gltf.nodes[r]
      if (n.matrix !== undefined) {
        const m = n.matrix
        n.matrix = m.map((v, i) => (i < 12 ? v * s : i < 15 ? v * s + d[i - 12] : v))
      } else {
        const t = n.translation ?? [0, 0, 0]
        n.translation = [t[0] * s + d[0], t[1] * s + d[1], t[2] * s + d[2]]
        n.scale = (n.scale ?? [1, 1, 1]).map(v => v * s)
      }
    }
  } else {
    const joints = new Set(skins.flatMap(k => k.joints))
    const parent = new Map<number, number>()
    gltf.nodes.forEach((n, i) => { for (const c of n.children ?? []) parent.set(c, i) })
    const chainIdentity = (i: number): boolean => { for (let at = parent.get(i); at !== undefined; at = parent.get(at)) if (!identity(gltf.nodes[at])) return false; return true }
    if ((gltf.animations ?? []).some(a => a.channels.some(c => c.target.path === 'translation' || c.target.path === 'scale'))) throw new Error('It carries animations that move its bones: not resized in place')
    gltf.nodes.forEach((n, i) => {
      if (n.matrix !== undefined) throw new Error(`${n.name ?? 'A node'} is placed by a matrix: not resized in place`)
      const underJoint = (() => { for (let at = parent.get(i); at !== undefined; at = parent.get(at)) if (joints.has(at)) return true; return false })()
      if (joints.has(i) || underJoint) {
        const t = n.translation ?? [0, 0, 0]
        // (a root bone's place in the model moved with it; the rest keep their turn, their offsets scaled)
        if (joints.has(i) && !underJoint) {
          if (!chainIdentity(i)) throw new Error('Its skeleton sits under a moved node: not resized in place')
          n.translation = [t[0] * s + d[0], t[1] * s + d[1], t[2] * s + d[2]]
        } else n.translation = t.map(v => v * s)
        if ((n.scale ?? [1, 1, 1]).some(v => Math.abs(v - 1) > 1e-6)) throw new Error('A scaled bone: not resized in place')
      } else if (n.mesh !== undefined) {
        if (!identity(n) || !chainIdentity(i)) throw new Error(`${n.name ?? 'A mesh'} is moved by its node: not resized in place`)
      }
    })
    // the meshes' points, each accessor once
    const done = new Set<number>()
    const point = (index: number, move: boolean): void => {
      if (done.has(index)) return
      done.add(index)
      const f = floats(gltf, bin, index)
      for (let i = 0; i < f.count; i++) for (let k = 0; k < 3; k++) f.set(i, k, f.get(i, k) * s + (move ? d[k] : 0))
      const a = gltf.accessors[index]
      if (a.min !== undefined) a.min = a.min.map((v, k) => v * s + (move ? d[k] : 0))
      if (a.max !== undefined) a.max = a.max.map((v, k) => v * s + (move ? d[k] : 0))
    }
    for (const n of gltf.nodes) {
      if (n.mesh === undefined) continue
      for (const p of gltf.meshes?.[n.mesh].primitives ?? []) {
        point(p.attributes.POSITION, true)
        for (const t of p.targets ?? []) if (t.POSITION !== undefined) point(t.POSITION, false)
      }
    }
    // inverse binds: s · W⁻¹ · S⁻¹ (S⁻¹ = scale 1/s after moving by -d)
    for (const skin of skins) {
      if (skin.inverseBindMatrices === undefined || done.has(skin.inverseBindMatrices)) continue
      done.add(skin.inverseBindMatrices)
      const f = floats(gltf, bin, skin.inverseBindMatrices)
      for (let i = 0; i < f.count; i++) {
        const m = Array.from({ length: 16 }, (_, k) => f.get(i, k))
        // column-major: columns 0..2 are the turn (and scale), column 3 the move
        const out = m.slice()
        // W⁻¹·S⁻¹: S⁻¹(p) = (p - d)/s → columns 0..2 divided by s, column 3 = (M3 - M[0..2]·d)
        for (let c = 0; c < 3; c++) for (let r = 0; r < 4; r++) out[c * 4 + r] = m[c * 4 + r] / s
        for (let r = 0; r < 4; r++) out[12 + r] = m[12 + r] - (out[r] * d[0] + out[4 + r] * d[1] + out[8 + r] * d[2])
        // s·(…): rows 0..2 times s
        for (let c = 0; c < 4; c++) for (let r = 0; r < 3; r++) out[c * 4 + r] *= s
        out.forEach((v, k) => { f.set(i, k, v) })
      }
    }
  }
  let json = Buffer.from(JSON.stringify(gltf), 'utf8')
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)])
  const out = Buffer.alloc(28 + json.length + bin.length)
  out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(out, 28 + json.length)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, out)
  await rename(tmp, file)
}
