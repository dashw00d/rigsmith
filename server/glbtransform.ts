// A character's model files resized and moved in place (Import → Size: a height, stood on the floor), without
// importing or rigging again: a rig keeps its weights, its painting, everything but where and how big it is.
//
// p' = s·p + d for every rest point (s uniform, d a move). An unskinned file just has its scene's top nodes moved. A
// skinned one has its skin and skeleton moved themselves (the vertices, the root bones' places, every bone's offset
// from its parent, and the inverse binds: W' = S·W·s⁻¹ so W'⁻¹ = s·W⁻¹·S⁻¹), which three.js and Godot read alike.
import { readFile, rename, writeFile } from 'node:fs/promises'
import { accessor, readGlb, writeGlb, type AccessorView, type Glb, type GltfNode } from '../src/engine/glb.ts'

const identity = (n: GltfNode): boolean =>
  n.matrix === undefined &&
  (n.translation ?? [0, 0, 0]).every(v => Math.abs(v) < 1e-9) &&
  (n.scale ?? [1, 1, 1]).every(v => Math.abs(v - 1) < 1e-9) &&
  (n.rotation ?? [0, 0, 0, 1]).every((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) < 1e-9)

/** A float accessor's values, read and written in place. */
function floats (glb: Glb, index: number): AccessorView {
  const a = glb.json.accessors![index]
  if (a.sparse !== undefined || a.bufferView === undefined) throw new Error('A sparse accessor: not resized in place')
  if (a.componentType !== 5126) throw new Error('A quantized accessor: not resized in place')
  return accessor(glb, index)
}

/** The lowest and highest the model's surface reaches (rest; y up), from its meshes' extents. */
export function extentY (bytes: Uint8Array): { min: number, max: number } {
  const gltf = readGlb(bytes).json
  const nodes = gltf.nodes ?? []
  const parent = new Map<number, number>()
  nodes.forEach((n, i) => { for (const c of n.children ?? []) parent.set(c, i) })
  let min = Infinity; let max = -Infinity
  nodes.forEach((n, i) => {
    if (n.mesh === undefined) return
    // (a skinned mesh's points are where its skin puts them: its node's own place doesn't count)
    let up = 0; let k = 1
    if (n.skin === undefined) {
      for (let at: number | undefined = i; at !== undefined; at = parent.get(at)) {
        const m = nodes[at]
        if (m.matrix !== undefined || (m.rotation !== undefined && !identity({ rotation: m.rotation }))) throw new Error('A turned model: measure it by importing it again')
        up = up * (m.scale?.[1] ?? 1) + (m.translation?.[1] ?? 0); k *= m.scale?.[1] ?? 1
      }
    }
    for (const p of gltf.meshes?.[n.mesh].primitives ?? []) {
      const a = gltf.accessors![p.attributes.POSITION]
      if (a.min === undefined || a.max === undefined) continue
      min = Math.min(min, a.min[1] * k + up); max = Math.max(max, a.max[1] * k + up)
    }
  })
  if (!Number.isFinite(min)) throw new Error('No mesh to measure')
  return { min, max }
}

/** The file resized by `s` about its origin, then moved by `d` (written over itself). */
export async function transformGlb (file: string, s: number, d: [number, number, number]): Promise<void> {
  const out = transformedGlb(await readFile(file), s, d)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, out)
  await rename(tmp, file)
}

/** A GLB's bytes resized by `s` about its origin, then moved by `d`, as new bytes (`bytes` is left as it was). Throws,
 * having changed nothing, when the file can't be resized in place. */
export function transformedGlb (bytes: Uint8Array, s: number, d: [number, number, number]): Uint8Array {
  if (!(s > 0) || !Number.isFinite(s)) throw new Error('Bad scale')
  // (a copy, not a view, even of a Buffer: the accessors below are written in place, and the caller keeps the original
  // to put back on failure)
  const glb = readGlb(new Uint8Array(bytes))
  const gltf = glb.json
  const nodes = gltf.nodes ?? []
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? []
  const skins = gltf.skins ?? []
  if (skins.length === 0) {
    // (no skin: the scene's top nodes moved, the meshes as they are)
    for (const r of roots) {
      const n = nodes[r]
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
    nodes.forEach((n, i) => { for (const c of n.children ?? []) parent.set(c, i) })
    const chainIdentity = (i: number): boolean => { for (let at = parent.get(i); at !== undefined; at = parent.get(at)) if (!identity(nodes[at])) return false; return true }
    if ((gltf.animations ?? []).some(a => a.channels.some(c => c.target.path === 'translation' || c.target.path === 'scale'))) throw new Error('It carries animations that move its bones: not resized in place')
    nodes.forEach((n, i) => {
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
      const f = floats(glb, index)
      for (let i = 0; i < f.count; i++) for (let k = 0; k < 3; k++) f.set(i, k, f.get(i, k) * s + (move ? d[k] : 0))
      const a = gltf.accessors![index]
      if (a.min !== undefined) a.min = a.min.map((v, k) => v * s + (move ? d[k] : 0))
      if (a.max !== undefined) a.max = a.max.map((v, k) => v * s + (move ? d[k] : 0))
    }
    for (const n of nodes) {
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
      const f = floats(glb, skin.inverseBindMatrices)
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
  return writeGlb(gltf, glb.bin)
}
