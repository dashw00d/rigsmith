// Export what the weight optimizer needs for one rigged GLB: rest vertices, triangles, current skin,
// and world-space skinning matrices for a set of training poses retargeted from the library.
// node tools/skin_opt/pose_set.ts <rig.glb> <out prefix> [--poses 256] [--exclude id,id] [--seed 1]
//   writes <prefix>.json (layout) and <prefix>.bin (float32 / uint32 arrays, offsets in the json)
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { canonical, captureRest, retarget } from '../../src/engine/retarget.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images') }
console.error = () => {}
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const [rigPath, prefix] = args
const poseCount = Number(flag('--poses') ?? 256)
const holdout = (JSON.parse(readFileSync(path.join(import.meta.dirname, 'holdout.json'), 'utf8')) as { clips: string[] }).clips
const exclude = new Set([...holdout, ...(flag('--exclude') ?? '').split(',').filter(Boolean)])
let seed = Number(flag('--seed') ?? 1)
const random = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 }

const LIBRARY = path.resolve(import.meta.dirname, '../../workspace/library')
async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[], parser?: unknown }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => { new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject) })
}
const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

const manifest = JSON.parse(readFileSync(path.join(LIBRARY, 'manifest.json'), 'utf8')) as { clips: Array<{ id: string, file: string, duplicateOf?: string | null, rig?: string | null, frames?: number }> }
const pool = manifest.clips.filter(c => (c.duplicateOf === null || c.duplicateOf === undefined) && (c.rig === null || c.rig === undefined || c.rig === 'mixamo') && !exclude.has(c.id) && (c.frames ?? 0) > 1)
const picks: string[] = []
const clipCount = Math.ceil(poseCount / 2)
while (picks.length < Math.min(clipCount, pool.length)) {
  const c = pool[Math.floor(random() * pool.length)]
  if (!picks.includes(c.id)) picks.push(c.id)
}

const rig = await load(rigPath) as { scene: THREE.Group, animations: THREE.AnimationClip[], parser: { associations: Map<THREE.Object3D, { meshes?: number, primitives?: number }> } }
rig.scene.updateMatrixWorld(true)
const meshes: THREE.SkinnedMesh[] = []
rig.scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) meshes.push(o as THREE.SkinnedMesh) })
// Global bone list (canonical names) and per-mesh local -> global bone index.
const boneNames: string[] = []
const boneNodes: THREE.Bone[] = []
const maps = meshes.map(m => m.skeleton.bones.map(b => {
  const name = canonical(b.name)
  let i = boneNames.indexOf(name)
  if (i < 0) { i = boneNames.length; boneNames.push(name); boneNodes.push(b) }
  return i
}))
const parents = boneNodes.map(b => (b.parent as THREE.Bone | null)?.isBone === true ? boneNames.indexOf(canonical(b.parent!.name)) : -1)

const rest: number[] = []; const tris: number[] = []; const skinIndex: number[] = []; const skinWeight: number[] = []
const meshInfo: Array<{ name: string, count: number, mesh?: number, primitive?: number }> = []
const v = new THREE.Vector3()
for (const [k, m] of meshes.entries()) {
  const base = rest.length / 3
  const p = m.geometry.attributes.position
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).applyMatrix4(m.matrixWorld); rest.push(v.x, v.y, v.z)
    for (let j = 0; j < 4; j++) { skinIndex.push(maps[k][m.geometry.attributes.skinIndex.getComponent(i, j)]); skinWeight.push(m.geometry.attributes.skinWeight.getComponent(i, j)) }
  }
  const index = m.geometry.index!
  for (let i = 0; i < index.count; i++) tris.push(base + index.getX(i))
  const assoc = rig.parser.associations.get(m)
  meshInfo.push({ name: m.name, count: p.count, mesh: assoc?.meshes, primitive: assoc?.primitives })
}

// World-space skinning matrix per bone: posed_world = S_b * rest_world (same for every mesh bound at rest).
const m0 = meshes[0]
rig.scene.updateMatrixWorld(true)
const restHeads = boneNodes.map(b => b.getWorldPosition(new THREE.Vector3()).toArray())
const target = captureRest(rig.scene, isBone)
const matrices: number[] = []
const S = new THREE.Matrix4()
const bindTo = new THREE.Matrix4().copy(m0.matrixWorld).multiply(m0.bindMatrixInverse)
const fromRest = new THREE.Matrix4().copy(m0.bindMatrix).multiply(new THREE.Matrix4().copy(m0.matrixWorld).invert())
const inverses = boneNodes.map(b => { const k = meshes.findIndex(m => m.skeleton.bones.includes(b)); return meshes[k].skeleton.boneInverses[meshes[k].skeleton.bones.indexOf(b)] })
let poses = 0
for (const id of picks) {
  const clip = await load(path.join(LIBRARY, 'clips', `${id}.glb`))
  const source = captureRest(clip.scene, isBone)
  const baked = retarget(clip.scene, source, clip.animations[0], target, { fps: 30, inPlace: true })
  const mixer = new THREE.AnimationMixer(rig.scene)
  mixer.clipAction(baked).play()
  for (const t of [random(), random()]) {
    if (poses >= poseCount) break
    mixer.setTime(baked.duration * t)
    rig.scene.updateMatrixWorld(true)
    for (let b = 0; b < boneNodes.length; b++) {
      S.copy(bindTo).multiply(boneNodes[b].matrixWorld).multiply(inverses[b]).multiply(fromRest)
      matrices.push(...S.elements) // column-major
    }
    poses++
  }
  mixer.stopAllAction()
  mixer.uncacheRoot(rig.scene)
}

const parts: Array<[string, Float32Array | Uint32Array]> = [
  ['rest', Float32Array.from(rest)], ['tris', Uint32Array.from(tris)], ['skinIndex', Uint32Array.from(skinIndex)],
  ['skinWeight', Float32Array.from(skinWeight)], ['matrices', Float32Array.from(matrices)],
]
const layout: Record<string, { offset: number, length: number, type: string }> = {}
let offset = 0
for (const [name, arr] of parts) { layout[name] = { offset, length: arr.length, type: arr instanceof Float32Array ? 'f4' : 'u4' }; offset += arr.byteLength }
const bin = new Uint8Array(offset)
for (const [name, arr] of parts) bin.set(new Uint8Array(arr.buffer), layout[name].offset)
writeFileSync(prefix + '.bin', bin)
const heads = restHeads
writeFileSync(prefix + '.json', JSON.stringify({ boneNames, parents, heads, meshes: meshInfo, poses, clips: picks, layout }))
console.log(`poses ${poses} bones ${boneNames.length} verts ${rest.length / 3} tris ${tris.length / 3}`)
