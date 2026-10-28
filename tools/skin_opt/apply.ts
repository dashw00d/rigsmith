// Write optimizer output (<prefix>.opt.bin) into a rigged GLB's skin: JOINTS_0 / WEIGHTS_0 of each skinned primitive
// are overwritten in the binary chunk (same accessor types and sizes, so textures and everything else stay
// byte-identical), and the result written to <out.glb>.
// node tools/skin_opt/apply.ts <rig.glb> <prefix> <out.glb>
// The output is always named (the rig job passes its candidate) and is never a character's rigged.glb: a live rig's
// weights change only through the rig and paint routes, which honour the skin lock.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { accessor, readGlb } from '../../src/engine/glb.ts'

const [glbPath, prefix, outPath] = process.argv.slice(2)
if (glbPath === undefined || prefix === undefined || outPath === undefined) {
  console.error('usage: node tools/skin_opt/apply.ts <rig.glb> <prefix> <out.glb>')
  process.exit(2)
}
const parts = path.resolve(outPath).split(path.sep)
if (parts.at(-1) === 'rigged.glb' && parts.at(-3) === 'characters') {
  console.error(`${outPath} is a character's live rig: write a copy and publish it through the app`)
  process.exit(2)
}
const bytes = readFileSync(glbPath)
const glb = readGlb(bytes)
const { nodes = [], meshes = [], skins = [] } = glb.json
const meta = JSON.parse(readFileSync(prefix + '.json', 'utf8')) as { boneNames: string[], nodeNames?: string[], meshes: Array<{ count: number, mesh?: number, primitive?: number }> }
const rows = readFileSync(prefix + '.opt.bin')
const canonical = (name: string): string => name.replace(/^mixamorig\d*[:_]?/, '')
// three.js's PropertyBinding.sanitizeNodeName, so JSON names compare with the names pose_set saw.
const sanitize = (name: string): string => name.replace(/\s/g, '_').replace(/[[\].:/]/g, '')

let row = 0
for (const info of meta.meshes) {
  if (info.mesh === undefined || info.primitive === undefined) throw new Error('mesh association missing')
  const prim = meshes[info.mesh].primitives[info.primitive]
  const node = nodes.find(n => n.mesh === info.mesh && n.skin !== undefined)
  if (node === undefined) throw new Error(`no skinned node for mesh ${info.mesh}`)
  const raw = skins[node.skin!].joints.map(j => sanitize(nodes[j].name ?? ''))
  const joints = skins[node.skin!].joints.map(j => canonical(nodes[j].name ?? ''))
  const jointOf = meta.boneNames.map((name, b) => {
    const exact = meta.nodeNames === undefined ? -1 : raw.indexOf(meta.nodeNames[b])
    return exact >= 0 ? exact : joints.indexOf(name)
  })
  const ja = accessor(glb, prim.attributes.JOINTS_0)
  const wa = accessor(glb, prim.attributes.WEIGHTS_0)
  if (ja.count !== info.count || wa.count !== info.count) throw new Error('vertex count mismatch')
  for (let i = 0; i < info.count; i++, row++) {
    let total = 0
    const w = [0, 1, 2, 3].map(k => rows.readFloatLE(row * 32 + 16 + k * 4))
    for (const x of w) total += x
    for (let k = 0; k < 4; k++) {
      const bone = rows.readUInt32LE(row * 32 + k * 4)
      const joint = w[k] > 0 ? jointOf[bone] : 0
      if (joint < 0) throw new Error(`bone ${meta.boneNames[bone]} not in skin`)
      ja.set(i, k, joint)
      wa.set(i, k, w[k] / total)
    }
  }
}
// (bin is a view of the file's bytes: the accessors wrote into them)
writeFileSync(outPath, bytes)
console.log(`applied ${row} vertices`)
