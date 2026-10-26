// Export rigged characters as game units, headless. A spec in the game's repo names each unit's Rigsmith character, its
// size and budget, and the clip names the game plays; everything a unit plays and carries comes from the character as
// it is in Rigsmith, so the game gets what Rigsmith shows:
//   clips     the character's animation set, by the game's names (its clip, loop, in place, speed)
//   scripts   the character's enabled clip scripts (src/engine/scripts.ts: a fist held, an attack's blow timed, a
//             walk paced), applied exactly as the viewer applies them
//   gear      its rigid garments (weapons, shields, quivers, the villager's tools, heads and wear) placed exactly as
//             there, riding their bones
//
// node tools/game_export.ts <spec.json> <models dir> <work dir> [unit ...]
//
// Per unit, written:
//   <models dir>/<unit>.glb              the character at its game height, soles at y = 0, facing +Z, a "root"
//                                        bone above Hips, LOD0 within the budget plus <unit>_LOD1/_LOD2, tangents,
//                                        one material "Main" (the game binds its own maps), its gear, the clips
//   <work dir>/<unit>/base.*             the character's colour texture (the game's map build reads it)
//   <work dir>/<unit>/rigsmith.json      what went in and what came out (clips, scripts, gear, stride, LODs)
//
// Spec: { "units": { "<unit>": { "character": "<rigsmith id>", "height": 2.0, "budget": 8000, "lods": [0.45, 0.15],
//   "clips": ["Idle", "Walk", "Run", "Attack", "Die"] } } }: every name must be in the character's set.
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptSimplifier } from 'meshoptimizer'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { compact, simplify } from '../src/engine/export/lods.ts'
import { garmentMatrix } from '../src/engine/placement.ts'
import { captureRest, pelvisName, retarget } from '../src/engine/retarget.ts'
import { applyScripts, retime, sample, stride, type ClipScript } from '../src/engine/scripts.ts'
import { applyBoneKeys, applyLift, propTracks } from '../src/engine/keys.ts'
import type { AnimationEntry, Garment } from '../server/workspace.ts'

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

interface UnitSpec {
  character: string, height: number, budget: number, lods?: number[]
  /** The clips the game plays: each a name in the character's animation set. */
  clips: string[]
  /** Split the body's own head off as its own mesh (a swappable head: the game picks one Head* per unit). */
  head?: { name: string, above?: number }
  /** Where this one's .glb goes instead of <models dir> (relative to the spec's repo: a source, not a unit). */
  models_dir?: string
  /** A second character in the same unit (the caravan's pony beside its trader): its own skeleton under the
   * unit's root, its own surface, its clips (its own set's, by the unit's names; a name it lacks plays its Idle)
   * fitted to the unit's. */
  companion?: CompanionSpec
}
interface CompanionSpec {
  character: string
  /** Its height in game units (soles at 0). */
  height: number
  /** Its bones' prefix: they share the unit's skeleton, under root. */
  prefix: string
  /** Where it stands from the unit's origin (game x, z) and which way it faces (degrees about +Y, 0 = +Z). */
  at?: [number, number]
  yaw?: number
  budget: number
  /** Its surface, "Atlas_<material>": the game draws it from textures/models/<material>. */
  material: string
  /** The feet whose planted one paces its walk (default: a horse's four). */
  feet?: string[]
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

// What a game clip must look like, by its name: locomotion steps, standing clips stand. Library names can mislead
// ("Carrying" was "Carrying Someone Idle", "Talking" "Talking While Seated"), so the export checks the motion itself.
const STEPS = new Set(['Walk', 'Carry', 'Run'])
// The library audit (tools/library_audit.py): clips whose motion contradicts their library name, by id.
const AUDIT_FILE = path.join(WORKSPACE, 'library', 'audit.json')
const AUDIT = existsSync(AUDIT_FILE)
  ? (JSON.parse(readFileSync(AUDIT_FILE, 'utf8')) as { clips: Record<string, { name: string, problems: Array<{ rule: string, motion: string }> }> }).clips
  : {}
const STANDS = new Set(['Idle', 'Trade', 'Hunt'])
// Parts the game shows by job or look (the villager's tools and loads, spare heads, job wear): exported even while
// hidden in Rigsmith, and outside the body's triangle budget.
const SWAPPED = /^(Gear|Head|Wear)/

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

/** The clip played `times` times over (keys shifted a cycle each time; a key a cycle repeats is kept once). */
function repeat (clip: THREE.AnimationClip, times: number): THREE.AnimationClip {
  if (times === 1) return clip
  const T = clip.duration
  const tracks = clip.tracks.map(t => {
    const size = t.getValueSize()
    const keys: number[] = []; const values: number[] = []
    for (let r = 0; r < times; r++) {
      for (let i = 0; i < t.times.length; i++) {
        const at = t.times[i] + r * T
        if (keys.length > 0 && at <= keys[keys.length - 1] + 1e-6) continue
        keys.push(at)
        for (let j = 0; j < size; j++) values.push(t.values[i * size + j])
      }
    }
    const Track = t.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack
    return new Track(t.name, keys, values)
  })
  return new THREE.AnimationClip(clip.name, T * times, tracks)
}

/** Where an entry's clip comes from: a converted library clip, or one bundled with the app (url /animations/<file>#<name>). */
async function entrySource (entry: { clipId: string, url?: string }): Promise<{ scene: THREE.Group, clip: THREE.AnimationClip }> {
  if (entry.url !== undefined) {
    const [file, hash] = entry.url.split('#')
    if (!file.startsWith('/animations/')) throw new Error(`clip ${entry.clipId}: ${entry.url} is not a clip bundled with Rigsmith`)
    const src = await load(path.join(ROOT, 'static', file))
    const name = hash === undefined ? undefined : decodeURIComponent(hash)
    const clip = name === undefined ? src.animations[0] : src.animations.find(a => a.name === name)
    if (clip === undefined) throw new Error(`clip ${entry.clipId}: no ${name} in ${file}`)
    return { scene: src.scene, clip }
  }
  const file = path.join(WORKSPACE, 'library', 'clips', `${entry.clipId}.glb`)
  if (!existsSync(file)) throw new Error(`clip ${entry.clipId}: not in the library`)
  const src = await load(file)
  return { scene: src.scene, clip: src.animations[0] }
}

/** A companion character, its clips retargeted onto it and scaled to its height (placed later, under the root). */
async function loadCompanion (unit: string, c: CompanionSpec, names: string[]): Promise<{ mesh: THREE.SkinnedMesh, top: THREE.Bone, geometry: THREE.BufferGeometry, floor: number, s: number, clips: Map<string, THREE.AnimationClip>, entries: Map<string, AnimationEntry>, file: string }> {
  const dir = path.join(WORKSPACE, 'characters', c.character)
  const info = JSON.parse(readFileSync(path.join(dir, 'character.json'), 'utf8')) as { files: { rigged?: string }, animations: AnimationEntry[] }
  const file = path.join(dir, info.files.rigged ?? 'rigged.glb')
  const { scene } = await load(file)
  scene.updateMatrixWorld(true)
  const skinned: THREE.SkinnedMesh[] = []
  scene.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh) })
  if (skinned.length !== 1) throw new Error(`${unit}: companion ${c.character}: expected one skinned mesh, found ${skinned.length}`)
  const mesh = skinned[0]
  const rest = captureRest(scene, isBone)
  // its top bone carries it (a creature rig's own root above the pelvis, or the pelvis): every bone hangs from it
  const tops = mesh.skeleton.bones.filter(b => !isBone(b.parent ?? new THREE.Object3D()))
  if (tops.length !== 1) throw new Error(`${unit}: companion ${c.character}: ${tops.length} top bones (${tops.map(b => b.name).join(', ')})`)
  const top = tops[0]
  if (!mesh.skeleton.bones.some(b => b.name === pelvisName(rest))) throw new Error(`${unit}: companion ${c.character}: no pelvis`)
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  geometry.computeBoundingBox()
  const floor = geometry.boundingBox!.min.y
  const s = c.height / (geometry.boundingBox!.max.y - floor)
  const clips = new Map<string, THREE.AnimationClip>()
  const entries = new Map<string, AnimationEntry>()
  for (const name of names) {
    const entry = info.animations.find(a => a.name === name)
    if (entry === undefined) continue
    const src = await entrySource(entry)
    let clip = retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: true })
    clip = retime(scalePositions(clip, s, floor, top.name), entry.speed)
    clip.name = name
    clips.set(name, clip)
    entries.set(name, entry)
  }
  return { mesh, top, geometry, floor, s, clips, entries, file }
}

function triangles (geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3
}

async function exportUnit (unit: string, spec: UnitSpec, modelsDir: string, workDir: string): Promise<Record<string, unknown>> {
  const characterDir = path.join(WORKSPACE, 'characters', spec.character)
  const character = JSON.parse(readFileSync(path.join(characterDir, 'character.json'), 'utf8')) as {
    name: string, rigReport?: { method?: string }, files: { rigged?: string }, animations: AnimationEntry[], scripts?: ClipScript[], garments?: Garment[], props?: Array<{ name: string }>
  }
  if (!Array.isArray(spec.clips)) throw new Error(`${unit}: the spec's clips are the game's clip names (["Idle", "Walk", ...]); what plays under each is the character's set in Rigsmith`)
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

  // Clips: the character's set, by the game's names, retargeted onto it as it is (the app's own path), then scaled with
  // it and played at its entry's speed (the viewer's order: speed, then the scripts, below).
  const rest = captureRest(scene, isBone)
  const clips: THREE.AnimationClip[] = []
  const clipReport: Record<string, unknown> = {}
  const missing = spec.clips.filter(n => !character.animations.some(a => a.name === n))
  if (missing.length > 0) throw new Error(`${unit}: ${character.name} in Rigsmith has no clip named ${missing.join(', ')} (its set: ${character.animations.map(a => a.name).join(', ')})`)
  for (const name of spec.clips) {
    const entry = character.animations.find(a => a.name === name)!
    const src = await entrySource(entry)
    let hasBones = false
    src.scene.traverse(o => { if (isBone(o)) hasBones = true })
    if (!hasBones) throw new Error(`${unit}: clip ${entry.clipId} has no skeleton`)
    let clip = retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: entry.inPlace })
    clip = retime(scalePositions(clip, s, floor, 'Hips'), entry.speed)
    clip.name = name
    clips.push(clip)
    clipReport[name] = { clip: entry.clipId, url: entry.url, loop: entry.loop, inPlace: entry.inPlace, speed: entry.speed, seconds: +clip.duration.toFixed(3) }
    const flagged = AUDIT[entry.clipId]
    if (flagged !== undefined) {
      for (const p of flagged.problems) console.warn(`warning: ${unit} ${name}: library clip ${entry.clipId} "${flagged.name}" ${p.rule} ${p.motion}`)
      Object.assign(clipReport[name] as object, { audit: flagged.problems.map(p => `${p.rule} ${p.motion}`) })
    }
  }
  const scripts = character.scripts ?? []
  if (spec.clips.includes('Attack') && !scripts.some(x => x.enabled && x.kind === 'blow' && x.clip === 'Attack')) {
    console.warn(`warning: ${unit}: no blow timing on its Attack: the game lands each hit at 45 % of the clip`)
  }

  const comp = spec.companion !== undefined ? await loadCompanion(unit, spec.companion, spec.clips) : null

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
  // The companion beside it: its top bone under the root too, placed (scaled to its height, turned, moved to `at`);
  // its bones and clip tracks take its prefix, its top bone's own keys the same placing.
  const compBones: THREE.Bone[] = []
  let place = new THREE.Matrix4()
  if (comp !== null) {
    const c = spec.companion!
    const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(c.yaw ?? 0))
    const at = new THREE.Vector3(c.at?.[0] ?? 0, 0, c.at?.[1] ?? 0)
    place = new THREE.Matrix4().compose(at, qYaw, new THREE.Vector3(1, 1, 1))
      .multiply(new THREE.Matrix4().makeScale(comp.s, comp.s, comp.s)).multiply(new THREE.Matrix4().makeTranslation(0, -comp.floor, 0))
    const p2 = new THREE.Vector3(); const q2 = new THREE.Quaternion(); const s2 = new THREE.Vector3()
    comp.top.matrixWorld.decompose(p2, q2, s2)
    root.add(comp.top)
    comp.top.position.copy(p2.applyMatrix4(place))
    comp.top.quaternion.copy(qYaw.clone().multiply(q2))
    comp.top.scale.set(1, 1, 1)
    comp.top.traverse(b => { if (b !== comp.top) b.position.multiplyScalar(comp.s) })
    const topName = comp.top.name
    compBones.push(...comp.mesh.skeleton.bones)
    for (const b of compBones) b.name = c.prefix + b.name
    for (const [name, clip] of comp.clips) {
      const tracks = clip.tracks.map(t => {
        const copy = t.clone()
        const dot = t.name.lastIndexOf('.')
        const bone = t.name.slice(0, dot); const prop = t.name.slice(dot + 1)
        copy.name = `${c.prefix}${bone}.${prop}`
        if (bone === topName && prop === 'position') {
          const v = new THREE.Vector3()
          for (let i = 0; i < copy.values.length; i += 3) v.fromArray(copy.values, i).applyQuaternion(qYaw).add(at).toArray(copy.values, i)
        }
        if (bone === topName && prop === 'quaternion') {
          const q = new THREE.Quaternion()
          for (let i = 0; i < copy.values.length; i += 4) q.fromArray(copy.values, i).premultiply(qYaw).toArray(copy.values, i)
        }
        return copy
      })
      comp.clips.set(name, new THREE.AnimationClip(name, clip.duration, tracks))
    }
  }
  out.updateMatrixWorld(true)
  const bones = [...skeleton.bones, root, ...compBones]
  // each bone's rest (game space): a clip's key on a bone the clip doesn't move starts from there
  const restLocal = new Map(bones.map(b => [b.name, { q: b.quaternion.clone(), p: b.position.clone() }]))
  // a prop keyed in any clip rides its own bone ("Prop_<name>", at its pivot under the bone it rides), which the clips move
  const keyedProps = new Set(spec.clips.flatMap(n => Object.keys(character.animations.find(a => a.name === n)?.keys?.props ?? {})))
  const propBones: Array<{ bone: THREE.Bone, garment: Garment, rest: { position: THREE.Vector3, quaternion: THREE.Quaternion } }> = []
  const material = new THREE.MeshStandardMaterial({ name: 'Main' })
  geometry.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0)))
  for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) geometry.deleteAttribute(name)

  await MeshoptSimplifier.ready
  // Its gear: the character's rigid garments in Rigsmith (weapons, shields, quivers, the villager's tools, heads and
  // wear), each placed exactly as there (garmentMatrix: the character's rest space), then into game space with the body,
  // riding its bone rigidly. A hidden one stays out, except the pieces the game itself shows by job (Gear*, Head*,
  // Wear*); only parts the game built go in (from "emberhold:...": AGENTS.md, every model starts in Blender). A part
  // with one surface gets levels like the body; one with several (a wear piece on two trim sheets) is one mesh, one level.
  const srcDir = path.join(workDir, unit)
  const toGame = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0))
  const parts: Array<{ bone: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string, budget: boolean }> = []
  const gearReport: Record<string, unknown> = {}
  for (const g of character.garments ?? []) {
    const left = g.status !== 'ready' || g.file === undefined ? 'not ready'
      : g.mode !== 'rigid' ? 'a clothing garment (only rigid ones are exported)'
        : g.hidden === true && !SWAPPED.test(g.name) ? 'hidden'
          : !(g.from ?? '').startsWith('emberhold:') ? 'not a part the game built (AGENTS.md: every model starts in Blender)' : null
    if (left !== null) {
      if (left !== 'hidden') console.warn(`warning: ${unit}: ${g.name} left out: ${left}`)
      gearReport[g.name] = { left }
      continue
    }
    const index = bones.findIndex(b => b.name === g.bone)
    if (index < 0) throw new Error(`${unit}: ${g.name} rides ${g.bone}, not in the skeleton`)
    let ride = index
    if (keyedProps.has(g.name)) {
      const parent = bones[index]
      const gp = new THREE.Vector3(); const gq = new THREE.Quaternion(); const gsc = new THREE.Vector3()
      garmentMatrix(g).decompose(gp, gq, gsc)
      const world = new THREE.Matrix4().compose(gp.clone().applyMatrix4(toGame), gq, new THREE.Vector3(1, 1, 1))
      const pb = new THREE.Bone()
      pb.name = `Prop_${g.name.replace(/[^\w]+/g, '_')}`
      parent.matrixWorld.clone().invert().multiply(world).decompose(pb.position, pb.quaternion, pb.scale)
      parent.add(pb)
      pb.updateMatrixWorld(true)
      bones.push(pb)
      ride = bones.length - 1
      propBones.push({ bone: pb, garment: g, rest: { position: pb.position.clone(), quaternion: pb.quaternion.clone() } })
    }
    const file = path.join(characterDir, g.file!)
    const { scene: gs } = await load(file)
    gs.updateMatrixWorld(true)
    const place = new THREE.Matrix4().multiplyMatrices(toGame, garmentMatrix(g))
    const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = []
    gs.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(place, m.matrixWorld))
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
      geos.push(geo)
      const loaded = Array.isArray(m.material) ? m.material[0] : m.material
      // (the game binds a surface's maps by its material's name: Main, Atlas_<set>, Trim_<sheet>)
      mats.push(/^Main(\.\d+)?$/.test(loaded.name) ? material : new THREE.MeshStandardMaterial({ name: loaded.name }))
    })
    if (geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.file}`)
    const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)
    const n = geo.attributes.position.count
    const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
    for (let i = 0; i < n; i++) { si[i * 4] = ride; sw[i * 4] = 1 }
    geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
    geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
    parts.push({ bone: bones[ride].name, geometry: geo, material: mats.length === 1 ? mats[0] : mats, name: g.name, budget: !SWAPPED.test(g.name) })
    gearReport[g.name] = {
      bone: g.bone, position: g.position, rotation: g.rotation, scale: g.scale, hidden: g.hidden === true, from: g.from,
      propBone: ride !== index ? bones[ride].name : undefined,
      mesh: createHash('sha256').update(readFileSync(file)).digest('hex'),
    }
  }
  for (const p of character.props ?? []) console.warn(`warning: ${unit}: catalog prop ${p.name} left out (not built by the game: AGENTS.md, every model starts in Blender)`)
  // (parts with their own budget, the villager's gear and spare heads, don't eat into the body's)
  const partTris = parts.reduce((t, x) => t + (x.budget ? triangles(x.geometry) : 0), 0)
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
    if (Array.isArray(part.material)) {
      if (part.geometry.attributes.uv !== undefined && part.geometry.index !== null) part.geometry.computeTangents()
      const mesh = new THREE.SkinnedMesh(part.geometry, part.material)
      mesh.name = part.name
      out.add(mesh)
      meshes.push(mesh)
      partReport[part.name] = [triangles(part.geometry)]
      continue
    }
    addLevels(part.name, part.geometry, part.material, (partReport[part.name] = []))
  }
  // The companion's mesh: placed as its skeleton, skinned to its bones (after the unit's), its own surface.
  const compReport: Record<string, unknown> = {}
  if (comp !== null) {
    const c = spec.companion!
    const geo = comp.geometry.clone().applyMatrix4(place)
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) geo.deleteAttribute(name)
    const offset = skeleton.bones.length + 1
    const si = geo.attributes.skinIndex
    for (let i = 0; i < si.count * si.itemSize; i++) (si.array as Uint16Array)[i] += offset
    si.needsUpdate = true
    const t0 = triangles(geo)
    const lod0c = t0 > c.budget ? simplify(geo, c.budget / t0 * 0.99) : geo
    const levels: number[] = []
    addLevels(c.material, lod0c, new THREE.MeshStandardMaterial({ name: `Atlas_${c.material}` }), levels)
    compReport.character = c.character
    compReport.triangles = { source: t0, budget: c.budget, lods: levels }
    const img = embeddedImage(comp.file)
    if (img !== null) {
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(path.join(srcDir, `base_${c.material}.${img.ext}`), img.bytes)
    }
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

  // The character's scripts, as the viewer applies them (src/engine/scripts.ts): fists held, blows timed, walks paced.
  const named = new Map(clips.map(c => [c.name, c]))
  const { clips: scripted, report: scriptReport } = await applyScripts(out, named, scripts, async id => {
    const src = await entrySource({ clipId: id })
    return retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: true })
  })
  for (let i = 0; i < clips.length; i++) {
    clips[i] = scripted.get(clips[i].name)!
    ;(clipReport[clips[i].name] as Record<string, unknown>).seconds = +clips[i].duration.toFixed(3)
  }
  for (const r of Object.values(scriptReport) as Array<Record<string, unknown>>) {
    if (r.kind === 'blow') Object.assign(clipReport[r.clip as string] as object, { blow: r.blow, kept: r.kept, hit: r.at })
    if (r.kind === 'pace') Object.assign(clipReport[r.clip as string] as object, { pacedLike: r.like, retimed: r.retimed })
  }
  // Then each clip's ground and keys, as the viewer applies them (src/engine/keys.ts), in game units (x s); every clip
  // moves the prop bones (at rest where it has no keys for them), so a prop keyed in one clip is back in the next.
  for (let i = 0; i < clips.length; i++) {
    const entry = character.animations.find(a => a.name === clips[i].name)!
    let clip = applyLift(clips[i], 'Hips', (entry.lift ?? 0) * s, restLocal.get('Hips')!.p)
    clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, b => restLocal.get(b) ?? null, s)
    const extra = propBones.flatMap(pb => propTracks(pb.bone.name, clip.duration, entry.keys?.props?.[pb.garment.name], entry.loop, pb.rest, pb.garment.scale, s))
    clips[i] = extra.length > 0 ? new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks, ...extra]) : clip
    const counted = (t?: Record<string, unknown[]>): Record<string, number> | undefined =>
      t === undefined || Object.keys(t).length === 0 ? undefined : Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length]))
    Object.assign(clipReport[clip.name] as object, { lift: entry.lift, keys: entry.keys === undefined ? undefined : { bones: counted(entry.keys.bones), props: counted(entry.keys.props) } })
  }
  // (the build record keeps the keys themselves too: game_import restores a character from it)
  for (const name of spec.clips) {
    const entry = character.animations.find(a => a.name === name)!
    if (entry.keys !== undefined) Object.assign(clipReport[name] as object, { keyData: entry.keys })
  }
  exportSkeleton.pose()
  out.updateMatrixWorld(true)
  const walk = clips.find(c => c.name === 'Walk')
  const walkStride = walk !== undefined ? stride(out, walk) : null
  const run = clips.find(c => c.name === 'Run')
  const runStride = run !== undefined ? stride(out, run) : null
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

  // The companion's clips joined to the unit's under the same names. Its walk first takes the unit's pace (its
  // planted foot as fast as the unit's), then loops fit by whole cycles (m of the unit's against n of its own, the
  // closest within six); its attack fits the unit's (the blows together); anything else plays at its own length.
  if (comp !== null) {
    const c = spec.companion!
    const feet = (c.feet ?? ['front_leg_foot_l', 'front_leg_foot_r', 'back_leg_foot_l', 'back_leg_foot_r']).map(f => c.prefix + f)
    const clipsOut: Record<string, unknown> = {}
    for (let k = 0; k < clips.length; k++) {
      const main = clips[k]
      let other = comp.clips.get(main.name) ?? comp.clips.get('Idle')
      if (other === undefined) continue
      const e = comp.entries.get(main.name) ?? comp.entries.get('Idle')
      const info: Record<string, unknown> = { clip: e?.clipId, url: e?.url, loop: e?.loop, inPlace: e?.inPlace, speed: e?.speed }
      const own = main.name === 'Walk' ? walkStride : main.name === 'Run' ? runStride : null
      if (own !== null) {
        const pace = own / stride(out, other, feet)
        other = retime(other, pace)
        info.pace = +pace.toFixed(3)
      }
      let m = 1; let n = 1
      if (character.animations.find(a => a.name === main.name)?.loop === true) {
        let err = Infinity
        for (let mm = 1; mm <= 6; mm++) {
          for (let nn = 1; nn <= 6; nn++) {
            const e = Math.abs(mm * main.duration - nn * other.duration) / (mm * main.duration)
            if (e < err - 1e-9) { err = e; m = mm; n = nn }
          }
        }
        other = retime(other, n * other.duration / (m * main.duration))
        Object.assign(info, { cycles: [m, n], fit: +err.toFixed(3) })
      } else if (scripts.some(x => x.enabled && x.kind === 'blow' && x.clip === main.name)) {
        other = retime(other, other.duration / main.duration)
      }
      const a = repeat(main, m); const b = repeat(other, n)
      clips[k] = new THREE.AnimationClip(main.name, Math.max(a.duration, b.duration), [...a.tracks, ...b.tracks])
      clipsOut[main.name] = { ...info, seconds: +b.duration.toFixed(3) }
    }
    compReport.clips = clipsOut
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    const walkC = clips.find(x => x.name === 'Walk')
    compReport.walkStride = walkC !== undefined ? +stride(out, walkC, feet).toFixed(3) : null
    const runC = clips.find(x => x.name === 'Run')
    if (runC !== undefined) compReport.runStride = +stride(out, runC, feet).toFixed(3)
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
    scripts: scripts.map(x => ({ ...x, did: scriptReport[x.id] })),
    gear: gearReport,
    companion: comp !== null ? compReport : undefined,
    walkStride: walkStride === null ? null : +walkStride.toFixed(3),
    runStride: runStride === null ? undefined : +runStride.toFixed(3),
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
  console.log(JSON.stringify({ unit, triangles: report.triangles, walkStride: report.walkStride, runStride: report.runStride, clips: report.clips }))
}
