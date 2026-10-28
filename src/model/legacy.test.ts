// @vitest-environment node
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommands } from './commands.ts'
import { humanJoints } from './fixtures.ts'
import { toV1, v1PatchToCommands } from './legacy.ts'
import { migrate } from './migrate.ts'
import { DEFAULT_FIST, slotByName } from './select.ts'
import type { Character } from './types.ts'
import type { V1AnimationEntry, V1Character, V1ClipScript, V1Garment } from './v1.ts'

const counter = (): () => string => {
  let n = 0
  return () => `id${(n++).toString(16).padStart(6, '0')}`
}
const types = (cmds: Command[]): string[] => cmds.map(c => c.type)

const bow: V1Garment = {
  id: 'g1', name: 'Weapons_LeftHand', file: 'garments/g1/model.glb', status: 'ready', mode: 'rigid', policy: 'body', bone: 'LeftHand',
  position: [0.1, 0.2, 0.3], rotation: [10, 20, 30], scale: 1, hideBody: false, hidden: false, from: 'emberhold:archer/Weapons_LeftHand',
  sockets: [
    { id: 'left-hand', name: 'Left hand', position: [0, 0.1, 0], rotation: [0, 0, 0, 1], placed: true },
    { id: 'right-hand', name: 'Right hand', position: [0, -0.3, 0.1], rotation: [0, 1, 0, 0] },
  ],
  pulls: [{ id: 'p1', name: 'Draw', bone: 'RightHand', grip: [0, 0.07, 0], rest: [0.2, 0.4, 0], holds: { Attack: [[0.5, 1]] }, pose: 'pose:bowgrip' }],
  carryPose: 'pose:bowgrip',
  carryOpen: { Attack: [[0.6, 0.8]] },
}
const quiver: V1Garment = {
  id: 'g2', name: 'Quiver', file: 'garments/g2/model.glb', status: 'ready', mode: 'rigid', policy: 'body', bone: 'Spine2',
  position: [0, 1.3, -0.1], rotation: [0, 0, 0], scale: 1, hideBody: false, hidden: true, group: 'backs',
}

function archer (over: Partial<V1Character> = {}): V1Character {
  return {
    id: 'archer-000001', name: 'Archer', createdAt: 1, updatedAt: 2,
    source: { file: 'source/original.glb', originalName: 'archer.glb', bytes: 100 },
    status: 'rigged', kind: 'mesh', stats: { vertices: 10, triangles: 20, height: 1.8, meshes: 1, bones: 65 },
    joints: humanJoints('full'), autoJoints: humanJoints('full'), jointsEdited: false, fingers: 'full', template: 'human', scale: 1,
    files: { model: 'model.glb', rigged: 'rigged.glb' }, revision: 4, thumbVersion: 9,
    rigReport: { method: 'native-heat', seconds: 3, warnings: ['a thin wrist'] },
    handPoses: [{ id: 'bowgrip', name: 'Bow grip', side: 'Left', joints: { Index1: [0, 0, 0, 1] } }],
    garments: [bow, quiver],
    props: [{ id: 'p9', ref: 'catalog:spear_A.glb', name: 'Spear', socket: 'RightHand', position: [0, 0, 0], rotation: [-80, 0, 0], scale: 0.62 }],
    animations: [
      { clipId: 'mixamo-Idle', name: 'Idle', inPlace: true, loop: true, speed: 1, note: 'calm' },
      {
        clipId: 'custom-Attack', url: '/animations/x.glb#Attack', name: 'Attack', inPlace: true, loop: false, speed: 1.2, lift: 0.01,
        keys: { bones: { Spine: [{ u: 0, q: [0, 0, 0, 1] }] }, props: { Weapons_LeftHand: [{ u: 0.5, q: [0, 0, 0, 1], p: [0, 0, 0.1] }] } },
      },
      { clipId: 'mixamo-Walk', name: 'Walk', inPlace: false, loop: true, speed: 1 },
      { clipId: 'mixamo-Run', name: 'Run', inPlace: false, loop: true, speed: 1 },
    ],
    scripts: [
      { id: 's1', kind: 'grip', enabled: true, side: 'Right', clip: 'mixamo-2hand_Idle', open: { Idle: [[0.2, 0.4]] } },
      { id: 's2', kind: 'blow', enabled: true, clip: 'Attack', at: 0.45, hand: 'RightHand', window: 1 },
      { id: 's3', kind: 'pace', enabled: false, clip: 'Run', like: 'Walk' },
    ],
    mount: { character: 'horse-31ad32', bone: 'spine_2', position: [0, 0.17, -0.03], rotation: [0, 0, 0], freeze: ['Hips'], pose: { Hips: [0, 0, 0, 1] }, gear: ['999dd134'] },
    ...over,
  }
}

/** A JSON value with its keys in order and no undefined ones, to compare as text. */
const canon = (x: unknown): unknown => (Array.isArray(x)
  ? x.map(canon)
  : typeof x === 'object' && x !== null
    ? Object.fromEntries(Object.entries(x).filter(([, y]) => y !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, y]) => [k, canon(y)]))
    : x)
/** Scripts compared as v1 clients use them: in any order, ids aside. */
const scriptSet = (scripts: V1ClipScript[] | undefined): string[] =>
  (scripts ?? []).map(s => JSON.stringify(canon({ ...s, id: undefined }))).sort()

const all = (v: V1Character): Parameters<typeof v1PatchToCommands>[1] =>
  ({ animations: v.animations, scripts: v.scripts, garments: v.garments, props: v.props })

describe('toV1', () => {
  const v = archer()
  const c = migrate(v).character
  const w = toV1(c)

  it('gives back what the game\'s scripts read', () => {
    expect(w).toMatchObject({
      id: v.id, name: v.name, status: 'rigged', kind: 'mesh', stats: v.stats, fingers: 'full', template: 'human', files: v.files,
      revision: 4, thumbVersion: 9, scale: 1, rigReport: v.rigReport, handPoses: v.handPoses, mount: v.mount, source: v.source,
    })
    expect(w.joints).toEqual(v.joints)
    expect(w.autoJoints).toEqual(v.autoJoints)
    expect(w.jointsEdited).toBe(false)
  })

  it('gives back the animations, scripts, garments and props as they were', () => {
    expect(w.animations).toEqual(v.animations)
    expect(scriptSet(w.scripts)).toEqual(scriptSet(v.scripts))
    expect(w.garments).toEqual(v.garments)
    expect(w.props).toEqual(v.props)
  })

  it('says import warnings as an import report when the skin has no report', () => {
    const imported = toV1(migrate(archer({ status: 'ready', rigReport: { method: 'import', seconds: 0, warnings: ['legs hidden'] } })).character)
    expect(imported.rigReport).toEqual({ method: 'import', seconds: 0, warnings: ['legs hidden'] })
  })

  it('says a converted import was a mesh, and shows placed joints as edited', () => {
    expect(toV1(migrate(archer({ rigPreset: 'tripo' })).character).kind).toBe('mesh')
    const edited = toV1(migrate(archer({ joints: { ...humanJoints('full'), Hips: [0, 1.1, 0] }, jointsEdited: true })).character)
    expect(edited.jointsEdited).toBe(true)
    expect(edited.joints?.Hips).toEqual([0, 1.1, 0])
  })

  it('closes a held hand on the default fist when it names none', () => {
    const held = toV1(migrate(archer({ scripts: [{ id: 'g', kind: 'grip', enabled: true, side: 'Left', clip: DEFAULT_FIST }] })).character)
    expect(held.scripts).toEqual([{ id: 'hold-left', kind: 'grip', enabled: true, side: 'Left', clip: DEFAULT_FIST }])
  })

  it('is a copy', () => {
    w.animations[0].name = 'Changed'
    expect(c.clips[0].name).toBe('Idle')
  })

  it('says in its status what a job is doing to it, and a failure while none is', () => {
    expect(toV1(c, undefined, null).status).toBe('rigged')
    expect(toV1(c, undefined, { kind: 'inspect', status: 'queued' }).status).toBe('importing')
    expect(toV1(c, undefined, { kind: 'reimport', status: 'running' }).status).toBe('importing')
    // (a re-rig asked for is under way at once, though the old rig stays 'rigged' until it runs)
    expect(toV1(c, undefined, { kind: 'rig', status: 'queued' }).status).toBe('rigging')
    expect(toV1(c, undefined, { kind: 'rig', status: 'running' }).status).toBe('rigging')
    expect(toV1(c, undefined, { kind: 'rig', status: 'done' }).status).toBe('rigged')
    expect(toV1(c, undefined, { kind: 'compose', status: 'running' }).status).toBe('rigged')
    // a failed re-rig leaves the old rig 'rigged' with the error: v1 said 'error'
    const failed: Character = { ...c, error: 'the rig was cancelled' }
    expect(toV1(failed).status).toBe('error')
    expect(toV1(failed, undefined, null).status).toBe('error')
    expect(toV1(failed, undefined, { kind: 'rig', status: 'running' }).status).toBe('rigging')
    expect(toV1(failed, undefined, { kind: 'reimport', status: 'queued' }).status).toBe('importing')
  })
})

describe('v1PatchToCommands', () => {
  const c = migrate(archer()).character
  const v = toV1(c)

  it('makes nothing of a PATCH that changes nothing', () => {
    expect(v1PatchToCommands(c, all(v), counter())).toEqual([])
  })

  it('fills a fresh character from a template\'s clips and scripts (import_new_units)', () => {
    const fresh = migrate(archer({ id: 'newbie-000002', animations: [], scripts: [], garments: [], props: [], mount: undefined })).character
    const scripts = v.scripts!.map((s, i) => ({ ...s, id: `copy${i}` }))
    const cmds = v1PatchToCommands(fresh, { animations: v.animations, scripts }, counter())
    expect(types(cmds)).toEqual(['hands.hold', 'clips.replace'])
    const after = applyCommands(fresh, cmds).character
    expect(after.hands.hold).toEqual({ Right: { fist: 'mixamo-2hand_Idle' } })
    const w = toV1(after)
    expect(w.animations.map(a => a.name)).toEqual(['Idle', 'Attack', 'Walk', 'Run'])
    // (it has no bow: the bow's keys don't come along)
    expect(w.animations[1].keys).toEqual({ bones: { Spine: [{ u: 0, q: [0, 0, 0, 1] }] } })
    expect(scriptSet(w.scripts)).toEqual(scriptSet(v.scripts))
    expect(slotByName(after, 'Run')!.adjustments[0]).toMatchObject({ kind: 'pace', like: slotByName(after, 'Walk')!.id })
  })

  it('names, marks and puts an uploaded piece on its bone (import_gear)', () => {
    const upload: V1Garment = {
      id: 'u1', name: 'Weapons LeftHand', file: 'garments/u1/model.glb', status: 'ready', mode: 'rigid', policy: 'body', bone: 'Hips',
      position: [0.3, 0.1, 0], rotation: [0, 90, 0], scale: 2, hideBody: false, hidden: true,
    }
    const before = migrate(archer({ garments: [upload], props: [], animations: [], scripts: [] })).character
    const gs: V1Garment[] = toV1(before).garments!.map(g => ({
      ...g, name: 'Weapons_LeftHand', mode: 'rigid', bone: 'LeftHand', position: [0, 0, 0], rotation: [0, 0, 0], scale: 1,
      hideBody: false, hidden: false, from: 'emberhold:archer/Weapons_LeftHand',
    }))
    const cmds = v1PatchToCommands(before, { garments: gs }, counter())
    expect(types(cmds)).toEqual(['gear.update', 'gear.update', 'gear.attach'])
    const after = applyCommands(before, cmds).character
    expect(toV1(after).garments).toEqual(gs)
    expect(after.gear[0].handles).toMatchObject([{ kind: 'carry', hand: 'Left' }])
  })

  it('adds the game\'s new parts and takes out the ones it dropped (game_import)', () => {
    const added: V1Garment = {
      id: 'n1', name: 'Weapons_RightHand', file: 'garments/n1/model.ab12cd34.glb', status: 'ready', mode: 'rigid', policy: 'body',
      bone: 'RightHand', position: [0, 0.1, 0], rotation: [0, 0, 0], scale: 1, hideBody: false, hidden: false, from: 'emberhold:archer/Weapons_RightHand',
    }
    const cmds = v1PatchToCommands(c, { ...all(v), garments: [v.garments![0], added], props: [] }, counter())
    expect(types(cmds)).toEqual(['gear.remove', 'gear.add', 'gear.remove'])
    const after = applyCommands(c, cmds).character
    expect(after.gear.map(g => g.id)).toEqual(['g1', 'n1'])
    expect(toV1(after).garments![1]).toEqual(added)
  })

  it('moves a carried piece\'s open windows and a pull\'s holds into the slots', () => {
    const g1 = { ...v.garments![0], carryOpen: { Attack: [[0.6, 0.8]], Idle: [[0.1, 0.15]] } as V1Garment['carryOpen'] }
    g1.pulls = [{ ...g1.pulls![0], holds: { Attack: [[0.4, 0.9]] } }]
    const cmds = v1PatchToCommands(c, { garments: [g1, v.garments![1]] }, counter())
    expect(types(cmds)).toEqual(['clips.replace'])
    const after = applyCommands(c, cmds).character
    expect(after.clips.map(s => s.id)).toEqual(c.clips.map(s => s.id))
    const w = toV1(after).garments![0]
    expect(w.carryOpen).toEqual(g1.carryOpen)
    expect(w.pulls![0].holds).toEqual({ Attack: [[0.4, 0.9]] })
    // (the adjustment that was there keeps its id)
    const hold = (x: Character): string | undefined => slotByName(x, 'Attack')!.adjustments.find(a => a.kind === 'handleHold')?.id
    expect(hold(after)).toBe(hold(c))
  })

  it('lets go of a hand when its grip script goes, open windows and all', () => {
    const cmds = v1PatchToCommands(c, { scripts: v.scripts!.filter(s => s.kind !== 'grip') }, counter())
    expect(types(cmds)).toEqual(['hands.hold', 'clips.replace'])
    const after = applyCommands(c, cmds).character
    expect(after.hands.hold).toBeUndefined()
    expect(slotByName(after, 'Idle')!.adjustments).toEqual([])
  })

  it('keeps what v1 can\'t show of a slot while its clip stays', () => {
    const walk = slotByName(c, 'Walk')!
    const c2 = applyCommands(c, [
      { type: 'slot.adjust.add', slot: walk.id, adjustment: { id: 'k1', kind: 'ground', enabled: false, lift: 0.05 } },
      { type: 'slot.adjust.add', slot: walk.id, adjustment: { id: 'k2', kind: 'handPose', enabled: true, hand: 'Left', pose: { pose: 'bowgrip' } } },
    ]).character
    const v2 = toV1(c2)
    const faster = v2.animations.map((a): V1AnimationEntry => (a.name === 'Walk' ? { ...a, speed: 1.1 } : a))
    const cmds = v1PatchToCommands(c2, { animations: faster }, counter())
    expect(types(cmds)).toEqual(['clips.replace'])
    const after = slotByName(applyCommands(c2, cmds).character, 'Walk')!
    expect(after).toMatchObject({ id: walk.id, speed: 1.1 })
    expect(after.adjustments.map(a => a.id)).toEqual(['k1', 'k2'])
    // another clip in the slot: they were made for the old one
    const other = v2.animations.map((a): V1AnimationEntry => (a.name === 'Walk' ? { ...a, clipId: 'mixamo-Walk_2' } : a))
    const swapped = applyCommands(c2, v1PatchToCommands(c2, { animations: other }, counter())).character
    expect(slotByName(swapped, 'Walk')!.adjustments).toEqual([])
  })

  it('moves a catalog prop in its grip frame, its hand left open when it comes back onto one', () => {
    const off = v1PatchToCommands(c, { props: [{ ...v.props![0], socket: 'LeftForeArm', position: [0.1, 0, 0] }] }, counter())
    expect(types(off)).toEqual(['gear.attach'])
    const moved = applyCommands(c, off).character
    expect(moved.gear.find(g => g.id === 'p9')).toMatchObject({ attach: { bone: 'LeftForeArm', legacyFrame: 'grip' }, handles: [] })
    const back = v1PatchToCommands(moved, { props: v.props }, counter())
    expect(types(back)).toEqual(['gear.attach', 'gear.handle.update'])
    expect(applyCommands(moved, back).character.gear.find(g => g.id === 'p9')!.handles).toMatchObject([{ kind: 'carry', hand: 'Right', pose: 'clip' }])
  })

  it('takes the grips, pulls, holds and keys of a piece put on the skin away, and gives it none back', () => {
    const cloak: V1Garment = { ...v.garments![0], mode: 'clothing' }
    const cmds = v1PatchToCommands(c, { garments: [cloak, v.garments![1]] }, counter())
    expect(types(cmds)).toEqual(['gear.attach'])
    const after = applyCommands(c, cmds).character
    expect(after.gear[0]).toMatchObject({ attach: { kind: 'skin', policy: 'body' }, handles: [] })
    const attack = slotByName(after, 'Attack')!
    expect(attack.adjustments.map(a => a.kind).sort()).toEqual(['blowTiming', 'ground', 'keys'])
    expect(attack.adjustments.find(a => a.kind === 'keys')).toMatchObject({ bones: { Spine: [{ u: 0 }] } })
    expect(attack.adjustments.find(a => a.kind === 'keys')).not.toHaveProperty('gear')
    const w = toV1(after).garments![0]
    expect(w.mode).toBe('clothing')
    expect([w.sockets, w.pulls, w.carryPose, w.carryOpen]).toEqual([undefined, undefined, undefined, undefined])
    // sent again as it was read, nothing changes
    expect(v1PatchToCommands(after, { garments: toV1(after).garments }, counter())).toEqual([])
  })

  it('refuses what the commands refuse: the game names its own gear', () => {
    expect(() => v1PatchToCommands(c, { garments: [{ ...v.garments![0], name: 'Bow' }, v.garments![1]] }, counter())).toThrow()
  })
})

// The real workspace (a private copy), when it is there: the v1 view of each migrated character is what v1 clients
// read before, and sending it back changes nothing.
const CHARACTERS = fileURLToPath(new URL('../../workspace/characters', import.meta.url))
const real = existsSync(CHARACTERS)
  ? readdirSync(CHARACTERS).filter(id => existsSync(`${CHARACTERS}/${id}/character.json`))
  : []

describe.skipIf(real.length === 0)('toV1 of the workspace\'s characters', () => {
  it.each(real)('%s', id => {
    const raw = JSON.parse(readFileSync(`${CHARACTERS}/${id}/character.json`, 'utf8')) as V1Character & { schema?: number }
    if (raw.schema === 2) return
    const c = migrate(raw).character
    const w = toV1(c)
    // (no trim, no lift of 0, no empty keys: they did nothing)
    const entry = (a: V1AnimationEntry): unknown => canon({
      ...a, trim: undefined, lift: a.lift === 0 ? undefined : a.lift,
      keys: a.keys === undefined ? undefined : { ...a.keys, bones: Object.keys(a.keys.bones ?? {}).length > 0 ? a.keys.bones : undefined },
    })
    expect(w.animations.map(entry)).toEqual(raw.animations.map(entry))
    // (grips: the switched-off ones are gone, their notes went to the journal)
    const scripts = (raw.scripts ?? []).filter(s => s.kind !== 'grip' || s.enabled).map(s => (s.kind === 'grip' ? { ...s, note: undefined } : s))
    expect(scriptSet(w.scripts)).toEqual(scriptSet(scripts))
    expect(w.garments).toEqual((raw.garments ?? []).map(g => ({ ...g, hidden: g.hidden === true })))
    expect(w.props).toEqual(raw.props ?? [])
    expect(w.mount).toEqual(raw.mount)
    expect(w.stats?.height).toBe(raw.stats?.height)
    expect(w.rigReport?.warnings).toEqual(raw.rigReport?.warnings ?? [])
    expect(v1PatchToCommands(c, all(w), counter())).toEqual([])
  })
})
