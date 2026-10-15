// Write optimizer output (<prefix>.opt.bin) into a rigged GLB's skin, in place: JOINTS_0 / WEIGHTS_0
// of each skinned primitive are overwritten in the binary chunk (same accessor types and sizes, so
// textures and everything else stay byte-identical).
// node tools/skin_opt/apply.ts <rig.glb> <prefix> [<out.glb>]
import { readFileSync, writeFileSync } from 'node:fs'

const [glbPath, prefix, outPath] = process.argv.slice(2)
const glb = readFileSync(glbPath)
const jsonLength = glb.readUInt32LE(12)
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as {
  nodes: Array<{ name?: string, mesh?: number, skin?: number }>
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>
  skins: Array<{ joints: number[] }>
  accessors: Array<{ bufferView: number, byteOffset?: number, componentType: number, count: number, normalized?: boolean, type: string }>
  bufferViews: Array<{ byteOffset?: number, byteStride?: number }>
}
const binStart = 20 + jsonLength + 8
const meta = JSON.parse(readFileSync(prefix + '.json', 'utf8')) as { boneNames: string[], meshes: Array<{ count: number, mesh?: number, primitive?: number }> }
const rows = readFileSync(prefix + '.opt.bin')
const canonical = (name: string): string => name.replace(/^mixamorig\d*[:_]?/, '')

const SIZE: Record<number, number> = { 5121: 1, 5123: 2, 5126: 4 }
function write (view: Buffer, type: number, offset: number, value: number, normalized: boolean): void {
  if (type === 5126) view.writeFloatLE(value, offset)
  else if (type === 5121) view.writeUInt8(normalized ? Math.round(value * 255) : value, offset)
  else if (type === 5123) view.writeUInt16LE(normalized ? Math.round(value * 65535) : value, offset)
  else throw new Error(`component type ${type}`)
}

let row = 0
for (const info of meta.meshes) {
  if (info.mesh === undefined || info.primitive === undefined) throw new Error('mesh association missing')
  const prim = gltf.meshes[info.mesh].primitives[info.primitive]
  const node = gltf.nodes.find(n => n.mesh === info.mesh && n.skin !== undefined)
  if (node === undefined) throw new Error(`no skinned node for mesh ${info.mesh}`)
  const joints = gltf.skins[node.skin!].joints.map(j => canonical(gltf.nodes[j].name ?? ''))
  const jointOf = meta.boneNames.map(name => joints.indexOf(name))
  const ja = gltf.accessors[prim.attributes.JOINTS_0]
  const wa = gltf.accessors[prim.attributes.WEIGHTS_0]
  if (ja.count !== info.count || wa.count !== info.count) throw new Error('vertex count mismatch')
  const jv = gltf.bufferViews[ja.bufferView]; const wv = gltf.bufferViews[wa.bufferView]
  const jStride = jv.byteStride ?? SIZE[ja.componentType] * 4
  const wStride = wv.byteStride ?? SIZE[wa.componentType] * 4
  const jBase = binStart + (jv.byteOffset ?? 0) + (ja.byteOffset ?? 0)
  const wBase = binStart + (wv.byteOffset ?? 0) + (wa.byteOffset ?? 0)
  for (let i = 0; i < info.count; i++, row++) {
    let total = 0
    const w = [0, 1, 2, 3].map(k => rows.readFloatLE(row * 32 + 16 + k * 4))
    for (const x of w) total += x
    for (let k = 0; k < 4; k++) {
      const bone = rows.readUInt32LE(row * 32 + k * 4)
      const joint = w[k] > 0 ? jointOf[bone] : 0
      if (joint < 0) throw new Error(`bone ${meta.boneNames[bone]} not in skin`)
      write(glb, ja.componentType, jBase + i * jStride + k * SIZE[ja.componentType], joint, false)
      write(glb, wa.componentType, wBase + i * wStride + k * SIZE[wa.componentType], w[k] / total, wa.normalized === true)
    }
  }
}
writeFileSync(outPath ?? glbPath, glb)
console.log(`applied ${row} vertices`)
