// Export rigged characters as game units, headless. A spec in the game's repo names each unit's Rigsmith character, its
// size and budget, and the clip names the game plays; everything a unit plays and carries comes from the character as
// it is in Rigsmith, so the game gets what Rigsmith shows:
//   clips     the character's animation set, by the game's names (its clip, loop, in place, speed)
//   scripts   the character's enabled clip scripts (src/engine/scripts.ts: a fist held, an attack's blow timed, a
//             walk paced), applied exactly as the viewer applies them
//   gear      its accessories placed exactly as there: props (weapons, shields, quivers, the villager's tools, heads
//             and wear) riding their bones, clothing skinned to the body and parts pinned to a spot on it, weighted as
//             the viewer weights them (tools/lib/gearskin.ts); a prop's pulls (a bowstring drawn by the other hand:
//             src/engine/pulls.ts) as a bone each, Prop_<prop>_<pull> under the bone the prop rides, its clip tracks
//             the pull as the viewer steps it
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
import { MeshoptSimplifier } from 'meshoptimizer'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { compact, simplify } from '../src/engine/export/lods.ts'
import { garmentMatrix } from '../src/engine/placement.ts'
import { captureRest, pelvisName, restUpOf, retarget } from '../src/engine/retarget.ts'
import { applyScripts, handScripts, retime, sample, stride, type ClipScript } from '../src/engine/scripts.ts'
import { applyBoneKeys, applyLift, frameTimes, propTracks } from '../src/engine/keys.ts'
import { fitRide, freezeClip, repeat, seatMatrix } from '../src/engine/mount.ts'
import { CharacterView } from '../src/engine/CharacterView.ts'
import type { GarmentEdit } from '../src/engine/garments.ts'
import { holdFactor, pullBoneName, pullPosition, type PullSocket } from '../src/engine/pulls.ts'
import { gearSkin, pullSkin } from './lib/gearskin.ts'
import { entrySource, isBone, load, ROOT, WORKSPACE } from './lib/node3d.ts'
import type { AnimationEntry, Garment, Mount } from '../server/workspace.ts'

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
  /** The unit rides it (the character's mount in Rigsmith: its seat, held bones, the horse's skin and gear): the rider
   * sits on its seat bone, the horse's gait leads the clips, the unit's stride is the horse's. */
  ridden?: boolean
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

/** A companion character, its clips retargeted onto it and scaled to its height (placed later, under the root). */
async function loadCompanion (unit: string, c: CompanionSpec, names: string[]): Promise<{ mesh: THREE.SkinnedMesh, top: THREE.Bone, geometry: THREE.BufferGeometry, floor: number, s: number, clips: Map<string, THREE.AnimationClip>, entries: Map<string, AnimationEntry>, file: string,
  dir: string, info: { garments?: Garment[], skins?: Array<{ name: string, file: string }> } }> {
  const dir = path.join(WORKSPACE, 'characters', c.character)
  const info = JSON.parse(readFileSync(path.join(dir, 'character.json'), 'utf8')) as { files: { rigged?: string }, animations: AnimationEntry[], scripts?: ClipScript[], garments?: Garment[], skins?: Array<{ name: string, file: string }> }
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
  // its clips as the viewer plays them (its own scripts, ground and keys, in its own units), then at its game size
  const baked = new Map<string, THREE.AnimationClip>()
  const entries = new Map<string, AnimationEntry>()
  for (const name of names) {
    const entry = info.animations.find(a => a.name === name)
    if (entry === undefined) continue
    const src = await entrySource(entry)
    const clip = retime(retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: entry.inPlace }), entry.speed)
    clip.name = name
    baked.set(name, clip)
    entries.set(name, entry)
  }
  const { clips: scripted } = await applyScripts(scene, baked, handScripts(info), async id => {
    const src = await entrySource({ clipId: id })
    return retarget(src.scene, captureRest(src.scene, isBone), src.clip, rest, { fps: 30, inPlace: true })
  })
  const restOf = (b: string): { q: THREE.Quaternion, p: THREE.Vector3 } | null => {
    const r = rest.bones.get(b)
    return r === undefined ? null : { q: r.localQuaternion.clone(), p: r.localPosition.clone() }
  }
  const hips = rest.bones.get('Hips') ?? rest.bones.get('hips')
  const clips = new Map<string, THREE.AnimationClip>()
  for (const [name, entry] of entries) {
    let clip = scripted.get(name)!
    if (hips !== undefined) clip = applyLift(clip, hips.name, entry.lift ?? 0, hips.localPosition, restUpOf(rest, hips.name))
    clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, restOf)
    clip = scalePositions(clip, s, floor, top.name)
    clip.name = name
    clips.set(name, clip)
  }
  return { mesh, top, geometry, floor, s, clips, entries, file, dir, info }
}

function triangles (geometry: THREE.BufferGeometry): number {
  return (geometry.index?.count ?? geometry.attributes.position.count) / 3
}

/** simplify (src/engine/export/lods.ts) keeping the vertices `lock` marks where they are: a pulled strand's ring (left
 * free, the simplifier collapses it back into the straight strand, which then can't bend). The same attributes and
 * weights as simplify. */
function simplifyKeeping (geometry: THREE.BufferGeometry, ratio: number, lock: Uint8Array): THREE.BufferGeometry {
  const flat = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute): Float32Array => {
    const out = new Float32Array(a.count * a.itemSize)
    for (let i = 0; i < a.count; i++) for (let k = 0; k < a.itemSize; k++) out[i * a.itemSize + k] = a.getComponent(i, k)
    return out
  }
  const count = geometry.attributes.position.count
  const source = geometry.index !== null ? Uint32Array.from(geometry.index.array) : Uint32Array.from({ length: count }, (_, i) => i)
  const target = Math.max(3, Math.floor(source.length * ratio / 3) * 3)
  const parts: Array<{ data: Float32Array, size: number, weight: number }> = []
  if (geometry.attributes.normal !== undefined) parts.push({ data: flat(geometry.attributes.normal), size: 3, weight: 0.5 })
  if (geometry.attributes.uv !== undefined) parts.push({ data: flat(geometry.attributes.uv), size: 2, weight: 4 })
  const stride = Math.max(1, parts.reduce((t, p) => t + p.size, 0))
  const attributes = new Float32Array(count * stride)
  for (let v = 0; v < count; v++) {
    let o = v * stride
    for (const p of parts) for (let k = 0; k < p.size; k++) attributes[o++] = p.data[v * p.size + k]
  }
  const weights = parts.length > 0 ? parts.flatMap(p => new Array<number>(p.size).fill(p.weight)) : [0]
  const [indices] = MeshoptSimplifier.simplifyWithAttributes(source, flat(geometry.attributes.position), 3, attributes, stride, weights, lock, target, 1, ['Permissive'])
  return compact(geometry, indices)
}

async function exportUnit (unit: string, spec: UnitSpec, modelsDir: string, workDir: string): Promise<Record<string, unknown>> {
  const characterDir = path.join(WORKSPACE, 'characters', spec.character)
  const character = JSON.parse(readFileSync(path.join(characterDir, 'character.json'), 'utf8')) as {
    name: string, rigReport?: { method?: string }, files: { rigged?: string }, animations: AnimationEntry[], scripts?: ClipScript[], garments?: Garment[], props?: Array<{ name: string }>, mount?: Mount
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
  // (its own scripts and its hands' poses round what they carry, as the viewer plays them)
  const scripts = handScripts(character)
  if (spec.clips.includes('Attack') && !scripts.some(x => x.enabled && x.kind === 'blow' && x.clip === 'Attack')) {
    console.warn(`warning: ${unit}: no blow timing on its Attack: the game lands each hit at 45 % of the clip`)
  }

  const comp = spec.companion !== undefined ? await loadCompanion(unit, spec.companion, spec.clips) : null
  // riding: the horse is the companion, the seat and the held bones the character's mount in Rigsmith
  const ridden = spec.companion?.ridden === true
  const mount = character.mount
  if (ridden && (mount === undefined || mount.character !== spec.companion!.character)) {
    throw new Error(`${unit}: rides ${spec.companion!.character} in the spec, but ${character.name}'s mount in Rigsmith is ${mount?.character ?? 'none'}`)
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
  // (one world unit up in the hips' parent's frame, at rest: the ground lift goes straight up whatever the parent's tilt)
  const hipsBone = bones.find(b => b.name === 'Hips')
  hipsBone?.parent?.updateMatrixWorld(true)
  const hipsUp = hipsBone?.parent == null ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 1, 0).applyMatrix3(new THREE.Matrix3().setFromMatrix4(hipsBone.parent.matrixWorld.clone().invert()))
  // a prop keyed in any clip rides its own bone ("Prop_<name>", at its pivot under the bone it rides), which the clips move
  const keyedProps = new Set(spec.clips.flatMap(n => Object.keys(character.animations.find(a => a.name === n)?.keys?.props ?? {})))
  const propBones: Array<{ bone: THREE.Bone, garment: Garment, rest: { position: THREE.Vector3, quaternion: THREE.Quaternion } }> = []
  // a prop's pulls: a bone each under the bone the prop rides, at the pull's rest point, which every clip moves
  const pullBones: Array<{ bone: THREE.Bone, parent: THREE.Bone, hand: THREE.Bone, pull: PullSocket, rest: THREE.Vector3 }> = []
  const material = new THREE.MeshStandardMaterial({ name: 'Main' })
  geometry.applyMatrix4(new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0)))
  for (const name of Object.keys(geometry.attributes)) if (!['position', 'normal', 'uv', 'skinIndex', 'skinWeight'].includes(name)) geometry.deleteAttribute(name)

  await MeshoptSimplifier.ready
  // Its gear: the character's accessories in Rigsmith, each placed exactly as there (garmentMatrix: the character's rest
  // space), then into game space with the body: props (weapons, shields, quivers, the villager's tools, heads and wear)
  // riding their bone rigidly, clothing and parts skinned to the body's bones as the viewer skins them. A hidden one
  // stays out, except the pieces the game itself shows by job (Gear*, Head*, Wear*); only parts the game built go in
  // (from "emberhold:...": AGENTS.md, every model starts in Blender). A part with one surface gets levels like the body;
  // one with several (a wear piece on two trim sheets) is one mesh, one level.
  const srcDir = path.join(workDir, unit)
  const toGame = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0))
  // (`pulled`: a prop's pull joints, whose vertices every level keeps)
  const parts: Array<{ bone: string, geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string, budget: boolean, pulled?: Set<number> }> = []
  const gearReport: Record<string, unknown> = {}
  // (a garment model's meshes, each placed by `placement` over its own nodes, with the surfaces the game binds by name)
  const gearModel = async (file: string, placement: THREE.Matrix4): Promise<{ geos: THREE.BufferGeometry[], mats: THREE.Material[], animations: string[] }> => {
    const { scene: gs, animations } = await load(file)
    gs.updateMatrixWorld(true)
    const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = []
    gs.traverse(o => {
      const m = o as THREE.Mesh
      if (m.isMesh !== true) return
      const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(placement, m.matrixWorld))
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
      geos.push(geo)
      const loaded = Array.isArray(m.material) ? m.material[0] : m.material
      // (the game binds a surface's maps by its material's name: Main, Atlas_<set>, Trim_<sheet>)
      mats.push(/^Main(\.\d+)?$/.test(loaded.name) ? material : new THREE.MeshStandardMaterial({ name: loaded.name }))
    })
    return { geos, mats, animations: animations.map(a => a.name) }
  }
  // (the body at rest as the viewer holds it, for clothing and parts: loaded apart, the skeleton above is the game's now)
  let restView: CharacterView | null = null
  for (const g of character.garments ?? []) {
    const kind = g.mode === 'rigid' ? 'prop' : g.mode
    const left = g.status !== 'ready' || g.file === undefined ? 'not ready'
      : g.hidden === true && !SWAPPED.test(g.name) ? 'hidden'
        : !(g.from ?? '').startsWith('emberhold:') ? 'not a part the game built (AGENTS.md: every model starts in Blender)' : null
    if (left !== null) {
      if (left !== 'hidden') console.warn(`warning: ${unit}: ${g.name} left out: ${left}`)
      gearReport[g.name] = { left, kind, group: g.group }
      continue
    }
    if (g.mode !== 'rigid') {
      // Clothing and parts: weighted in the character's rest space as the viewer weights them (the body's weights under
      // each vertex and the painted ones, or the part's spot's), bones by name onto this skeleton, then into game space.
      const file = path.join(characterDir, g.file!)
      const { geos, mats, animations } = await gearModel(file, garmentMatrix(g))
      if (geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.file}`)
      // (painted weights beside its model, as the viewer reads them: garmentWeightsUrl)
      const weightsFile = path.join(path.dirname(file), 'weights.json')
      const painted = g.mode === 'clothing' && (g.painted ?? 0) > 0
      if (painted && !existsSync(weightsFile)) console.warn(`warning: ${unit}: ${g.name}: ${g.painted} painted weights, but no ${path.relative(characterDir, weightsFile)}`)
      const edits = painted && existsSync(weightsFile) ? JSON.parse(readFileSync(weightsFile, 'utf8')) as GarmentEdit[] : []
      restView ??= new CharacterView((await load(riggedFile)).scene)
      const skin = gearSkin(restView, g, geos, edits, animations, bones.map(b => b.name))
      geos.forEach((geo, i) => {
        geo.applyMatrix4(toGame)
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.skins[i].indices, 4))
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.skins[i].weights, 4))
      })
      if (skin.mechanism !== undefined) console.warn(`warning: ${unit}: ${g.name}: its own animation ${skin.mechanism} isn't exported: it rides ${skin.lead} still`)
      const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)
      parts.push({ bone: skin.lead, geometry: geo, material: mats.length === 1 ? mats[0] : mats, name: g.name, budget: !SWAPPED.test(g.name) })
      gearReport[g.name] = {
        bone: skin.lead, position: g.position, rotation: g.rotation, scale: g.scale, hidden: g.hidden === true, from: g.from,
        mesh: createHash('sha256').update(readFileSync(file)).digest('hex'),
        kind, group: g.group, policy: g.mode === 'clothing' ? g.policy : undefined, spot: skin.spot, painted: g.mode === 'clothing' ? skin.painted : undefined,
        hideBody: g.mode === 'clothing' && g.hideBody ? 'not applied (the body is whole in the game)' : undefined,
        animation: skin.mechanism !== undefined ? `${skin.mechanism} (not exported: still)` : undefined,
      }
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
    const pulls = g.pulls ?? []
    let geo: THREE.BufferGeometry
    let mats: THREE.Material[]
    let painted: number | undefined
    if (pulls.length === 0) {
      const model = await gearModel(file, new THREE.Matrix4().multiplyMatrices(toGame, garmentMatrix(g)))
      if (model.geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.file}`)
      mats = model.mats
      geo = model.geos.length === 1 ? model.geos[0] : mergeGeometries(model.geos, true)
      const n = geo.attributes.position.count
      const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) { si[i * 4] = ride; sw[i * 4] = 1 }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
    } else {
      // A prop with pulls, rigged as the viewer rigs it (garments.ts rigPulls): its root is the bone it rides; each pull
      // a bone under that one at the pull's rest point (prop model space, placed as its vertices are: garmentMatrix,
      // then into game space), no turn of its own; its meshes split and weighted in model space, then placed.
      const placed = new THREE.Matrix4().multiplyMatrices(toGame, garmentMatrix(g))
      const parent = bones[ride]
      const joints = [ride]
      for (const pull of pulls) {
        const hand = bones.find(b => b.name === pull.bone)
        if (hand === undefined) throw new Error(`${unit}: ${g.name}'s pull ${pull.name} is held by ${pull.bone}, not in the skeleton`)
        const pb = new THREE.Bone()
        pb.name = pullBoneName(g.name, pull)
        if (bones.some(b => b.name === pb.name)) throw new Error(`${unit}: ${g.name}: a second bone named ${pb.name}`)
        pb.position.copy(parent.worldToLocal(new THREE.Vector3(...pull.rest).applyMatrix4(placed)))
        parent.add(pb)
        pb.updateMatrixWorld(true)
        bones.push(pb)
        joints.push(bones.length - 1)
        pullBones.push({ bone: pb, parent, hand, pull, rest: pb.position.clone() })
      }
      const model = await gearModel(file, new THREE.Matrix4())
      if (model.geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.file}`)
      mats = model.mats
      // (painted weights beside its model, as the viewer reads them: garmentWeightsUrl)
      const weightsFile = path.join(path.dirname(file), 'weights.json')
      if ((g.painted ?? 0) > 0 && !existsSync(weightsFile)) console.warn(`warning: ${unit}: ${g.name}: ${g.painted} painted weights, but no ${path.relative(characterDir, weightsFile)}`)
      const edits = (g.painted ?? 0) > 0 && existsSync(weightsFile) ? JSON.parse(readFileSync(weightsFile, 'utf8')) as GarmentEdit[] : []
      const skin = pullSkin(g, model.geos, edits, joints)
      painted = skin.painted
      skin.geometries.forEach((x, i) => {
        x.applyMatrix4(placed)
        x.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skin.skins[i].indices, 4))
        x.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skin.skins[i].weights, 4))
      })
      geo = skin.geometries.length === 1 ? skin.geometries[0] : mergeGeometries(skin.geometries, true)
    }
    parts.push({ bone: bones[ride].name, geometry: geo, material: mats.length === 1 ? mats[0] : mats, name: g.name, budget: !SWAPPED.test(g.name),
      pulled: pulls.length > 0 ? new Set(pullBones.filter(pb => pulls.includes(pb.pull)).map(pb => bones.indexOf(pb.bone))) : undefined })
    gearReport[g.name] = {
      bone: g.bone, position: g.position, rotation: g.rotation, scale: g.scale, hidden: g.hidden === true, from: g.from,
      propBone: ride !== index ? bones[ride].name : undefined,
      mesh: createHash('sha256').update(readFileSync(file)).digest('hex'),
      kind, group: g.group,
      pulls: pulls.length > 0 ? pulls.map(p => ({ name: p.name, bone: p.bone, holds: p.holds ?? {} })) : undefined,
      painted,
    }
  }
  for (const p of character.props ?? []) console.warn(`warning: ${unit}: catalog prop ${p.name} left out (not built by the game: AGENTS.md, every model starts in Blender)`)
  // Riding: the rider's rig, body and gear onto the horse's seat bone: his game space into the horse's (his size over
  // the horse's cancels: one rigid move), his Hips under the seat bone from there. His clips' Hips follow (below).
  let seatA: THREE.Matrix4 | null = null
  if (ridden && comp !== null && mount !== undefined) {
    const c = spec.companion!
    const seatBone = compBones.find(b => b.name === c.prefix + mount.bone)
    if (seatBone === undefined) throw new Error(`${unit}: the horse has no bone ${mount.bone}`)
    out.updateMatrixWorld(true)
    const W = place.clone().multiply(seatMatrix(mount, s / comp.s))
      .multiply(new THREE.Matrix4().makeTranslation(0, floor, 0)).multiply(new THREE.Matrix4().makeScale(1 / s, 1 / s, 1 / s))
    seatA = seatBone.matrixWorld.clone().invert().multiply(W)
    const local = seatA.clone().multiply(new THREE.Matrix4().compose(hips.position, hips.quaternion, new THREE.Vector3(1, 1, 1)))
    seatBone.add(hips)
    local.decompose(hips.position, hips.quaternion, hips.scale)
    hips.scale.set(1, 1, 1)
    geometry.applyMatrix4(W)
    for (const part of parts) part.geometry.applyMatrix4(W)
    out.updateMatrixWorld(true)
  }
  // (parts with their own budget, the villager's gear and spare heads, don't eat into the body's)
  const partTris = parts.reduce((t, x) => t + (x.budget ? triangles(x.geometry) : 0), 0)
  const bodyBudget = spec.budget - partTris
  const tris0 = triangles(geometry)
  const lod0 = tris0 > bodyBudget ? simplify(geometry, bodyBudget / tris0 * 0.99) : geometry
  const meshes: THREE.SkinnedMesh[] = []
  const lodReport: number[] = []
  // (`pulled`: joints whose vertices every level keeps where they are: a pull's, so each level's strand bends as LOD0's)
  const addLevels = (base: string, geo0: THREE.BufferGeometry, mat: THREE.Material, report: number[], pulled?: Set<number>): void => {
    let lock: Uint8Array | null = null
    if (pulled !== undefined) {
      const si = geo0.attributes.skinIndex; const sw = geo0.attributes.skinWeight
      lock = new Uint8Array(si.count)
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0 && pulled.has(si.getComponent(i, k))) lock[i] = 1
    }
    const level = (r: number): THREE.BufferGeometry => lock === null ? simplify(geo0, r) : simplifyKeeping(geo0, r, lock)
    const geos = triangles(geo0) <= 60 ? [geo0] : [geo0, ...(spec.lods ?? [0.45, 0.15]).map(level)]
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
    addLevels(part.name, part.geometry, part.material, (partReport[part.name] = []), part.pulled)
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
    // a ridden horse's gear (the rider's mount picks its pieces from the horse's garments), riding the horse's bones
    if (ridden && mount !== undefined) {
      const worn: Record<string, unknown> = {}
      for (const g of comp.info.garments ?? []) {
        if (!(mount.gear ?? []).some(x => x === g.name || x === g.id)) continue
        if (g.status !== 'ready' || g.file === undefined || g.mode !== 'rigid') { worn[g.name] = { left: 'not a ready rigid garment' }; continue }
        const index = bones.findIndex(b => b.name === c.prefix + g.bone)
        if (index < 0) throw new Error(`${unit}: the horse's ${g.name} rides ${g.bone}, not in its skeleton`)
        const file = path.join(comp.dir, g.file)
        const { scene: gs } = await load(file)
        gs.updateMatrixWorld(true)
        const at = new THREE.Matrix4().multiplyMatrices(place, garmentMatrix(g))
        const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = []
        gs.traverse(o => {
          const m = o as THREE.Mesh
          if (m.isMesh !== true) return
          const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(at, m.matrixWorld))
          for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
          geos.push(geo)
          const loaded = Array.isArray(m.material) ? m.material[0] : m.material
          mats.push(new THREE.MeshStandardMaterial({ name: /^Main(\.\d+)?$/.test(loaded.name) ? `Atlas_${c.material}` : loaded.name }))
        })
        if (geos.length === 0) continue
        const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)
        const n = geo.attributes.position.count
        const si2 = new Uint16Array(n * 4); const sw2 = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) { si2[i * 4] = index; sw2[i * 4] = 1 }
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si2, 4))
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw2, 4))
        const name = `${c.prefix}${g.name}`
        if (mats.length === 1) addLevels(name, geo, mats[0], (partReport[name] = []))
        else {
          if (geo.attributes.uv !== undefined && geo.index !== null) geo.computeTangents()
          const mesh = new THREE.SkinnedMesh(geo, mats)
          mesh.name = name
          out.add(mesh)
          meshes.push(mesh)
          partReport[name] = [triangles(geo)]
        }
        worn[g.name] = { bone: g.bone, position: g.position, rotation: g.rotation, scale: g.scale, mesh: createHash('sha256').update(readFileSync(file)).digest('hex') }
      }
      compReport.gear = worn
    }
    // its colour: the rider's pick of its skins, else its own texture
    const skin = ridden && mount?.skin !== undefined ? comp.info.skins?.find(k => k.name === mount.skin) : undefined
    if (ridden && mount?.skin !== undefined && skin === undefined) console.warn(`warning: ${unit}: the horse has no skin ${mount.skin}: its own texture`)
    compReport.skin = skin?.name
    const img = skin !== undefined
      ? { bytes: readFileSync(path.join(comp.dir, skin.file)), ext: path.extname(skin.file).slice(1).replace('jpeg', 'jpg') }
      : embeddedImage(comp.file)
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
    let clip = applyLift(clips[i], 'Hips', (entry.lift ?? 0) * s, restLocal.get('Hips')!.p, hipsUp)
    clip = applyBoneKeys(clip, entry.keys?.bones, entry.loop, b => restLocal.get(b) ?? null, s)
    const extra = propBones.flatMap(pb => propTracks(pb.bone.name, clip.duration, entry.keys?.props?.[pb.garment.name], entry.loop, pb.rest, pb.garment.scale, s))
    clips[i] = extra.length > 0 ? new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks, ...extra]) : clip
    const counted = (t?: Record<string, unknown[]>): Record<string, number> | undefined =>
      t === undefined || Object.keys(t).length === 0 ? undefined : Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length]))
    Object.assign(clipReport[clip.name] as object, { lift: entry.lift, keys: entry.keys === undefined ? undefined : { bones: counted(entry.keys.bones), props: counted(entry.keys.props) } })
  }
  // Riding: his held bones still in their seat (game units), then his Hips' keys from the root's frame into the seat
  // bone's (he hangs from it now).
  if (ridden && mount !== undefined && seatA !== null) {
    const toGame = (p: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(p.x * s, (p.y - floor) * s, p.z * s)
    const qA = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(seatA))
    for (let i = 0; i < clips.length; i++) {
      const frozen = freezeClip(clips[i], mount, b => restLocal.get(b) ?? null, toGame)
      const tracks = frozen.tracks.map(t => {
        if (t.name === 'Hips.position') {
          const c2 = t.clone(); const v = new THREE.Vector3()
          for (let j = 0; j < c2.values.length; j += 3) v.fromArray(c2.values, j).applyMatrix4(seatA!).toArray(c2.values, j)
          return c2
        }
        if (t.name === 'Hips.quaternion') {
          const c2 = t.clone(); const q = new THREE.Quaternion()
          for (let j = 0; j < c2.values.length; j += 4) q.fromArray(c2.values, j).premultiply(qA).toArray(c2.values, j)
          return c2
        }
        return t
      })
      clips[i] = new THREE.AnimationClip(frozen.name, frozen.duration, tracks)
    }
  }
  // Pulls: every clip moves each pull bone (at rest where the clip doesn't hold it, as a prop bone is where it has no
  // keys: the game keeps a bone where the last clip left it), held as the viewer steps it (pulls.ts tickPulls): at each
  // frame of the clip's own pose, toward the holding bone's grip (its rest-frame offset, in game units) as far as the
  // clip holds it at that part of it, in the space of the bone the prop rides.
  if (pullBones.length > 0) {
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i]
      const held = pullBones.filter(pb => (pb.pull.holds?.[clip.name] ?? []).length > 0)
      const times = held.length > 0 ? frameTimes(clip.duration) : [0, clip.duration]
      const values = new Map(pullBones.map(pb => [pb, held.includes(pb) ? [] as number[] : [...pb.rest.toArray(), ...pb.rest.toArray()]]))
      if (held.length > 0) {
        exportSkeleton.pose()
        const mixer = new THREE.AnimationMixer(out)
        const action = mixer.clipAction(clip)
        // (once, held at its end: its last frame is its end's pose, not its start's)
        action.setLoop(THREE.LoopOnce, 1)
        action.clampWhenFinished = true
        action.play()
        const grip = new THREE.Vector3()
        for (const t of times) {
          action.paused = false
          action.enabled = true
          mixer.setTime(t)
          out.updateMatrixWorld(true)
          for (const pb of held) {
            grip.set(...pb.pull.grip).multiplyScalar(s).applyMatrix4(pb.hand.matrixWorld)
            const at = pullPosition({ ...pb.pull, rest: pb.rest.toArray() }, holdFactor(pb.pull.holds?.[clip.name], clip.duration > 0 ? t / clip.duration : 0), pb.parent.worldToLocal(grip.clone()))
            values.get(pb)!.push(...at.toArray())
          }
        }
        action.stop()
        mixer.uncacheRoot(out)
        exportSkeleton.pose()
      }
      const tracks = pullBones.map(pb => new THREE.VectorKeyframeTrack(`${pb.bone.name}.position`, held.includes(pb) ? times : [0, clip.duration], values.get(pb)!))
      clips[i] = new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks, ...tracks])
    }
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
    if (ridden) break    // (a rider's feet are in the stirrups: his steps are the horse's, checked by its stride below)
    const stats = checkClip(out, clip, spec.height)
    if (STANDS.has(clip.name) && stats.hipsMedian < 0.8 * restHips) {
      throw new Error(`${unit}: clip ${clip.name}: the hips sit at ${stats.hipsMedian} x height (rest ${restHips.toFixed(3)}): not standing (a seated clip?)`)
    }
    Object.assign(clipReport[clip.name] as object, stats)
  }

  // Riding: the horse's clips under his, fitted as the viewer fits them (src/engine/mount.ts: loops by whole cycles, the
  // horse's gait leading; its attack to his); the unit's stride is the horse's planted hoof.
  if (comp !== null && ridden) {
    const c = spec.companion!
    const feet = (c.feet ?? ['front_leg_foot_l', 'front_leg_foot_r', 'back_leg_foot_l', 'back_leg_foot_r']).map(f => c.prefix + f)
    const clipsOut: Record<string, unknown> = {}
    for (let k = 0; k < clips.length; k++) {
      const main = clips[k]
      const other = comp.clips.get(main.name) ?? comp.clips.get('Idle')
      if (other === undefined) continue
      const e = comp.entries.get(main.name) ?? comp.entries.get('Idle')
      const attack = scripts.some(x => x.enabled && x.kind === 'blow' && x.clip === main.name)
      const fit = fitRide(main, other, character.animations.find(a => a.name === main.name)?.loop === true, attack)
      clips[k] = new THREE.AnimationClip(main.name, Math.max(fit.rider.duration, fit.horse.duration), [...fit.rider.tracks, ...fit.horse.tracks])
      clipsOut[main.name] = { clip: e?.clipId, url: e?.url, loop: e?.loop, inPlace: e?.inPlace, speed: e?.speed, ...fit.report, seconds: +clips[k].duration.toFixed(3) }
    }
    compReport.clips = clipsOut
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    const walkC = clips.find(x => x.name === 'Walk')
    compReport.walkStride = walkC !== undefined ? +stride(out, walkC, feet).toFixed(3) : null
    const runC = clips.find(x => x.name === 'Run')
    if (runC !== undefined) compReport.runStride = +stride(out, runC, feet).toFixed(3)
  }
  // The companion's clips joined to the unit's under the same names. Its walk first takes the unit's pace (its
  // planted foot as fast as the unit's), then loops fit by whole cycles (m of the unit's against n of its own, the
  // closest within six); its attack fits the unit's (the blows together); anything else plays at its own length.
  if (comp !== null && !ridden) {
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
    // (a rider's stride is his horse's)
    walkStride: ridden ? compReport.walkStride : walkStride === null ? null : +walkStride.toFixed(3),
    runStride: ridden ? compReport.runStride : runStride === null ? undefined : +runStride.toFixed(3),
    mount: ridden ? mount : undefined,
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
  // (a draft is built only when named: the game keeps the unit it has till then)
  if (only.length === 0 && (unitSpec as { draft?: boolean }).draft === true) { console.error(`${unit}: a draft, left out (name it to build it)`); continue }
  const merged = { ...spec.defaults, ...unitSpec } as UnitSpec
  const repo = path.resolve(path.dirname(specFile), '..', '..')
  const report = await exportUnit(unit, merged, merged.models_dir !== undefined ? path.join(repo, merged.models_dir) : modelsDir, workDir)
  console.log(JSON.stringify({ unit, triangles: report.triangles, walkStride: report.walkStride, runStride: report.runStride, clips: report.clips }))
}
