// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanImageName } from '../../server/glbimages.ts'
import { applyCommands } from './commands.ts'
import { stableId } from './ids.ts'
import { makeCharacter, makeGear } from './fixtures.ts'
import { gearFromProp, gearFromV1, holdsFromV1, migrate, migrateSettings, migrateV1, needsClipTimes, piecesFromHolds, readCharacter, slotFromV2, slotsFromV1, slotToV2, toV5, unmeasured, v2TimeMap } from './migrate.ts'
import type { GameSpec } from './unit.ts'
import type { V3Character, V3Slot } from './v3.ts'
import type { V4Character } from './v4.ts'
import { DEFAULT_FIST, jointsOf } from './select.ts'
import { hierarchyOf, humanHierarchy } from './skeletons.ts'
import type { Adjustment, Character, FingerLevel, Joints, Pool, Skin, Vec3 } from './types.ts'
import type { V2Adjustment, V2Character, V2Slot } from './v2.ts'
import type { V1Character, V1ClipScript, V1Garment } from './v1.ts'

const ID = 'hero-abc123'
const FINGER = /Hand(Thumb|Index|Middle|Ring|Pinky)\d+$/

/** Each joint somewhere of its own (by its name), shifted along x. */
const pos = (name: string, shift = 0): Vec3 => [name.length / 10 + shift, name.charCodeAt(0) / 100, name.charCodeAt(name.length - 1) / 100]
const skeleton = (level: FingerLevel, shift = 0): Joints => Object.fromEntries(humanHierarchy(level).map(([b]) => [b, pos(b, shift)]))
const only = (j: Joints, fingers: boolean): Joints => Object.fromEntries(Object.entries(j).filter(([k]) => FINGER.test(k) === fingers))

function v1 (over: Partial<V1Character> = {}): V1Character {
  return {
    id: ID,
    name: 'Hero',
    createdAt: 1,
    updatedAt: 2,
    source: { file: 'source/original.glb', originalName: 'hero.glb', bytes: 100 },
    status: 'rigged',
    kind: 'mesh',
    stats: { vertices: 10, triangles: 20, height: 1, meshes: 1, bones: 65 },
    joints: skeleton('full'),
    autoJoints: skeleton('full'),
    jointsEdited: false,
    fingers: 'full',
    files: { model: 'model.glb', rigged: 'rigged.glb', thumbnail: 'thumbnail.webp' },
    revision: 3,
    rigReport: { method: 'native-heat', seconds: 12, warnings: ['a thin wrist'] },
    animations: [],
    ...over,
  }
}

const bow = (over: Partial<V1Garment> = {}): V1Garment => ({
  id: 'g1',
  name: 'Weapons_LeftHand',
  file: 'garments/g1/model.glb',
  status: 'ready',
  mode: 'rigid',
  policy: 'body',
  bone: 'LeftHand',
  position: [0.1, 0.2, 0.3],
  rotation: [10, 20, 30],
  scale: 1.5,
  hideBody: false,
  hidden: false,
  from: 'emberhold:archer/Weapons_LeftHand',
  ...over,
})

const withoutIds = (adjustments: Array<Adjustment | V2Adjustment>): unknown[] => adjustments.map(a => Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'id')))
const slot = <S extends { name: string }>(c: { clips: S[] }, name: string): S => c.clips.find(s => s.name === name)!

describe('migrate: source and skin', () => {
  it('moves what the import found into source', () => {
    const c = migrate(v1({ kind: undefined, rigPreset: undefined, scale: undefined })).character
    expect(c.source).toEqual({
      file: 'source/original.glb', originalName: 'hero.glb', bytes: 100, kind: 'mesh', scale: 1,
      stats: { vertices: 10, triangles: 20, height: 1, meshes: 1, bones: 65 }, warnings: [],
    })
    expect(migrate(v1({ kind: 'animation', scale: 1.25 })).character.source).toMatchObject({ kind: 'animation', scale: 1.25 })
  })

  it('keeps an import report as the source warnings, any other as the skin report', () => {
    const imported = migrate(v1({ status: 'ready', rigReport: { method: 'import', seconds: 0, warnings: ['legs hidden'] } })).character
    expect(imported.source.warnings).toEqual(['legs hidden'])
    expect(imported.skin.report).toBeUndefined()
    const rigged = migrate(v1()).character
    expect(rigged.source.warnings).toEqual([])
    expect(rigged.skin.report).toEqual({ method: 'native-heat', seconds: 12, warnings: ['a thin wrist'] })
  })

  it('counts the bones, the painted points and the bind pose of a rigged character', () => {
    const bind = { Hips: [0, 1, 0] as Vec3 }
    const c = migrate(v1(), { paintedCount: 7, bindJoints: bind }).character
    expect(c.skin).toMatchObject({ bones: 65, painted: 7, rigJoints: bind })
    expect(migrate(v1()).character.skin.rigJoints).toEqual(v1().joints)
    const ready = migrate(v1({ status: 'ready' }), { paintedCount: 3 }).character.skin
    expect(ready.bones).toBeUndefined()
    expect(ready.rigJoints).toBeUndefined()
    expect(ready.painted).toBe(3)
  })

  it('locks the hand-fixed weights of every rigged character but the scout and the villager', () => {
    const m = migrate(v1())
    expect(m.character.skin).toMatchObject({ locked: true, lockReason: 'hand-fixed weights' })
    expect(m.notes.some(n => n.includes('locked'))).toBe(true)
    for (const id of ['scout-c9d3b8', 'villager-57e3f6']) {
      const skin = migrate(v1({ id })).character.skin
      expect(skin.locked).toBe(false)
      expect(skin.lockReason).toBeUndefined()
    }
    expect(migrate(v1({ status: 'ready' })).character.skin.locked).toBe(false)
  })

  it('reads a converted import (mesh with a rig preset) as a rigged import converted', () => {
    const c = migrate(v1({ kind: 'mesh', rigPreset: 'tripo', template: 'horse', autoJoints: undefined })).character
    expect(c.source).toMatchObject({ kind: 'rigged', rigPreset: 'tripo' })
    expect(c.skeleton.converted).toBe(true)
    const plain = migrate(v1({ kind: 'rigged', rigPreset: 'mixamo' })).character
    expect(plain.source.kind).toBe('rigged')
    expect(plain.skeleton.converted).toBeUndefined()
  })

  it('stamps the schema, a first version and the revision', () => {
    const c = migrate(v1({ revision: undefined, thumbVersion: 5 })).character
    expect(c).toMatchObject({ schema: 5, version: 1, revision: 0, thumbVersion: 5, id: ID, name: 'Hero', status: 'rigged' })
    expect(migrate(v1()).character.revision).toBe(3)
  })
})

describe('migrate: skeleton', () => {
  it('defaults the template and finger level', () => {
    const c = migrate(v1({ template: undefined, fingers: undefined })).character
    expect(c.skeleton).toMatchObject({ template: 'human', fingerLevel: 'full' })
  })

  it('case 1, never edited: everything detected, nothing overridden', () => {
    const auto = skeleton('two')
    const c = migrate(v1({ joints: skeleton('full'), autoJoints: auto, jointsEdited: false })).character
    expect(c.skeleton.detected).toEqual(skeleton('full'))
    expect(c.skeleton.overrides).toEqual({})
    expect(c.skeleton.imported).toEqual(auto)
    expect(jointsOf(c)).toEqual(skeleton('full'))
  })

  it('case 1, a creature with no import detection: detected, no imported', () => {
    const joints = { spine_1: [0, 1, 0] as Vec3, spine_2: [0, 1, 0.5] as Vec3 }
    const c = migrate(v1({ template: 'horse', joints, autoJoints: undefined, jointsEdited: true })).character
    expect(c.skeleton).toMatchObject({ template: 'horse', detected: joints, overrides: {} })
    expect(c.skeleton.imported).toBeUndefined()
  })

  it('case 2, fingers traced at another level than detected: the trace is detected, the hand-placed joints overrides', () => {
    const auto = skeleton('two')
    const trace = skeleton('full', 0.3)
    const joints: Joints = { ...only(auto, false), ...only(trace, true), LeftArm: [9, 9, 9], HeadTop_End: [0, 2, 0] }
    delete auto.HeadTop_End
    const m = migrate(v1({ fingers: 'full', joints, autoJoints: auto, jointsEdited: true }))
    const s = m.character.skeleton
    expect(s.overrides).toEqual({ LeftArm: [9, 9, 9] })
    expect(s.detected).toEqual({ ...only(auto, false), ...only(trace, true), HeadTop_End: [0, 2, 0] })
    expect(s.imported).toEqual(auto)
    expect(jointsOf(m.character)).toEqual(joints)
    expect(m.notes.some(n => n.includes('1 joint placed by hand'))).toBe(true)
  })

  it('case 2, fingers at the detected level: detected as imported, every moved joint (fingers too) overridden', () => {
    const auto = skeleton('two')
    const joints: Joints = { ...auto, Hips: [0, 1.1, 0], LeftHandIndex2: [0.5, 0.5, 0.5], RightHandThumb1: [auto.RightHandThumb1[0] + 5e-8, auto.RightHandThumb1[1], auto.RightHandThumb1[2]] }
    const c = migrate(v1({ fingers: 'two', joints, autoJoints: auto, jointsEdited: true })).character
    expect(c.skeleton.detected).toEqual(auto)
    expect(c.skeleton.overrides).toEqual({ Hips: [0, 1.1, 0], LeftHandIndex2: [0.5, 0.5, 0.5] })
    const got = jointsOf(c)
    expect(Object.keys(got).sort()).toEqual(Object.keys(joints).sort())
    for (const [k, p] of Object.entries(joints)) p.forEach((x, i) => expect(got[k][i]).toBeCloseTo(x, 6))
  })

  it('keeps markers and the bone map', () => {
    const markers = { set: 'human', base: { Hips: [0, 1, 0] as Vec3 }, positions: { hips: [0, 1, 0] as Vec3 } }
    const c = migrate(v1({ markers, boneMap: { Hips: 'pelvis' } })).character
    expect(c.skeleton.markers).toEqual(markers)
    expect(c.skeleton.boneMap).toEqual({ Hips: 'pelvis' })
  })

  it('leaves a character not yet detected without joints', () => {
    const c = migrate(v1({ status: 'importing', joints: undefined, autoJoints: undefined })).character
    expect(c.skeleton.detected).toBeUndefined()
    expect(c.skeleton.overrides).toEqual({})
  })
})

describe('migrate: hands', () => {
  const pose = { id: 'bowgrip', name: 'Bow grip', side: 'Left' as const, joints: { Index1: [0, 0, 0, 1] as [number, number, number, number] } }

  it('keeps the hand poses', () => {
    expect(migrate(v1({ handPoses: [pose] })).character.hands.poses).toEqual([pose])
  })

  it('makes enabled grip scripts hands held in every clip, their notes journal notes, switched-off ones dropped', () => {
    const scripts: V1ClipScript[] = [
      { id: 's1', kind: 'grip', enabled: true, side: 'Right', clip: 'mixamo-2hand_Idle', note: 'both fists on a shaft' },
      { id: 's2', kind: 'grip', enabled: false, side: 'Left', clip: 'mixamo-Other' },
    ]
    const m = migrate(v1({ scripts }))
    expect(m.character.hands.hold).toEqual({ Right: { fist: 'mixamo-2hand_Idle' } })
    expect(m.notes.some(n => n.includes('both fists on a shaft'))).toBe(true)
    expect(m.notes.some(n => n.includes('switched off'))).toBe(true)
  })

  it('reads hand pose strings as references', () => {
    const notes: string[] = []
    const hold = holdsFromV1([
      { id: 'a', kind: 'grip', enabled: true, side: 'Left', clip: DEFAULT_FIST },
      { id: 'b', kind: 'grip', enabled: true, side: 'Right', clip: 'pose:bowgrip' },
    ], { poses: new Set(['bowgrip']), notes })
    expect(hold).toEqual({ Left: 'default', Right: { pose: 'bowgrip' } })
    expect(holdsFromV1([{ id: 'c', kind: 'grip', enabled: true, side: 'Left', clip: 'open' }])).toEqual({ Left: 'clip' })
    // (two on one hand: v1 laid the later over the earlier)
    expect(holdsFromV1([
      { id: 'd', kind: 'grip', enabled: true, side: 'Left', clip: 'mixamo-A' },
      { id: 'e', kind: 'grip', enabled: true, side: 'Left', clip: 'mixamo-B' },
    ], { notes })).toEqual({ Left: { fist: 'mixamo-B' } })
    expect(notes.some(n => n.includes('two grips'))).toBe(true)
  })

  it('falls back to the default fist for a pose that no longer exists, and says so', () => {
    const m = migrate(v1({ handPoses: [pose], garments: [bow({ carryPose: 'pose:gone' })], scripts: [{ id: 's', kind: 'grip', enabled: true, side: 'Right', clip: 'pose:lost' }] }))
    expect(m.character.gear[0].handles[0].pose).toBe('default')
    expect(m.character.hands.hold).toEqual({ Right: 'default' })
    expect(m.notes.filter(n => n.includes('no longer exists'))).toHaveLength(2)
  })
})

describe('migrate: gear', () => {
  it('makes a rigid garment bone gear, and one on a hand gets its carry handle', () => {
    const g = gearFromV1(bow({ carryPose: 'pose:bowgrip', group: 'bows', painted: 4 }), { poses: new Set(['bowgrip']) })
    expect(g).toEqual({
      id: 'g1', name: 'Weapons_LeftHand', model: 'garments/g1/model.glb', status: 'ready', swapSet: 'bows', painted: 4,
      from: 'emberhold:archer/Weapons_LeftHand',
      attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0.1, 0.2, 0.3], rotation: [10, 20, 30], scale: 1.5 } },
      handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left', pose: { pose: 'bowgrip' } }],
    })
    expect(gearFromV1(bow()).handles[0].pose).toBe('default')
    expect(gearFromV1(bow({ carryPose: 'open' })).handles[0].pose).toBe('clip')
    expect(gearFromV1(bow({ carryPose: DEFAULT_FIST })).handles[0].pose).toBe('default')
    expect(gearFromV1(bow({ carryPose: 'mixamo-Fist' })).handles[0].pose).toEqual({ fist: 'mixamo-Fist' })
    expect(gearFromV1(bow({ bone: 'Spine2' })).handles).toEqual([])
  })

  it('makes clothing skin gear and a part spot gear', () => {
    const cloak = gearFromV1(bow({ id: 'g2', name: 'Cloak', mode: 'clothing', policy: 'cape', bone: 'Head', hideBody: true, error: 'x', status: 'error' }))
    expect(cloak.attach).toEqual({ kind: 'skin', policy: 'cape', place: { position: [0.1, 0.2, 0.3], rotation: [10, 20, 30], scale: 1.5 }, hideBody: true })
    expect(cloak).toMatchObject({ status: 'error', error: 'x', handles: [] })
    const wheel = gearFromV1(bow({ id: 'g3', mode: 'part', bone: 'Head', anchor: [0, 1, 0], animation: 'Spin' }))
    expect(wheel.attach).toEqual({ kind: 'spot', place: { position: [0.1, 0.2, 0.3], rotation: [10, 20, 30], scale: 1.5 }, anchor: [0, 1, 0], animation: 'Spin' })
  })

  it('makes the carry hand\'s socket the carry handle\'s place and the others grips; "(carries it)" sockets go', () => {
    const g = gearFromV1(bow({
      bone: 'RightHand',
      sockets: [
        { id: 'right-hand', name: 'Right hand', position: [1, 2, 3], rotation: [0, 0, 0, 1], placed: true },
        { id: 'left-hand', name: 'Left hand', position: [4, 5, 6], rotation: [0, 1, 0, 0] },
        { id: 'grip-2', name: 'Pommel', position: [7, 8, 9], rotation: [1, 0, 0, 0], placed: true },
        { id: 'c', name: 'Right hand (carries it)', position: [0, 0, 0], rotation: [0, 0, 0, 1] },
      ],
    }))
    expect(g.handles).toEqual([
      { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right', pose: 'default', place: { position: [1, 2, 3], rotation: [0, 0, 0, 1] }, exact: true },
      { id: 'left-hand', name: 'Left hand', kind: 'grip', hand: 'Left', place: { position: [4, 5, 6], rotation: [0, 1, 0, 0] } },
      { id: 'grip-2', name: 'Pommel', kind: 'grip', place: { position: [7, 8, 9], rotation: [1, 0, 0, 0] }, exact: true },
    ])
    // (the hand from the id when the name doesn't say)
    expect(gearFromV1(bow({ sockets: [{ id: 'left-hand', name: 'Grip', position: [1, 1, 1], rotation: [0, 0, 0, 1] }] })).handles[0].place)
      .toEqual({ position: [1, 1, 1], rotation: [0, 0, 0, 1] })
  })

  it('makes pulls pull handles, a pose only when one was set', () => {
    const g = gearFromV1(bow({
      pulls: [
        { id: 'p1', name: 'Draw', bone: 'RightHand', grip: [0, 0.07, 0], rest: [0.2, 0.4, 0], pose: 'pose:pinch' },
        { id: 'p2', name: 'Open', bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0], pose: 'open' },
        { id: 'p3', name: 'Tail', bone: 'Spine', grip: [0, 0, 0], rest: [1, 1, 1] },
      ],
    }), { poses: new Set(['pinch']) })
    expect(g.handles.slice(1)).toEqual([
      { id: 'p1', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0.07, 0], rest: [0.2, 0.4, 0] }, pose: { pose: 'pinch' } },
      { id: 'p2', name: 'Open', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] } },
      { id: 'p3', name: 'Tail', kind: 'pull', pull: { bone: 'Spine', grip: [0, 0, 0], rest: [1, 1, 1] } },
    ])
  })

  it('makes catalog props catalog gear still in the grip frame; on a hand it leaves the hand as the clip has it', () => {
    const notes: string[] = []
    const spear = gearFromProp({ id: 'p9', ref: 'catalog:spear_A.glb', name: 'Spear', socket: 'RightHand', position: [0, 0, 0], rotation: [-80, 0, 0], scale: 0.62 }, { notes })
    expect(spear).toEqual({
      id: 'p9', name: 'Spear', catalog: 'spear_A.glb', from: 'catalog:spear_A.glb', status: 'ready',
      attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [-80, 0, 0], scale: 0.62 }, legacyFrame: 'grip' },
      handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right', pose: 'clip' }],
    })
    expect(notes).toHaveLength(1)
    const shield = gearFromProp({ id: 'p8', ref: 'catalog:shield_A.glb', name: 'Shield', socket: 'LeftForeArm', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 })
    expect(shield?.handles).toEqual([])
    expect(gearFromProp({ id: 'p7', ref: 'custom:x', name: 'Odd', socket: 'Hips', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 })).toBeNull()
  })

  it('puts garments before catalog props and makes gear names unique', () => {
    const m = migrate(v1({
      garments: [bow(), bow({ id: 'g2', name: 'Weapons LeftHand', from: undefined })],
      props: [{ id: 'p9', ref: 'catalog:spear_A.glb', name: 'Spear', socket: 'RightHand', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }],
    }))
    expect(m.character.gear.map(g => [g.id, g.name])).toEqual([['g1', 'Weapons_LeftHand'], ['g2', 'Weapons LeftHand 2'], ['p9', 'Spear']])
    expect(m.notes.some(n => n.includes('Weapons LeftHand 2'))).toBe(true)
  })
})

describe('migrate: clips', () => {
  const pinch = { id: 'pinch', name: 'Pinch', side: 'Right' as const, joints: {} }
  const garments: V1Garment[] = [bow({
    carryOpen: { Attack: [[0.5, 0.7]], Nowhere: [[0, 1]] },
    pulls: [{ id: 'p1', name: 'Draw', bone: 'RightHand', grip: [0, 0.07, 0], rest: [0.2, 0.4, 0], holds: { Attack: [[0.516, 1]], Gone: [[0, 1]], Idle: [] }, pose: 'pose:pinch' }],
  })]
  const scripts: V1ClipScript[] = [
    { id: 's1', kind: 'blow', enabled: false, clip: 'Attack', at: 0.45, hand: 'RightHand', window: 1, note: 'off for now' },
    { id: 's2', kind: 'pace', enabled: true, clip: 'Walk', like: 'Idle' },
    { id: 's3', kind: 'pace', enabled: true, clip: 'Walk', like: 'Run' },
    { id: 's4', kind: 'blow', enabled: true, clip: 'Missing', at: 0.45 },
    { id: 's5', kind: 'grip', enabled: true, side: 'Right', clip: 'mixamo-2hand_Idle', open: { Idle: [[0.2, 0.4]] } },
  ]
  const animations = [
    { clipId: 'mixamo-Idle', name: 'Idle', inPlace: true, loop: true, speed: 1, trim: [0, 1] as [number, number] },
    {
      clipId: 'custom-Attack', url: '/animations/x.glb#Attack', name: 'Attack', inPlace: true, loop: false, speed: 1.2, note: 'why this one', lift: 0.013,
      keys: { bones: { Spine: [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }] }, props: { Weapons_LeftHand: [{ u: 0.5, q: [0, 0, 0, 1] as [number, number, number, number], p: [0, 0, 0.1] as Vec3 }], Ghost: [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }] } },
    },
    { clipId: 'mixamo-Walk', name: 'Walk', inPlace: false, loop: true, speed: 1, lift: 0 },
    { clipId: 'mixamo-Idle2', name: 'Idle', inPlace: true, loop: true, speed: 1 },
  ]
  // (the v1 -> v2 step: what schema 2 made of v1; schema 3's step is below)
  const m = migrateV1(v1({ animations, scripts, garments, handPoses: [pinch] }))
  const c = m.character

  it('makes entries slots with stable ids, the clip as a reference, trim dropped', () => {
    expect(c.clips.map(s => s.id)).toEqual([0, 1, 2, 3].map(i => stableId(`${ID}:slot:${i}`)))
    expect(c.clips[1]).toMatchObject({ name: 'Attack', clip: { id: 'custom-Attack', url: '/animations/x.glb#Attack' }, speed: 1.2, loop: false, inPlace: true, note: 'why this one' })
    expect(c.clips[0].clip).toEqual({ id: 'mixamo-Idle' })
    expect(c.clips[0]).not.toHaveProperty('trim')
    for (const s of c.clips) s.adjustments.forEach((a, j) => expect(a.id).toBe(stableId(`${ID}:adjust:${c.clips.indexOf(s)}:${j}`)))
  })

  it('renames a second clip of a name; what is keyed by the name goes to the first', () => {
    expect(c.clips.map(s => s.name)).toEqual(['Idle', 'Attack', 'Walk', 'Idle 2'])
    expect(c.clips[3].adjustments).toEqual([])
    expect(withoutIds(c.clips[0].adjustments)).toEqual([{ kind: 'handPose', enabled: true, hand: 'Right', pose: 'clip', windows: [[0.2, 0.4]] }])
    expect(m.notes.some(n => n.includes('Idle 2'))).toBe(true)
    // (a renamed one never takes a name another has)
    const names = slotsFromV1(['A', 'A', 'A 2'].map(name => ({ clipId: 'x', name, inPlace: true, loop: true, speed: 1 })), [], {}, ID).map(s => s.name)
    expect(names).toEqual(['A', 'A 3', 'A 2'])
  })

  it('makes a lift a ground and keys keys, gear keys by gear id (unknown names dropped)', () => {
    const a = withoutIds(slot(c, 'Attack').adjustments)
    expect(a).toContainEqual({ kind: 'ground', enabled: true, lift: 0.013 })
    expect(a).toContainEqual({
      kind: 'keys', enabled: true, bones: { Spine: [{ u: 0, q: [0, 0, 0, 1] }] }, gear: { g1: [{ u: 0.5, q: [0, 0, 0, 1], p: [0, 0, 0.1] }] },
    })
    expect(m.notes.some(n => n.includes('Ghost'))).toBe(true)
    expect(slot(c, 'Walk').adjustments.some(x => x.kind === 'ground')).toBe(false)
  })

  it('makes blow scripts blow timing (switched off stays off) and pace a pace by slot id', () => {
    const attack = withoutIds(slot(c, 'Attack').adjustments)
    expect(attack).toContainEqual({ kind: 'blowTiming', enabled: false, note: 'off for now', at: 0.45, hand: 'RightHand', window: 1 })
    expect(withoutIds(slot(c, 'Walk').adjustments)).toEqual([{ kind: 'pace', enabled: true, like: slot(c, 'Idle').id }])
    expect(m.notes.some(n => n.includes('Run'))).toBe(true)
    expect(m.notes.some(n => n.includes('Missing'))).toBe(true)
  })

  it('makes a carried piece\'s open windows a hand pose of its own, and pull holds handle holds', () => {
    const attack = withoutIds(slot(c, 'Attack').adjustments)
    expect(attack).toContainEqual({ kind: 'handPose', enabled: true, hand: 'Left', pose: 'clip', windows: [[0.5, 0.7]], gear: 'g1' })
    expect(attack).toContainEqual({ kind: 'handleHold', enabled: true, gear: 'g1', handle: 'p1', windows: [[0.516, 1]] })
    expect(slot(c, 'Idle').adjustments.some(x => x.kind === 'handleHold')).toBe(false)
    expect(m.notes.some(n => n.includes('Nowhere'))).toBe(true)
    expect(m.notes.some(n => n.includes('Gone'))).toBe(true)
    // (its blow timing is off: nothing was cut, so nothing to check)
    expect(m.notes.some(n => n.includes('blow cut'))).toBe(false)
  })

  it('says so when a cut clip has windows', () => {
    const notes: string[] = []
    slotsFromV1([{ clipId: 'x', name: 'Attack', inPlace: true, loop: false, speed: 1 }],
      [{ id: 'b', kind: 'blow', enabled: true, clip: 'Attack', at: 0.45 }], {}, ID, { garments, notes })
    expect(notes.some(n => n.includes('blow cut'))).toBe(true)
  })
})

describe('migrate: look, mount, settings', () => {
  it('makes the scan the look\'s and each texture file a snapshot layer copied into layers/', () => {
    const m = migrate(v1({
      texture: {
        filled: true, at: 123, painted: true,
        images: [{ image: 'Diffuse Texture', coverage: 0.05, file: 'Diffuse_Texture.png', mask: 'Diffuse_Texture.mask.png' }, { image: 'Body.001', coverage: 0.1, file: null }],
      },
      skins: [{ name: 'Dapple', file: 'skins/dapple.png' }],
    }), { textureFiles: ['Diffuse_Texture.png', 'Diffuse_Texture.mask.png'] })
    const id = stableId(`${ID}:layer:0`)
    expect(m.character.look).toEqual({
      layers: [{ id, kind: 'snapshot', image: 'Diffuse_Texture', file: `textures/layers/${id}.png`, enabled: true, at: 123 }],
      scan: { images: [{ image: 'Diffuse_Texture', coverage: 0.05 }, { image: 'Body_001', coverage: 0.1 }], at: 123 },
      at: 123,
      skins: [{ name: 'Dapple', file: 'skins/dapple.png' }],
    })
    expect(m.fileOps).toEqual([{ op: 'copy', from: 'textures/Diffuse_Texture.png', to: `textures/layers/${id}.png` }])
  })

  it('names a scanned image that has no file as Blender cleans it, as the server and the browser do', () => {
    // (v1 named the files by Blender's clean_name too: an image with a file keeps that file's name)
    const names = ['Diffuse Texture', 'tripo_rgb_c141c76d-3257-46b4-83da-8d803f5a26f2', 'tex-1 a.b', 'Üé ÿ', '名前.png', 'x\u0000y~z']
    const scan = migrate(v1({ texture: { filled: false, at: 1, images: names.map(image => ({ image, coverage: 0.1, file: null })) } })).character.look.scan
    const images = scan?.images.map(i => i.image)
    expect(images).toEqual(['Diffuse_Texture', 'tripo_rgb_c141c76d-3257-46b4-83da-8d803f5a26f2', 'tex-1_a_b', '___ÿ', '名前_png', 'x_y_z'])
    expect(images).toEqual(names.map(cleanImageName))
  })

  it('leaves a look with no texture empty', () => {
    expect(migrate(v1({ texture: { filled: false, images: [], at: 5, painted: true } })).character.look).toEqual({ layers: [], at: 5 })
    expect(migrate(v1()).character.look).toEqual({ layers: [] })
  })

  it('keeps the mount, and says when the horse is not the unit\'s companion', () => {
    const mount = { character: 'horse-1', bone: 'spine_2', position: [0, 0.2, 0] as Vec3, rotation: [0, 0, 0] as Vec3, freeze: [], pose: {}, gear: ['g7'] }
    const unit = { character: ID, height: 1.8, budget: 5000, clips: [], companion: { character: 'horse-2', height: 2.3, prefix: 'Horse_', budget: 7000, material: 'horse', ridden: true } }
    const m = migrate(v1({ mount }), { units: { units: { rider: unit } } })
    expect(m.character.mount).toEqual(mount)
    expect(m.notes.some(n => n.includes('horse-2'))).toBe(true)
    const agree = migrate(v1({ mount }), { units: { units: { rider: { ...unit, companion: { ...unit.companion, character: 'horse-1' } } } } })
    expect(agree.notes.some(n => n.includes('companion'))).toBe(false)
  })

  it('keeps the game repo and the shared hand poses of the settings, and nothing else', () => {
    const handPoses = [{ id: 'h', name: 'Fist', side: 'Left' as const, joints: {} }]
    expect(migrateSettings({ exportDir: '/x', exportFormat: 'glb', boneNames: 'mixamo', gameRepo: '/game', handPoses })).toEqual({ gameRepo: '/game', handPoses })
    expect(migrateSettings({}, { gameRepo: '/default' })).toEqual({ gameRepo: '/default' })
    expect(migrateSettings({ gameRepo: '/g', comfyUrl: ' http://gpu:8188 ' })).toEqual({ gameRepo: '/g', comfyUrl: 'http://gpu:8188' })
    expect(migrateSettings({ gameRepo: '/g', comfyUrl: '' })).toEqual({ gameRepo: '/g' })
    expect(migrateSettings(migrateSettings({ gameRepo: '/g' }))).toEqual({ gameRepo: '/g' })
  })
})

describe('migrate: schema 2 -> 3', () => {
  const q: [number, number, number, number] = [0, 0, 0, 1]
  const k = (u: number): { u: number, q: [number, number, number, number] } => ({ u, q })
  const v2slot = (over: Partial<V2Slot> = {}): V2Slot => ({ id: 's1', name: 'Attack', clip: { id: 'mixamo-Stab' }, speed: 1, loop: false, inPlace: true, adjustments: [], ...over })
  const v2char = (clips: V2Slot[]): V2Character => ({ ...(migrate(v1({ animations: [], scripts: [] })).character as unknown as V2Character), schema: 2, clips })
  const blow = (over: Record<string, unknown> = {}): V2Adjustment => ({ id: 'b', enabled: true, kind: 'blowTiming', at: 0.45, hand: 'RightHand', ...over }) as V2Adjustment

  it('makes blow timing the fit (a blow picked by hand its hit), pace the pace, keys the tracks', () => {
    const s = slotFromV2(v2slot({ adjustments: [
      blow({ blowU: 0.3, late: 'hold', note: 'why' }), { id: 'p', enabled: false, kind: 'pace', like: 'walk' },
      { id: 'k', enabled: false, kind: 'keys', bones: { Spine: [k(0.2)] }, gear: { bow: [k(0.5)], empty: [] } },
      { id: 'g', enabled: true, kind: 'ground', lift: 0.01 },
    ] }), { characterId: ID, index: 2, times: { seconds: 2 } })
    expect(s).toEqual({
      id: 's1', name: 'Attack', clip: { id: 'mixamo-Stab' }, speed: 1, loop: false, inPlace: true,
      time: { fit: { enabled: true, at: 0.45, late: 'hold', hand: 'RightHand' }, pace: { enabled: false, like: 'walk' } },
      adjustments: [{ id: 'g', enabled: true, kind: 'ground', lift: 0.01 }],
      // (the cut ran the end past the clip: 0.3 of it is the blow, so the played clip is 0.3 / 0.45 of the source)
      bones: { Spine: [k(0.2 * 0.3 / 0.45)] }, gear: { bow: { keys: [k(0.5 * 0.3 / 0.45)] } },
      muted: ['bones', 'gear'],
      events: [{ id: stableId(`${ID}:hit:2`), name: 'hit', u: 0.3 }],
    })
  })

  it('may be written unmeasured only where the clip doesn\'t exist: a clip that failed to measure leaves it unwritten', () => {
    const keyed = v2slot({ adjustments: [blow(), { id: 'k', enabled: true, kind: 'keys', bones: { Spine: [k(0.2)] } }] })
    const picked = v2slot({ id: 's2', name: 'Thrust', adjustments: [blow({ blowU: 0.3 }), { id: 'k', enabled: true, kind: 'keys', bones: { Spine: [k(0.2)] } }] })
    const idle = v2slot({ id: 's3', name: 'Idle', adjustments: [{ id: 'k', enabled: true, kind: 'keys', bones: { Spine: [k(0.2)] } }] })
    const raw = v2char([keyed, picked, idle])
    // (measured: nothing stops it)
    expect(unmeasured(raw, { s1: { seconds: 2, blow: 1.2 }, s2: { seconds: 2 } })).toEqual([])
    // (a measure that failed, or a blow it didn't find: those slots stop it; Idle has no cut to measure)
    expect(unmeasured(raw, {})).toEqual(['Attack', 'Thrust'])
    expect(unmeasured(raw, undefined)).toEqual(['Attack', 'Thrust'])
    expect(unmeasured(raw, { s1: { seconds: 2 }, s2: { seconds: 2 } })).toEqual(['Attack'])
    // (a clip that doesn't exist can't play either: its phases may be kept)
    expect(unmeasured(raw, { s2: { seconds: 2 } }, ['s1'])).toEqual([])
    expect(unmeasured({ ...raw, schema: 3 }, {})).toEqual([])
  })

  it('moves phases through the cut the fit made: a late blow cuts the start, a held one runs past 1, a window', () => {
    const at = (adj: V2Adjustment, times: { seconds: number, blow?: number }, u: number): number => v2TimeMap(v2slot({ adjustments: [adj] }), times)!.toSource(u)
    // (measured at 1.2 s of a 2 s clip: past 0.45, so the start goes; 0.45 of what is kept is the blow)
    const start = (1.2 - 0.45 * 2) / (1 - 0.45)
    expect(at(blow(), { seconds: 2, blow: 1.2 }, 0)).toBeCloseTo(start / 2, 12)
    expect(at(blow(), { seconds: 2, blow: 1.2 }, 1)).toBeCloseTo(1, 12)
    expect(at(blow(), { seconds: 2, blow: 1.2 }, 0.45)).toBeCloseTo(0.6, 12)
    // (held: the end at 1.2 / 0.45 s, past the source's 2 s)
    expect(at(blow({ late: 'hold' }), { seconds: 2, blow: 1.2 }, 1)).toBeCloseTo(1.2 / 0.45 / 2, 12)
    // (early: the end cut so the blow lands at 0.45)
    expect(at(blow(), { seconds: 2, blow: 0.6 }, 1)).toBeCloseTo(0.6 / 0.45 / 2, 12)
    // (a 0.5 s window round the blow)
    expect(at(blow({ window: 0.5 }), { seconds: 2, blow: 1 }, 0)).toBeCloseTo((1 - 0.45 * 0.5) / 2, 12)
    // (the speed: the clip at speed 2 is 1 s long, the blow found at 0.6 s of it)
    expect(v2TimeMap(v2slot({ speed: 2, adjustments: [blow()] }), { seconds: 2, blow: 0.6 })!.toSource(0.45)).toBeCloseTo(0.6, 12)
    // (a picked blow needs only the length; a measured one needs the blow too)
    expect(v2TimeMap(v2slot({ adjustments: [blow({ blowU: 0.6 })] }), { seconds: 2 })!.toSource(0.45)).toBeCloseTo(0.6, 12)
    expect(v2TimeMap(v2slot({ adjustments: [blow()] }), { seconds: 2 })).toBeNull()
    // (switched off: nothing was cut)
    expect(v2TimeMap(v2slot({ adjustments: [blow({ enabled: false })] }), undefined)!.toSource(0.37)).toBe(0.37)
  })

  it('moves keys and windows, and maps them back to where they played', () => {
    const was = v2slot({ speed: 1.25, adjustments: [
      blow(), { id: 'k', enabled: true, kind: 'keys', gear: { bow: [k(0), k(0.3), k(1)] } },
      { id: 'h', enabled: true, kind: 'handleHold', gear: 'bow', handle: 'draw', windows: [[0.35, 0.92]] },
      { id: 'p', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.1, 0.2]] },
      { id: 'w', enabled: true, kind: 'handPose', hand: 'Right', pose: 'default' },
    ] })
    const times = { seconds: 2.1666667461395264, blow: 0.41666666666666663 }
    const now = slotFromV2(was, { characterId: ID, index: 0, times })
    const map = v2TimeMap(was, times)!
    expect(now.gear!.bow.keys!.map(x => map.toPlayed(x.u))).toEqual([0, 0.3, 1].map(u => expect.closeTo(u, 12) as unknown as number))
    const hold = now.adjustments.find(a => a.id === 'h')!
    expect(hold.kind === 'handleHold' && hold.windows.flat().map(map.toPlayed)).toEqual([0.35, 0.92].map(u => expect.closeTo(u, 12) as unknown as number))
    // (a whole-clip hand pose stays the whole clip, whatever the timing)
    expect(now.adjustments.find(a => a.id === 'w')).not.toHaveProperty('windows')
  })

  it('needs the cut measured: strict throws, else keeps the phases and says so', () => {
    const c = v2char([v2slot({ adjustments: [blow(), { id: 'k', enabled: true, kind: 'keys', bones: { Spine: [k(0.5)] } }] })])
    expect(() => migrate(c, {}, { strict: true })).toThrow(/run node tools\/migrate.ts/)
    expect(() => readCharacter(c)).toThrow(/measured/)
    const loose = migrate(c)
    expect(loose.character.clips[0].bones).toEqual({ Spine: [k(0.5)] })
    expect(loose.notes.some(n => n.includes("couldn't be measured"))).toBe(true)
    // (measured, it goes through; nothing to move needs nothing measured)
    expect(migrate(c, { clipTimes: { s1: { seconds: 1, blow: 0.25 } } }, { strict: true }).character.clips[0].bones!.Spine[0].u).toBeCloseTo(0.5 * 0.25 / 0.45, 12)
    expect(() => readCharacter(v2char([v2slot({ adjustments: [blow()] })]))).not.toThrow()
  })

  it('says it came from schema 2 (kept as character.v2.json) and is schema 5 after', () => {
    const m = migrate(v2char([v2slot()]))
    expect([m.migrated, m.from, m.character.schema]).toEqual([true, 2, 5])
    expect(migrate(m.character).migrated).toBe(false)
  })

  it('reads back as schema 2 for the v1 view, times as they are', () => {
    const s = slotFromV2(v2slot({ adjustments: [blow({ blowU: 0.5 }), { id: 'k', enabled: true, kind: 'keys', bones: { Spine: [k(0.2)] } }] }), { characterId: ID, index: 0 })
    expect(slotToV2(s).adjustments).toEqual([
      { id: 's1-fit', kind: 'blowTiming', enabled: true, at: 0.45, blowU: 0.5, hand: 'RightHand' },
      { id: 's1-keys', kind: 'keys', enabled: true, bones: { Spine: [k(0.2)] } },
    ])
    expect(slotToV2(s, { rowIds: true }).adjustments.map(a => a.id)).toEqual(['fit', 'keys'])
  })
})

describe('migrate: as a whole', () => {
  const full = v1({
    joints: { ...skeleton('full'), Hips: [0, 1.2, 0] },
    jointsEdited: true,
    handPoses: [{ id: 'bowgrip', name: 'Bow grip', side: 'Left', joints: {} }],
    garments: [bow({ carryPose: 'pose:bowgrip', carryOpen: { Attack: [[0.5, 0.7]] } })],
    props: [{ id: 'p9', ref: 'catalog:spear_A.glb', name: 'Spear', socket: 'RightHand', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }],
    animations: [{ clipId: 'a', name: 'Attack', inPlace: true, loop: false, speed: 1, lift: 0.01 }],
    scripts: [{ id: 's', kind: 'blow', enabled: true, clip: 'Attack', at: 0.45 }, { id: 't', kind: 'grip', enabled: true, side: 'Right', clip: 'mixamo-A' }],
    texture: { filled: true, images: [{ image: 'Tex', coverage: 0.1, file: 'Tex.png' }], at: 9 },
  })

  it('is idempotent: schema 5 comes back as it is', () => {
    const once = migrate(full, { textureFiles: ['Tex.png'] })
    expect([once.migrated, once.from]).toEqual([true, 1])
    const twice = migrate(once.character, { textureFiles: ['Tex.png'] })
    expect(twice).toEqual({ character: once.character, migrated: false, from: 5, notes: [], fileOps: [] })
    expect(migrate(JSON.parse(JSON.stringify(once.character))).character).toEqual(once.character)
    expect(readCharacter(full)).toEqual(migrate(full).character)
  })

  it('is deterministic and leaves its input alone', () => {
    const before = JSON.stringify(full)
    const a = migrate(full, { textureFiles: ['Tex.png'], paintedCount: 2 })
    const b = migrate(JSON.parse(before), { textureFiles: ['Tex.png'], paintedCount: 2 })
    expect(JSON.stringify(full)).toBe(before)
    expect(b).toEqual(a)
    // (nothing undefined left in: it reads back from JSON exactly)
    expect(JSON.parse(JSON.stringify(a.character))).toStrictEqual(a.character)
  })

  it('makes only what the commands would accept', () => accepted(migrate(full).character))

  it('refuses what is not a character, or a schema it doesn\'t know', () => {
    expect(() => migrate(null)).toThrow()
    expect(() => migrate({ name: 'x' })).toThrow()
    expect(() => migrate({ ...full, schema: 6 })).toThrow()
  })
})

/** Each piece of gear, the set of clips and the held hands go back in through the reducers without complaint. */
function accepted (c: Character): void {
  for (const g of c.gear) expect(() => applyCommands({ ...c, gear: c.gear.filter(x => x !== g) }, [{ type: 'gear.add', gear: g }])).not.toThrow()
  expect(() => applyCommands(c, [{ type: 'clips.replace', slots: c.clips }])).not.toThrow()
  for (const [side, pose] of Object.entries(c.hands.hold ?? {})) {
    expect(() => applyCommands({ ...c, hands: { poses: c.hands.poses } }, [{ type: 'hands.hold', side: side as 'Left' | 'Right', pose }])).not.toThrow()
  }
}

// The real workspace (a private copy), when it is there: every character reads as schema 2 with the same skeleton.
const CHARACTERS = fileURLToPath(new URL('../../workspace/characters', import.meta.url))
const real = existsSync(CHARACTERS)
  ? readdirSync(CHARACTERS).filter(id => existsSync(`${CHARACTERS}/${id}/character.json`))
  : []

describe.skipIf(real.length === 0)('migrate: the workspace\'s characters', () => {
  it.each(real)('%s', id => {
    // (the v1 record: the file while it is one, else the copy migration kept)
    const kept = `${CHARACTERS}/${id}/character.v1.json`
    const raw = JSON.parse(readFileSync(existsSync(kept) ? kept : `${CHARACTERS}/${id}/character.json`, 'utf8')) as V1Character & { schema?: number }
    if (raw.schema !== undefined) return
    const textures = existsSync(`${CHARACTERS}/${id}/textures`) ? readdirSync(`${CHARACTERS}/${id}/textures`) : []
    const edits = `${CHARACTERS}/${id}/weight_edits.json`
    const ctx = { textureFiles: textures, paintedCount: existsSync(edits) ? Object.keys(JSON.parse(readFileSync(edits, 'utf8')) as object).length : undefined }
    const m = migrate(raw, ctx)
    const c = m.character
    // the effective skeleton is the old one
    const old = raw.joints ?? {}
    const now = jointsOf(c)
    expect(Object.keys(now).sort()).toEqual(Object.keys(old).sort())
    for (const [k, p] of Object.entries(old)) p.forEach((x, i) => expect(Math.abs(now[k][i] - x)).toBeLessThanOrEqual(1e-7))
    // with the overrides taken away the skeleton is still whole
    if (raw.joints !== undefined) expect(Object.keys(jointsOf({ skeleton: { ...c.skeleton, overrides: {} } })).length).toBe(hierarchyOf(c).length)
    // the same twice over, and schema 2 is left as it is
    expect(migrate(JSON.parse(JSON.stringify(raw)), ctx)).toEqual(m)
    expect(migrate(c, ctx).character).toBe(c)
    expect(JSON.parse(JSON.stringify(c))).toStrictEqual(c)
    // nothing lost by count
    expect(c.clips.map(s => s.name)).toEqual(raw.animations.map(a => a.name))
    expect(c.gear.length).toBe((raw.garments ?? []).length + (raw.props ?? []).length)
    expect(c.skin.locked).toBe(raw.status === 'rigged' && !/^(scout|villager)-/.test(id))
    accepted(c)
  })
})

describe('migrate: schema 3 -> 4 (holds become pieces)', () => {
  const v3slot = (o: Partial<V3Slot> = {}): V3Slot => ({ id: 'atk', name: 'Attack', clip: { id: 'mixamo-Slash' }, speed: 1, loop: false, inPlace: false, adjustments: [], ...o })
  const v3char = (clips: V3Slot[]): V3Character => ({ ...(migrate(v1({ animations: [], scripts: [] })).character as unknown as V3Character), schema: 3, clips })
  const held = (): V3Slot => v3slot({
    time: { fit: { enabled: true, at: 0.45 }, holds: [{ id: 'h1', u: 0.5, seconds: 0.5 }, { id: 'h0', u: 0, seconds: 0.25 }] },
    bones: { Spine: [{ u: 0.25, q: [0, 0, 0, 1] }, { u: 0.5, q: [0, 0, 0, 1] }, { u: 0.75, q: [0, 0, 0, 1] }] },
    events: [{ id: 'e', name: 'hit', u: 0.6 }],
    adjustments: [{ id: 'p', enabled: true, kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.4, 0.8]] }],
  })

  it('makes each hold a held piece between parts of the clip, every time where it played', () => {
    const m = migrate(v3char([held(), v3slot({ id: 'idle', name: 'Idle' })]), { clipTimes: { atk: { seconds: 2 } } })
    expect([m.migrated, m.from, m.character.schema]).toEqual([true, 3, 5])
    const s = m.character.clips[0]
    expect(s.pieces!.map(p => [p.id, p.kind, p.from, p.to])).toEqual([['h0', 'hold', 0, 0.25], [expect.any(String), 'clip', 0, 1], ['h1', 'hold', 0, 0.5], [expect.any(String), 'clip', 1, 2]])
    expect(s.time).toEqual({ fit: { enabled: true, at: 0.45 } })
    // (2 s of clip and 0.75 s of holds: a key at u plays at u·2 plus the holds before it; at a hold's u, at its start)
    const at = (u: number): number => u * 2.75
    expect(s.bones!.Spine.map(k => at(k.u))).toEqual([0.75, 1.25, 2.25].map(x => expect.closeTo(x, 9)))
    expect(at(s.events![0].u)).toBeCloseTo(1.2 + 0.75, 9)
    expect((s.adjustments[0] as { windows: number[][] }).windows[0].map(at)).toEqual([expect.closeTo(1.05, 9), expect.closeTo(2.35, 9)])
    // (a slot without holds as it was)
    expect(m.character.clips[1]).toEqual(v3slot({ id: 'idle', name: 'Idle' }))
    expect(m.notes.some(n => /held pieces/.test(n))).toBe(true)
    expect(migrate(m.character).migrated).toBe(false)
  })

  it('moves retime markers so the warp plays the same seconds', () => {
    const s = migrate(v3char([v3slot({ time: { markers: [{ id: 'm', u: 0.75, to: 0.5 }], holds: [{ id: 'h', u: 0.5, seconds: 1 }] } })]), { clipTimes: { atk: { seconds: 2 } } }).character.clips[0]
    // (old: seconds of u = W(u)·2 + the hold's second past 0.5; new: W'(u')·3)
    const W = (ms: Array<{ u: number, to: number }>, u: number): number => {
      const xs = [0, ...ms.map(m => m.u), 1]; const ys = [0, ...ms.map(m => m.to), 1]
      let i = 1; while (i < xs.length - 1 && xs[i] < u) i++
      return ys[i - 1] + (u - xs[i - 1]) / (xs[i] - xs[i - 1]) * (ys[i] - ys[i - 1])
    }
    const old = (u: number): number => W([{ u: 0.75, to: 0.5 }], u) * 2 + (u > 0.5 ? 1 : 0)
    const move = (u: number): number => (u * 2 + (u > 0.5 ? 1 : 0)) / 3
    for (const u of [0.1, 0.3, 0.5, 0.6, 0.75, 0.9]) expect(W(s.time!.markers!, move(u)) * 3).toBeCloseTo(old(u), 9)
  })

  it('needs the clip\'s length: measured, else strict readers throw and the holds go with a note', () => {
    const raw = v3char([held()])
    expect(needsClipTimes(raw)).toBe(true)
    expect(needsClipTimes(v3char([v3slot()]))).toBe(false)
    expect(unmeasured(raw, {})).toEqual(['Attack'])
    expect(unmeasured(raw, {}, ['atk'])).toEqual([])
    expect(() => readCharacter(raw)).toThrow(/measured/)
    const loose = migrate(raw)
    expect(loose.character.clips[0].pieces).toBeUndefined()
    expect(loose.character.clips[0].time).toEqual({ fit: { enabled: true, at: 0.45 } })
    expect(loose.notes.some(n => /dropped/.test(n))).toBe(true)
    const p = piecesFromHolds(held(), 2, 'x')
    expect(p.pieces).toHaveLength(4)
  })
})

describe('schema 4 -> 5 (a dynamic character\'s dressing as data)', () => {
  const skin = (name: string, tags?: string[]): Skin => ({ name, file: `skins/${name}.png`, ...(tags !== undefined ? { tags } : {}) })
  const folkV4 = (): V4Character => {
    const c = makeCharacter({
      id: 'folk-v6-aaaaaa',
      gear: [
        makeGear({ id: 'h1', name: 'Hair_braids', role: 'hair', swapSet: 'hair', tags: ['fem', 'long'] }),
        makeGear({ id: 'h2', name: 'Hair_tonsure', role: 'hair', swapSet: 'hair', tags: ['masc'] }),
        makeGear({ id: 'b1', name: 'Beard_full', role: 'beard', swapSet: 'beard' }),
        makeGear({ id: 'm1', name: 'Outfit_mail_helm', outfit: 'mail', tags: ['covers-hair'] }),
        makeGear({ id: 'm2', name: 'Outfit_mail_forearm_L', outfit: 'mail' }),
        makeGear({ id: 's1', name: 'Outfit_straw_hat', outfit: 'straw' }),
        makeGear({ id: 'x', name: 'Axe' }),
      ],
      look: { layers: [], skins: [skin('asha', ['female']), skin('bran')], clothes: [skin('plain'), { ...skin('long'), file: 'clothes/long.png', tags: ['long-sleeves'] }], skin: 'bran', clothing: 'plain' },
    })
    return { ...c, schema: 4 } as unknown as V4Character
  }

  it('only moves a character that isn\'t dynamic to schema 5', () => {
    const plain = { ...makeCharacter(), schema: 4 }
    const m = migrate(plain)
    expect([m.migrated, m.from, m.character.schema]).toEqual([true, 4, 5])
    expect(m.character.folk).toBeUndefined()
    expect(m.character.look.cloth).toBeUndefined()
    expect({ ...m.character, schema: 4 }).toEqual(plain)
    expect(m.notes).toEqual([])
  })

  it('makes each outfit a set, the roles and skins pools with the old rules, the clothes cloth layers, one kind', () => {
    const v4 = folkV4()
    const m = migrate(v4)
    const c = m.character
    expect([m.migrated, m.from, c.schema]).toEqual([true, 4, 5])
    const f = c.folk!
    expect(f.sets).toEqual([
      { id: stableId('folk-v6-aaaaaa:set:mail'), name: 'mail', pieces: ['m1', 'm2'], tags: [], grants: ['bracers', 'covers-hair'] },
      { id: stableId('folk-v6-aaaaaa:set:straw'), name: 'straw', pieces: ['s1'], tags: [], grants: [] },
    ])
    const pool = (kind: string): Pool => f.pools.find(p => p.kind === kind)!
    expect(pool('skin').items).toEqual([{ ref: 'asha' }, { ref: 'bran' }])
    expect(pool('hair')).toMatchObject({ excludes: ['covers-hair'], items: [{ ref: 'h1', requires: ['female'] }, { ref: 'h2', excludes: ['female'] }] })
    expect(pool('beard')).toMatchObject({ chance: 0.5, excludes: ['beardless', 'covers-face'], items: [{ ref: 'b1' }] })
    const long = c.look.cloth!.find(l => l.name === 'long')!
    expect(c.look.cloth).toEqual([
      { id: stableId('folk-v6-aaaaaa:cloth:plain'), name: 'plain', slots: ['top', 'bottom'], file: 'skins/plain.png' },
      { id: long.id, name: 'long', slots: ['top', 'bottom'], file: 'clothes/long.png', shapes: ['long_sleeve'], tags: ['long-sleeves'] },
    ])
    expect(pool('cloth')).toMatchObject({ slot: 'bottom', items: [{ ref: c.look.cloth![0].id }, { ref: long.id, excludes: ['bracers'] }] })
    expect(f.kinds).toEqual([{ id: 'folk', name: 'Folk', tags: [], sets: { query: [] } }])
    expect(f.stances).toEqual([])
    // (the old fields stay, the UI reads them until it is ported)
    expect(c.gear).toEqual(v4.gear)
    expect(c.look.clothes).toEqual(v4.look.clothes)
    expect(m.notes.join('\n')).toMatch(/2 outfits are sets.*kinds folk/)
  })

  it('takes the kinds from the game\'s units of it', () => {
    const units: GameSpec = { units: {
      villager: { character: 'folk-v6-aaaaaa', height: 1.8, budget: 5000, clips: [], folk: { outfits: ['straw'] } },
      guard: { character: 'folk-v6-aaaaaa', height: 1.8, budget: 5000, clips: [], folk: { outfits: ['mail', 'gone'] } },
      other: { character: 'someone-else', height: 1.8, budget: 5000, clips: [], folk: { outfits: ['mail'] } },
    } }
    const f = migrate(folkV4(), { units }).character.folk!
    expect(f.kinds).toEqual([
      { id: 'guard', name: 'guard', tags: [], sets: [{ set: stableId('folk-v6-aaaaaa:set:mail') }] },
      { id: 'villager', name: 'villager', tags: [], sets: [{ set: stableId('folk-v6-aaaaaa:set:straw') }] },
    ])
  })

  it('is pure, deterministic and idempotent; older schemas come through it too', () => {
    const v4 = folkV4()
    const copy = structuredClone(v4)
    const once = migrate(v4)
    expect(v4).toEqual(copy)
    expect(migrate(structuredClone(v4))).toEqual(once)
    expect(migrate(once.character)).toEqual({ character: once.character, migrated: false, from: 5, notes: [], fileOps: [] })
    expect(toV5(v4)).toEqual(once.character)
    expect(needsClipTimes(v4)).toBe(false)
    expect(unmeasured(v4, undefined)).toEqual([])
    const v3 = { ...structuredClone(v4), schema: 3 }
    expect(migrate(v3).character).toEqual(once.character)
  })
})
