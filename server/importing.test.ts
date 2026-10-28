// @vitest-environment node
// What an import writes into the character (DESIGN.md §2.2) and the resize plan (server/importing.ts).
import { describe, expect, it } from 'vitest'
import { humanJoints, makeCharacter, makeRigged } from '../src/model/fixtures.ts'
import type { Vec3 } from '../src/model/types.ts'
import { applyInspect, fitLines, hasOwnRig, planFit, type InspectResult } from './importing.ts'

const stats = { vertices: 5000, triangles: 9000, height: 1.75, meshes: 2, bones: 0 }
const mesh = (over: Partial<InspectResult> = {}): InspectResult =>
  ({ kind: 'mesh', rigPreset: null, stats, joints: humanJoints(), model: 'model.glb', warnings: [], ...over })
const moved = (p: Vec3, dy: number): Vec3 => [p[0], p[1] + dy, p[2]]

describe('a first import', () => {
  it('writes what the file is, its joints and that it is ready to rig', () => {
    const c = makeCharacter({ status: 'importing', files: {}, skeleton: { detected: undefined }, source: { stats: undefined } })
    const lines = applyInspect(c, mesh({ warnings: ['Stood on the floor: moved +0.100 up.'] }), { again: false })
    expect(c.status).toBe('ready')
    expect(c.files.model).toBe('model.glb')
    expect(c.source.kind).toBe('mesh')
    expect(c.source.stats).toEqual(stats)
    expect(c.source.warnings).toEqual(['Stood on the floor: moved +0.100 up.'])
    expect(c.skeleton.detected).toEqual(humanJoints())
    expect(c.skeleton.imported).toEqual(humanJoints())
    expect(c.revision).toBe(1)
    expect(lines[0]).toBe('import done: an unrigged mesh, 9,000 triangles, 1.75 tall')
    expect(lines).toContain('Stood on the floor: moved +0.100 up.')
  })

  it('makes a rigged file its own rig, and an animation file nothing to show', () => {
    const rigged = makeCharacter({ status: 'importing', files: {} })
    applyInspect(rigged, mesh({ kind: 'rigged', rigPreset: 'mixamo', joints: null, stats: { ...stats, bones: 65 } }), { again: false })
    expect(rigged.status).toBe('rigged')
    expect(rigged.files.rigged).toBe('model.glb')
    expect(rigged.source.rigPreset).toBe('mixamo')
    const clip = makeCharacter({ status: 'importing', files: {} })
    const lines = applyInspect(clip, mesh({ kind: 'animation', joints: null, model: null }), { again: false })
    expect(clip.status).toBe('ready')
    expect(clip.files.model).toBeUndefined()
    expect(lines[0]).toBe('import done: an animation file, no model')
  })
})

describe('a re-import', () => {
  it('keeps placed joints over the new detection and drops those it now agrees with', () => {
    const c = makeCharacter()
    const found = humanJoints()
    found.LeftArm = moved(found.LeftArm, 0.01)
    c.skeleton.overrides = { Head: moved(humanJoints().Head, 0.05), LeftArm: found.LeftArm }
    const lines = applyInspect(c, mesh({ joints: found }), { again: true })
    expect(c.skeleton.detected).toEqual(found)
    expect(Object.keys(c.skeleton.overrides)).toEqual(['Head'])
    expect(lines).toContain('1 placed joint is kept over the new detection: Head')
    expect(lines[0]).toMatch(/^imported again: /)
  })

  it('keeps the joints it had when detection fails or the skeleton is a creature', () => {
    const c = makeCharacter()
    const before = structuredClone(c.skeleton.detected)
    applyInspect(c, mesh({ joints: null, warnings: ['Automatic joint detection failed: no arms'] }), { again: true })
    expect(c.skeleton.detected).toEqual(before)
    expect(c.source.warnings).toEqual(['Automatic joint detection failed: no arms', 'The joints it had are kept.'])

    const horse = makeCharacter({ skeleton: { template: 'horse' } })
    const fit = structuredClone(horse.skeleton.detected)
    applyInspect(horse, mesh(), { again: true })
    expect(horse.skeleton.detected).toEqual(fit)
    expect(horse.skeleton.imported).toBeUndefined()
    expect(horse.source.warnings[0]).toMatch(/horse skeleton/)
  })

  it('never touches a rig made here', () => {
    const c = makeRigged()
    c.status = 'error'
    c.error = 'Re-import failed: Blender crashed'
    applyInspect(c, mesh(), { again: true })
    expect(c.files.rigged).toBe('rigged.glb')
    expect(c.status).toBe('rigged')
    expect(c.error).toBeUndefined()
    expect(hasOwnRig(c)).toBe(true)
  })

  it('keeps a converted import converted', () => {
    const c = makeCharacter({ status: 'rigged', files: { model: 'model.glb', rigged: 'model.glb' }, source: { kind: 'rigged', rigPreset: 'tripo' }, skeleton: { converted: true } })
    expect(hasOwnRig(c)).toBe(false)
    applyInspect(c, mesh({ kind: 'rigged', rigPreset: 'tripo', joints: null }), { again: true })
    expect(c.skeleton.converted).toBe(true)
    expect(c.source.kind).toBe('rigged')
    expect(c.status).toBe('rigged')
    expect(c.files.rigged).toBe('model.glb')
  })
})

describe('a resize', () => {
  it('scales to the height asked and stands each file on the floor', () => {
    const plan = planFit([{ min: -0.1, max: 1.9 }, { min: -0.05, max: 1.95 }], 1)
    expect(plan?.s).toBeCloseTo(0.5)
    expect(plan?.height).toBeCloseTo(1)
    expect(plan?.moves[0][1]).toBeCloseTo(0.05)
    expect(plan?.moves[1][1]).toBeCloseTo(0.025)
    expect(fitLines(2, plan!)).toEqual(['resized from 2.00 to 1.00 tall (×0.500)', 'stood on the floor (moved 5.0 cm up)'])
  })

  it('does nothing for a model already that size on the floor, and refuses heights it cannot have', () => {
    expect(planFit([{ min: 0, max: 1.8 }])).toBeNull()
    expect(planFit([{ min: 0, max: 1.8 }], 1.8)).toBeNull()
    expect(planFit([{ min: 0.2, max: 2 }])?.moves[0][1]).toBeCloseTo(-0.2)
    expect(() => planFit([{ min: 0, max: 1.8 }], 0)).toThrow()
    expect(() => planFit([{ min: 0, max: 1.8 }], 500)).toThrow(/between/)
    expect(() => planFit([])).toThrow(/No model/)
    expect(() => planFit([{ min: 1, max: 1 }], 1)).toThrow(/no height/)
  })
})
