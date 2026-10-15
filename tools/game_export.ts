// Export rigged characters as game units, headless: a spec (in the game's repo) names each unit's
// Rigsmith character, its size and budget, and the library clips it plays under the game's clip names.
//
// node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]
//
// Per unit, written:
//   <models dir>/<unit>.glb              the character at its game height, soles at y = 0, facing +Z, a "root"
//                                        bone above Hips, LOD0 within the budget plus <unit>_LOD1/_LOD2, tangents,
//                                        one material "Main" (the game binds its own maps), the clips
//   <work dir>/<unit>/base.*             the character's colour texture (the game's map build reads it)
//   <work dir>/<unit>/rigsmith.json      what went in and what came out (clips, hit times, stride, LODs)
//
// Spec: { "units": { "<unit>": { "character": "<rigsmith id>", "height": 2.0, "budget": 8000,
//   "lods": [0.45, 0.15], "clips": { "<GameName>": { "clip": "<library id>", "loop": true, "inPlace": true,
//   "speed": 1, "attack": true, "hit": 0.45, "hand": "RightHand", "trim": [start s, end s] } } } } }
// An attack clip is cut so its blow (the hand's fastest moment, or `hitAt` seconds) lands at `hit` of its length.
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptSimplifier } from 'meshoptimizer'
import { simplify } from '../src/engine/export/lods.ts'
import { captureRest, retarget } from '../src/engine/retarget.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in node') }
// GLTFExporter reads its binary chunks with a FileReader.
g.FileReader ??= class {
  result: ArrayBuffer | string | null = null
  onloadend: (() => void) | null = null
  readAsArrayBuffer (blob: Blob): void { void blob.arrayBuffer().then(b => { this.result = b; this.onloadend?.() }) }
  readAsDataURL (blob: Blob): void {
    void blob.arrayBuffer().then(b => { this.result = `data:${blob.type};base64,${Buffer.from(b).toString('base64')}`; this.onloadend?.() })
  }
}
const quiet = console.warn
console.warn = (...a: unknown[]) => { if (!String(a[0]).includes('THREE.GLTFLoader')) quiet(...a) }

const ROOT = path.resolve(import.meta.dirname, '..')
const WORKSPACE = path.join(ROOT, 'workspace')

interface ClipSpec { clip: string, loop?: boolean, inPlace?: boolean, speed?: number, attack?: boolean, hit?: number, hitAt?: number, hand?: string, trim?: [number, number] }
interface UnitSpec { character: string, height: number, budget: number, lods?: number[], clips: Record<string, ClipSpec> }

const isBone = (o: THREE.Object3D): boolean => (o as THREE.Bone).isBone === true

async function load (file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  const data = readFileSync(file)
  return await new Promise((resolve, reject) => {
    new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject)
  })
}

/** The first image embedded in a GLB: bytes and extension. */
function embeddedImage (file: string): { bytes: Buffer, ext: string } | null {
  const b = readFileSync(file)
  const jsonLength = b.readUInt32LE(12)
  const json = JSON.parse(b.subarray(20, 20 + jsonLength).toString('utf8')) as {
    images?: Array<{ bufferView?: number, mimeType?: string }>, bufferViews: Array<{ byteOffset?: number, byteLength: number }>
  }
  const image = json.images?.find(i => i.bufferView !== undefined)
  if (image === undefined) return null
  const view = json.bufferViews[image.bufferView!]
  const bin = 20 + jsonLength + 8
  return { bytes: b.subarray(bin + (view.byteOffset ?? 0), bin + (view.byteOffset ?? 0) + view.byteLength), ext: image.mimeType === 'image/jpeg' ? 'jpg' : 'png' }
}

/** World positions of named bones while `clip` plays on `root`, sampled at `rate` Hz. */
function sample (root: THREE.Object3D, clip: THREE.AnimationClip, names: string[], rate = 60): { times: number[], at: Map<string, THREE.Vector3[]> } {
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.play()
  const bones = names.map(n => root.getObjectByName(n)!)
  const at = new Map(names.map(n => [n, [] as THREE.Vector3[]]))
  const times: number[] = []
  for (let t = 0; t <= clip.duration + 1e-6; t += 1 / rate) {
    mixer.setTime(t)
    root.updateMatrixWorld(true)
    times.push(t)
    bones.forEach((b, i) => at.get(names[i])!.push(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)))
  }
  action.stop()
  mixer.uncacheRoot(root)
  return { times, at }
}

/** The blow: when the hand moves fastest, away from the clip's ends (wind-up and recovery) and ignoring
 * one-frame jumps (clips that end on a copy of their first frame snap back on the last step). */
function blowTime (root: THREE.Object3D, clip: THREE.AnimationClip, hand: string): number {
  const { times, at } = sample(root, clip, [hand])
  const p = at.get(hand)!
  const steps = p.slice(1).map((x, i) => x.distanceTo(p[i]))
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length * 0.9)]
  let best = clip.duration * 0.45
  let speed = -1
  for (let i = 1; i < p.length - 1; i++) {
    if (times[i] < clip.duration * 0.05 || times[i] > clip.duration * 0.88) continue
    if (steps[i - 1] > 4 * typical || steps[i] > 4 * typical) continue
    const v = p[i + 1].distanceTo(p[i - 1]) / (times[i + 1] - times[i - 1])
    if (v > speed) { speed = v; best = times[i] }
  }
  return best
}

/** Ground covered per second by a walk at speed 1: the planted (lower) foot's backward speed. */
function stride (root: THREE.Object3D, clip: THREE.AnimationClip): number {
  const feet = ['LeftFoot', 'RightFoot']
  const { times, at } = sample(root, clip, feet)
  const speeds: number[] = []
  for (let i = 1; i < times.length - 1; i++) {
    const foot = at.get('LeftFoot')![i].y <= at.get('RightFoot')![i].y ? 'LeftFoot' : 'RightFoot'
    const p = at.get(foot)!
    const dt = times[i + 1] - times[i - 1]
    speeds.push(Math.hypot(p[i + 1].x - p[i - 1].x, p[i + 1].z - p[i - 1].z) / dt)
  }
  speeds.sort((a, b) => a - b)
  return speeds[Math.floor(speeds.length / 2)]
}

function scalePositions (clip: THREE.AnimationClip, s: number, floor: number, hips: string): THREE.AnimationClip {
  const tracks = clip.tracks.map(t => {
    if (!t.name.endsWith('.position')) return t
    const copy = t.clone()
    const values = copy.values
    const isHips = t.name === `${hips}.position`
    for (let i = 0; i < values.length; i += 3) {
      values[i] *= s
      values[i + 1] = (values[i + 1] - (isHips ? floor : 0)) * s
      values[i + 2] *= s
    }
    return copy
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

function cut (clip: THREE.AnimationClip, start: number, end: number, name: string): THREE.AnimationClip {
  const tracks = clip.tracks.map(t => {
    const copy = t.clone()
    copy.trim(start, end)
    copy.shift(-start)
    return copy
  })
  return new THREE.AnimationClip(name, end - start, tracks)
}

function retime (clip: THREE.AnimationClip, speed: number): THREE.AnimationClip {
  if (speed === 1) return clip
  const tracks = clip.tracks.map(t => { const c = t.clone(); c.times = c.times.map(x => x / speed); return c })
  return new THREE.AnimationClip(clip.name, clip.duration / speed, tracks)
}

function triangles (geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3
}

async function exportUnit (unit: string, spec: UnitSpec, modelsDir: string, workDir: string): Promise<Record<string, unknown>> {
  const characterDir = path.join(WORKSPACE, 'characters', spec.character)
  const character = JSON.parse(readFileSync(path.join(characterDir, 'character.json'), 'utf8')) as { name: string, rigReport?: { method?: string }, files: { rigged?: string } }
  const riggedFile = path.join(characterDir, character.files.rigged ?? 'rigged.glb')
  const { scene } = await load(riggedFile)
  scene.updateMatrixWorld(true)
  const skinned: THREE.SkinnedMesh[] = []
  scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh) })
  if (skinned.length !== 1) throw new Error(`${unit}: expected one skinned mesh, found ${skinned.length}`)
  const source = skinned[0]
  const skeleton = source.skeleton
  const hips = skeleton.bones.find(b => b.name === 'Hips')
  if (hips === undefined) throw new Error(`${unit}: no Hips bone`)
  const hipsParent = hips.parent?.matrixWorld ?? new THREE.Matrix4()
  if (!hipsParent.equals(new THREE.Matrix4())) throw new Error(`${unit}: the skeleton's parent is transformed; not supported`)

  // Size: soles at 0, `height` tall.
  const geometry = source.geometry.clone().applyMatrix4(source.matrixWorld)
  geometry.computeBoundingBox()
  const box = geometry.boundingBox!
  const floor = box.min.y
  const s = spec.height / (box.max.y - box.min.y)

  // Clips, retargeted onto the character as it is (the app's own path), then scaled with it.
  const rest = captureRest(scene, isBone)
  const clips: THREE.AnimationClip[] = []
  const clipReport: Record<string, unknown> = {}
  for (const [name, c] of Object.entries(spec.clips)) {
    const src = await load(path.join(WORKSPACE, 'library', 'clips', `${c.clip}.glb`))
    let hasBones = false
    src.scene.traverse(o => { if (isBone(o)) hasBones = true })
    if (!hasBones) throw new Error(`${unit}: clip ${c.clip} has no skeleton`)
    const sourceRest = captureRest(src.scene, isBone)
    let clip = retarget(src.scene, sourceRest, src.animations[0], rest, { fps: 30, inPlace: c.inPlace === true })
    clip = retime(scalePositions(clip, s, floor, 'Hips'), c.speed ?? 1)
    clip.name = name
    if (c.trim !== undefined) clip = cut(clip, c.trim[0], Math.min(c.trim[1], clip.duration), name)
    clips.push(clip)
    clipReport[name] = { clip: c.clip, loop: c.loop === true, inPlace: c.inPlace === true, seconds: +clip.duration.toFixed(3) }
  }

  // The game unit: root bone above Hips, the mesh baked to world, scaled, grounded.
  const out = new THREE.Group()
  out.name = 'Armature'
  const root = new THREE.Bone()
  root.name = 'root'
  out.add(root)
  const p = new THREE.Vector3(); const q = new THREE.Quaternion(); const sc = new THREE.Vector3()
  hips.matrixWorld.decompose(p, q, sc)
  root.add(hips)
  hips.position.set(p.x * s, (p.y - floor) * s, p.z * s)
  hips.quaternion.copy(q)
  hips.scale.set(1, 1, 1)
  hips.traverse(b => { if (b !== hips) b.position.multiplyScalar(s) })
  out.updateMatrixWorld(true)
  const bones = [...skeleton.bones, root]
  const material = new THREE.MeshStandardMaterial({ name: 'Main' })
  geometry.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0)))
  for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) geometry.deleteAttribute(name)

  await MeshoptSimplifier.ready
  const tris0 = triangles(geometry)
  const lod0 = tris0 > spec.budget ? simplify(geometry, spec.budget / tris0 * 0.99) : geometry
  const levels = [lod0, ...(spec.lods ?? [0.45, 0.15]).map(r => simplify(lod0, r))]
  const lodReport: number[] = []
  const meshes: THREE.SkinnedMesh[] = []
  levels.forEach((geo, i) => {
    geo.computeTangents()
    const mesh = new THREE.SkinnedMesh(geo, material)
    mesh.name = i === 0 ? unit : `${unit}_LOD${i}`
    out.add(mesh)
    meshes.push(mesh)
    lodReport.push(triangles(geo))
  })
  const exportSkeleton = new THREE.Skeleton(bones)
  for (const mesh of meshes) mesh.bind(exportSkeleton)

  // Attack: the blow at `hit` of the clip. Stride from the walk.
  for (const [name, c] of Object.entries(spec.clips)) {
    const i = clips.findIndex(x => x.name === name)
    if (c.attack === true) {
      const clip = clips[i]
      const blow = c.hitAt ?? blowTime(out, clip, c.hand ?? 'RightHand')
      const want = c.hit ?? 0.45
      let start = 0; let end = clip.duration
      if (blow / clip.duration < want) end = Math.min(clip.duration, blow / want)
      else start = Math.max(0, (blow - want * end) / (1 - want))
      clips[i] = cut(clip, start, end, name)
      Object.assign(clipReport[name] as object, { blow: +blow.toFixed(3), kept: [+start.toFixed(3), +end.toFixed(3)], seconds: +(end - start).toFixed(3), hit: want })
    }
  }
  const walk = clips.find(c => c.name === 'Walk')
  const walkStride = walk !== undefined ? stride(out, walk) : null

  // Back to the bind pose for export (sampling moved the bones).
  exportSkeleton.pose()

  const result = await new GLTFExporter().parseAsync(out, { binary: true, animations: clips, onlyVisible: false }) as ArrayBuffer
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(path.join(modelsDir, `${unit}.glb`), Buffer.from(result))

  const srcDir = path.join(workDir, unit)
  mkdirSync(srcDir, { recursive: true })
  const image = embeddedImage(riggedFile)
  if (image !== null) writeFileSync(path.join(srcDir, `base.${image.ext}`), image.bytes)
  let commit = 'unknown'
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() } catch {}
  const report = {
    unit,
    generator: 'rigsmith tools/game_export.ts',
    rigsmith: { commit, character: spec.character, name: character.name, rig: character.rigReport?.method ?? null },
    height: spec.height,
    scale: +s.toFixed(5),
    bones: bones.length,
    triangles: { source: tris0, budget: spec.budget, lods: lodReport },
    clips: clipReport,
    walkStride: walkStride === null ? null : +walkStride.toFixed(3),
    texture: image === null ? null : { file: `base.${image.ext}`, sha256: createHash('sha256').update(image.bytes).digest('hex') },
    rigged: { file: path.relative(WORKSPACE, riggedFile), sha256: createHash('sha256').update(readFileSync(riggedFile)).digest('hex') },
  }
  writeFileSync(path.join(srcDir, 'rigsmith.json'), JSON.stringify(report, null, 1) + '\n')
  return report
}

const [specFile, modelsDir, workDir, ...only] = process.argv.slice(2)
if (specFile === undefined || modelsDir === undefined || workDir === undefined) {
  console.error('usage: node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]')
  process.exit(2)
}
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as { defaults?: Partial<UnitSpec>, units: Record<string, UnitSpec> }
for (const [unit, unitSpec] of Object.entries(spec.units)) {
  if (only.length > 0 && !only.includes(unit)) continue
  const merged = { ...spec.defaults, ...unitSpec } as UnitSpec
  const report = await exportUnit(unit, merged, modelsDir, workDir)
  console.log(JSON.stringify({ unit, triangles: report.triangles, walkStride: report.walkStride, clips: report.clips }))
}
