// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommand, applyCommands, CommandError } from './commands.ts'
import { restoreEntities, undoRecord } from './entities.ts'
import { humanJoints, makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import type { Adjustment, Character, Gear, Placement, StaleOverride, TextureLayer } from './types.ts'

const run = (c: Character, ...cmds: Command[]): { character: Character, changes: string[] } => applyCommands(c, cmds)

/** The status and message a command fails with. */
function failure (f: () => unknown): { status: number, message: string } {
  try { f() } catch (e) {
    if (e instanceof CommandError) return { status: e.status, message: e.message }
    throw e
  }
  throw new Error('it did not fail')
}

const place: Placement = { position: [0.7, 1.45, 0], rotation: [0, 90, 0], scale: 1 }
const bow = (over: Partial<Gear> = {}): Gear => makeGear({
  id: 'bow', name: 'Bow', attach: { kind: 'bone', bone: 'LeftHand', place },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left' },
    { id: 'draw', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0.07, 0], rest: [0.27, 0.47, 0.02] } },
    { id: 'grip', name: 'Other hand', kind: 'grip', hand: 'Right', place: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1] } },
  ],
  ...over,
})
const adj = (a: Record<string, unknown> & { kind: Adjustment['kind'] }): Adjustment => ({ id: 'a1', enabled: true, ...a }) as Adjustment
const key = { u: 0.5, q: [0, 0, 0, 1] as [number, number, number, number] }

describe('applyCommands', () => {
  it('works on a copy and never bumps the version', () => {
    const c = makeCharacter({ version: 3, updatedAt: 5 })
    const before = structuredClone(c)
    const r = run(c, { type: 'character.rename', name: 'Hero' })
    expect(c).toEqual(before)
    expect(r.character.name).toBe('Hero')
    expect(r.character.version).toBe(3)
    expect(r.character.updatedAt).toBe(5)
  })

  it('is all or nothing', () => {
    const c = makeCharacter()
    expect(failure(() => run(c, { type: 'character.rename', name: 'Hero' }, { type: 'gear.remove', id: 'nope' })).status).toBe(404)
    expect(c.name).toBe('Tester')
  })

  it("refuses what it doesn't know", () => {
    const c = makeCharacter()
    expect(failure(() => applyCommand(c, { type: 'gear.melt' } as unknown as Command)).status).toBe(400)
    expect(failure(() => applyCommand(c, { type: 'teleport' } as unknown as Command)).status).toBe(400)
    expect(failure(() => applyCommand(c, {} as unknown as Command)).status).toBe(400)
  })
})

describe('character', () => {
  it('renames, trimmed', () => {
    const r = applyCommand(makeCharacter(), { type: 'character.rename', name: '  Hero ' })
    expect(r.character.name).toBe('Hero')
    expect(r.changes).toEqual(['name: Tester -> Hero'])
    expect(applyCommand(makeCharacter(), { type: 'character.rename', name: 'Tester' }).changes).toEqual([])
    expect(failure(() => applyCommand(makeCharacter(), { type: 'character.rename', name: ' ' })).status).toBe(400)
  })
})

describe('skeleton', () => {
  const d = humanJoints()

  it('keeps as overrides only the joints placed away from where they were detected', () => {
    const r = applyCommand(makeCharacter(), { type: 'skeleton.place', joints: { LeftHand: [0.7, 1.5, 0], RightHand: [d.RightHand[0] + 5e-7, d.RightHand[1], d.RightHand[2]] } })
    expect(r.character.skeleton.overrides).toEqual({ LeftHand: [0.7, 1.5, 0] })
    expect(r.changes).toEqual(['skeleton: placed LeftHand'])
    const back = applyCommand(r.character, { type: 'skeleton.place', joints: { LeftHand: d.LeftHand } })
    expect(back.character.skeleton.overrides).toEqual({})
    expect(back.changes).toEqual(['skeleton: LeftHand back where detected'])
  })

  it('refuses joints the skeleton lacks, and saves or clears the markers', () => {
    expect(failure(() => applyCommand(makeCharacter(), { type: 'skeleton.place', joints: { Tail: [0, 0, 0] } })).status).toBe(400)
    const markers = { set: 'human', base: { Hips: d.Hips }, positions: { hips: d.Hips } }
    const r = applyCommand(makeCharacter(), { type: 'skeleton.place', joints: {}, markers })
    expect(r.character.skeleton.markers).toEqual(markers)
    expect(r.changes).toEqual(['markers placed (human)'])
    expect(applyCommand(r.character, { type: 'skeleton.markers', markers: null }).changes).toEqual(['markers cleared'])
  })

  it('unplaces and resets', () => {
    const stale: StaleOverride[] = [{ joint: 'LeftHandIndex1', at: [1, 1, 1], reason: 'finger level', template: 'human', level: 'two' }]
    const c = makeCharacter({ skeleton: { overrides: { LeftHand: [1, 1, 1], Head: [0, 2, 0] }, stale, markers: { set: 'human', base: {}, positions: {} } } })
    const un = applyCommand(c, { type: 'skeleton.unplace', joints: ['Head', 'Neck'] })
    expect(un.character.skeleton.overrides).toEqual({ LeftHand: [1, 1, 1] })
    expect(un.changes).toEqual(['skeleton: Head back where detected'])
    const reset = applyCommand(un.character, { type: 'skeleton.reset' })
    expect(reset.character.skeleton.overrides).toEqual({})
    expect(reset.character.skeleton.markers).toBeUndefined()
    expect(reset.character.skeleton.stale).toBeUndefined()
    expect(reset.changes).toEqual(['skeleton: back to detected (1 placed joint, the markers and 1 set-aside placement cleared)'])
  })

  it('restores set-aside placements only where they were made', () => {
    const stale: StaleOverride[] = [
      { joint: 'LeftHandIndex1', at: [1, 1, 1], reason: 'finger level', template: 'human', level: 'full' },
      { joint: 'LeftHandIndex2', at: [2, 2, 2], reason: 'finger level', template: 'human', level: 'two' },
    ]
    const c = makeCharacter({ skeleton: { fingerLevel: 'two', stale } })
    const r = applyCommand(c, { type: 'skeleton.stale', action: 'restore' })
    expect(r.character.skeleton.overrides).toEqual({ LeftHandIndex2: [2, 2, 2] })
    expect(r.character.skeleton.stale).toEqual([stale[0]])
    expect(r.changes).toEqual(['skeleton: restored LeftHandIndex2', 'skeleton: LeftHandIndex1 still set aside (made at finger level full)'])
    expect(failure(() => applyCommand(r.character, { type: 'skeleton.stale', action: 'restore', joints: ['LeftHandIndex1'] })).status).toBe(409)
    expect(failure(() => applyCommand(r.character, { type: 'skeleton.stale', action: 'discard', joints: ['Head'] })).status).toBe(404)
    const gone = applyCommand(r.character, { type: 'skeleton.stale', action: 'discard', joints: ['LeftHandIndex1'] })
    expect(gone.character.skeleton.stale).toBeUndefined()
  })

  it('sets and clears the bone map', () => {
    const r = applyCommand(makeCharacter(), { type: 'skeleton.boneMap', boneMap: { Hips: 'pelvis' } })
    expect(r.character.skeleton.boneMap).toEqual({ Hips: 'pelvis' })
    expect(applyCommand(r.character, { type: 'skeleton.boneMap', boneMap: null }).character.skeleton.boneMap).toBeUndefined()
  })
})

describe('skin', () => {
  it('locks with a reason and unlocks', () => {
    const r = applyCommand(makeCharacter(), { type: 'skin.lock', locked: true, reason: 'hand-fixed weights' })
    expect(r.character.skin).toMatchObject({ locked: true, lockReason: 'hand-fixed weights' })
    expect(r.changes).toEqual(['skin: locked (hand-fixed weights)'])
    expect(applyCommand(r.character, { type: 'skin.lock', locked: true }).changes).toEqual([])
    const open = applyCommand(r.character, { type: 'skin.lock', locked: false })
    expect(open.character.skin.lockReason).toBeUndefined()
    expect(open.changes).toEqual(['skin: unlocked'])
  })
})

describe('hands', () => {
  const grip = { id: 'p1', name: 'Grip', side: 'Right' as const, joints: { Index1: [0, 0, 0.5, 0.87] as [number, number, number, number] } }

  it('adds poses once per id', () => {
    const r = applyCommand(makeCharacter(), { type: 'hands.pose.add', pose: { ...grip, from: { clip: 'mixamo-Idle', at: 0.5 } } })
    expect(r.changes).toEqual(['hand pose Grip: added (from mixamo-Idle at 0.50 s)'])
    expect(failure(() => applyCommand(r.character, { type: 'hands.pose.add', pose: grip })).status).toBe(409)
    const u = applyCommand(r.character, { type: 'hands.pose.update', id: 'p1', patch: { name: 'Fist' } })
    expect(u.changes).toEqual(['hand pose Grip: renamed Fist'])
  })

  it('falls back to the default fist wherever a removed pose was used', () => {
    const c = makeCharacter({
      hands: { poses: [grip], hold: { Right: { pose: 'p1' } } },
      gear: [bow({ handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left', pose: { pose: 'p1' } }] })],
      clips: [makeSlot({ name: 'Attack', adjustments: [adj({ kind: 'handPose', hand: 'Left', pose: { pose: 'p1' }, windows: [[0.2, 0.4]] })] })],
    })
    const r = applyCommand(c, { type: 'hands.pose.remove', id: 'p1' })
    expect(r.character.hands.poses).toEqual([])
    expect(r.character.hands.hold).toEqual({ Right: 'default' })
    expect(r.character.gear[0].handles[0].pose).toBe('default')
    expect(r.character.clips[0].adjustments[0]).toMatchObject({ pose: 'default' })
    expect(r.changes).toEqual([
      'hand pose Grip: removed',
      'gear Bow: Carried back in the default fist (Grip was removed)',
      'clip Attack: Left hand back in the default fist (Grip was removed)',
      'Right hand: held in the default fist (Grip was removed)',
    ])
  })

  it('holds a hand in every clip, or no longer', () => {
    const r = applyCommand(makeCharacter(), { type: 'hands.hold', side: 'Left', pose: 'clip' })
    expect(r.character.hands.hold).toEqual({ Left: 'clip' })
    expect(r.changes).toEqual(['Left hand: held as the clip has it in every clip'])
    expect(applyCommand(r.character, { type: 'hands.hold', side: 'Left', pose: null }).character.hands.hold).toBeUndefined()
  })
})

describe('gear', () => {
  it('adds a carry handle to a piece put on a hand', () => {
    const spear = makeGear({ id: 'spear', name: 'Spear', catalog: 'spear_A.glb', from: 'catalog:spear_A.glb', attach: { kind: 'bone', bone: 'RightHand', place } })
    const r = applyCommand(makeCharacter(), { type: 'gear.add', gear: spear })
    expect(r.character.gear[0].handles).toEqual([{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Right' }])
    expect(r.changes).toEqual(['gear Spear: added (on RightHand)', 'gear Spear: carried in the Right hand'])
  })

  it('makes a taken name unique, except for the game’s own gear', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'a', name: 'Gear_Axe' })] })
    const r = applyCommand(c, { type: 'gear.add', gear: makeGear({ id: 'b', name: 'Gear Axe' }) })
    expect(r.character.gear[1].name).toBe('Gear Axe 2')
    expect(r.changes[0]).toBe('gear Gear Axe 2: added (on Spine2; Gear Axe was taken)')
    expect(failure(() => applyCommand(c, { type: 'gear.add', gear: makeGear({ id: 'b', name: 'Gear Axe', from: 'emberhold:raider/Gear_Axe' }) })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'gear.add', gear: makeGear({ id: 'a', name: 'Pick' }) })).status).toBe(409)
  })

  it("checks a piece's files and bone", () => {
    const c = makeCharacter()
    expect(failure(() => applyCommand(c, { type: 'gear.add', gear: makeGear({ model: 'garments/other/model.glb' }) })).status).toBe(400)
    expect(failure(() => applyCommand(c, { type: 'gear.add', gear: makeGear({ model: 'garments/g1/../../x.glb' }) })).status).toBe(400)
    expect(applyCommand(c, { type: 'gear.add', gear: makeGear({ model: 'garments/g1/model.glb' }) }).character.gear[0].model).toBe('garments/g1/model.glb')
    expect(failure(() => applyCommand(c, { type: 'gear.add', gear: makeGear({ attach: { kind: 'bone', bone: 'Tail', place } }) })).status).toBe(400)
  })

  it('hides the rest of a swap set when one of it is shown', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'axe', name: 'Axe', swapSet: 'tools' }), makeGear({ id: 'pick', name: 'Pick', swapSet: 'tools', hidden: true }), makeGear({ id: 'cap', name: 'Cap' })] })
    const r = applyCommand(c, { type: 'gear.update', id: 'pick', patch: { hidden: false } })
    expect(r.character.gear.map(g => g.hidden === true)).toEqual([true, false, false])
    expect(r.changes).toEqual(['gear Pick: shown', 'gear Axe: hidden (Pick of swap set tools shown)'])
  })

  it("won't rename the game's gear, or onto a taken name", () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'a', name: 'GearAxe', from: 'emberhold:raider/GearAxe' }), makeGear({ id: 'b', name: 'Cap' })] })
    expect(failure(() => applyCommand(c, { type: 'gear.update', id: 'a', patch: { name: 'Axe' } })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'gear.update', id: 'b', patch: { name: 'GearAxe' } })).status).toBe(409)
    expect(applyCommand(c, { type: 'gear.update', id: 'b', patch: { name: 'Hat' } }).changes).toEqual(['gear Cap: renamed Hat'])
  })

  it('takes the carry handle and its hand poses away when a piece leaves the hands', () => {
    const c = makeCharacter({ gear: [bow()], clips: [makeSlot({ name: 'Attack', adjustments: [adj({ kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.5, 0.7]], gear: 'bow' })] })] })
    const r = applyCommand(c, { type: 'gear.attach', id: 'bow', attach: { kind: 'bone', bone: 'Spine2', place } })
    expect(r.character.gear[0].handles.map(h => h.kind)).toEqual(['pull', 'grip'])
    expect(r.character.clips[0].adjustments).toEqual([])
    expect(r.changes).toEqual([
      'gear Bow: on Spine2',
      'gear Bow: no longer carried (its carry handle removed)',
      "clip Attack: hand pose letting go of Bow removed (it isn't carried)",
    ])
  })

  it('moves the hand poses to the other hand with the piece, unless that hand is posed then', () => {
    const slots = [
      makeSlot({ id: 's1', name: 'Attack', adjustments: [adj({ kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.5, 0.7]], gear: 'bow' })] }),
      makeSlot({ id: 's2', name: 'Shoot', adjustments: [adj({ kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'bow' }), adj({ id: 'a2', kind: 'handPose', hand: 'Right', pose: 'default', windows: [[0.6, 0.8]] })] }),
    ]
    const r = applyCommand(makeCharacter({ gear: [bow()], clips: slots }), { type: 'gear.attach', id: 'bow', attach: { kind: 'bone', bone: 'RightHand', place } })
    expect(r.character.gear[0].handles[0]).toMatchObject({ kind: 'carry', hand: 'Right' })
    expect(r.character.clips[0].adjustments[0]).toMatchObject({ hand: 'Right', gear: 'bow' })
    expect(r.character.clips[1].adjustments.map(a => a.id)).toEqual(['a2'])
  })

  it('replaces the attachment whole on a kind change', () => {
    const r = applyCommand(makeCharacter({ gear: [makeGear()] }), { type: 'gear.attach', id: 'g1', attach: { kind: 'skin', policy: 'cape', place } })
    expect(r.character.gear[0].attach).toEqual({ kind: 'skin', policy: 'cape', place })
    expect(r.changes).toEqual(['gear Axe: worn on the skin (follows cape)', 'gear Axe: placed at [0.7, 1.45, 0], turned [0, 90, 0], size 1'])
  })

  it('takes grips, pulls, their holds and the keys on a piece away when it leaves the bones, and undo brings them back', () => {
    const c = makeCharacter({
      gear: [bow()],
      clips: [
        makeSlot({ id: 's1', name: 'Shoot', bones: { Hips: [key] }, gear: { bow: { keys: [key] } }, muted: ['gear:bow'], adjustments: [
          adj({ id: 'h', kind: 'handleHold', gear: 'bow', handle: 'draw', windows: [[0.5, 1]] }),
          adj({ id: 'p', kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'bow' }),
          adj({ id: 'g', kind: 'ground', lift: 0.01 }),
        ] }),
        makeSlot({ id: 's2', name: 'Walk', gear: { bow: { keys: [key] } } }),
      ],
    })
    const r = applyCommand(c, { type: 'gear.attach', id: 'bow', attach: { kind: 'skin', policy: 'body', place } })
    expect(r.character.gear[0].handles).toEqual([])
    expect(r.character.clips[0]).toEqual(makeSlot({ id: 's1', name: 'Shoot', bones: { Hips: [key] }, adjustments: [adj({ id: 'g', kind: 'ground', lift: 0.01 })] }))
    expect(r.character.clips[1]).toEqual(makeSlot({ id: 's2', name: 'Walk' }))
    expect(r.changes).toEqual([
      'gear Bow: worn on the skin (follows body)',
      'gear Bow: no longer carried (its carry handle removed)',
      "clip Shoot: hand pose letting go of Bow removed (it isn't carried)",
      "gear Bow: pull Draw (drawn by RightHand) removed (it isn't on a bone)",
      "gear Bow: grip Other hand (Right hand) removed (it isn't on a bone)",
      "clip Shoot: the track of Bow removed (it isn't on a bone)",
      "clip Shoot: hold of Bow · Draw removed (it isn't on a bone)",
      "clip Walk: the track of Bow removed (it isn't on a bone)",
    ])
    // (the piece and its slots are the entities the write touched)
    const undo = undoRecord(c, r.character)
    expect(undo.entities.map(e => e.key).sort()).toEqual(['gear:bow', 'slot:s1', 'slot:s2'])
    const back = restoreEntities(r.character, undo)
    expect(back.gear).toEqual(c.gear)
    expect(back.clips).toEqual(c.clips)

    // from one bone to another they stay
    const moved = applyCommand(c, { type: 'gear.attach', id: 'bow', attach: { kind: 'bone', bone: 'Spine2', place } })
    expect(moved.character.gear[0].handles.map(h => h.id)).toEqual(['draw', 'grip'])
    expect(moved.character.clips[0].adjustments.map(a => a.id)).toEqual(['h', 'g'])
    expect(moved.character.clips.map(s => s.gear)).toEqual([{ bow: { keys: [key] } }, { bow: { keys: [key] } }])
  })

  it('gives grips and pulls only to a piece on a bone', () => {
    const cape = makeCharacter({ gear: [makeGear({ attach: { kind: 'skin', policy: 'cape', place } })] })
    const grip = { id: 'h', name: 'Grip', kind: 'grip' as const }
    const pull = { id: 'p', name: 'Draw', kind: 'pull' as const, pull: { bone: 'RightHand', grip: [0, 0, 0] as [number, number, number], rest: [0, 0, 0] as [number, number, number] } }
    expect(failure(() => applyCommand(cape, { type: 'gear.handle.add', gear: 'g1', handle: grip })).status).toBe(400)
    expect(failure(() => applyCommand(cape, { type: 'gear.handle.add', gear: 'g1', handle: pull })).status).toBe(400)
    expect(applyCommand(makeCharacter({ gear: [makeGear()] }), { type: 'gear.handle.add', gear: 'g1', handle: grip }).changes).toEqual(['gear Axe: grip Grip added'])
    // (a piece added off the bones comes without them)
    const added = applyCommand(makeCharacter(), { type: 'gear.add', gear: makeGear({ attach: { kind: 'spot', place }, handles: [grip] }) })
    expect(added.character.gear[0].handles).toEqual([])
    expect(added.changes).toEqual(['gear Axe: added (pinned to the skin)', "gear Axe: grip Grip removed (it isn't on a bone)"])
  })

  it('places a piece, out of the old grip frame for good', () => {
    const c = makeCharacter({ gear: [makeGear({ name: 'GearAxe', attach: { kind: 'bone', bone: 'Spine2', place, legacyFrame: 'grip' } })] })
    const r = applyCommand(c, { type: 'gear.place', id: 'g1', place: { position: [0.1, 1.2, 0], rotation: [0, 90, 0], scale: 1.16 } })
    expect(r.character.gear[0].attach).toEqual({ kind: 'bone', bone: 'Spine2', place: { position: [0.1, 1.2, 0], rotation: [0, 90, 0], scale: 1.16 } })
    expect(r.changes).toEqual(['gear GearAxe: placed at [0.1, 1.2, 0], turned [0, 90, 0], size 1.16'])
    expect(failure(() => applyCommand(c, { type: 'gear.place', id: 'g1', place: { ...place, scale: 0 } })).status).toBe(400)
  })

  it('takes out what pointed at a removed piece', () => {
    const c = makeCharacter({
      gear: [bow()],
      clips: [
        makeSlot({ id: 's1', name: 'Shoot', gear: { bow: { keys: [key], shown: [{ u: 0.5, shown: false }] } }, adjustments: [
          adj({ id: 'h', kind: 'handleHold', gear: 'bow', handle: 'draw', windows: [[0.5, 1]] }),
          adj({ id: 'p', kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'bow' }),
          adj({ id: 'g', kind: 'ground', lift: 0.01 }),
        ] }),
        makeSlot({ id: 's2', name: 'Walk', bones: { Hips: [key] }, gear: { bow: { keys: [key] } } }),
      ],
    })
    const r = applyCommand(c, { type: 'gear.remove', id: 'bow' })
    expect(r.character.gear).toEqual([])
    expect(r.character.clips[0].adjustments.map(a => a.id)).toEqual(['g'])
    expect(r.character.clips[0].gear).toBeUndefined()
    expect(r.character.clips[1]).toEqual(makeSlot({ id: 's2', name: 'Walk', bones: { Hips: [key] } }))
    expect(r.changes).toEqual([
      'gear Bow: removed',
      'clip Shoot: the track of Bow removed',
      'clip Shoot: hold of Bow · Draw removed',
      'clip Shoot: hand pose letting go of Bow removed',
      'clip Walk: the track of Bow removed',
    ])
  })

  it('keeps the carry handle and takes holds out with their handle', () => {
    const c = makeCharacter({ gear: [bow()], clips: [makeSlot({ name: 'Shoot', adjustments: [adj({ kind: 'handleHold', gear: 'bow', handle: 'draw', windows: [[0.5, 1]] })] })] })
    expect(failure(() => applyCommand(c, { type: 'gear.handle.remove', gear: 'bow', id: 'carry' })).status).toBe(409)
    const r = applyCommand(c, { type: 'gear.handle.remove', gear: 'bow', id: 'draw' })
    expect(r.character.gear[0].handles.map(h => h.id)).toEqual(['carry', 'grip'])
    expect(r.character.clips[0].adjustments).toEqual([])
    expect(r.changes).toEqual(['gear Bow: pull Draw (drawn by RightHand) removed', 'clip Shoot: hold of Bow · Draw removed'])
  })

  it('adds and changes handles under their rules', () => {
    const c = makeCharacter({ gear: [bow()] })
    const pull = { id: 'p2', name: 'Nock', kind: 'pull' as const, pull: { bone: 'LeftHand', grip: [0, 0, 0] as [number, number, number], rest: [0, 0, 0] as [number, number, number] } }
    expect(applyCommand(c, { type: 'gear.handle.add', gear: 'bow', handle: pull }).character.gear[0].handles[3].hand).toBe('Left')
    expect(failure(() => applyCommand(c, { type: 'gear.handle.add', gear: 'bow', handle: { ...pull, name: 'Draw' } })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'gear.handle.add', gear: 'bow', handle: { id: 'c2', name: 'Again', kind: 'carry' } })).status).toBe(409)
    const u = applyCommand(c, { type: 'gear.handle.update', gear: 'bow', id: 'grip', patch: { hand: null, pose: 'clip', exact: true } })
    expect(u.character.gear[0].handles[2]).toEqual({ id: 'grip', name: 'Other hand', kind: 'grip', place: { position: [0, 0.1, 0], rotation: [0, 0, 0, 1] }, exact: true, pose: 'clip' })
    expect(failure(() => applyCommand(c, { type: 'gear.handle.update', gear: 'bow', id: 'carry', patch: { hand: 'Right' } })).status).toBe(400)
  })
})

describe('clips', () => {
  const walk = makeSlot({ id: 'walk', name: 'Walk', clip: { id: 'mixamo-Walking' } })

  it('adds slots with free names', () => {
    const c = makeCharacter({ clips: [walk] })
    const r = applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'run', name: 'Run', clip: { id: 'mixamo-Running' } }), index: 0 })
    expect(r.character.clips.map(s => s.id)).toEqual(['run', 'walk'])
    expect(r.changes).toEqual(['clip Run: added (mixamo-Running)'])
    expect(failure(() => applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'x', name: 'Walk' }) })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'slot.add', slot: makeSlot({ id: 'walk', name: 'Other' }) })).status).toBe(409)
  })

  it('fills a slot: what was made for the old clip goes unless kept, keys merge per track', () => {
    const c = makeCharacter({ clips: [makeSlot({
      id: 'atk', name: 'Attack', speed: 1.3, bones: { Hips: [key] }, time: { fit: { enabled: true, at: 0.45 } }, events: [{ id: 'e', name: 'hit', u: 0.5 }],
      adjustments: [adj({ id: 'g', kind: 'ground', lift: 0.02 })],
    })] })
    const r = applyCommand(c, { type: 'slot.fill', id: 'atk', clip: { id: 'custom-1' }, loop: false })
    expect(r.character.clips[0]).toEqual(makeSlot({ id: 'atk', name: 'Attack', clip: { id: 'custom-1' }, speed: 1, loop: false }))
    expect(r.changes).toEqual(['clip Attack: mixamo-Idle -> custom-1', 'clip Attack: speed 1.3 -> 1', 'clip Attack: plays once',
      'clip Attack: ground lift 0.02, blow at 45%, keys and gear tracks and 1 event dropped (made for the clip it had)'])
    const kept = applyCommand(c, { type: 'slot.fill', id: 'atk', clip: { id: 'custom-1' }, keepAdjustments: true, bones: { Spine: [key] } })
    expect(kept.character.clips[0].bones).toEqual({ Hips: [key], Spine: [key] })
    expect(kept.character.clips[0].time).toEqual({ fit: { enabled: true, at: 0.45 } })
    expect(kept.character.clips[0].events).toEqual([{ id: 'e', name: 'hit', u: 0.5 }])
    // (a second hit is refused: one blow per slot)
    expect(failure(() => applyCommand(c, { type: 'slot.fill', id: 'atk', clip: { id: 'x' }, keepAdjustments: true, events: [{ id: 'e2', name: 'hit', u: 0.6 }] })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'slot.fill', id: 'atk', clip: { id: 'x' }, keepAdjustments: true, adjustments: [adj({ id: 'g2', kind: 'ground', lift: 0 })] })).status).toBe(409)
  })

  it('fills a new slot by name, never one that exists', () => {
    const c = makeCharacter({ clips: [walk] })
    const r = applyCommand(c, { type: 'slot.fill', name: 'Run', newId: 'run', clip: { id: 'mixamo-Running' }, loop: true, inPlace: true })
    expect(r.character.clips[1]).toEqual(makeSlot({ id: 'run', name: 'Run', clip: { id: 'mixamo-Running' } }))
    expect(failure(() => applyCommand(c, { type: 'slot.fill', name: 'Walk', newId: 'w2', clip: { id: 'x' } })).status).toBe(409)
    expect(failure(() => applyCommand(c, { type: 'slot.fill', id: 'walk', name: 'Walk', clip: { id: 'x' } })).status).toBe(400)
  })

  it('takes out the paces that followed a removed slot', () => {
    const c = makeCharacter({ clips: [walk, makeSlot({ id: 'carry', name: 'Carry', time: { pace: { enabled: true, like: 'walk' } } })] })
    const r = applyCommand(c, { type: 'slot.remove', id: 'walk' })
    expect(r.character.clips).toEqual([makeSlot({ id: 'carry', name: 'Carry' })])
    expect(r.changes).toEqual(['clip Walk: removed', 'clip Carry: pace of Walk removed (that clip is gone)'])
  })

  it('reorders, the slots not named keeping their place after', () => {
    const c = makeCharacter({ clips: [walk, makeSlot({ id: 'a', name: 'A' }), makeSlot({ id: 'b', name: 'B' })] })
    expect(applyCommand(c, { type: 'slot.reorder', ids: ['b', 'walk'] }).character.clips.map(s => s.id)).toEqual(['b', 'walk', 'a'])
    expect(failure(() => applyCommand(c, { type: 'slot.reorder', ids: ['b', 'b'] })).status).toBe(400)
    expect(failure(() => applyCommand(c, { type: 'slot.reorder', ids: ['zz'] })).status).toBe(404)
  })

  it('keeps one of each per slot and hand poses apart', () => {
    const c = makeCharacter({ gear: [bow()], clips: [walk, makeSlot({ id: 's', name: 'Shoot', adjustments: [adj({ kind: 'ground', lift: 0 }), adj({ id: 'hp', kind: 'handPose', hand: 'Right', pose: 'default', windows: [[0.2, 0.4]] })] })] })
    const add = (a: Adjustment): Command => ({ type: 'slot.adjust.add', slot: 's', adjustment: a })
    expect(failure(() => applyCommand(c, add(adj({ id: 'g2', kind: 'ground', lift: 1 })))).status).toBe(409)
    expect(failure(() => applyCommand(c, add(adj({ id: 'x', kind: 'handPose', hand: 'Right', pose: 'clip', windows: [[0.3, 0.5]] })))).status).toBe(409)
    expect(failure(() => applyCommand(c, add(adj({ id: 'x', kind: 'handPose', hand: 'Right', pose: 'clip' })))).status).toBe(409)
    expect(applyCommand(c, add(adj({ id: 'x', kind: 'handPose', hand: 'Right', pose: 'clip', windows: [[0.4, 0.6]] }))).changes)
      .toEqual(['clip Shoot: Right hand as the clip has it in 40%-60% added'])
    expect(failure(() => applyCommand(c, add(adj({ id: 'x', kind: 'handleHold', gear: 'bow', handle: 'grip', windows: [[0, 1]] })))).status).toBe(400)
    expect(failure(() => applyCommand(c, add(adj({ id: 'x', kind: 'handleHold', gear: 'nope', handle: 'draw', windows: [[0, 1]] })))).status).toBe(404)
    expect(failure(() => applyCommand(c, add(adj({ id: 'x', kind: 'handPose', hand: 'Right', pose: 'clip', gear: 'bow', windows: [[0.8, 0.9]] })))).status).toBe(400)
    // (blow timing, pace and keys are the slot's time and tracks now)
    expect(failure(() => applyCommand(c, add({ id: 'x', kind: 'pace', like: 'walk', enabled: true } as unknown as Adjustment))).message).toMatch(/slot.time/)
  })

  it('updates an adjustment, null unsetting a field', () => {
    const c = makeCharacter({ clips: [makeSlot({ id: 's', name: 'Shoot', adjustments: [adj({ kind: 'handPose', hand: 'Left', pose: 'clip', windows: [[0.2, 0.4]] }), adj({ id: 'g', kind: 'ground', lift: 0.1 })] })] })
    const r = applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'a1', patch: { windows: null } })
    expect(r.character.clips[0].adjustments[0]).toEqual(adj({ kind: 'handPose', hand: 'Left', pose: 'clip' }))
    expect(r.changes).toEqual(['clip Shoot: Left hand as the clip has it in 20%-40% -> Left hand as the clip has it in the whole clip'])
    expect(applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'g', patch: { enabled: false } }).changes).toEqual(['clip Shoot: ground lift 0.1 off'])
    expect(failure(() => applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'g', patch: { kind: 'handPose' } })).status).toBe(400)
    expect(failure(() => applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'g', patch: { at: 1 } })).status).toBe(400)
    // (windows are source time: past 1 is the held end, up to MAX_U)
    expect(applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'a1', patch: { windows: [[1.2, 2]] } }).character.clips[0].adjustments[0]).toMatchObject({ windows: [[1.2, 2]] })
    expect(failure(() => applyCommand(c, { type: 'slot.adjust.update', slot: 's', id: 'a1', patch: { windows: [[1, 17]] } })).status).toBe(400)
  })

  it('removes and sets adjustments', () => {
    const c = makeCharacter({ clips: [makeSlot({ id: 's', name: 'Shoot', adjustments: [adj({ kind: 'ground', lift: 0.1 })] })] })
    expect(applyCommand(c, { type: 'slot.adjust.remove', slot: 's', id: 'a1' }).changes).toEqual(['clip Shoot: ground lift 0.1 removed'])
    const set = applyCommand(c, { type: 'slot.adjust.set', slot: 's', adjustments: [adj({ id: 'g', kind: 'ground', lift: 0.2 })] })
    expect(set.character.clips[0].adjustments).toEqual([adj({ id: 'g', kind: 'ground', lift: 0.2 })])
    expect(set.changes).toEqual(['clip Shoot: adjustments now ground lift 0.2'])
  })

  it("replaces the set, mapping another character's gear by name and dropping what doesn't resolve", () => {
    const c = makeCharacter({ gear: [bow({ id: 'mine' })], clips: [walk] })
    const slots = [
      makeSlot({ id: 'n1', name: 'Shoot', time: { pace: { enabled: true, like: 'elsewhere' } }, gear: { theirs: { keys: [key] }, gone: { keys: [key] } }, muted: ['gear:theirs', 'gear:gone'], adjustments: [
        adj({ id: 'h', kind: 'handleHold', gear: 'theirs', handle: 'p9', windows: [[0.5, 1]] }),
        adj({ id: 'p', kind: 'handPose', hand: 'Right', pose: 'clip', gear: 'theirs', windows: [[0.1, 0.2]] }),
      ] }),
    ]
    const r = applyCommand(c, { type: 'clips.replace', slots, gearNames: { theirs: 'Bow', gone: 'Lute' }, handleNames: { 'theirs/p9': 'Draw' } })
    expect(r.character.clips.map(s => s.id)).toEqual(['n1'])
    expect(r.character.clips[0]).toEqual(makeSlot({
      id: 'n1', name: 'Shoot', gear: { mine: { keys: [key] } }, muted: ['gear:mine'], adjustments: [
        adj({ id: 'h', kind: 'handleHold', gear: 'mine', handle: 'draw', windows: [[0.5, 1]] }),
        adj({ id: 'p', kind: 'handPose', hand: 'Left', pose: 'clip', gear: 'mine', windows: [[0.1, 0.2]] }),
      ],
    }))
    expect(r.changes).toEqual([
      'clips replaced: Shoot',
      "clip Shoot: pace dropped (the clip it followed isn't in the set)",
      'clip Shoot: the track of Lute dropped (no such gear here)',
    ])
    expect(failure(() => applyCommand(c, { type: 'clips.replace', slots: [walk, { ...walk, id: 'w2' }] })).status).toBe(400)
  })
})

describe('slot time, keys, events and gear tracks (schema 3)', () => {
  const walk = makeSlot({ id: 'walk', name: 'Walk' })
  const atk = makeSlot({ id: 'atk', name: 'Attack', loop: false })
  const q = (z: number): [number, number, number, number] => [0, 0, z, Math.sqrt(1 - z * z)]
  const base = (): Character => makeCharacter({ gear: [makeGear({ id: 'bow', name: 'Bow' })], clips: [walk, atk] })

  it('sets the blow fit, pace, markers and holds, each part whole, null taking it out', () => {
    const r = applyCommand(base(), { type: 'slot.time', slot: 'atk', patch: { fit: { enabled: true, at: 0.45, late: 'hold' }, pace: { enabled: true, like: 'walk' } } })
    expect(r.character.clips[1].time).toEqual({ fit: { enabled: true, at: 0.45, late: 'hold' }, pace: { enabled: true, like: 'walk' } })
    expect(r.changes).toEqual(['clip Attack: blow at 45%, a late one held added', 'clip Attack: pace of Walk'])
    const m = applyCommand(r.character, { type: 'slot.time', slot: 'atk', patch: { markers: [{ id: 'm', u: 0.4, to: 0.3 }], holds: [{ id: 'h', u: 0.5, seconds: 0.2 }], pace: null } })
    expect(m.character.clips[1].time).toEqual({ fit: { enabled: true, at: 0.45, late: 'hold' }, markers: [{ id: 'm', u: 0.4, to: 0.3 }], holds: [{ id: 'h', u: 0.5, seconds: 0.2 }] })
    expect(m.changes).toEqual(['clip Attack: pace removed', 'clip Attack: retimed by 1 marker', 'clip Attack: held 0.2 s at 50%'])
    const off = applyCommand(m.character, { type: 'slot.time', slot: 'atk', patch: { fit: null, markers: null, holds: [] } })
    expect(off.character.clips[1].time).toBeUndefined()
  })

  it('keeps a slot\'s time valid', () => {
    const c = base()
    const time = (patch: Record<string, unknown>): Command => ({ type: 'slot.time', slot: 'atk', patch } as Command)
    expect(failure(() => applyCommand(c, time({ pace: { enabled: true, like: 'atk' } }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ pace: { enabled: true, like: 'gone' } }))).status).toBe(404)
    expect(failure(() => applyCommand(c, time({ fit: { enabled: true, at: 1.2 } }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ markers: [{ id: 'a', u: 0.3, to: 0.5 }, { id: 'b', u: 0.6, to: 0.4 }] }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ markers: [{ id: 'a', u: 1, to: 0.5 }] }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ holds: [{ id: 'a', u: 0.3, seconds: 0 }] }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ holds: [{ id: 'a', u: 0.3, seconds: 1 }, { id: 'b', u: 0.3, seconds: 1 }] }))).status).toBe(400)
    expect(failure(() => applyCommand(c, time({ speed: 2 }))).status).toBe(400)
  })

  it('replaces a track\'s keys, sorted, with their eases, a track with none going', () => {
    const r = applyCommand(base(), { type: 'slot.keys.set', slot: 'atk', tracks: [
      { bone: 'RightArm', keys: [{ u: 0.6, q: q(0.2), ease: 'step' }, { u: 0.2, q: q(0.1), ease: 'smooth' }] },
      { gear: 'bow', keys: [{ u: 1.4, q: q(0), p: [0, 0.1, 0] }] },
    ] })
    const slot = r.character.clips[1]
    expect(slot.bones).toEqual({ RightArm: [{ u: 0.2, q: q(0.1) }, { u: 0.6, q: q(0.2), ease: 'step' }] })
    expect(slot.gear).toEqual({ bow: { keys: [{ u: 1.4, q: q(0), p: [0, 0.1, 0] }] } })
    expect(r.changes).toEqual(['clip Attack: 2 keys on RightArm', 'clip Attack: 1 key on Bow'])
    const gone = applyCommand(r.character, { type: 'slot.keys.set', slot: 'atk', tracks: [{ bone: 'RightArm', keys: [] }, { gear: 'bow', keys: [] }] })
    expect(gone.character.clips[1]).toEqual(atk)
    expect(gone.changes).toEqual(['clip Attack: keys on RightArm removed', 'clip Attack: keys on Bow removed'])
  })

  it('refuses keys at the same moment, past MAX_U, on a bone or gear that isn\'t there', () => {
    const c = base()
    const set = (tracks: unknown[]): Command => ({ type: 'slot.keys.set', slot: 'atk', tracks } as Command)
    expect(failure(() => applyCommand(c, set([{ bone: 'Hips', keys: [{ u: 0.5, q: q(0) }, { u: 0.5 + 1e-8, q: q(0.1) }] }]))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([{ bone: 'Hips', keys: [{ u: 17, q: q(0) }] }]))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([{ bone: 'Hips', keys: [{ u: 0.5, q: q(0), ease: 'bouncy' }] }]))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([{ bone: 'Tail', keys: [] }]))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([{ gear: 'nope', keys: [] }]))).status).toBe(404)
    expect(failure(() => applyCommand(c, set([{ bone: 'Hips', keys: [] }, { bone: 'Hips', keys: [] }]))).status).toBe(400)
    expect(failure(() => applyCommand(c, set([{ bone: 'Hips', gear: 'bow', keys: [] }]))).status).toBe(400)
  })

  it('adds, changes and removes events: one hit, spans forward', () => {
    const add = applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'e1', name: 'hit', u: 0.5 } })
    expect(add.character.clips[1].events).toEqual([{ id: 'e1', name: 'hit', u: 0.5 }])
    expect(add.changes).toEqual(['clip Attack: hit at 50% added'])
    const two = applyCommand(add.character, { type: 'slot.event.add', slot: 'atk', event: { id: 'e2', name: 'swing', u: 0.2, to: 0.45, sound: 'mix:sword_swing', bone: 'RightHand' } })
    expect(two.character.clips[1].events!.map(e => e.id)).toEqual(['e2', 'e1'])
    expect(failure(() => applyCommand(two.character, { type: 'slot.event.add', slot: 'atk', event: { id: 'e3', name: 'hit', u: 0.7 } })).status).toBe(409)
    expect(failure(() => applyCommand(two.character, { type: 'slot.event.add', slot: 'atk', event: { id: 'e1', name: 'draw', u: 0.7 } })).status).toBe(409)
    expect(failure(() => applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'x', name: 'swing', u: 0.5, to: 0.4 } })).status).toBe(400)
    expect(failure(() => applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'x', name: '9lives', u: 0.5 } })).status).toBe(400)
    expect(failure(() => applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'x', name: 'step.L', u: 0.5, sound: 'boom.wav' } })).status).toBe(400)
    expect(failure(() => applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'x', name: 'hit', u: 0.2, to: 0.4 } })).status).toBe(400)
    const moved = applyCommand(two.character, { type: 'slot.event.update', slot: 'atk', id: 'e2', patch: { to: null, sound: null, u: 0.25 } })
    expect(moved.character.clips[1].events![0]).toEqual({ id: 'e2', name: 'swing', u: 0.25, bone: 'RightHand' })
    expect(moved.changes).toEqual(['clip Attack: swing at 20%-45% (mix:sword_swing) -> swing at 25%'])
    expect(failure(() => applyCommand(two.character, { type: 'slot.event.update', slot: 'atk', id: 'e2', patch: { name: 'hit', to: null } })).status).toBe(409)
    expect(failure(() => applyCommand(two.character, { type: 'slot.event.update', slot: 'atk', id: 'e2', patch: { name: 'hit' } })).status).toBe(400)
    const removed = applyCommand(add.character, { type: 'slot.event.remove', slot: 'atk', id: 'e1' })
    expect(removed.character.clips[1].events).toBeUndefined()
  })

  it("keeps an event's sound volume and pitch in range, and takes them off with null", () => {
    const loud = applyCommand(base(), { type: 'slot.event.add', slot: 'atk', event: { id: 'e1', name: 'release', u: 0.5, sound: 'mix:bowshot', volume: 0.5, pitch: 1.2 } })
    expect(loud.character.clips[1].events).toEqual([{ id: 'e1', name: 'release', u: 0.5, sound: 'mix:bowshot', volume: 0.5, pitch: 1.2 }])
    const plain = applyCommand(loud.character, { type: 'slot.event.update', slot: 'atk', id: 'e1', patch: { volume: null, pitch: 2 } })
    expect(plain.character.clips[1].events![0]).toEqual({ id: 'e1', name: 'release', u: 0.5, sound: 'mix:bowshot', pitch: 2 })
    for (const bad of [{ volume: 0 }, { volume: 5 }, { pitch: 0.1 }, { pitch: 8 }]) {
      expect(failure(() => applyCommand(loud.character, { type: 'slot.event.update', slot: 'atk', id: 'e1', patch: bad })).status).toBe(400)
    }
  })

  it('sets who holds a piece and when it shows, kept beside its keys', () => {
    const keyed = applyCommand(base(), { type: 'slot.keys.set', slot: 'atk', tracks: [{ gear: 'bow', keys: [{ u: 0.5, q: q(0) }] }] }).character
    const r = applyCommand(keyed, { type: 'slot.gear.update', slot: 'atk', gear: 'bow', patch: { heldBy: [{ u: 0.4, bone: 'RightHand' }, { u: 0.1, bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }], shown: [{ u: 0.9, shown: false }] } })
    expect(r.character.clips[1].gear!.bow).toEqual({
      keys: [{ u: 0.5, q: q(0) }],
      heldBy: [{ u: 0.1, bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, { u: 0.4, bone: 'RightHand' }],
      shown: [{ u: 0.9, shown: false }],
    })
    expect(r.changes).toEqual(['clip Attack: Bow held by LeftHand from 10% and RightHand from 40%', 'clip Attack: Bow hidden from 90%'])
    expect(failure(() => applyCommand(keyed, { type: 'slot.gear.update', slot: 'atk', gear: 'bow', patch: { heldBy: [{ u: 0.4, bone: 'Wing' }] } })).status).toBe(400)
    expect(failure(() => applyCommand(keyed, { type: 'slot.gear.update', slot: 'atk', gear: 'bow', patch: { shown: [{ u: 0.4, shown: true }, { u: 0.4, shown: false }] } })).status).toBe(400)
    const cleared = applyCommand(r.character, { type: 'slot.gear.update', slot: 'atk', gear: 'bow', patch: { heldBy: null, shown: null } })
    expect(cleared.character.clips[1].gear).toEqual({ bow: { keys: [{ u: 0.5, q: q(0) }] } })
  })

  it('switches tracks off and on', () => {
    const r = applyCommand(base(), { type: 'slot.update', id: 'atk', patch: { muted: ['bones', 'gear:bow', 'bones'] } })
    expect(r.character.clips[1].muted).toEqual(['bones', 'gear:bow'])
    expect(r.changes).toEqual(['clip Attack: bones and gear:bow switched off'])
    expect(applyCommand(r.character, { type: 'slot.update', id: 'atk', patch: { muted: null } }).character.clips[1].muted).toBeUndefined()
    expect(failure(() => applyCommand(base(), { type: 'slot.update', id: 'atk', patch: { muted: ['everything'] } })).status).toBe(400)
  })

  it('copies a slot\'s setup over another (Save as), which keeps its own id, name, loop and in place', () => {
    const made = makeSlot({
      id: 'edit', name: 'Attack edit', clip: { id: 'mixamo-Thrust' }, speed: 1.2, loop: true, inPlace: false,
      time: { fit: { enabled: true, at: 0.45 }, pace: { enabled: true, like: 'atk' } }, bones: { Hips: [key] }, events: [{ id: 'h', name: 'hit', u: 0.5 }],
      adjustments: [adj({ id: 'g', kind: 'ground', lift: 0.01 })],
    })
    const c = makeCharacter({ clips: [walk, atk, made] })
    const r = applyCommand(c, { type: 'slot.copy', from: 'edit', to: 'atk' })
    expect(r.character.clips[1]).toEqual({ ...made, id: 'atk', name: 'Attack', loop: false, inPlace: true, time: { fit: { enabled: true, at: 0.45 } } })
    expect(r.changes).toEqual(["clip Attack: now Attack edit's (mixamo-Thrust, speed 1.2), what it had gone", 'clip Attack: pace dropped (it would follow itself)'])
    const fresh = applyCommand(c, { type: 'slot.copy', from: 'edit', name: 'Lunge', newId: 'lunge' })
    expect(fresh.character.clips[3]).toEqual({ ...made, id: 'lunge', name: 'Lunge' })
    expect(failure(() => applyCommand(c, { type: 'slot.copy', from: 'edit', to: 'edit' })).status).toBe(400)
    expect(failure(() => applyCommand(c, { type: 'slot.copy', from: 'edit', name: 'Walk', newId: 'w2' })).status).toBe(409)
  })

  it('takes pace off the slots that followed a removed one, in their time', () => {
    const c = makeCharacter({ clips: [walk, makeSlot({ id: 'carry', name: 'Carry', time: { pace: { enabled: true, like: 'walk' }, fit: { enabled: false, at: 0.45 } } })] })
    expect(applyCommand(c, { type: 'slot.remove', id: 'walk' }).character.clips[0].time).toEqual({ fit: { enabled: false, at: 0.45 } })
  })
})

describe('look', () => {
  const layer = (id: string, image = 'Body'): TextureLayer => ({ id, kind: 'fill', image, file: `textures/layers/${id}.png`, enabled: true, at: 0 })

  it('switches, removes and orders layers', () => {
    const c = makeCharacter({ look: { layers: [layer('l1'), layer('l2', 'Cloak')] } })
    const off = applyCommand(c, { type: 'look.layer.update', id: 'l1', patch: { enabled: false } })
    expect(off.character.look.layers[0].enabled).toBe(false)
    expect(off.changes).toEqual(['layer fill on Body: off'])
    expect(applyCommand(c, { type: 'look.layer.remove', id: 'l2' }).character.look.layers.map(l => l.id)).toEqual(['l1'])
    expect(applyCommand(c, { type: 'look.layer.reorder', ids: ['l2', 'l1'] }).character.look.layers.map(l => l.id)).toEqual(['l2', 'l1'])
    expect(failure(() => applyCommand(c, { type: 'look.layer.remove', id: 'l9' })).status).toBe(404)
  })
})

describe('mount', () => {
  const mount = { character: 'horse-1', bone: 'spine_3', position: [0, 0.1, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], freeze: ['LeftUpLeg'], pose: {}, skin: 'Bay' }

  it('sets, changes and clears the mount', () => {
    const r = applyCommand(makeCharacter(), { type: 'mount.set', mount })
    expect(r.character.mount).toEqual(mount)
    expect(r.changes).toEqual(['mount: rides horse-1 on its spine_3'])
    const u = applyCommand(r.character, { type: 'mount.update', patch: { skin: null, scale: 1.1 } })
    const expected: Record<string, unknown> = { ...mount, scale: 1.1 }
    delete expected.skin
    expect(u.character.mount).toEqual(expected)
    expect('skin' in u.character.mount!).toBe(false)
    expect(u.changes).toEqual(['mount: scale 1.1', 'mount: skin unset'])
    expect(applyCommand(r.character, { type: 'mount.set', mount: null }).changes).toEqual(['mount: on foot'])
    expect(failure(() => applyCommand(makeCharacter(), { type: 'mount.set', mount: { ...mount, character: 'tester-000001' } })).status).toBe(400)
    expect(failure(() => applyCommand(makeCharacter(), { type: 'mount.update', patch: { bone: 'x' } })).status).toBe(404)
  })
})
