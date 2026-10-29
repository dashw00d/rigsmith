// @vitest-environment node
// The game's contract on a unit built end to end (DESIGN.md §9): the fixture character (./fixture.ts) exported with
// tools/lib/unit_export.ts exportUnit, its GLB read back as the game reads it, and checked against the game's rules:
// mesh names and levels, one Main material, a root bone above Hips, Prop_ bones for keyed gear and pulls, LOD0 within
// the budget, soles at 0, the clips under their game names, tangents, and the build record. Then parity by
// construction: what the viewer bakes (src/engine/bake.ts bakeSlot on the character as the viewer holds it) and what
// the export plays agree on the bones, on a point of the gear and on the pull, once the export's scale and floor are
// taken into account.
//
// RIGSMITH_CONTRACT_KEEP=1 keeps the temp workspace and prints where the unit's GLB is (for tests/godot/check_export.gd).
import { BOW, BOW_NAME, BOW_PLACE, BOW_TIP, bowGear, BUDGET, buildFixture, CHARACTER, FLOOR, GAME_HEIGHT, GRIP, HEIGHT, HOLD, LEVEL, STRING_REST, UNIT, writeVariant, type Fixture } from './fixture.ts'
import { readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bakeSlot, type BakeContext } from '../../src/engine/bake.ts'
import { CharacterView } from '../../src/engine/CharacterView.ts'
import { failing, gearBones, unitChecks } from '../../src/engine/checks.ts'
import { STEP_SWING } from '../../src/engine/contract.ts'
import { boneFrame } from '../../src/engine/garments.ts'
import { gearNode, safeName } from '../../src/engine/geom.ts'
import { readGlb, type Gltf } from '../../src/engine/glb.ts'
import { loadGlb, loadGlbFile } from '../../src/engine/headless.ts'
import { frameTimes } from '../../src/engine/keys.ts'
import { garmentMatrix } from '../../src/engine/placement.ts'
import { slotByName } from '../../src/model/select.ts'
import { humanHierarchy } from '../../src/model/skeletons.ts'
import type { Adjustment, Gear, Vec3 } from '../../src/model/types.ts'
import type { BuildRecord } from '../../src/model/unit.ts'
import { nodeClipSource } from '../../tools/lib/node3d.ts'
import { exportUnit } from '../../tools/lib/unit_export.ts'

/** Game units per character unit, and how near the game must be to the viewer (a thousandth of its height). */
const S = GAME_HEIGHT / HEIGHT
const NEAR = 1e-3 * GAME_HEIGHT
const PROP = `Prop_${safeName(BOW_NAME)}`
const PULL = `Prop_${safeName(BOW_NAME)}_String`
/** Bones the parity test follows: the body's mover, a foot, both hands, the head, a finger the carried bow closes. */
const BONES = ['Hips', 'LeftFoot', 'RightHand', 'LeftHand', 'Head', 'RightHandIndex3']
const SLOW = 120_000

/** A point of the character's rest space where the export puts it: scaled to the game's height, its soles at 0. */
const toGame = (v: THREE.Vector3): THREE.Vector3 => new THREE.Vector3(v.x * S, (v.y - FLOOR) * S, v.z * S)
const vec = (v: Vec3, scale = 1): THREE.Vector3 => new THREE.Vector3(...v).multiplyScalar(scale)
/** A point in `o`'s own frame, in world space. */
const world = (o: THREE.Object3D, local: THREE.Vector3 = new THREE.Vector3()): THREE.Vector3 => local.clone().applyMatrix4(o.matrixWorld)

function named (root: THREE.Object3D, name: string): THREE.Object3D {
  const o = root.getObjectByName(name)
  if (o === undefined) throw new Error(`no ${name}`)
  return o
}

/** What `read` sees with `clip` played to `t` on `root` (once, held at its end: how the export samples a clip), every
 * node put back after. */
function posed<T> (root: THREE.Object3D, clip: THREE.AnimationClip, t: number, read: () => T): T {
  const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = []
  root.traverse(o => { saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]) })
  const mixer = new THREE.AnimationMixer(root)
  const action = mixer.clipAction(clip)
  action.setLoop(THREE.LoopOnce, 1)
  action.clampWhenFinished = true
  action.play()
  mixer.setTime(t)
  root.updateMatrixWorld(true)
  try {
    return read()
  } finally {
    action.stop()
    mixer.uncacheRoot(root)
    for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s) }
    root.updateMatrixWorld(true)
  }
}

let fx: Fixture
let record: BuildRecord
let json: Gltf
let game: GLTF
/** The character as the viewer holds it: its rigged body, the bow's place node on its hand, what the bake needs. */
let viewer: { view: CharacterView, place: THREE.Object3D, ctx: BakeContext }

const bow = (): Gear => fx.character.gear.find(g => g.id === BOW)!
const nodeIndex = (name: string): number => {
  const i = json.nodes!.findIndex(n => n.name === name)
  if (i < 0) throw new Error(`no node ${name} in ${UNIT}.glb`)
  return i
}
const parentOf = (name: string): string | undefined => json.nodes!.find(n => n.children?.includes(nodeIndex(name)))?.name
const meshOf = (name: string): NonNullable<Gltf['meshes']>[number] => {
  const mesh = json.nodes![nodeIndex(name)].mesh
  if (mesh === undefined) throw new Error(`${name} is not a mesh`)
  return json.meshes![mesh]
}
const trianglesOf = (name: string): number => meshOf(name).primitives.reduce((n, p) => n + json.accessors![p.indices!].count / 3, 0)
const gameClip = (name: string): THREE.AnimationClip => {
  const clip = game.animations.find(a => a.name === name)
  if (clip === undefined) throw new Error(`no clip ${name} in ${UNIT}.glb`)
  return clip
}

beforeAll(async () => {
  fx = await buildFixture()
  record = await exportUnit(UNIT, fx.spec, { workspace: fx.workspace, modelsDir: fx.modelsDir, workDir: fx.workDir, runToken: 'test-run' })
  const bytes = readFileSync(path.join(fx.modelsDir, `${UNIT}.glb`))
  json = readGlb(bytes).json
  game = await loadGlb(bytes)
  game.scene.updateMatrixWorld(true)

  const view = new CharacterView((await loadGlbFile(fx.rigged)).scene)
  const a = bow().attach
  if (view.rest === null || a.kind !== 'bone') throw new Error('fixture: no rest skeleton, or the bow is not on a bone')
  // (the bow's frame on its hand as the gear area puts it on: the node its gear tracks move)
  const frame = boneFrame(view, bow(), a.bone, a.place)
  if (frame === null) throw new Error('fixture: no bone for the bow')
  viewer = { view, place: frame.place, ctx: { rest: view.rest, posable: view.root, clips: nodeClipSource(view.rest, fx.workspace), fps: 30 } }
}, SLOW)

afterAll(() => {
  if (fx === undefined) return
  if (process.env.RIGSMITH_CONTRACT_KEEP !== undefined) console.log(`contract unit kept: ${path.join(fx.modelsDir, `${UNIT}.glb`)}`)
  else rmSync(fx.workspace, { recursive: true, force: true })
})

describe('the unit export keeps the game\'s contract', () => {
  it('names the body after the unit and its levels <unit>_LOD1, _LOD2, each lighter than the one before', () => {
    const meshes = json.nodes!.filter(n => n.mesh !== undefined).map(n => n.name)
    expect(meshes.sort()).toEqual([BOW_NAME, UNIT, `${UNIT}_LOD1`, `${UNIT}_LOD2`].sort())
    expect(trianglesOf(`${UNIT}_LOD1`)).toBeLessThan(trianglesOf(UNIT))
    expect(trianglesOf(`${UNIT}_LOD2`)).toBeLessThan(trianglesOf(`${UNIT}_LOD1`))
    expect(record.triangles.lods).toEqual([UNIT, `${UNIT}_LOD1`, `${UNIT}_LOD2`].map(trianglesOf))
  })

  it('puts the body (and the gear on the body\'s maps) on one material, Main', () => {
    expect(json.materials!.map(m => m.name)).toEqual(['Main'])
    for (const name of [UNIT, `${UNIT}_LOD1`, `${UNIT}_LOD2`]) {
      const primitives = meshOf(name).primitives
      expect(primitives).toHaveLength(1)
      expect(json.materials![primitives[0].material!].name).toBe('Main')
    }
  })

  it('hangs the skeleton from a root bone above Hips', () => {
    expect(parentOf('Hips')).toBe('root')
    expect(parentOf('root')).toBe('Armature')
    const joints = new Set(json.skins!.flatMap(s => s.joints))
    expect(joints.has(nodeIndex('root'))).toBe(true)
    expect(joints.has(nodeIndex('Hips'))).toBe(true)
    // (every bone of the character, the root, the bow's own bone and its string's)
    expect(record.bones).toBe(humanHierarchy(LEVEL).length + 3)
    for (const skin of json.skins!) expect(skin.joints).toHaveLength(record.bones)
  })

  it('gives the keyed bow a Prop_ bone on its hand and its pull one under that: the bones the Ship checks name', () => {
    expect(parentOf(PROP)).toBe('RightHand')
    expect(parentOf(PULL)).toBe(PROP)
    const props = json.nodes!.map(n => n.name ?? '').filter(n => n.startsWith('Prop_')).sort()
    expect(props).toEqual([PROP, PULL])
    expect(gearBones(fx.character, fx.spec.clips).map(x => x.bone).sort()).toEqual(props)
    // (the viewer's place node is the viewer's: the game moves the bow by its bone)
    expect(json.nodes!.some(n => n.name === gearNode(bow()))).toBe(false)
  })

  it('brings LOD0 within the budget, gear included', () => {
    expect(record.triangles.source).toBe(fx.character.source.stats!.triangles)
    expect(record.triangles.source).toBeGreaterThan(BUDGET)
    expect(record.triangles.budget).toBe(BUDGET)
    expect(record.triangles.parts[BOW_NAME]).toEqual([trianglesOf(BOW_NAME)])
    expect(trianglesOf(UNIT) + trianglesOf(BOW_NAME)).toBeLessThanOrEqual(BUDGET)
  })

  it('stands the soles at y = 0 and the head at the unit\'s height, in the bind pose', () => {
    const body = named(game.scene, UNIT) as THREE.SkinnedMesh
    expect(body.isSkinnedMesh).toBe(true)
    body.geometry.computeBoundingBox()
    const box = body.geometry.boundingBox!
    expect(Math.abs(box.min.y)).toBeLessThan(NEAR)
    expect(Math.abs(box.max.y - GAME_HEIGHT)).toBeLessThan(NEAR)
    expect(record.height).toBe(GAME_HEIGHT)
    expect(record.scale).toBeCloseTo(S, 4)
    const skeleton = JSON.parse(readFileSync(path.join(fx.workDir, UNIT, 'skeleton.json'), 'utf8')) as { height: number, joints: Record<string, number[]> }
    expect(skeleton.height).toBe(GAME_HEIGHT)
    expect(skeleton.joints.HeadTop_End[1]).toBeCloseTo(GAME_HEIGHT, 3)
    expect(skeleton.joints.root.every(x => Math.abs(x) < 1e-9)).toBe(true)
    expect(skeleton.joints['grip.R']).toHaveLength(3)
  })

  it('places the bow and its string where Rigsmith places them', () => {
    // (at rest: the bow's own bone carries no scale, so a point of the model sits at its placed, game-scaled offset)
    const placed = garmentMatrix(BOW_PLACE)
    const tip = world(named(game.scene, PROP), vec(BOW_TIP, S * BOW_PLACE.scale))
    expect(tip.distanceTo(toGame(vec(BOW_TIP).applyMatrix4(placed)))).toBeLessThan(NEAR)
    expect(world(named(game.scene, PULL)).distanceTo(toGame(vec(STRING_REST).applyMatrix4(placed)))).toBeLessThan(NEAR)
  })

  it('computes tangents for every mesh', () => {
    for (const name of [UNIT, `${UNIT}_LOD1`, `${UNIT}_LOD2`, BOW_NAME]) {
      expect(meshOf(name).primitives.every(p => p.attributes.TANGENT !== undefined), name).toBe(true)
    }
  })

  it('plays the unit\'s clips under their game names, and no trial', () => {
    expect(json.animations!.map(a => a.name)).toEqual(fx.spec.clips)
    expect(game.animations.map(a => a.name)).toEqual(fx.spec.clips)
    expect(Object.keys(record.clips)).toEqual(fx.spec.clips)
  })

  it('writes the build record: the run, the strides, the clips as baked, the slots and the gear by name', () => {
    expect(JSON.parse(readFileSync(path.join(fx.workDir, UNIT, 'rigsmith.json'), 'utf8'))).toEqual(record)
    expect(record).toMatchObject({ schema: 4, unit: UNIT, run: 'test-run', rigsmith: { character: CHARACTER, name: 'Tester' } })
    expect(record.rigged.file).toBe(path.join('characters', CHARACTER, 'rigged.glb'))
    expect(record.texture).toBeNull()
    expect(record.hands).toEqual({})
    expect(record.warnings).toEqual([])

    expect(record.walkStride).toBeGreaterThan(0)
    expect(record.runStride).toBeGreaterThan(record.walkStride!)
    expect(record.clips.Walk.footSwing).toBeGreaterThanOrEqual(STEP_SWING)
    expect(record.clips.Run.footSwing).toBeGreaterThanOrEqual(STEP_SWING)
    expect(record.clips.Run.speed).toBe(1.5)
    expect(record.clips.Idle.lift).toBe(0.02)
    expect(record.clips.Attack).toMatchObject({ blow: 0.5, hit: 0.45, loop: false })
    expect(record.clips.Attack.kept![0]).toBeCloseTo(0.05 / 0.55, 2)
    expect(record.clips.Attack.kept![1]).toBe(1)
    expect(record.clips.Walk.keyData?.props).toEqual({ [BOW_NAME]: expect.any(Array) })

    expect(record.slots.map(x => x.name)).toEqual(fx.spec.clips)
    const of = <K extends Adjustment['kind']> (slot: string, kind: K): Extract<Adjustment, { kind: K }> =>
      record.slots.find(x => x.name === slot)!.adjustments.find((a): a is Extract<Adjustment, { kind: K }> => a.kind === kind)!
    expect(Object.keys(record.slots.find(x => x.name === 'Walk')!.gear!)).toEqual([BOW_NAME])
    // (the slots as stored: source time, gear by name)
    const stored = slotByName(fx.character, 'Attack')!.adjustments.find(a => a.kind === 'handleHold')!
    expect(of('Attack', 'handleHold')).toMatchObject({ gear: BOW_NAME, handle: 'string', windows: stored.kind === 'handleHold' ? stored.windows : [] })
    // (the events file beside the GLB: the hit where the fit landed it, nothing else)
    expect(record.events.clips.Attack).toEqual({ loop: false, seconds: record.clips.Attack.seconds, events: [{ t: 0.45, name: 'hit' }] })
    expect(record.events.clips.Walk.events).toEqual([])
    expect(JSON.parse(readFileSync(path.join(fx.modelsDir, `${UNIT}.events.json`), 'utf8'))).toEqual(record.events)
    expect(record.gearIds).toEqual({ [BOW]: { name: BOW_NAME, from: `emberhold:${UNIT}/${BOW_NAME}`, handles: { carry: 'Carried', string: 'String' } } })
    expect(record.gear[BOW_NAME]).toMatchObject({
      kind: 'prop', bone: 'RightHand', propBone: PROP,
      pulls: [{ id: 'string', name: 'String', bone: 'LeftHand', holds: { Attack: [[expect.closeTo(HOLD[0], 9), expect.closeTo(HOLD[1], 9)]] } }],
    })
  })
})

describe('the viewer\'s bake and the export agree', () => {
  it.each(['Idle', 'Walk', 'Attack'])('%s: its bones, and the tip of the bow where the viewer shows it', async name => {
    const slot = slotByName(fx.character, name)!
    const baked = await bakeSlot(fx.character, slot, viewer.ctx)
    // (the viewer keys the bow's place node; the export its Prop_ bone)
    expect(baked.clip.tracks.some(t => t.name === `${gearNode(bow())}.quaternion`)).toBe(true)
    const clip = gameClip(name)
    expect(clip.duration).toBeCloseTo(baked.clip.duration, 4)
    const prop = named(game.scene, PROP)
    for (const u of [0.1, 0.35, 0.5, 0.8]) {
      const want = posed(viewer.view.root, baked.clip, u * baked.clip.duration, () => ({
        bones: BONES.map(b => toGame(world(named(viewer.view.root, b)))),
        tip: toGame(world(viewer.place, vec(BOW_TIP))),
      }))
      const got = posed(game.scene, clip, u * clip.duration, () => ({
        bones: BONES.map(b => world(named(game.scene, b))),
        tip: world(prop, vec(BOW_TIP, S * BOW_PLACE.scale)),
      }))
      BONES.forEach((b, i) => expect(got.bones[i].distanceTo(want.bones[i]), `${name} ${b} at ${u}`).toBeLessThan(NEAR))
      expect(got.tip.distanceTo(want.tip), `${name} bow tip at ${u}`).toBeLessThan(NEAR)
    }
  }, SLOW)

  it('draws the string to the left hand\'s grip while Attack holds it, and rests it on the bow outside', async () => {
    const baked = await bakeSlot(fx.character, slotByName(fx.character, 'Attack')!, viewer.ctx)
    expect(baked.pulls).toEqual([{ gear: BOW, handle: 'string', bone: 'LeftHand', windows: [[expect.closeTo(HOLD[0], 9), expect.closeTo(HOLD[1], 9)]] }])
    const clip = gameClip('Attack')
    const pull = named(game.scene, PULL)
    // (held: on a frame of the clip, where the export keys the pull)
    const n = frameTimes(clip.duration).length - 1
    const held = Math.round(0.4 * n) / n
    expect(held).toBeGreaterThan(HOLD[0])
    expect(held).toBeLessThan(HOLD[1])
    const grip = posed(viewer.view.root, baked.clip, held * baked.clip.duration, () => toGame(world(named(viewer.view.root, 'LeftHand'), vec(GRIP))))
    const got = posed(game.scene, clip, held * clip.duration, () => ({ pull: world(pull), grip: world(named(game.scene, 'LeftHand'), vec(GRIP, S)) }))
    expect(got.grip.distanceTo(grip)).toBeLessThan(NEAR)
    expect(got.pull.distanceTo(grip)).toBeLessThan(NEAR)
    // (let go: on the bow, where the viewer's string rests)
    for (const u of [0.05, 0.9]) {
      const rest = posed(viewer.view.root, baked.clip, u * baked.clip.duration, () => toGame(world(viewer.place, vec(STRING_REST))))
      const at = posed(game.scene, clip, u * clip.duration, () => world(pull))
      expect(at.distanceTo(rest), `string at ${u}`).toBeLessThan(NEAR)
    }
  }, SLOW)
})

describe('the export and the Ship checks refuse the same unit', () => {
  it('two gear bones of one name: a keyed piece named after the bow\'s pull', async () => {
    const c = structuredClone(fx.character)
    c.id = 'tester-clash01'
    // (a game part keyed in Walk whose Prop_ bone is the bow's string's)
    c.gear.push({ ...bowGear(), id: 'c1a50001', name: `${BOW_NAME} String`, from: 'emberhold:clashunit/Quiver', handles: [] })
    const walk = slotByName(c, 'Walk')!
    walk.gear = { ...walk.gear, c1a50001: walk.gear![BOW] }
    writeVariant(fx, c)
    const spec = { ...fx.spec, character: c.id, clips: ['Walk'] }
    expect(failing(unitChecks({ unit: 'clashunit', spec, character: c })).map(x => x.rule)).toEqual(['bone-names'])
    await expect(exportUnit('clashunit', spec, { workspace: fx.workspace, modelsDir: fx.modelsDir, workDir: fx.workDir }))
      .rejects.toThrow(`a second bone named ${PULL}`)
  }, SLOW)
})
