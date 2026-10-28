// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { humanJoints, makeCharacter, makeRigged } from '../../src/model/fixtures.ts'
import { jointsOf, phaseOf } from '../../src/model/select.ts'
import { hierarchyOf } from '../../src/model/skeletons.ts'
import type { Joints, RigReport, Vec3 } from '../../src/model/types.ts'
import { HttpError } from '../http.ts'
import { applyRig, assertUnlocked, jointsBack, rigRefusal } from './skin-policy.ts'

const report = (): RigReport => ({ method: 'regions', seconds: 12.3, warnings: [], decisions: [{ stage: 'Weights', choice: 'Regional heat', why: 'x' }] })
const names = (c: Parameters<typeof hierarchyOf>[0]): string[] => hierarchyOf(c).map(([j]) => j)
const shifted = (p: Vec3, d: number): Vec3 => [p[0] + d, p[1], p[2]]

describe('the weight lock', () => {
  it('refuses with the reason while locked, 409', () => {
    expect(() => { assertUnlocked(makeRigged()) }).not.toThrow()
    const c = makeRigged({ skin: { locked: true, lockReason: 'hand-fixed weights' } })
    let error: unknown
    try { assertUnlocked(c) } catch (e) { error = e }
    expect(error).toBeInstanceOf(HttpError)
    expect((error as HttpError).status).toBe(409)
    expect((error as Error).message).toMatch(/locked \(hand-fixed weights\)/)
  })
})

describe('what can be rigged', () => {
  it('refuses an animation, a model rigged elsewhere until converted, and a busy one', () => {
    expect(rigRefusal(makeCharacter())).toBeNull()
    expect(rigRefusal(makeCharacter({ source: { kind: 'animation' } }))?.status).toBe(400)
    expect(rigRefusal(makeCharacter({ source: { kind: 'rigged' } }))?.status).toBe(409)
    expect(rigRefusal(makeCharacter({ source: { kind: 'rigged' }, skeleton: { converted: true } }))).toBeNull()
    expect(rigRefusal(makeCharacter({ status: 'importing' }))?.status).toBe(409)
    expect(rigRefusal(makeCharacter({ status: 'rigging' }))?.status).toBe(409)
  })

  it('needs a known creature template with joints', () => {
    expect(rigRefusal(makeCharacter({ skeleton: { template: 'horse' } }))).toBeNull()
    expect(rigRefusal(makeCharacter({ skeleton: { template: 'horse', detected: {} } }))?.message).toMatch(/Place its joints/)
    expect(rigRefusal(makeCharacter({ skeleton: { template: 'gryphon', detected: { a: [0, 0, 0] } } }))?.status).toBe(400)
  })
})

describe('the joints Blender gives back', () => {
  it('tells joints it completed from placed joints it moved, and warns of a move', () => {
    const input: Joints = { Hips: [0, 1, 0], Spine: [0, 1.1, 0] }
    const out = jointsBack(['Hips', 'Spine', 'Neck'], input, { Hips: [0, 1, 0], Spine: [0, 1.12, 0], Neck: [0, 1.5, 0] })
    expect(out.added).toEqual(['Neck'])
    expect(out.moved).toEqual(['Spine'])
    expect(out.warning).toMatch(/^Blender moved 1 of the placed joints \(Spine; up to 2\.0 cm\)/)
    expect(jointsBack(['Hips'], input, { Hips: [0, 1 + 5e-5, 0] })).toEqual({ added: [], moved: [], warning: null })
  })
})

describe('a rig published into the document', () => {
  it('is rigged on exactly its hierarchy, its report and bones kept, overrides untouched', () => {
    const c = makeCharacter({ error: 'the rig was interrupted', skeleton: { overrides: { LeftHand: [0.7, 1.45, 0] } } })
    const input = jointsOf(c)
    const result = { ...input, Extra: [0, 0, 0] as Vec3 }
    const lines = applyRig(c, { input, result, report: report(), painted: 0 })
    expect(c.status).toBe('rigged')
    expect(c.error).toBeUndefined()
    expect(c.files.rigged).toBe('rigged.glb')
    expect(c.revision).toBe(1)
    expect(Object.keys(c.skin.rigJoints!).sort()).toEqual(names(c).sort())
    expect(c.skin.bones).toBe(names(c).length)
    expect(c.skin.report?.method).toBe('regions')
    expect(c.skeleton.overrides).toEqual({ LeftHand: [0.7, 1.45, 0] })
    expect(c.skin.painted).toBeUndefined()
    expect(phaseOf(c).phase).toBe('rigged')
    expect(lines).toEqual(['rigged (regions, 12.3 s)'])
  })

  it('adds the joints Blender completed to detected, never to the overrides', () => {
    // (a mitten's index at the full level: jointsOf leaves the Index chain out of the input, Blender traces it)
    const c = makeCharacter()
    const detected = humanJoints('full')
    for (const s of ['Left', 'Right']) for (const f of ['Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 4; i++) delete detected[`${s}Hand${f}${i}`]
    c.skeleton.detected = detected
    const input = jointsOf(c)
    expect(input.LeftHandIndex1).toBeUndefined()
    const traced = humanJoints('full')
    const result: Joints = { ...input }
    for (const j of names(c)) if (input[j] === undefined) result[j] = shifted(traced[j], 0.001)
    const lines = applyRig(c, { input, result, report: report(), painted: 0 })
    expect(c.skeleton.detected!.LeftHandIndex1).toEqual(shifted(traced.LeftHandIndex1, 0.001))
    expect(c.skeleton.overrides).toEqual({})
    expect(lines[1]).toMatch(/found by the rig, added to the detected joints$/)
    expect(phaseOf(c).phase).toBe('rigged')
    expect(c.skin.report!.warnings).toEqual([])
  })

  it('keeps the painted count current and says when placements changed meanwhile', () => {
    const c = makeRigged({ skin: { painted: 40 } })
    const input = jointsOf(c)
    c.skeleton.overrides.LeftHand = [0.8, 1.45, 0]
    const r = report()
    applyRig(c, { input, result: input, report: r, painted: 38 })
    expect(c.skin.painted).toBe(38)
    expect(c.skin.report!.warnings).toEqual(['Placements changed during rigging; rig again to use the latest joints'])
    expect(r.warnings).toEqual([])
    applyRig(c, { input, result: input, report: report(), painted: 0 })
    expect(c.skin.painted).toBeUndefined()
  })
})
