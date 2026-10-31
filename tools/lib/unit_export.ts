// A game unit built from its character as Rigsmith shows it, headless (tools/game_export.ts is its command line, which
// the game's build.sh runs for the Ship step). A spec (src/model/unit.ts UnitSpec) names the unit's character, its
// size and budget and the clip names the game plays; everything the unit plays and carries comes from the character:
//   clips  its slots by the game's names, baked by the one bake the viewer plays (src/engine/bake.ts bakeSlot, and
//          bakeRide when it rides) on the character in its own units, then scaled and grounded into game units
//   gear   its game gear (contract.ts: only parts the game built) placed as Rigsmith places it: bone gear riding its
//          bone (on a Prop_<gear> bone of its own when a clip keys it), skin and spot gear skinned to the body as the
//          viewer skins them (tools/lib/gearskin.ts), each pull handle a Prop_<gear>_<handle> bone the clips draw
// A companion (a pony beside it, the horse under it) is built the same way under the unit's root, its bones prefixed.
// A rider's horse gear (mount.gear: a saddle, barding) is built into the unit on the horse's bones (the designer,
// 2026-10-28: the horse's tack and barding ship).
//
// Written per unit:
//   <models dir>/<unit>.glb          the character at its game height, soles at y = 0, facing +Z, a "root" bone above
//                                    Hips, LOD0 within the budget plus <unit>_LOD1/_LOD2, tangents, one material
//                                    "Main" (the game binds its own maps), its gear, the clips
//   <models dir>/<unit>.events.json  each clip's loop, length and events as exported (docs/motion-plan.md §6): what
//                                    the game times hits, sounds and spawns by
//   <work dir>/<unit>/base.*         the character's colour texture (the game's map build reads it)
//   <work dir>/<unit>/skeleton.json  every joint in game space, and each hand's grip
//   <work dir>/<unit>/rigsmith.json  the build record (src/model/unit.ts BuildRecord)
//   <work dir>/<unit>/sounds/        the files its events play that were dropped in Rigsmith (the game's build.sh
//                                    installs them into its mix as sounds of their own)
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { bakeRide, bakeSlot, eventsInClip, gearTracks, type BakeContext, type BakedEvent, type BakedSlot, type GearTrackTarget, type PullPlan } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { budgetOf, budgetRatio, clipProblem, DEFAULT_LODS, gearLeftOut, HIT_AT, meshNameOf, NO_LOD_BELOW } from '../../src/engine/contract.ts'
import { originMatrix, type GarmentEdit } from '../../src/engine/garments.ts'
import { safeName } from '../../src/engine/geom.ts'
import { baseColorImage, imageBytes, readGlb } from '../../src/engine/glb.ts'
import { frameTimes } from '../../src/engine/keys.ts'
import { compact, ready, simplify, triangles, uvSeamLock } from '../../src/engine/lods.ts'
import { repeat, seatMatrix } from '../../src/engine/mount.ts'
import { garmentMatrix } from '../../src/engine/placement.ts'
import { holdFactor } from '../../src/engine/pulls.ts'
import { pelvisName } from '../../src/engine/retarget.ts'
import { retime, sample, stride } from '../../src/engine/timing.ts'
import { gearEvents, holdTracks, withTracks as withHoldTracks, type HoldTarget } from '../../src/engine/geartracks.ts'
import { gearById, slotByName } from '../../src/model/select.ts'
import { exportClash, exportName, gameNameOf, variantsField, withVariants } from '../../src/model/variants.ts'
import type { Character, ClipKey, Gear, HandPose, Mount, Slot } from '../../src/model/types.ts'
import type { BuildRecord, BuiltClip, BuiltCompanion, BuiltGear, CompanionSpec, UnitEvent, UnitEvents, UnitSpec } from '../../src/model/unit.ts'
import { gearSkin, pullHandles, pullSkin, type PullHandle } from './gearskin.ts'
import { character, isBone, load, nodeClipSource, nodeRom, ROOT, settings } from './node3d.ts'

export interface UnitExportOptions {
  /** The Rigsmith workspace the characters, the library and the settings are read from. */
  workspace: string
  /** Where <unit>.glb goes (the caller has applied the spec's models_dir). */
  modelsDir: string
  /** Where <unit>/ (its texture, skeleton and build record) goes. */
  workDir: string
  /** The build's run token (RIGSMITH_RUN), kept in the record. */
  runToken?: string
}

/** Frames a second the clips are baked at. */
const FPS = 30
/** What paces a companion's walk when its spec names no feet: a horse's four. */
const HORSE_FEET = ['front_leg_foot_l', 'front_leg_foot_r', 'back_leg_foot_l', 'back_leg_foot_r']
/** The attributes the game reads; the rest are dropped. */
const ATTRIBUTES = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']
/** Gear kinds as the build record has always named them. */
const KIND = { bone: 'prop', skin: 'clothing', spot: 'part' } as const

export async function exportUnit (unit: string, spec: UnitSpec, o: UnitExportOptions): Promise<BuildRecord> {
  if (!Array.isArray(spec.clips)) throw new Error(`${unit}: the spec's clips are the game's clip names (["Idle", "Walk", ...]); what plays under each is the character's set in Rigsmith`)
  const warnings: string[] = []
  const warn = (line: string): void => { warnings.push(line); console.warn(`warning: ${unit}: ${line}`) }
  const shared = settings(o.workspace).handPoses
  const me = await subject(unit, spec.character, o.workspace, shared)
  const c = me.c
  const missing = spec.clips.filter(n => slotByName(c, n) === undefined)
  if (missing.length > 0) throw new Error(`${unit}: ${c.name} in Rigsmith has no clip named ${missing.join(', ')} (its set: ${c.clips.map(x => x.name).join(', ')})`)
  // (each game clip followed by its variants, `Attack 2` played as `Attack_2`: src/model/variants.ts)
  const stored = withVariants(c, spec.clips)
  const slots = stored.map(s => (s.name === exportName(s.name, spec.clips) ? s : { ...s, name: exportName(s.name, spec.clips) }))
  const clash = exportClash(stored, spec.clips)
  if (clash !== null) throw new Error(`${unit}: ${c.name}'s clips ${clash.join(' and ')} both play as ${exportName(clash[0], spec.clips)} in the game; rename one in Rigsmith`)
  const gameName = (name: string): string => gameNameOf(name, spec.clips)

  // Its clips as the viewer bakes them, on the character in its own units (the export keys its own gear bones, below).
  const baked = new Map<string, BakedSlot>()
  for (const slot of slots) baked.set(slot.name, await bakeSlot(c, slot, me.ctx, { gearNodes: false }))
  // (as each slot plays alone, before a ride fits it: what the record says of its keys and holds)
  const alone = new Map(baked)
  const audit = readAudit(o.workspace)
  const clipReport: Record<string, BuiltClip> = {}
  for (const slot of slots) clipReport[slot.name] = clipRecord(c, slot, baked.get(slot.name)!, audit, warn)
  if (baked.has('Attack') && baked.get('Attack')!.cut === undefined) warn(`no blow timing on its Attack: the game lands each hit at ${Math.round(HIT_AT * 100)} % of the clip`)

  const comp = spec.companion === undefined ? null : await companionOf(unit, spec.companion, o.workspace, shared)
  // Riding: the horse is the companion, the seat and the held bones the character's mount in Rigsmith. His clips are
  // seated and the horse's slot of the same name (else its Idle) fitted under each, as the viewer plays them.
  let ride: { horse: Companion, mount: Mount } | null = null
  const horseClips = new Map<string, { clip: THREE.AnimationClip, slot: Slot, report: Record<string, unknown>, events: BakedEvent[] }>()
  if (comp?.spec.ridden === true) {
    const mount = c.mount
    if (mount === undefined || mount.character !== comp.spec.character) throw new Error(`${unit}: rides ${comp.spec.character} in the spec, but ${c.name}'s mount in Rigsmith is ${mount?.character ?? 'none'}`)
    ride = { horse: comp, mount }
    for (const slot of slots) {
      const b = baked.get(slot.name)!
      const r = await bakeRide(b, { c: comp.c, ctx: comp.ctx, slotName: gameName(slot.name) }, mount, { loop: slot.loop, attack: b.cut !== undefined, rest: me.ctx.rest })
      baked.set(slot.name, r.rider)
      const hs = slotByName(comp.c, gameName(slot.name)) ?? slotByName(comp.c, 'Idle')
      if (r.horse !== null && hs !== undefined) horseClips.set(slot.name, { clip: r.horse, slot: hs, report: r.report, events: r.horseEvents ?? [] })
    }
  }
  // A companion beside it plays its own slots by the unit's names (one it lacks plays its Idle), fitted below.
  const besideClips = new Map<string, { clip: THREE.AnimationClip, slot: Slot, events: BakedEvent[] }>()
  if (comp !== null && ride === null) {
    for (const slot of slots) {
      const own = slotByName(comp.c, gameName(slot.name))
      if (own === undefined) continue
      const b = await bakeSlot(comp.c, own, comp.ctx, { gearNodes: false })
      besideClips.set(slot.name, { clip: b.clip, slot: own, events: b.events })
    }
  }

  // The game unit: a root bone above Hips, the body baked to world, scaled to its height, its soles at 0. (Its own copy
  // of the body: the one the bake measured on stays at rest for the gear's weights.)
  const { scene } = await load(me.file)
  scene.updateMatrixWorld(true)
  const skinned = skinnedIn(scene)
  if (skinned.length !== 1) throw new Error(`${unit}: expected one skinned mesh, found ${skinned.length}`)
  const skeleton = skinned[0].skeleton
  const hips = skeleton.bones.find(b => b.name === 'Hips')
  if (hips === undefined) throw new Error(`${unit}: no Hips bone`)
  if (!(hips.parent?.matrixWorld ?? new THREE.Matrix4()).equals(new THREE.Matrix4())) throw new Error(`${unit}: the skeleton's parent is transformed; not supported`)
  const geometry = skinned[0].geometry.clone().applyMatrix4(skinned[0].matrixWorld)
  geometry.computeBoundingBox()
  const floor = geometry.boundingBox!.min.y
  const s = spec.height / (geometry.boundingBox!.max.y - floor)
  const toGame = new THREE.Matrix4().makeScale(s, s, s).multiply(new THREE.Matrix4().makeTranslation(0, -floor, 0))
  const out = new THREE.Group()
  out.name = 'Armature'
  const root = new THREE.Bone()
  root.name = 'root'
  out.add(root)
  const hp = new THREE.Vector3(); const hq = new THREE.Quaternion()
  hips.matrixWorld.decompose(hp, hq, new THREE.Vector3())
  root.add(hips)
  hips.position.copy(hp.applyMatrix4(toGame))
  hips.quaternion.copy(hq)
  hips.scale.set(1, 1, 1)
  hips.traverse(b => { if (b !== hips) b.position.multiplyScalar(s) })
  // The companion beside it: its top bone under the root too, placed (scaled to its height, turned, moved to `at`); its
  // bones and clip tracks take its prefix, its top bone's own keys the same placing.
  const compBones: THREE.Bone[] = []
  let place = new THREE.Matrix4()
  let placeClip = (clip: THREE.AnimationClip): THREE.AnimationClip => clip
  if (comp !== null) {
    const yaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(comp.spec.yaw ?? 0))
    const at = new THREE.Vector3(comp.spec.at?.[0] ?? 0, 0, comp.spec.at?.[1] ?? 0)
    place = new THREE.Matrix4().compose(at, yaw, new THREE.Vector3(1, 1, 1))
      .multiply(new THREE.Matrix4().makeScale(comp.s, comp.s, comp.s)).multiply(new THREE.Matrix4().makeTranslation(0, -comp.floor, 0))
    const tp = new THREE.Vector3(); const tq = new THREE.Quaternion()
    comp.top.matrixWorld.decompose(tp, tq, new THREE.Vector3())
    root.add(comp.top)
    comp.top.position.copy(tp.applyMatrix4(place))
    comp.top.quaternion.copy(yaw.clone().multiply(tq))
    comp.top.scale.set(1, 1, 1)
    comp.top.traverse(b => { if (b !== comp.top) b.position.multiplyScalar(comp.s) })
    const placing = { s: comp.s, floor: comp.floor, top: comp.top.name, prefix: comp.spec.prefix, yaw, at }
    placeClip = clip => placeCompanionClip(clip, placing)
    compBones.push(...comp.mesh.skeleton.bones)
    for (const b of compBones) b.name = comp.spec.prefix + b.name
  }
  out.updateMatrixWorld(true)
  const bones = [...skeleton.bones, root, ...compBones]
  const material = new THREE.MeshStandardMaterial({ name: 'Main' })
  geometry.applyMatrix4(toGame)
  for (const name of Object.keys(geometry.attributes)) if (!ATTRIBUTES.includes(name)) geometry.deleteAttribute(name)

  // Its gear, each piece placed as Rigsmith places it (its placement in the character's rest space), then into game
  // space with the body. Bone gear rides its bone rigidly, or a Prop_ bone of its own under it when any clip keys it,
  // hands it on or hides it (the clips move that bone, at rest where they don't key it: src/engine/geartracks.ts);
  // skin and spot gear is weighted to the body's bones. A part with one surface gets levels like the body; one with
  // several (a wear piece on two trim sheets) is one mesh.
  const keyed = new Set([...baked.values()].flatMap(b => [...Object.keys(b.gearKeys), ...Object.keys(b.gearHolds ?? {})]))
  // (pieces hidden in some clip: every clip keys their bone's size, so one that hid it never leaves it hidden)
  const sized = new Set([...baked.values()].flatMap(b => Object.entries(b.gearHolds ?? {}).filter(([, h]) => h.shown.length > 0).map(([id]) => id)))
  const holdTargets: HoldTarget[] = []
  const exportedGear = new Set<string>()
  const parts: Part[] = []
  const gearReport: Record<string, BuiltGear> = {}
  const propTargets: GearTrackTarget[] = []
  const pullBones: PullBone[] = []
  const editsOf = (g: Gear): GarmentEdit[] => {
    if ((g.painted ?? 0) === 0) return []
    const file = path.join(me.dir, 'garments', g.id, 'weights.json')
    if (!existsSync(file)) { warn(`${g.name}: ${g.painted} painted weights, but no ${path.relative(me.dir, file)}`); return [] }
    return JSON.parse(readFileSync(file, 'utf8')) as GarmentEdit[]
  }
  for (const g of c.gear) {
    const a = g.attach
    const name = meshNameOf(g)
    const kind = KIND[a.kind]
    const left = gearLeftOut(g) ?? (g.model === undefined ? 'no model of its own'
      : a.kind === 'bone' && a.legacyFrame !== undefined ? 'still placed in the old catalog frame (place it in Gear)' : null)
    if (left !== null) {
      if (left !== 'hidden') warn(`${g.name} left out: ${left}`)
      gearReport[name] = { left, kind, group: g.swapSet }
      continue
    }
    const file = path.join(me.dir, g.model!)
    const shown = { position: a.place.position, rotation: a.place.rotation, scale: a.place.scale, origin: g.origin, hidden: g.hidden === true, from: g.from }
    if (a.kind !== 'bone') {
      // Skin and spot gear: weighted in the character's rest space as the viewer weights it, bones by name onto this
      // skeleton, then into game space.
      const model = await gearModel(file, g, garmentMatrix(a.place), material)
      if (model.geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.model}`)
      const skin = gearSkin(me.view, g, model.geos, a.kind === 'skin' ? editsOf(g) : [], model.animations, bones.map(b => b.name))
      model.geos.forEach((geo, i) => setSkin(geo.applyMatrix4(toGame), skin.skins[i].indices, skin.skins[i].weights))
      if (skin.mechanism !== undefined) warn(`${g.name}: its own animation ${skin.mechanism} isn't exported: it rides ${skin.lead} still`)
      parts.push({ geometry: merged(model.geos, unit, g), material: model.mats.length === 1 ? model.mats[0] : model.mats, name })
      gearReport[name] = {
        bone: skin.lead, ...shown, mesh: sha256(readFileSync(file)), kind, group: g.swapSet,
        policy: a.kind === 'skin' ? a.policy : undefined, spot: skin.spot, painted: a.kind === 'skin' ? skin.painted : undefined,
        hideBody: a.kind === 'skin' && a.hideBody === true ? 'not applied (the body is whole in the game)' : undefined,
        animation: skin.mechanism !== undefined ? `${skin.mechanism} (not exported: still)` : undefined,
      }
      continue
    }
    const index = bones.findIndex(b => b.name === a.bone)
    if (index < 0) throw new Error(`${unit}: ${g.name} rides ${a.bone}, not in the skeleton`)
    const placed = new THREE.Matrix4().multiplyMatrices(toGame, garmentMatrix(a.place))
    // (the joint its vertices follow: its bone, or its own Prop_ bone)
    let joint = index
    if (keyed.has(g.id)) {
      const pb = newBone(bones, `Prop_${safeName(g.name)}`, unit, g)
      const gp = new THREE.Vector3(); const gq = new THREE.Quaternion()
      garmentMatrix(a.place).decompose(gp, gq, new THREE.Vector3())
      const world = new THREE.Matrix4().compose(gp.applyMatrix4(toGame), gq, new THREE.Vector3(1, 1, 1))
      bones[index].matrixWorld.clone().invert().multiply(world).decompose(pb.position, pb.quaternion, pb.scale)
      bones[index].add(pb)
      pb.updateMatrixWorld(true)
      bones.push(pb)
      joint = bones.length - 1
      propTargets.push({ gear: g, node: pb.name, rest: { position: pb.position.clone(), quaternion: pb.quaternion.clone() }, placeScale: a.place.scale, moveScale: s })
      holdTargets.push({ gear: g, node: pb.name, bone: a.bone, place: a.place, parent: 'bone', unit: s, size: 1 })
    }
    exportedGear.add(g.id)
    const pulls = pullHandles(g)
    let geo: THREE.BufferGeometry
    let mats: THREE.Material[]
    let painted: number | undefined
    if (pulls.length === 0) {
      const model = await gearModel(file, g, placed, material)
      if (model.geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.model}`)
      mats = model.mats
      geo = merged(model.geos, unit, g)
      const n = geo.attributes.position.count
      const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
      for (let i = 0; i < n; i++) { si[i * 4] = joint; sw[i * 4] = 1 }
      setSkin(geo, si, sw)
    } else {
      // Pulled, rigged as the viewer rigs it (garments.ts rigPulls): its root is the bone it rides; each pull handle a
      // bone under that one at the pull's rest point (the model's own space, placed as its vertices are), no turn of
      // its own; its meshes split and weighted in model space, then placed.
      const parent = bones[joint]
      const joints = [joint]
      for (const h of pulls) {
        const hand = bones.find(b => b.name === h.pull.bone)
        if (hand === undefined) throw new Error(`${unit}: ${g.name}'s pull ${h.name} is held by ${h.pull.bone}, not in the skeleton`)
        const pb = newBone(bones, `Prop_${safeName(g.name)}_${safeName(h.name)}`, unit, g)
        pb.position.copy(parent.worldToLocal(new THREE.Vector3(...h.pull.rest).applyMatrix4(placed)))
        parent.add(pb)
        pb.updateMatrixWorld(true)
        bones.push(pb)
        joints.push(bones.length - 1)
        pullBones.push({ bone: pb, parent, hand, gear: g, handle: h, rest: pb.position.clone() })
      }
      const model = await gearModel(file, g, new THREE.Matrix4(), material)
      if (model.geos.length === 0) throw new Error(`${unit}: ${g.name}: no mesh in ${g.model}`)
      mats = model.mats
      const skin = pullSkin(g, model.geos, editsOf(g), joints)
      painted = skin.painted
      skin.geometries.forEach((x, i) => setSkin(x.applyMatrix4(placed), skin.skins[i].indices, skin.skins[i].weights))
      geo = merged(skin.geometries, unit, g)
    }
    parts.push({ geometry: geo, material: mats.length === 1 ? mats[0] : mats, name, pulled: pulls.length > 0 ? new Set(pullBones.filter(pb => pb.gear === g).map(pb => bones.indexOf(pb.bone))) : undefined })
    gearReport[name] = {
      bone: a.bone, ...shown, propBone: joint !== index ? bones[joint].name : undefined, mesh: sha256(readFileSync(file)), kind, group: g.swapSet,
      pulls: pulls.length > 0 ? pulls.map(h => ({ id: h.id, name: h.name, bone: h.pull.bone, holds: holdsOf(alone, g, h) })) : undefined,
      painted,
    }
  }

  // Riding: the rider's rig, body and gear onto the horse's seat bone: his game space into the horse's (his size over
  // the horse's cancels: one rigid move), his Hips under the seat bone from there. His clips' Hips follow (below).
  let seat: THREE.Matrix4 | null = null
  if (ride !== null) {
    const { horse, mount } = ride
    const seatBone = compBones.find(b => b.name === horse.spec.prefix + mount.bone)
    if (seatBone === undefined) throw new Error(`${unit}: the horse has no bone ${mount.bone}`)
    out.updateMatrixWorld(true)
    const W = place.clone().multiply(seatMatrix(mount, s / horse.s))
      .multiply(new THREE.Matrix4().makeTranslation(0, floor, 0)).multiply(new THREE.Matrix4().makeScale(1 / s, 1 / s, 1 / s))
    seat = seatBone.matrixWorld.clone().invert().multiply(W)
    const local = seat.clone().multiply(new THREE.Matrix4().compose(hips.position, hips.quaternion, new THREE.Vector3(1, 1, 1)))
    seatBone.add(hips)
    local.decompose(hips.position, hips.quaternion, hips.scale)
    hips.scale.set(1, 1, 1)
    geometry.applyMatrix4(W)
    for (const part of parts) part.geometry.applyMatrix4(W)
    out.updateMatrixWorld(true)
  }

  // Levels: the body within what its gear leaves of the budget (swapped parts don't count: one shows at a time).
  await ready
  const bodyBudget = budgetOf(spec.budget, parts.map(p => ({ name: p.name, triangles: triangles(p.geometry) })))
  if (bodyBudget <= 0) throw new Error(`${unit}: its gear alone is over its budget of ${spec.budget} triangles`)
  const tris0 = triangles(geometry)
  const ratio = budgetRatio(tris0, bodyBudget)
  const lod0 = ratio < 1 ? simplify(geometry, ratio, uvSeamLock(geometry), true) : geometry
  const meshes: THREE.SkinnedMesh[] = []
  // (`pulled`: joints whose vertices every level keeps where they are: a pull's, so each level's strand bends as LOD0's)
  const addLevels = (base: string, geo0: THREE.BufferGeometry, mat: THREE.Material, report: number[], pulled?: Set<number>): void => {
    let lock: Uint8Array | undefined
    if (pulled !== undefined) {
      const si = geo0.attributes.skinIndex; const sw = geo0.attributes.skinWeight
      lock = new Uint8Array(si.count)
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0 && pulled.has(si.getComponent(i, k))) lock[i] = 1
    }
    const geos = triangles(geo0) <= NO_LOD_BELOW ? [geo0] : [geo0, ...(spec.lods ?? DEFAULT_LODS).map(r => simplify(geo0, r, lock))]
    geos.forEach((geo, i) => {
      out.add(skinnedMesh(i === 0 ? base : `${base}_LOD${i}`, geo, mat, meshes))
      report.push(triangles(geo))
    })
  }
  // The body's own head, split off at `above` x height over the Neck joint (by face centre).
  const lodReport: number[] = []
  const headReport: number[] = []
  if (spec.head !== undefined) {
    const neck = bones.find(b => b.name === 'Neck')
    if (neck === undefined) throw new Error(`${unit}: no Neck to split its head ${spec.head.name} off at`)
    const index = lod0.index
    if (index === null) throw new Error(`${unit}: its body has no triangle list to split its head off`)
    const cutY = new THREE.Vector3().setFromMatrixPosition(neck.matrixWorld).y + (spec.head.above ?? 0.02) * spec.height
    const pos = lod0.attributes.position
    const head: number[] = []; const body: number[] = []
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t); const b = index.getX(t + 1); const d = index.getX(t + 2)
      const y = (pos.getY(a) + pos.getY(b) + pos.getY(d)) / 3
      ;(y > cutY ? head : body).push(a, b, d)
    }
    addLevels(unit, compact(lod0, Uint32Array.from(body)), material, lodReport)
    addLevels(spec.head.name, compact(lod0, Uint32Array.from(head)), material, headReport)
  } else {
    addLevels(unit, lod0, material, lodReport)
  }
  const partReport: Record<string, number[]> = {}
  for (const part of parts) {
    if (Array.isArray(part.material)) {
      out.add(skinnedMesh(part.name, part.geometry, part.material, meshes))
      partReport[part.name] = [triangles(part.geometry)]
    } else addLevels(part.name, part.geometry, part.material, (partReport[part.name] = []), part.pulled)
  }

  // The companion's mesh: placed as its skeleton, skinned to its bones (after the unit's), its own surface; and its
  // colour (a rider's pick of its horse's skins, else its own texture).
  const srcDir = path.join(o.workDir, unit)
  mkdirSync(srcDir, { recursive: true })
  let compReport: BuiltCompanion | undefined
  if (comp !== null) {
    const geo = comp.geometry.clone().applyMatrix4(place)
    for (const name of Object.keys(geo.attributes)) if (!ATTRIBUTES.includes(name)) geo.deleteAttribute(name)
    const offset = skeleton.bones.length + 1
    const si = geo.attributes.skinIndex
    for (let i = 0; i < si.count * si.itemSize; i++) (si.array as Uint16Array)[i] += offset
    si.needsUpdate = true
    const t0 = triangles(geo)
    const r = budgetRatio(t0, comp.spec.budget)
    const levels: number[] = []
    addLevels(comp.spec.material, r < 1 ? simplify(geo, r) : geo, new THREE.MeshStandardMaterial({ name: `Atlas_${comp.spec.material}` }), levels)
    compReport = { character: comp.spec.character, triangles: { source: t0, budget: comp.spec.budget, lods: levels }, clips: {}, walkStride: null }
    const pick = ride?.mount.skin
    const skin = pick === undefined ? undefined : comp.c.look.skins?.find(k => k.name === pick)
    if (ride !== null) {
      if (pick !== undefined && skin === undefined) warn(`the horse has no skin ${pick}: its own texture`)
      compReport.skin = skin?.name
      // the horse's gear his mount names (its ids; a name is read too), each piece rigid on the horse's bone
      const worn: Record<string, unknown> = {}
      for (const want of ride.mount.gear ?? []) {
        const g = comp.c.gear.find(x => x.id === want) ?? comp.c.gear.find(x => x.name === want)
        if (g === undefined) { worn[want] = { left: 'not the horse\'s' }; warn(`the horse has no gear ${want}`); continue }
        if (g.status !== 'ready' || g.model === undefined || g.attach.kind !== 'bone') { worn[g.name] = { left: 'not a ready piece on a bone' }; continue }
        const bone = g.attach.bone
        const index = bones.findIndex(b => b.name === comp.spec.prefix + bone)
        if (index < 0) throw new Error(`${unit}: the horse's ${g.name} rides ${bone}, not in its skeleton`)
        const file = path.join(comp.dir, g.model)
        const { scene: gs } = await load(file)
        gs.updateMatrixWorld(true)
        const at = new THREE.Matrix4().multiplyMatrices(place, garmentMatrix(g.attach.place))
        if (g.origin !== undefined) at.multiply(originMatrix(g))
        const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = []
        gs.traverse(o => {
          const m = o as THREE.Mesh
          if (m.isMesh !== true) return
          const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(at, m.matrixWorld))
          for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
          geos.push(geo)
          const loaded = Array.isArray(m.material) ? m.material[0] : m.material
          mats.push(new THREE.MeshStandardMaterial({ name: /^Main(\.\d+)?$/.test(loaded.name) ? `Atlas_${comp.spec.material}` : loaded.name }))
        })
        if (geos.length === 0) continue
        const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)
        const n = geo.attributes.position.count
        const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
        for (let i = 0; i < n; i++) { si[i * 4] = index; sw[i * 4] = 1 }
        geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
        geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
        const name = `${comp.spec.prefix}${g.name}`
        if (mats.length === 1) addLevels(name, geo, mats[0], (partReport[name] = []))
        else {
          if (geo.attributes.uv !== undefined && geo.index !== null) geo.computeTangents()
          out.add(skinnedMesh(name, geo, mats, meshes))
          partReport[name] = [triangles(geo)]
        }
        worn[g.name] = { bone, place: g.attach.place, origin: g.origin, mesh: createHash('sha256').update(readFileSync(file)).digest('hex') }
      }
      compReport.gear = worn
    }
    const img = skin !== undefined
      ? { bytes: readFileSync(path.join(comp.dir, skin.file)), ext: path.extname(skin.file).slice(1).replace('jpeg', 'jpg') }
      : baseImage(readFileSync(comp.file))
    if (img !== null) writeFileSync(path.join(srcDir, `base_${comp.spec.material}.${img.ext}`), img.bytes)
  }
  const exportSkeleton = new THREE.Skeleton(bones)
  for (const mesh of meshes) mesh.bind(exportSkeleton)

  // The rest skeleton in game space, for builds that fit parts to this rig: every joint, and each hand's grip (the
  // closed fist's centre: most of the way from the wrist to the middle knuckle).
  const worldOf = (name: string): THREE.Vector3 | null => {
    const b = bones.find(x => x.name === name)
    return b === undefined ? null : new THREE.Vector3().setFromMatrixPosition(b.matrixWorld)
  }
  const skeletonOut: Record<string, number[]> = {}
  for (const b of bones) skeletonOut[b.name] = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).toArray().map(x => round(x, 5))
  for (const side of ['Left', 'Right']) {
    const hand = worldOf(`${side}Hand`); const knuckle = worldOf(`${side}HandMiddle1`); const fore = worldOf(`${side}ForeArm`)
    if (hand === null || fore === null) continue
    const grip = knuckle !== null ? hand.clone().lerp(knuckle, 0.75) : hand.clone().addScaledVector(hand.clone().sub(fore).normalize(), 0.08 * spec.height)
    skeletonOut[`grip.${side === 'Left' ? 'L' : 'R'}`] = grip.toArray().map(x => round(x, 5))
  }
  writeFileSync(path.join(srcDir, 'skeleton.json'), JSON.stringify({ space: 'glTF (Y up, facing +Z), metres', height: spec.height, joints: skeletonOut }, null, 1) + '\n')

  // The clips in game units: scaled and grounded with the body (a rider's hips hung from the seat bone), then the gear
  // bones' tracks: each keyed piece's Prop_ bone from its keys (rest where a clip has none, so a piece keyed in one
  // clip is back in the next), each pull's bone where the clip draws it.
  const clips = slots.map(slot => {
    const b = baked.get(slot.name)!
    // (gear nodes are the viewer's; the export moves gear by its own bones)
    const own = new THREE.AnimationClip(b.clip.name, b.clip.duration, b.clip.tracks.filter(t => !t.name.slice(0, t.name.lastIndexOf('.')).endsWith('_place')))
    let clip = scalePositions(own, s, floor, hips.name)
    if (seat !== null) clip = seatClip(clip, hips.name, seat)
    if (propTargets.length > 0) clip = withTracks(clip, gearTracks(clip.duration, b.gearKeys, slot.loop, propTargets))
    // (who holds a piece and when it shows, on its Prop_ bone: the bake's holds played on the clip as it baked)
    if (holdTargets.length > 0 && (b.gearHolds !== undefined || sized.size > 0)) clip = withHoldTracks(clip, holdTracks(b.clip, b.gearHolds ?? {}, b.gearKeys, slot.loop, holdTargets, me.ctx, sized))
    if (pullBones.length > 0) clip = withTracks(clip, pullTracks(out, exportSkeleton, clip, pullBones, b.pulls, s))
    return clip
  })
  const named = (name: string): THREE.AnimationClip | undefined => clips.find(x => x.name === name)

  // Every clip checked against its game name (standing clips against the rest pose's hips), and the strides. A rider's
  // feet are in the stirrups: his steps are the horse's, measured below.
  let walkStride: number | null = null
  let runStride: number | null = null
  if (ride === null) {
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    const walk = named('Walk'); const run = named('Run')
    walkStride = walk !== undefined ? stride(out, walk) : null
    runStride = run !== undefined ? stride(out, run) : null
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    const restHips = new THREE.Vector3().setFromMatrixPosition(hips.matrixWorld).y / spec.height
    for (const clip of clips) {
      const stats = clipStats(out, clip, spec.height)
      const problem = clipProblem(gameName(clip.name), stats, restHips)
      if (problem !== null) throw new Error(`${unit}: ${problem}`)
      Object.assign(clipReport[clip.name], stats)
    }
  }

  // The companion's clips under the unit's, by the same names. A ridden horse's are fitted already (bakeRide); its
  // stride is the unit's. One beside it first takes the unit's pace on Walk and Run (its planted foot as fast as the
  // unit's), then loops fit by whole cycles (m of the unit's against n of its own); its attack fits the unit's (the
  // blows together); anything else plays at its own length.
  // (where each clip's events land in the clip as exported, when a companion's tracks lengthened it or repeated it)
  const ownFits = new Map<string, EventFit>()
  const compEvents = new Map<string, BakedEvent[]>()
  const strideOf = (clip: THREE.AnimationClip): number => {
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    return stride(out, clip)
  }
  if (comp !== null && compReport !== undefined) {
    const feet = (comp.spec.feet ?? HORSE_FEET).map(f => comp.spec.prefix + f)
    for (let k = 0; k < clips.length; k++) {
      const main = clips[k]
      if (ride !== null) {
        const h = horseClips.get(main.name)
        if (h === undefined) continue
        const other = placeClip(h.clip)
        clips[k] = new THREE.AnimationClip(main.name, Math.max(main.duration, other.duration), [...main.tracks, ...other.tracks])
        compReport.clips[main.name] = { ...builtFrom(h.slot), ...h.report, seconds: round(clips[k].duration, 3) }
        ownFits.set(main.name, { repeat: 1, share: main.duration / clips[k].duration })
        compEvents.set(main.name, fitEvents(h.events, { repeat: 1, share: other.duration / clips[k].duration }))
        continue
      }
      const own = besideClips.get(main.name) ?? besideClips.get('Idle')
      if (own === undefined) continue
      let other = placeClip(own.clip)
      const info: Record<string, unknown> = builtFrom(own.slot)
      // (a variant, Walk_2, by its own stride: the companion plays its Walk under it)
      const game = gameName(main.name)
      const pace = main.name === 'Walk' ? walkStride : main.name === 'Run' ? runStride : game === 'Walk' || game === 'Run' ? strideOf(main) : null
      if (pace !== null) {
        const f = pace / stride(out, other, feet)
        other = retime(other, f)
        info.pace = round(f, 3)
      }
      let m = 1; let n = 1
      if (slots[k].loop) {
        const fit = wholeCycles(main.duration, other.duration)
        m = fit.m; n = fit.n
        other = retime(other, n * other.duration / (m * main.duration))
        Object.assign(info, { cycles: [m, n], fit: round(fit.err, 3) })
      } else if (baked.get(main.name)!.cut !== undefined) {
        other = retime(other, other.duration / main.duration)
      }
      const a = repeat(main, m); const b = repeat(other, n)
      clips[k] = new THREE.AnimationClip(main.name, Math.max(a.duration, b.duration), [...a.tracks, ...b.tracks])
      compReport.clips[main.name] = { ...info, seconds: round(b.duration, 3) }
      ownFits.set(main.name, { repeat: m, share: a.duration / clips[k].duration })
      compEvents.set(main.name, fitEvents(own.events, { repeat: n, share: b.duration / clips[k].duration }))
    }
    exportSkeleton.pose()
    out.updateMatrixWorld(true)
    const walk = named('Walk'); const run = named('Run')
    compReport.walkStride = walk !== undefined ? round(stride(out, walk, feet), 3) : null
    if (run !== undefined) compReport.runStride = round(stride(out, run, feet), 3)
  }

  // Back to the bind pose for export (sampling moved the bones).
  exportSkeleton.pose()
  const built = await new GLTFExporter().parseAsync(out, { binary: true, animations: clips, onlyVisible: false }) as ArrayBuffer
  mkdirSync(o.modelsDir, { recursive: true })
  writeFileSync(path.join(o.modelsDir, `${unit}.glb`), new Uint8Array(built))

  const rigged = readFileSync(me.file)
  const image = baseImage(rigged)
  if (image !== null) writeFileSync(path.join(srcDir, `base.${image.ext}`), image.bytes)
  // (next to the GLB, what the game times its hits, sounds and spawns by)
  const events = eventsFile(unit, slots, clips, baked, {
    walk: ride !== null ? compReport!.walkStride : walkStride === null ? null : round(walkStride, 3),
    run: ride !== null ? compReport!.runStride ?? null : runStride === null ? null : round(runStride, 3),
  }, {
    gear: new Map(slots.map(slot => [slot.name, gearEvents(c, baked.get(slot.name)?.gearHolds, id => exportedGear.has(id))])),
    variants: variantsField(c, spec.clips),
    own: ownFits,
    companion: comp === null ? undefined : { prefix: comp.spec.prefix, events: compEvents },
  })
  // (the sound files its events play, beside the build record, for the game's build to install)
  copySounds(events, { unit: me.dir, companion: comp?.dir }, path.join(srcDir, 'sounds'), warn)
  writeFileSync(path.join(o.modelsDir, `${unit}.events.json`), JSON.stringify(events, null, 1) + '\n')
  const record: BuildRecord = {
    schema: 4,
    unit,
    generator: 'rigsmith tools/game_export.ts',
    run: o.runToken ?? null,
    rigsmith: { commit: commit(), character: spec.character, name: c.name, rig: c.skin.report?.method ?? null },
    height: spec.height,
    scale: round(s, 5),
    bones: bones.length,
    triangles: { source: tris0, budget: spec.budget, lods: lodReport, head: headReport.length > 0 ? headReport : undefined, parts: partReport },
    clips: clipReport,
    gear: gearReport,
    companion: compReport,
    // (a rider's stride is his horse's)
    walkStride: ride !== null ? compReport!.walkStride : walkStride === null ? null : round(walkStride, 3),
    runStride: ride !== null ? compReport!.runStride : runStride === null ? undefined : round(runStride, 3),
    mount: ride?.mount,
    texture: image === null ? null : { file: `base.${image.ext}`, sha256: sha256(image.bytes) },
    rigged: { file: path.relative(o.workspace, me.file), sha256: sha256(rigged) },
    slots: recordSlots(c, stored),
    events,
    hands: c.hands.hold ?? {},
    gearIds: Object.fromEntries(c.gear.map(g => [g.id, {
      name: g.name, from: g.from, handles: g.handles.length > 0 ? Object.fromEntries(g.handles.map(h => [h.id, h.name])) : undefined,
    }])),
    warnings,
  }
  writeFileSync(path.join(srcDir, 'rigsmith.json'), JSON.stringify(record, null, 1) + '\n')
  return record
}

// ---- clips in game units (pure) ---------------------------------------------------------------------------------

/** A clip in game units: every move scaled by `s`, the top bone's (the one under the unit's root) lowered by `floor`
 * first, so the soles stand at 0 as the body does. */
export function scalePositions (clip: THREE.AnimationClip, s: number, floor: number, top: string): THREE.AnimationClip {
  const tracks = clip.tracks.map(t => {
    if (!t.name.endsWith('.position')) return t
    const copy = t.clone()
    const values = copy.values
    const lower = t.name === `${top}.position` ? floor : 0
    for (let i = 0; i < values.length; i += 3) {
      values[i] *= s
      values[i + 1] = (values[i + 1] - lower) * s
      values[i + 2] *= s
    }
    return copy
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** A rider's clip with his hips hung from his horse's seat bone: their moves and turns taken from the unit's root's
 * frame into the seat bone's (`seat`: the root's frame in the seat bone's). */
export function seatClip (clip: THREE.AnimationClip, hips: string, seat: THREE.Matrix4): THREE.AnimationClip {
  const turn = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(seat))
  const tracks = clip.tracks.map(t => {
    if (t.name === `${hips}.position`) {
      const copy = t.clone(); const v = new THREE.Vector3()
      for (let i = 0; i < copy.values.length; i += 3) v.fromArray(copy.values, i).applyMatrix4(seat).toArray(copy.values, i)
      return copy
    }
    if (t.name === `${hips}.quaternion`) {
      const copy = t.clone(); const q = new THREE.Quaternion()
      for (let i = 0; i < copy.values.length; i += 4) q.fromArray(copy.values, i).premultiply(turn).toArray(copy.values, i)
      return copy
    }
    return t
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** A companion's clip (in its own units) as it plays in the unit: scaled and grounded as its body is, on its prefixed
 * bones, its top bone's keys placed as its top bone is (turned by `yaw` about +Y, moved to `at`). */
export function placeCompanionClip (clip: THREE.AnimationClip, p: { s: number, floor: number, top: string, prefix: string, yaw: THREE.Quaternion, at: THREE.Vector3 }): THREE.AnimationClip {
  const tracks = scalePositions(clip, p.s, p.floor, p.top).tracks.map(t => {
    const copy = t.clone()
    const dot = t.name.lastIndexOf('.')
    const bone = t.name.slice(0, dot); const prop = t.name.slice(dot + 1)
    copy.name = `${p.prefix}${bone}.${prop}`
    if (bone === p.top && prop === 'position') {
      const v = new THREE.Vector3()
      for (let i = 0; i < copy.values.length; i += 3) v.fromArray(copy.values, i).applyQuaternion(p.yaw).add(p.at).toArray(copy.values, i)
    }
    if (bone === p.top && prop === 'quaternion') {
      const q = new THREE.Quaternion()
      for (let i = 0; i < copy.values.length; i += 4) q.fromArray(copy.values, i).premultiply(p.yaw).toArray(copy.values, i)
    }
    return copy
  })
  return new THREE.AnimationClip(clip.name, clip.duration, tracks)
}

/** Two loops played together by whole cycles (m of the unit's, n of its companion's, up to six each): the pair whose
 * lengths agree best, and how far apart they are as a share of the unit's. */
export function wholeCycles (main: number, other: number): { m: number, n: number, err: number } {
  let m = 1; let n = 1; let err = Infinity
  for (let mm = 1; mm <= 6; mm++) {
    for (let nn = 1; nn <= 6; nn++) {
      const e = Math.abs(mm * main - nn * other) / (mm * main)
      if (e < err - 1e-9) { err = e; m = mm; n = nn }
    }
  }
  return { m, n, err }
}

/** The slots as the build record keeps them: whole, every adjustment (disabled ones too), gear referred to by its name
 * (ids are this character's own; a character rebuilt from the record shares the names). */
export function recordSlots (c: Pick<Character, 'gear'>, slots: Slot[]): Slot[] {
  const name = (id: string): string => gearById(c, id)?.name ?? id
  return slots.map(slot => {
    const copy = structuredClone(slot)
    if (copy.gear !== undefined) copy.gear = byGearName(c, copy.gear)
    if (copy.muted !== undefined) copy.muted = copy.muted.map(m => (m.startsWith('gear:') ? `gear:${name(m.slice(5))}` : m))
    for (const a of copy.adjustments) {
      if (a.kind === 'handleHold') a.gear = name(a.gear)
      if (a.kind === 'handPose' && a.gear !== undefined) a.gear = name(a.gear)
    }
    return copy
  })
}

/** Where a clip's events land in the clip as exported: its cycles repeated `repeat` times over the first `share` of it
 * (a companion's tracks can make the whole longer). */
export interface EventFit { repeat: number, share: number }

/** Events as phases of the clip as exported: those inside the clip (bake.ts eventsInClip: one outside it would land in
 * another cycle, or inside the whole when the clip is a share of it) repeated per cycle, then scaled into its share of
 * the whole. */
export function fitEvents (events: BakedEvent[], fit: EventFit): BakedEvent[] {
  const n = Math.max(1, fit.repeat)
  const at = (t: number, k: number): number => ((t + k) / n) * fit.share
  const inside = eventsInClip(events)
  return Array.from({ length: n }, (_, k) => inside.map(e => ({ ...e, t: at(e.t, k), ...(e.to !== undefined ? { to: at(e.to, k) } : {}) }))).flat()
}

/** The events file (src/model/unit.ts UnitEvents): each exported clip's loop, length and events as it was exported
 * (`clips`, in the slots' order; `baked`: after a ride's fit, which repeated a loop's events per cycle). `more.gear`:
 * each clip's gear events (src/engine/geartracks.ts gearEvents), among its own (after them at the same t);
 * `more.variants`: the clips that have variants (src/model/variants.ts variantsField); `more.own`: how a companion's fit
 * placed the unit's own clip in the whole. A companion's events (`more.companion`, phases of the whole already) go under
 * `companion`, their bones prefixed, when it has any. */
export function eventsFile (unit: string, slots: Slot[], clips: THREE.AnimationClip[], baked: Map<string, BakedSlot>, strides: { walk: number | null, run: number | null },
  more: {
    gear?: Map<string, Array<{ t: number, name: string, bone?: string }>>, variants?: Record<string, string[]>
    own?: Map<string, EventFit>, companion?: { prefix: string, events: Map<string, BakedEvent[]> }
  } = {}): UnitEvents {
  const out: UnitEvents = { unit, schema: 1, clips: {}, walkStride: strides.walk, runStride: strides.run, ...(more.variants !== undefined ? { variants: more.variants } : {}) }
  slots.forEach((slot, i) => {
    const b = baked.get(slot.name)
    const fit = more.own?.get(slot.name)
    // (its own and its gear's, both phases of the clip as baked, placed in the whole as a companion's fit placed it)
    const mine: BakedEvent[] = [...(b?.events ?? []), ...(more.gear?.get(slot.name) ?? []).map((e, k) => ({ id: `gear-${k}`, ...e }))]
    const own = fit === undefined ? mine : fitEvents(mine, fit)
    out.clips[slot.name] = { loop: slot.loop, seconds: round(clips[i].duration, 3), events: unitEvents(own) }
  })
  const comp = more.companion
  if (comp !== undefined) {
    const clipsOf: Record<string, { events: UnitEvent[] }> = {}
    for (const slot of slots) {
      const es = unitEvents((comp.events.get(slot.name) ?? []).map(e => (e.bone !== undefined ? { ...e, bone: comp.prefix + e.bone } : e)))
      if (es.length > 0) clipsOf[slot.name] = { events: es }
    }
    if (Object.keys(clipsOf).length > 0) out.companion = { prefix: comp.prefix, clips: clipsOf }
  }
  return out
}

/** Baked events as the game reads them: inside the clip (a span clipped to it), phases rounded to 1e-4, sorted. */
function unitEvents (events: BakedEvent[]): UnitEvent[] {
  return eventsInClip(events).map(e => ({
    t: round(Math.min(1, Math.max(0, e.t)), 4), name: e.name,
    ...(e.to !== undefined ? { to: round(Math.min(1, Math.max(0, e.to)), 4) } : {}),
    ...(e.sound !== undefined ? { sound: e.sound } : {}), ...(e.bone !== undefined ? { bone: e.bone } : {}),
    ...(e.volume !== undefined && e.volume !== 1 ? { volume: round(e.volume, 3) } : {}),
    ...(e.pitch !== undefined && e.pitch !== 1 ? { pitch: round(e.pitch, 3) } : {}),
  })).sort((a, b) => a.t - b.t)
}

/** A sound file an event plays: 'file:sounds/<file>' (a plain file name of the character's sounds/ folder), else null. */
export function soundFile (sound: string | undefined): string | null {
  const m = sound === undefined ? null : /^file:sounds\/([\w.-]+)$/.exec(sound)
  return m === null || m[1].startsWith('.') ? null : m[1]
}

/** The files the events play, copied from each character's sounds/ folder into `to` (emptied first, so a sound no event
 * plays any more doesn't linger), where the game's build installs them. A companion's are copied under its prefix
 * (`horse_neigh.wav`: two characters may each have a neigh.wav) and its events renamed to match; a name another file
 * took already (the unit's own horse_neigh.wav) is numbered (`horse_neigh_2.wav`). A file that is gone is warned about
 * and its events keep no sound. */
export function copySounds (events: UnitEvents, from: { unit: string, companion?: string }, to: string, warn: (line: string) => void): string[] {
  rmSync(to, { recursive: true, force: true })
  const copied: string[] = []
  // (each source file's name as copied: one name a file)
  const nameOf = new Map<string, string>()
  const nameFor = (src: string, want: string): string => {
    const had = nameOf.get(src)
    if (had !== undefined) return had
    const ext = path.extname(want); const stem = want.slice(0, want.length - ext.length)
    let name = want
    for (let n = 2; copied.includes(name); n++) name = `${stem}_${n}${ext}`
    nameOf.set(src, name)
    return name
  }
  const take = (list: UnitEvent[], dir: string | undefined, prefix: string, where: string): void => {
    for (const e of list) {
      const file = soundFile(e.sound)
      if (e.sound?.startsWith('file:') === true && file === null) { warn(`${where}: ${e.name} plays ${e.sound}, which isn't a file of its sounds folder: left silent`); delete e.sound; continue }
      if (file === null) continue
      const src = dir === undefined ? null : path.join(dir, 'sounds', file)
      if (src === null || !existsSync(src)) { warn(`${where}: ${e.name} plays sounds/${file}, which is gone: left silent`); delete e.sound; continue }
      const name = nameFor(path.resolve(src), prefix + file)
      if (!copied.includes(name)) {
        mkdirSync(to, { recursive: true })
        copyFileSync(src, path.join(to, name))
        copied.push(name)
      }
      e.sound = `file:sounds/${name}`
    }
  }
  for (const [clip, x] of Object.entries(events.clips)) take(x.events, from.unit, '', clip)
  if (events.companion !== undefined) {
    const prefix = events.companion.prefix.toLowerCase().replace(/[^a-z0-9]+/g, '_')
    for (const [clip, x] of Object.entries(events.companion.clips)) take(x.events, from.companion, prefix, `${clip} (${events.companion.prefix})`)
  }
  return copied
}

// ---- inside ---------------------------------------------------------------------------------------------------------

/** A character of the unit as the viewer holds it: its record, its rigged body at rest, and what the bake needs. */
interface Subject { c: Character, dir: string, file: string, view: CharacterView, ctx: BakeContext }

/** The unit's companion: what the bake needs, and its own copy of its body to place under the unit's root. */
interface Companion extends Subject {
  spec: CompanionSpec
  mesh: THREE.SkinnedMesh
  /** Its top bone (a creature rig's own root above the pelvis, or the pelvis): every bone hangs from it. */
  top: THREE.Bone
  /** Its body in its file's world space, its lowest point, and game units per its own. */
  geometry: THREE.BufferGeometry
  floor: number
  s: number
}

interface Part { geometry: THREE.BufferGeometry, material: THREE.Material | THREE.Material[], name: string, pulled?: Set<number> }

interface PullBone { bone: THREE.Bone, parent: THREE.Bone, hand: THREE.Bone, gear: Gear, handle: PullHandle, rest: THREE.Vector3 }

type Audit = Record<string, { name: string, problems: Array<{ rule: string, motion: string }> }>

async function subject (unit: string, id: string, workspace: string, shared: HandPose[] | undefined): Promise<Subject> {
  const c = character(id, workspace)
  if (c.files.rigged === undefined) throw new Error(`${unit}: ${c.name} (${id}) is not rigged`)
  const dir = path.join(workspace, 'characters', id)
  const file = path.join(dir, c.files.rigged)
  const view = new CharacterView((await load(file)).scene)
  if (view.rest === null) throw new Error(`${unit}: ${c.name}'s ${c.files.rigged} has no skeleton`)
  return { c, dir, file, view, ctx: { rest: view.rest, posable: view.root, clips: nodeClipSource(view.rest, workspace), fps: FPS, sharedPoses: shared, rom: nodeRom } }
}

async function companionOf (unit: string, spec: CompanionSpec, workspace: string, shared: HandPose[] | undefined): Promise<Companion> {
  const sub = await subject(unit, spec.character, workspace, shared)
  const { scene } = await load(sub.file)
  scene.updateMatrixWorld(true)
  const skinned = skinnedIn(scene)
  if (skinned.length !== 1) throw new Error(`${unit}: companion ${spec.character}: expected one skinned mesh, found ${skinned.length}`)
  const mesh = skinned[0]
  const tops = mesh.skeleton.bones.filter(b => b.parent === null || !isBone(b.parent))
  if (tops.length !== 1) throw new Error(`${unit}: companion ${spec.character}: ${tops.length} top bones (${tops.map(b => b.name).join(', ')})`)
  if (!mesh.skeleton.bones.some(b => b.name === pelvisName(sub.ctx.rest))) throw new Error(`${unit}: companion ${spec.character}: no pelvis`)
  const geometry = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld)
  geometry.computeBoundingBox()
  const floor = geometry.boundingBox!.min.y
  return { ...sub, spec, mesh, top: tops[0], geometry, floor, s: spec.height / (geometry.boundingBox!.max.y - floor) }
}

/** A clip's line of the build record, as it was baked (before a ride fits it to the horse's). */
function clipRecord (c: Character, slot: Slot, b: BakedSlot, audit: Audit, warn: (line: string) => void): BuiltClip {
  const r: BuiltClip = { ...builtFrom(slot), seconds: round(b.clip.duration, 3) }
  const flagged = audit[slot.clip.id]
  if (flagged !== undefined) {
    for (const p of flagged.problems) warn(`${slot.name}: library clip ${slot.clip.id} "${flagged.name}" ${p.rule} ${p.motion}`)
    r.audit = flagged.problems.map(p => `${p.rule} ${p.motion}`)
  }
  for (const x of Object.values(b.report) as Array<Record<string, unknown>>) {
    if (x.kind === 'blow') Object.assign(r, { blow: x.blow, kept: x.kept, hit: x.at })
    if (x.kind === 'pace' && x.missing === true) warn(`${slot.name}: paced like a slot it no longer has`)
    else if (x.kind === 'pace') Object.assign(r, { pacedLike: x.like, retimed: x.retimed })
  }
  if (b.lift !== 0) r.lift = b.lift
  // (the keys as they played: phases of this clip, as game_import has always read them)
  const bones = Object.keys(b.boneKeys).length > 0 ? b.boneKeys : undefined
  const props = byGearName(c, Object.keys(b.gearKeys).length > 0 ? b.gearKeys : undefined)
  if (bones !== undefined || props !== undefined) {
    r.keys = { bones: counted(bones), props: counted(props) }
    r.keyData = { bones, props }
  }
  return r
}

/** What clip a slot plays and how, as the record says it. */
function builtFrom (slot: Slot): Pick<BuiltClip, 'clip' | 'url' | 'loop' | 'inPlace' | 'speed'> {
  return { clip: slot.clip.id, url: slot.clip.url, loop: slot.loop, inPlace: slot.inPlace, speed: slot.speed }
}

/** The windows (by slot name, phases of each exported clip as it plays alone) each slot holds a pull handle in. */
function holdsOf (baked: Map<string, BakedSlot>, g: Gear, h: PullHandle): Record<string, Array<[number, number]>> {
  const out: Record<string, Array<[number, number]>> = {}
  for (const [name, b] of baked) {
    for (const p of b.pulls) if (p.gear === g.id && p.handle === h.id) out[name] = p.windows
  }
  return out
}

/** Each pull bone's track over a clip in game units, as the viewer steps it (pulls.ts tickPulls): at each frame of the
 * clip's pose, from its rest point toward the drawing bone's grip as far as the slot holds it then (its windows, eased
 * by holdFactor), in the space of the bone the piece rides. At rest where the clip doesn't hold it (the game keeps a
 * bone where the last clip left it). Leaves the skeleton in its bind pose. */
function pullTracks (out: THREE.Object3D, skeleton: THREE.Skeleton, clip: THREE.AnimationClip, pulls: PullBone[], plans: PullPlan[], s: number): THREE.KeyframeTrack[] {
  const windows = new Map(pulls.map(pb => [pb, plans.filter(p => p.gear === pb.gear.id && p.handle === pb.handle.id).flatMap(p => p.windows)]))
  const held = pulls.filter(pb => windows.get(pb)!.length > 0)
  const times = held.length > 0 ? frameTimes(clip.duration) : [0, clip.duration]
  const values = new Map(pulls.map(pb => [pb, held.includes(pb) ? [] as number[] : [...pb.rest.toArray(), ...pb.rest.toArray()]]))
  if (held.length > 0) {
    skeleton.pose()
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
        grip.set(...pb.handle.pull.grip).multiplyScalar(s).applyMatrix4(pb.hand.matrixWorld)
        const f = holdFactor(windows.get(pb), clip.duration > 0 ? t / clip.duration : 0)
        values.get(pb)!.push(...pb.rest.clone().lerp(pb.parent.worldToLocal(grip.clone()), THREE.MathUtils.clamp(f, 0, 1)).toArray())
      }
    }
    action.stop()
    mixer.uncacheRoot(out)
    skeleton.pose()
  }
  return pulls.map(pb => new THREE.VectorKeyframeTrack(`${pb.bone.name}.position`, held.includes(pb) ? times : [0, clip.duration], values.get(pb)!))
}

/** How a clip moves, as shares of the unit's height: the lesser foot's swing front to back, the hips' median height. */
function clipStats (root: THREE.Object3D, clip: THREE.AnimationClip, height: number): { footSwing: number, hipsMedian: number } {
  const { at } = sample(root, clip, ['LeftFoot', 'RightFoot', 'Hips'], 15)
  const swing = (n: string): number => {
    const z = at.get(n)!.map(v => v.z)
    return Math.max(...z) - Math.min(...z)
  }
  const hips = at.get('Hips')!.map(v => v.y).sort((a, b) => a - b)
  return { footSwing: round(Math.min(swing('LeftFoot'), swing('RightFoot')) / height, 3), hipsMedian: round(hips[Math.floor(hips.length / 2)] / height, 3) }
}

/** A gear model's meshes placed by `placement` over their own nodes (position, normal and uv kept), each with its
 * surface: the body's Main, or its own by name (the game binds a surface's maps by its material's name: Main,
 * Atlas_<set>, Trim_<sheet>). */
async function gearModel (file: string, g: Pick<Gear, 'origin'>, placement: THREE.Matrix4, main: THREE.Material): Promise<{ geos: THREE.BufferGeometry[], mats: THREE.Material[], animations: string[] }> {
  const { scene, animations } = await load(file)
  scene.updateMatrixWorld(true)
  const geos: THREE.BufferGeometry[] = []; const mats: THREE.Material[] = []
  // (its origin at zero first, as the viewer loads it: garments.ts originMatrix)
  const own = g.origin === undefined ? placement : placement.clone().multiply(originMatrix(g))
  scene.traverse(o => {
    const m = o as THREE.Mesh
    if (m.isMesh !== true) return
    const geo = m.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(own, m.matrixWorld))
    for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name)
    geos.push(geo)
    const loaded = Array.isArray(m.material) ? m.material[0] : m.material
    mats.push(/^Main(\.\d+)?$/.test(loaded.name) ? main : new THREE.MeshStandardMaterial({ name: loaded.name }))
  })
  return { geos, mats, animations: animations.map(a => a.name) }
}

/** The base colour image a GLB embeds, and its extension. */
function baseImage (bytes: Uint8Array): { bytes: Uint8Array, ext: string } | null {
  const glb = readGlb(bytes)
  const i = baseColorImage(glb)
  const image = i === null ? null : imageBytes(glb, i)
  return i === null || image === null ? null : { bytes: image, ext: glb.json.images?.[i]?.mimeType === 'image/jpeg' ? 'jpg' : 'png' }
}

/** The library audit (tools/library_audit.py): clips whose motion contradicts their library name, by id. */
function readAudit (workspace: string): Audit {
  const file = path.join(workspace, 'library', 'audit.json')
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { clips?: Audit }).clips ?? {} : {}
}

function skinnedIn (root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = []
  root.traverse(o => { if ((o as THREE.SkinnedMesh).isSkinnedMesh === true) out.push(o as THREE.SkinnedMesh) })
  return out
}

/** A new bone for a gear piece, refused when the name is taken (the game finds them by name). */
function newBone (bones: THREE.Bone[], name: string, unit: string, g: Gear): THREE.Bone {
  if (bones.some(b => b.name === name)) throw new Error(`${unit}: ${g.name}: a second bone named ${name}`)
  const bone = new THREE.Bone()
  bone.name = name
  return bone
}

function setSkin (geo: THREE.BufferGeometry, indices: Uint16Array, weights: Float32Array): void {
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4))
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4))
}

function merged (geos: THREE.BufferGeometry[], unit: string, g: Gear): THREE.BufferGeometry {
  const geo = geos.length === 1 ? geos[0] : mergeGeometries(geos, true)
  if (geo === null) throw new Error(`${unit}: ${g.name}: its meshes can't be joined (their attributes differ)`)
  return geo
}

/** A mesh of the unit, tangents computed where it can have them, added to `meshes` (bound to the skeleton later). */
function skinnedMesh (name: string, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], meshes: THREE.SkinnedMesh[]): THREE.SkinnedMesh {
  if (geo.attributes.uv !== undefined && geo.index !== null) geo.computeTangents()
  const mesh = new THREE.SkinnedMesh(geo, mat)
  mesh.name = name
  meshes.push(mesh)
  return mesh
}

function withTracks (clip: THREE.AnimationClip, extra: THREE.KeyframeTrack[]): THREE.AnimationClip {
  return extra.length === 0 ? clip : new THREE.AnimationClip(clip.name, clip.duration, [...clip.tracks, ...extra])
}

function byGearName<T> (c: Pick<Character, 'gear'>, byId: Record<string, T> | undefined): Record<string, T> | undefined {
  return byId === undefined ? undefined : Object.fromEntries(Object.entries(byId).map(([id, v]) => [gearById(c, id)?.name ?? id, v]))
}

function counted (t: Record<string, ClipKey[]> | undefined): Record<string, number> | undefined {
  return t === undefined || Object.keys(t).length === 0 ? undefined : Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.length]))
}

function commit (): string {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() } catch { return 'unknown' }
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const round = (x: number, digits: number): number => +x.toFixed(digits)
