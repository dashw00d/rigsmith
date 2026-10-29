// The contract tests' unit (DESIGN.md §9), built from nothing in a temp workspace: a character as a finished rig leaves
// it (schema 2, rigged), and the files the unit export reads.
//   rigged.glb  a procedural Mixamo skeleton at the 'one' finger level (Hips .. HeadTop_End, arms, legs, an index finger
//               on each hand), T-posed, its soles FLOOR above 0 (the export must stand them on it), and one skinned mesh
//               of boxes, each rigid on its bone and cut finely enough that the export can simplify it into its budget
//   library     clips/test-walk.glb (legs and arms swinging: a walk the game's step check passes), test-idle.glb, and the
//               default fist (select.DEFAULT_FIST), which the bow carried in the right hand closes that hand to. They are
//               made on the same skeleton standing at 0, as a library clip is in its own space
//   gear        a bow on RightHand as tools/game_import.py brings in a game part ('emberhold:testunit/Weapons_RightHand'),
//               its string a pull handle the left hand draws
//   slots       Idle (a ground lift), Walk (keys on the bow), Run (the walk faster), Attack (blow timing, the string held,
//               keys on the spine), and a trial the unit doesn't play
// The character document alone (fixtureCharacter) needs no files: the Ship checks' tests use it as it is.
import '../../src/engine/headless.ts'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { humanJoints, makeRigged } from '../../src/model/fixtures.ts'
import { DEFAULT_FIST } from '../../src/model/select.ts'
import { humanHierarchy } from '../../src/model/skeletons.ts'
import { slotFromV2 } from '../../src/model/migrate.ts'
import type { Character, ClipKey, FingerLevel, Gear, Joints, Placement, Quat, Slot, Vec3 } from '../../src/model/types.ts'
import type { V2Slot } from '../../src/model/v2.ts'
import type { UnitSpec } from '../../src/model/unit.ts'

export const UNIT = 'testunit'
export const CHARACTER = 'tester-000001'
/** The bow's gear id. */
export const BOW = 'b0a00001'
export const BOW_NAME = 'Weapons_RightHand'
export const LEVEL: FingerLevel = 'one'
/** How far above 0 the soles are in rigged.glb, and the character's height (soles to the top of the head). */
export const FLOOR = 0.1
export const HEIGHT = 1.8
/** The unit in the game: its height, its LOD0 budget (under the body's own triangles, so the export simplifies it). */
export const GAME_HEIGHT = 2.4
export const BUDGET = 1200
export const CLIPS = ['Idle', 'Walk', 'Run', 'Attack']

/** The bow in the character's rest space: by the right hand, turned and a little bigger than its model. */
export const BOW_PLACE: Placement = { position: [-0.74, 1.45 + FLOOR, 0.02], rotation: [0, 15, 0], scale: 1.1 }
/** The top of the bow's stave, in its model's own space: the gear point the parity test follows. */
export const BOW_TIP: Vec3 = [0, 0.4, 0]
/** Where the string's pull rests (the bow model's space) and where the left hand holds it (LeftHand's rest frame). */
export const STRING_REST: Vec3 = [0, 0, -0.06]
export const GRIP: Vec3 = [0.06, 0, 0]
/** The window Attack holds the string in. */
export const HOLD: [number, number] = [0.2, 0.6]

/** Faces of each body box cut CUTS x CUTS. */
const CUTS = 3

const sided = (bone: string, centre: Vec3, size: Vec3): Array<[string, Vec3, Vec3]> => [
  [`Left${bone}`, centre, size], [`Right${bone}`, [-centre[0], centre[1], centre[2]], size],
]

// The body as boxes [bone, centre, size], standing at 0 (fixtures.ts humanJoints' T-pose: hands at 1.45, hips at 1).
const BOXES: Array<[string, Vec3, Vec3]> = [
  ['Hips', [0, 0.97, 0], [0.34, 0.16, 0.2]],
  ['Spine1', [0, 1.2, 0], [0.32, 0.3, 0.18]],
  ['Spine2', [0, 1.41, 0], [0.36, 0.18, 0.2]],
  ['Neck', [0, 1.54, 0], [0.08, 0.08, 0.08]],
  // (its top at 1.8, HeadTop_End: the character's height)
  ['Head', [0, 1.69, 0], [0.2, 0.22, 0.22]],
  ...sided('Arm', [0.275, 1.45, 0], [0.25, 0.08, 0.08]),
  ...sided('ForeArm', [0.525, 1.45, 0], [0.25, 0.07, 0.07]),
  ...sided('Hand', [0.7, 1.45, 0], [0.1, 0.02, 0.08]),
  ...sided('UpLeg', [0.1, 0.725, 0], [0.14, 0.45, 0.14]),
  ...sided('Leg', [0.1, 0.29, 0], [0.11, 0.42, 0.11]),
  // (the soles at 0)
  ...sided('Foot', [0.1, 0.04, 0.05], [0.1, 0.08, 0.25]),
]

/** The body's triangles and vertices as rigged.glb has them. */
export const BODY_TRIANGLES = BOXES.length * 6 * CUTS * CUTS * 2
const BODY_VERTICES = BOXES.length * 6 * (CUTS + 1) * (CUTS + 1)

/** The character's joints, `floor` up (rigged.glb's at FLOOR; the library clips' at 0). */
export function joints (floor = FLOOR): Joints {
  return Object.fromEntries(Object.entries(humanJoints(LEVEL)).map(([j, p]): [string, Vec3] => [j, [p[0], p[1] + floor, p[2]]]))
}

const I: Quat = [0, 0, 0, 1]
const X = new THREE.Vector3(1, 0, 0)
const Y = new THREE.Vector3(0, 1, 0)
const Z = new THREE.Vector3(0, 0, 1)
const turn = (axis: THREE.Vector3, degrees: number): THREE.Quaternion => new THREE.Quaternion().setFromAxisAngle(axis, THREE.MathUtils.degToRad(degrees))
const quat = (q: THREE.Quaternion): Quat => q.toArray() as Quat
const key = (u: number, q: THREE.Quaternion | Quat, p?: Vec3): ClipKey => ({ u, q: Array.isArray(q) ? q : quat(q), ...(p === undefined ? {} : { p }) })

/** The bow as a game part: rigid on RightHand, carried (its carry handle closes the hand to the default fist), its
 * string a pull the left hand draws. */
export function bowGear (): Gear {
  return {
    id: BOW,
    name: BOW_NAME,
    model: `garments/${BOW}/model.glb`,
    status: 'ready',
    from: `emberhold:${UNIT}/${BOW_NAME}`,
    attach: { kind: 'bone', bone: 'RightHand', place: structuredClone(BOW_PLACE) },
    handles: [
      { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' },
      { id: 'string', name: 'String', kind: 'pull', hand: 'Left', pull: { bone: 'LeftHand', grip: [...GRIP], rest: [...STRING_REST] } },
    ],
  }
}

/** The slots: the unit's four, and a trial. */
/** The slots, written as schema 2 had them (phases of each clip as it plays) and moved into source time as the
 * migration moves them (src/model/migrate.ts slotFromV2; test-walk is 1 s long): what the contract checks is that the
 * unit plays them where they were set. */
export function fixtureSlots (): Slot[] {
  return v2FixtureSlots().map((s, i) => slotFromV2(s, { characterId: CHARACTER, index: i, times: { seconds: 1 }, strict: true }))
}

function v2FixtureSlots (): V2Slot[] {
  return [
    {
      id: 'a0000001', name: 'Idle', clip: { id: 'test-idle' }, speed: 1, loop: true, inPlace: true,
      adjustments: [{ id: 'ad000001', enabled: true, kind: 'ground', lift: 0.02 }],
    },
    {
      id: 'a0000002', name: 'Walk', clip: { id: 'test-walk' }, speed: 1, loop: true, inPlace: true,
      adjustments: [{ id: 'ad000002', enabled: true, kind: 'keys', gear: { [BOW]: [key(0, I), key(0.5, turn(X, 20), [0, 0.03, 0])] } }],
    },
    { id: 'a0000003', name: 'Run', clip: { id: 'test-walk' }, speed: 1.5, loop: true, inPlace: true, adjustments: [] },
    {
      id: 'a0000004', name: 'Attack', clip: { id: 'test-walk' }, speed: 1, loop: false, inPlace: true,
      adjustments: [
        // (the blow picked at half the clip: the cut is known without measuring the hand)
        { id: 'ad000003', enabled: true, kind: 'blowTiming', at: 0.45, blowU: 0.5 },
        { id: 'ad000004', enabled: true, kind: 'handleHold', gear: BOW, handle: 'string', windows: [[...HOLD]] },
        { id: 'ad000005', enabled: true, kind: 'keys', bones: { Spine: [key(0, I), key(0.45, turn(Y, 15)), key(1, I)] } },
      ],
    },
    { id: 'a0000005', name: 'Wave', clip: { id: 'test-idle' }, speed: 1, loop: true, inPlace: true, adjustments: [], note: 'a trial' },
  ]
}

/** The character document (schema 2): rigged for its hierarchy, the bow, the slots. */
export function fixtureCharacter (): Character {
  const bones = humanHierarchy(LEVEL).length
  return makeRigged({
    id: CHARACTER,
    name: 'Tester',
    source: { kind: 'mesh', stats: { vertices: BODY_VERTICES, triangles: BODY_TRIANGLES, height: HEIGHT, meshes: 1, bones } },
    skeleton: { template: 'human', fingerLevel: LEVEL, detected: joints() },
    skin: { bones, report: { method: 'regions', seconds: 1, warnings: [] } },
    gear: [bowGear()],
    clips: fixtureSlots(),
  })
}

export function fixtureSpec (): UnitSpec {
  return { character: CHARACTER, height: GAME_HEIGHT, budget: BUDGET, clips: [...CLIPS] }
}

export interface Fixture {
  /** The temp workspace (characters/, library/); the export writes under out/. */
  workspace: string
  modelsDir: string
  workDir: string
  character: Character
  spec: UnitSpec
  /** The character's folder and its rigged.glb. */
  dir: string
  rigged: string
}

/** The workspace with the character, its files and the library clips it plays. */
export async function buildFixture (): Promise<Fixture> {
  const workspace = mkdtempSync(path.join(tmpdir(), 'rigsmith-contract-'))
  const c = fixtureCharacter()
  const dir = path.join(workspace, 'characters', c.id)
  const rigged = path.join(dir, 'rigged.glb')

  const { armature, bones } = skeleton(FLOOR)
  const body = bodyMesh(bones, FLOOR)
  armature.add(body)
  armature.updateMatrixWorld(true)
  body.bind(new THREE.Skeleton(bones))
  await writeGlb(rigged, armature)
  writeFileSync(path.join(dir, 'character.json'), JSON.stringify(c, null, 1) + '\n')
  await writeGlb(path.join(dir, 'garments', BOW, 'model.glb'), bowModel())

  for (const clip of [walkClip(), idleClip(), fistClip()]) {
    await writeGlb(path.join(workspace, 'library', 'clips', `${clip.name}.glb`), skeleton(0).armature, [clip])
  }
  const out = path.join(workspace, 'out')
  return { workspace, modelsDir: path.join(out, 'models'), workDir: path.join(out, 'work'), character: c, spec: fixtureSpec(), dir, rigged }
}

/** The fixture's character folder copied under another character with its own record (a unit that must fail). */
export function writeVariant (fx: Fixture, c: Character): void {
  const dir = path.join(fx.workspace, 'characters', c.id)
  cpSync(fx.dir, dir, { recursive: true })
  writeFileSync(path.join(dir, 'character.json'), JSON.stringify(c, null, 1) + '\n')
}

// ---- the files ------------------------------------------------------------------------------------------------------

async function writeGlb (file: string, root: THREE.Object3D, animations: THREE.AnimationClip[] = []): Promise<void> {
  const glb = await new GLTFExporter().parseAsync(root, { binary: true, animations, onlyVisible: false }) as ArrayBuffer
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, new Uint8Array(glb))
}

/** The skeleton at rest (no turns: each bone at its joint), under an Armature at the origin. */
function skeleton (floor: number): { armature: THREE.Group, bones: THREE.Bone[] } {
  const at = joints(floor)
  const armature = new THREE.Group()
  armature.name = 'Armature'
  const bones: THREE.Bone[] = []
  const named = new Map<string, THREE.Bone>()
  for (const [name, parent] of humanHierarchy(LEVEL)) {
    const bone = new THREE.Bone()
    bone.name = name
    bone.position.set(...at[name])
    if (parent === null) armature.add(bone)
    else {
      bone.position.sub(new THREE.Vector3(...at[parent]))
      named.get(parent)!.add(bone)
    }
    bones.push(bone)
    named.set(name, bone)
  }
  armature.updateMatrixWorld(true)
  return { armature, bones }
}

/** The body: every box rigid on its bone, merged into one skinned mesh (the export takes exactly one). */
function bodyMesh (bones: THREE.Bone[], floor: number): THREE.SkinnedMesh {
  const boxes = BOXES.map(([bone, centre, size]) => {
    const index = bones.findIndex(b => b.name === bone)
    if (index < 0) throw new Error(`fixture: no bone ${bone}`)
    const g = new THREE.BoxGeometry(size[0], size[1], size[2], CUTS, CUTS, CUTS)
    g.translate(centre[0], centre[1] + floor, centre[2])
    const n = g.attributes.position.count
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, k) => (k % 4 === 0 ? index : 0)), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, k) => (k % 4 === 0 ? 1 : 0)), 4))
    return g
  })
  const geometry = mergeGeometries(boxes)
  if (geometry === null) throw new Error('fixture: the body boxes would not merge')
  const mesh = new THREE.SkinnedMesh(geometry, new THREE.MeshStandardMaterial({ name: 'Body' }))
  mesh.name = 'Body'
  return mesh
}

/** The bow: a stave along Y (its grip at the origin) and its string behind it, a separate thin strand the pull splits. */
function bowModel (): THREE.Mesh {
  const stave = new THREE.BoxGeometry(0.03, 0.8, 0.03)
  const string = new THREE.BoxGeometry(0.004, 0.76, 0.004).translate(...STRING_REST)
  const geometry = mergeGeometries([stave, string])
  if (geometry === null) throw new Error('fixture: the bow would not merge')
  // (Main: the game binds the body's maps to it; the export puts the part on the body's material)
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ name: 'Main' }))
  mesh.name = BOW_NAME
  return mesh
}

/** A bone turning about `axis` through `degrees` at `times`. */
function swing (bone: string, axis: THREE.Vector3, times: number[], degrees: number[]): THREE.KeyframeTrack {
  return new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, times, degrees.flatMap(d => quat(turn(axis, d))))
}

/** A second of walking: the legs swing 25 degrees either way of straight down, the arms against them, the hips bob. */
function walkClip (): THREE.AnimationClip {
  const t = [0, 0.25, 0.5, 0.75, 1]
  return new THREE.AnimationClip('test-walk', 1, [
    new THREE.VectorKeyframeTrack('Hips.position', t, [0, 1, 0, 0, 0.98, 0, 0, 1, 0, 0, 0.98, 0, 0, 1, 0]),
    swing('LeftUpLeg', X, t, [25, 0, -25, 0, 25]),
    swing('RightUpLeg', X, t, [-25, 0, 25, 0, -25]),
    swing('LeftArm', Y, t, [-20, 0, 20, 0, -20]),
    swing('RightArm', Y, t, [20, 0, -20, 0, 20]),
  ])
}

/** Two seconds of standing, breathing. */
function idleClip (): THREE.AnimationClip {
  const t = [0, 1, 2]
  return new THREE.AnimationClip('test-idle', 2, [
    new THREE.VectorKeyframeTrack('Hips.position', t, [0, 1, 0, 0, 1, 0, 0, 1, 0]),
    swing('Spine', X, t, [0, 3, 0]),
  ])
}

/** The default fist: each index finger curling shut at half the clip. */
function fistClip (): THREE.AnimationClip {
  const t = [0, 0.5, 1]
  return new THREE.AnimationClip(DEFAULT_FIST, 1, ['Left', 'Right'].flatMap(side =>
    [1, 2, 3].map(i => swing(`${side}HandIndex${i}`, Z, t, [0, side === 'Left' ? 60 : -60, 0]))))
}
