// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { humanJoints, makeCharacter, makeGear, makeRigged, makeSlot } from './fixtures.ts'
import {
  carriedBy, freshSet, gearByName, gearKeysFromPaths, heightOf, jointsOf, phaseOf, safeName,
} from './select.ts'
import { humanHierarchy } from './skeletons.ts'
import type { Character, Gear, Job } from './types.ts'

const onHand = (over: Partial<Gear> = {}): Gear => makeGear({
  id: 'bow', name: 'Bow', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0.7, 1.45, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [{ id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left' }], ...over,
})

const job = (over: Partial<Job>): Job => ({ id: 'j1', kind: 'rig', label: 'Rig Tester', characterId: 'tester-000001', status: 'running', progress: 0.5, message: 'Weighting', createdAt: 0, ...over })

describe('jointsOf', () => {
  it('puts the placements over the detected joints, only those of the skeleton', () => {
    const c = makeCharacter({ skeleton: { fingerLevel: 'none', detected: { ...humanJoints('full'), Extra: [9, 9, 9] }, overrides: { LeftHand: [1, 2, 3] } } })
    const j = jointsOf(c)
    expect(Object.keys(j)).toEqual(humanHierarchy('none').map(([b]) => b))
    expect(j.LeftHand).toEqual([1, 2, 3])
    expect(j.RightHand).toEqual(humanJoints().RightHand)
    j.LeftHand[0] = 7
    expect(c.skeleton.overrides.LeftHand).toEqual([1, 2, 3])
  })

  it("drops a hand's mitten Index chain at the full level, hand by hand", () => {
    const detected = humanJoints('full')
    for (const f of ['Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 4; i++) delete detected[`RightHand${f}${i}`]
    const j = jointsOf(makeCharacter({ skeleton: { detected } }))
    expect(j.RightHandIndex1).toBeUndefined()
    expect(j.RightHandThumb1).toBeDefined()
    expect(j.LeftHandIndex1).toBeDefined()
    // (below full the Index chain is the mitten itself)
    expect(jointsOf(makeCharacter({ skeleton: { fingerLevel: 'two', detected } })).RightHandIndex1).toBeDefined()
  })
})

describe('phaseOf', () => {
  it('reads the lifecycle', () => {
    expect(phaseOf(makeCharacter({ status: 'importing' })).phase).toBe('importing')
    expect(phaseOf(makeCharacter({ status: 'error', error: 'No meshes in the file\nTraceback...' }))).toEqual({ phase: 'error', label: 'No meshes in the file', tone: 'error' })
    expect(phaseOf(makeCharacter({ source: { kind: 'animation' } })).phase).toBe('animation-only')
    expect(phaseOf(makeCharacter()).phase).toBe('needs-rig')
    expect(phaseOf(makeRigged())).toEqual({ phase: 'rigged', label: 'Rigged', tone: 'ok' })
    expect(phaseOf(makeCharacter({ status: 'rigging' })).phase).toBe('rigging')
  })

  it('asks to convert a rigged import until converted, then for a rig', () => {
    const imported = makeCharacter({ status: 'rigged', files: { model: 'model.glb', rigged: 'rigged.glb' }, source: { kind: 'rigged', rigPreset: 'mixamo' } })
    expect(phaseOf(imported).phase).toBe('needs-conversion')
    expect(phaseOf({ ...imported, skeleton: { ...imported.skeleton, converted: true } })).toEqual({ phase: 'needs-rig', label: 'Needs rig again', tone: 'warn' })
  })

  it('wants a new rig once the skeleton is another than the one rigged', () => {
    const c = makeRigged()
    expect(phaseOf({ ...c, skeleton: { ...c.skeleton, fingerLevel: 'two' } }).phase).toBe('needs-rig')
    expect(phaseOf({ ...c, skeleton: { ...c.skeleton, template: 'horse' } }).phase).toBe('needs-rig')
  })

  it("shows a job's progress while one is queued or running", () => {
    expect(phaseOf(makeCharacter(), job({}))).toEqual({ phase: 'rigging', label: 'Weighting', tone: 'busy' })
    expect(phaseOf(makeCharacter(), job({ status: 'queued' })).label).toBe('Queued')
    expect(phaseOf(makeRigged(), job({ kind: 'compose', message: '' }))).toEqual({ phase: 'rigged', label: 'Rig Tester', tone: 'busy' })
    expect(phaseOf(makeRigged(), job({ status: 'done' })).tone).toBe('ok')
  })
})

describe('gear lookups', () => {
  it('finds the gear a hand carries: ready, shown, on that hand, with a carry handle', () => {
    const bow = onHand()
    expect(carriedBy(makeCharacter({ gear: [bow] }), 'Left')?.id).toBe('bow')
    expect(carriedBy(makeCharacter({ gear: [bow] }), 'Right')).toBeUndefined()
    expect(carriedBy(makeCharacter({ gear: [onHand({ hidden: true })] }), 'Left')).toBeUndefined()
    expect(carriedBy(makeCharacter({ gear: [onHand({ status: 'importing' })] }), 'Left')).toBeUndefined()
    expect(carriedBy(makeCharacter({ gear: [onHand({ handles: [] })] }), 'Left')).toBeUndefined()
    expect(carriedBy(makeCharacter({ gear: [onHand({ id: 'a', hidden: true }), onHand({ id: 'b' })] }), 'Left')?.id).toBe('b')
  })

  it('finds gear by name, else by its bone-safe form', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'x', name: 'Gear_Axe' })] })
    expect(gearByName(c, 'Gear_Axe')?.id).toBe('x')
    expect(gearByName(c, 'Gear Axe')?.id).toBe('x')
    expect(gearByName(c, 'Axe')).toBeUndefined()
    expect(gearKeysFromPaths(c, { 'Gear Axe': [{ u: 0, q: [0, 0, 0, 1] }], Bow: [] })).toEqual({ x: [{ u: 0, q: [0, 0, 0, 1] }] })
  })

  it('makes names bone-safe as the scene does', () => {
    expect(safeName('Gear Axe (old)')).toBe('Gear_Axe_old_')
    expect(safeName('Weapons_RightHand')).toBe('Weapons_RightHand')
  })
})

describe('freshSet', () => {
  it('gives slots and what they hold by id new ids, a pace following the copy of its slot', () => {
    const slots = [
      makeSlot({ id: 'walk', name: 'Walk', adjustments: [{ id: 'a1', enabled: true, kind: 'ground', lift: 0.01 }] }),
      makeSlot({ id: 'carry', name: 'Carry', time: { pace: { enabled: true, like: 'walk' }, markers: [{ id: 'm', u: 0.5, to: 0.4 }] }, events: [{ id: 'e', name: 'hit', u: 0.5 }] }),
      makeSlot({ id: 'run', name: 'Run', time: { pace: { enabled: true, like: 'elsewhere' } } }),
    ]
    let n = 0
    const fresh = freshSet(slots, () => `n${++n}`)
    expect(fresh.map(s => s.id)).toEqual(['n1', 'n2', 'n3'])
    expect(fresh[0].adjustments[0].id).toBe('n4')
    expect([fresh[1].events![0].id, fresh[1].time!.markers![0].id]).toEqual(['n5', 'n6'])
    expect(fresh.map(s => s.time?.pace?.like)).toEqual([undefined, 'n1', 'elsewhere'])
    expect(slots[0].id).toBe('walk')
  })
})

describe('heightOf', () => {
  it('is the measured height', () => {
    expect(heightOf(makeCharacter())).toBe(1.8)
    const c: Character = makeCharacter()
    delete c.source.stats
    expect(heightOf(c)).toBe(1)
  })
})
