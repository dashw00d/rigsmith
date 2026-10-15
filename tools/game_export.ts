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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptSimplifier } from 'meshoptimizer'
import { compact, simplify } from '../src/engine/export/lods.ts'
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

interface ClipSpec { clip: string, loop?: boolean, inPlace?: boolean, speed?: number, attack?: boolean, hit?: number, hitAt?: number, hand?: string, trim?: [number, number], window?: number
  /** Retime to cover ground at that clip's pace (the game plays Carry at the Walk's stride). */
  matchStride?: string
}
interface UnitSpec {
  character: string, height: number, budget: number, lods?: number[], clips: Record<string, ClipSpec>
  /** Split the body's own head off as its own mesh (a swappable head: the game picks one Head* per unit). */
  head?: { name: string, above?: number }
  /** Where this one's .glb goes instead of <models dir> (relative to the spec's repo: a source, not a unit). */
  models_dir?: string
  /** Hands that hold something in every clip (a second axe, a staff through a casting clip): side -> the library
   * clip whose most closed fist that hand keeps throughout (its fingers' rotations, held in every clip). */
  grip?: Partial<Record<'Left' | 'Right', string>>
}

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
    materials?: Array<{ pbrMetallicRoughness?: { baseColorTexture?: { index: number } } }>, textures?: Array<{ source?: number }>
  }
  // The base colour's image (a source with normal / roughness maps embeds those too).
  const texture = json.materials?.find(m => m.pbrMetallicRoughness?.baseColorTexture !== undefined)?.pbrMetallicRoughness?.baseColorTexture?.index
  const source = texture !== undefined ? json.textures?.[texture]?.source : undefined
  const image = source !== undefined ? json.images?.[source] : json.images?.find(i => i.bufferView !== undefined)
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

// What a game clip must look like, by its name: locomotion steps, standing clips stand. Library names can mislead
// ("Carrying" was "Carrying Someone Idle", "Talking" "Talking While Seated"), so the export checks the motion itself.
const STEPS = new Set(['Walk', 'Carry', 'Run'])
// The library audit (tools/library_audit.py): clips whose motion contradicts their library name, by id.
const AUDIT_FILE = path.join(WORKSPACE, 'library', 'audit.json')
const AUDIT = existsSync(AUDIT_FILE)
  ? (JSON.parse(readFileSync(AUDIT_FILE, 'utf8')) as { clips: Record<string, { name: string, problems: Array<{ rule: string, motion: string }> }> }).clips
  : {}
const STANDS = new Set(['Idle', 'Trade', 'Hunt'])

/** Refuses a clip that doesn't move as its game name says: a walk whose feet don't swing, a standing clip whose hips
 * sink (a seated or crouched clip). */
function checkClip (root: THREE.Object3D, clip: THREE.AnimationClip, height: number): Record<string, number> {
  const { at } = sample(root, clip, ['LeftFoot', 'RightFoot', 'Hips'], 15)
  const swing = (n: string): number => {
    const z = at.get(n)!.map(v => v.z)
    return Math.max(...z) - Math.min(...z)
  }
  const hips = at.get('Hips')!.map(v => v.y).sort((a, b) => a - b)
  const stats = { footSwing: +(Math.min(swing('LeftFoot'), swing('RightFoot')) / height).toFixed(3), hipsMedian: +(hips[Math.floor(hips.length / 2)] / height).toFixed(3) }
  if (STEPS.has(clip.name) && stats.footSwing < 0.12) throw new Error(`clip ${clip.name}: the feet swing ${stats.footSwing} x height: it doesn't walk (an idle under a walking name?)`)
  return stats
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
    const flagged = AUDIT[c.clip]
    if (flagged !== undefined) {
      for (const p of flagged.problems) console.warn(`warning: ${unit} ${name}: library clip ${c.clip} "${flagged.name}" ${p.rule} ${p.motion}`)
      Object.assign(clipReport[name] as object, { audit: flagged.problems.map(p => `${p.rule} ${p.motion}`) })
    }
  }

  // Held fists: a hand that holds something all the time keeps its fingers closed in every clip, as the grip
  // clip closes them most (finger rotations are relative to the hand, so they carry over to any clip).
  const gripReport: Record<string, unknown> = {}
  for (const [side, src] of Object.entries(spec.grip ?? {})) {
    const g = await load(path.join(WORKSPACE, 'library', 'clips', `${src}.glb`))
    const gClip = retarget(g.scene, captureRest(g.scene, isBone), g.animations[0], rest, { fps: 30, inPlace: true })
    const fingers: string[] = []
    scene.traverse(o => { if (isBone(o) && new RegExp(`^${side}Hand(Thumb|Index|Middle|Ring|Pinky)\\d$`).test(o.name)) fingers.push(o.name) })
    const chains = ['Index', 'Middle', 'Ring', 'Pinky'].map(f => [1, 2, 3, 4].map(i => `${side}Hand${f}${i}`).filter(n => fingers.includes(n)))
    const { times, at } = sample(scene, gClip, chains.flat(), 30)
    let best = 0; let curl = -1
    times.forEach((_, i) => {
      const c = chains.reduce((sum, ch) => {
        const pts = ch.map(n => at.get(n)![i])
        const len = pts.slice(1).reduce((d, x, k) => d + x.distanceTo(pts[k]), 0)
        return sum + 1 - pts[0].distanceTo(pts[pts.length - 1]) / Math.max(len, 1e-6)
      }, 0) / chains.length
      if (c > curl) { curl = c; best = times[i] }
    })
    const mixer = new THREE.AnimationMixer(scene)
    mixer.clipAction(gClip).play()
    mixer.setTime(best)
    const held = new Map(fingers.map(n => [n, scene.getObjectByName(n)!.quaternion.clone()]))
    mixer.stopAllAction()
    mixer.uncacheRoot(scene)
    for (let k = 0; k < clips.length; k++) {
      const c = clips[k]
      const tracks = c.tracks.filter(t => !held.has(t.name.replace(/\.quaternion$/, '')))
      for (const [n, q] of held) tracks.push(new THREE.QuaternionKeyframeTrack(`${n}.quaternion`, [0, c.duration], [...q.toArray(), ...q.toArray()]))
      clips[k] = new THREE.AnimationClip(c.name, c.duration, tracks)
    }
    gripReport[side] = { clip: src, at: +best.toFixed(3), curl: +(curl / 0.45).toFixed(2) }
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
  // Parts built for this rig elsewhere (the game's weapons: <work dir>/<unit>/parts.glb, one mesh per bone, in game
  // space) ride their bone rigidly; the body gives up their share of the budget.
  const srcDir = path.join(workDir, unit)
  const partsFile = path.join(srcDir, 'parts.glb')
  const parts: Array<{ bone: string, geometry: THREE.BufferGeometry, material: THREE.Material, name: string }> = []
  if (existsSync(partsFile)) {
    const { scene: partScene } = await load(partsFile)
    partScene.updateMatrixWorld(true)
    partScene.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const bone = String(m.userData.bone ?? m.name.replace(/^[^.]*\./, ''))
      const index = bones.findIndex(b => b.name === bone)
      if (index < 0) throw new Error(`${unit}: part ${m.name} wants bone ${bone}, not in the skeleton`)
      const geo = m.geometry.clone().applyMatrix4(m.matrixWorld)
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
      const n = geo.attributes.position.count
      const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) { si[i * 4] = index; sw[i * 4] = 1 }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
      const loaded = Array.isArray(m.material) ? m.material[0] : m.material
      // (a part on the body's own surface shares its material: one "Main" in the file)
      const partMaterial = /^Main(\.\d+)?$/.test(loaded.name) ? material : loaded
      parts.push({
        bone, geometry: geo, material: partMaterial, name: String(m.userData.part ?? m.name.split('.')[0]),
        exact: m.userData.name !== undefined ? String(m.userData.name) : undefined,
        lod: m.userData.lod !== undefined ? Number(m.userData.lod) : undefined,
        budget: m.userData.budget !== false,
      })
    })
  }
  // (parts with their own budget, the villager's gear and spare heads, don't eat into the body's)
  const partTris = parts.reduce((t, x) => t + (x.budget && (x.lod ?? 0) === 0 ? triangles(x.geometry) : 0), 0)
  const bodyBudget = spec.budget - partTris
  const tris0 = triangles(geometry)
  const lod0 = tris0 > bodyBudget ? simplify(geometry, bodyBudget / tris0 * 0.99) : geometry
  const meshes: THREE.SkinnedMesh[] = []
  const lodReport: number[] = []
  const addLevels = (base: string, geo0: THREE.BufferGeometry, mat: THREE.Material, report: number[]): void => {
    const geos = triangles(geo0) <= 60 ? [geo0] : [geo0, ...(spec.lods ?? [0.45, 0.15]).map(r => simplify(geo0, r))]
    geos.forEach((geo, i) => {
      if (geo.attributes.uv !== undefined && geo.index !== null) geo.computeTangents()
      const mesh = new THREE.SkinnedMesh(geo, mat)
      mesh.name = i === 0 ? base : `${base}_LOD${i}`
      out.add(mesh)
      meshes.push(mesh)
      report.push(triangles(geo))
    })
  }
  // The body's own head, split off at `above` x height over the Neck joint (by face centre).
  const headReport: number[] = []
  if (spec.head !== undefined) {
    const neck = bones.find(b => b.name === 'Neck')!
    const cutY = new THREE.Vector3().setFromMatrixPosition(neck.matrixWorld).y + (spec.head.above ?? 0.02) * spec.height
    const pos = lod0.attributes.position
    const index = lod0.index!
    const head: number[] = []; const body: number[] = []
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t); const b = index.getX(t + 1); const c = index.getX(t + 2)
      const y = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3
      ;(y > cutY ? head : body).push(a, b, c)
    }
    addLevels(unit, compact(lod0, Uint32Array.from(body)), material, lodReport)
    addLevels(spec.head.name, compact(lod0, Uint32Array.from(head)), material, headReport)
  } else {
    addLevels(unit, lod0, material, lodReport)
  }
  const partReport: Record<string, number[]> = {}
  for (const part of parts) {
    if (part.lod !== undefined) {
      // authored levels (the villager's gear and heads): kept as they come, by name
      if (part.geometry.attributes.uv !== undefined && part.geometry.index !== null) part.geometry.computeTangents()
      const mesh = new THREE.SkinnedMesh(part.geometry, part.material)
      mesh.name = part.exact ?? part.name
      out.add(mesh)
      meshes.push(mesh)
      const base = mesh.name.replace(/_LOD\d+$/, '')
      ;(partReport[base] ??= [])[part.lod] = triangles(part.geometry)
      continue
    }
    const base = part.exact ?? `${part.name}_${part.bone}`
    addLevels(base, part.geometry, part.material, (partReport[base] = []))
  }
  const exportSkeleton = new THREE.Skeleton(bones)
  for (const mesh of meshes) mesh.bind(exportSkeleton)

  // The rest skeleton in game space, for builds that fit parts to this rig: every joint, and each hand's grip
  // (the closed fist's centre: most of the way from the wrist to the middle knuckle).
  const joint = (name: string): THREE.Vector3 | null => {
    const b = bones.find(x => x.name === name)
    return b === undefined ? null : new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
  }
  const skeletonOut: Record<string, number[]> = {}
  for (const b of bones) skeletonOut[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray().map(x => +x.toFixed(5))
  for (const side of ['Left', 'Right']) {
    const hand = joint(`${side}Hand`); const knuckle = joint(`${side}HandMiddle1`); const fore = joint(`${side}ForeArm`)
    if (hand === null || fore === null) continue
    const grip = knuckle !== null ? hand.clone().lerp(knuckle, 0.75) : hand.clone().addScaledVector(hand.clone().sub(fore).normalize(), 0.08 * spec.height)
    skeletonOut[`grip.${side === 'Left' ? 'L' : 'R'}`] = grip.toArray().map(x => +x.toFixed(5))
  }
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(path.join(srcDir, 'skeleton.json'), JSON.stringify({ space: 'glTF (Y up, facing +Z), metres', height: spec.height, joints: skeletonOut }, null, 1) + '\n')

  // Attack: the blow at `hit` of the clip. Stride from the walk.
  for (const [name, c] of Object.entries(spec.clips)) {
    const i = clips.findIndex(x => x.name === name)
    if (c.attack === true) {
      const clip = clips[i]
      const blow = c.hitAt ?? blowTime(out, clip, c.hand ?? 'RightHand')
      const want = c.hit ?? 0.45
      let start = 0; let end = clip.duration
      if (c.window !== undefined) {
        // a window of its own length around the blow (cut from a longer working clip: the villager's dig)
        start = Math.max(0, blow - want * c.window)
        end = Math.min(clip.duration, start + c.window)
      } else if (blow / clip.duration < want) end = Math.min(clip.duration, blow / want)
      else start = Math.max(0, (blow - want * end) / (1 - want))
      clips[i] = cut(clip, start, end, name)
      Object.assign(clipReport[name] as object, { blow: +blow.toFixed(3), kept: [+start.toFixed(3), +end.toFixed(3)], seconds: +(end - start).toFixed(3), hit: want })
    }
  }
  const walk = clips.find(c => c.name === 'Walk')
  const walkStride = walk !== undefined ? stride(out, walk) : null
  for (const [name, c] of Object.entries(spec.clips)) {
    const i = clips.findIndex(x => x.name === name)
    const pace = c.matchStride !== undefined ? clips.find(x => x.name === c.matchStride) : undefined
    if (pace === undefined) continue
    const want = stride(out, pace); const have = stride(out, clips[i])
    clips[i] = retime(clips[i], want / have)
    clips[i].name = name
    Object.assign(clipReport[name] as object, { matchStride: c.matchStride, retimed: +(want / have).toFixed(3), seconds: +clips[i].duration.toFixed(3) })
  }
  // every clip checked against its game name; standing clips against the rest pose's hips
  exportSkeleton.pose()
  out.updateMatrixWorld(true)
  const restHips = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld).y / spec.height
  for (const clip of clips) {
    const stats = checkClip(out, clip, spec.height)
    if (STANDS.has(clip.name) && stats.hipsMedian < 0.8 * restHips) {
      throw new Error(`${unit}: clip ${clip.name}: the hips sit at ${stats.hipsMedian} x height (rest ${restHips.toFixed(3)}): not standing (a seated clip?)`)
    }
    Object.assign(clipReport[clip.name] as object, stats)
  }

  // Back to the bind pose for export (sampling moved the bones).
  exportSkeleton.pose()

  const result = await new GLTFExporter().parseAsync(out, { binary: true, animations: clips, onlyVisible: false }) as ArrayBuffer
  mkdirSync(modelsDir, { recursive: true })
  writeFileSync(path.join(modelsDir, `${unit}.glb`), Buffer.from(result))

  const image = embeddedImage(riggedFile)
  if (image !== null) writeFileSync(path.join(srcDir, `base.${image.ext}`), image.bytes)
  let commit = 'unknown'
  try { commit = execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim() } catch { /* not a git checkout */ }
  const report = {
    unit,
    generator: 'rigsmith tools/game_export.ts',
    rigsmith: { commit, character: spec.character, name: character.name, rig: character.rigReport?.method ?? null },
    height: spec.height,
    scale: +s.toFixed(5),
    bones: bones.length,
    triangles: { source: tris0, budget: spec.budget, lods: lodReport, head: headReport.length > 0 ? headReport : undefined, parts: partReport },
    clips: clipReport,
    grip: gripReport,
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
  const repo = path.resolve(path.dirname(specFile), '..', '..')
  const report = await exportUnit(unit, merged, merged.models_dir !== undefined ? path.join(repo, merged.models_dir) : modelsDir, workDir)
  console.log(JSON.stringify({ unit, triangles: report.triangles, walkStride: report.walkStride, clips: report.clips }))
}
