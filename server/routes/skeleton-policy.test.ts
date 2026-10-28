// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { applyCommand } from '../../src/model/commands.ts'
import { humanJoints, makeCharacter, makeRigged, makeSlot } from '../../src/model/fixtures.ts'
import { jointsOf, phaseOf } from '../../src/model/select.ts'
import { humanHierarchy, TEMPLATE_PARENTS } from '../../src/model/skeletons.ts'
import type { Joints, Vec3 } from '../../src/model/types.ts'
import { HttpError } from '../http.ts'
import { applyConvert, applyFingerTrace, applyRefit, applyTemplate, assertLevelUnlocked, humanSeed, traceInput } from './skeleton-policy.ts'

const FINGER = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)[1-4]$/
const moved = (p: Vec3, d = 0.01): Vec3 => [p[0] + d, p[1], p[2]]

/** What rig.py --placements-only gives back: the input as it was, and every finger of the level traced (here: the
 * fixture's fingers moved a little, so they differ from what was detected before). */
function trace (input: Joints, level: Parameters<typeof humanJoints>[0], shift: Vec3 = [0, 0, 0]): Joints {
  const fingers = Object.entries(humanJoints(level)).filter(([j]) => FINGER.test(j)).map(([j, p]): [string, Vec3] => [j, moved(p, 0.003)])
  const out: Joints = { ...input, ...Object.fromEntries(fingers) }
  return Object.fromEntries(Object.entries(out).map(([j, p]) => [j, [p[0] + shift[0], p[1] + shift[1], p[2] + shift[2]]]))
}

const status = (fn: () => unknown): number | undefined => {
  try { fn() } catch (error) { return error instanceof HttpError ? error.status : -1 }
  return undefined
}

describe('a finger trace', () => {
  it('starts from the skeleton as placed, without its fingers', () => {
    const c = makeCharacter({ skeleton: { overrides: { LeftHand: [0.7, 1.4, 0], LeftHandIndex2: [0.75, 1.4, 0] } } })
    const input = traceInput(c)
    expect(Object.keys(input).some(j => FINGER.test(j))).toBe(false)
    expect(input.LeftHand).toEqual([0.7, 1.4, 0])
    expect(Object.keys(input)).toHaveLength(humanHierarchy('none').length)
  })

  it('at a new level replaces the fingers and sets aside the placements that no longer mean the same', () => {
    const c = makeCharacter({
      skeleton: { overrides: { Hips: [0, 1.02, 0], LeftHandIndex2: [0.8, 1.4, 0], LeftHandPinky1: [0.7, 1.4, -0.05], LeftHandThumb2: [0.72, 1.44, 0.05] } },
    })
    const input = traceInput(c)
    const lines = applyFingerTrace(c, { level: 'two', redetect: false, from: 'full', input, result: trace(input, 'two') })
    const s = c.skeleton
    expect(s.fingerLevel).toBe('two')
    expect(Object.keys(jointsOf(c)).sort()).toEqual(humanHierarchy('two').map(([j]) => j).sort())
    expect(s.detected!.LeftHandIndex1).toEqual(moved(humanJoints('two').LeftHandIndex1, 0.003))
    expect(s.detected!.LeftHandMiddle1).toBeUndefined()
    // the body's placement and the thumb's stay; the index (a mitten's middle now) and the pinky (none at two) go aside
    expect(Object.keys(s.overrides).sort()).toEqual(['Hips', 'LeftHandThumb2'])
    expect(s.stale!.map(o => o.joint).sort()).toEqual(['LeftHandIndex2', 'LeftHandPinky1'])
    expect(s.stale!.every(o => o.template === 'human' && o.level === 'full')).toBe(true)
    expect(s.stale!.find(o => o.joint === 'LeftHandIndex2')!.at).toEqual([0.8, 1.4, 0])
    expect(lines[0]).toContain('finger level full -> two')
    expect(lines.some(l => l.includes('2 placements set aside'))).toBe(true)
  })

  it('detected again sets aside every finger placement, keeping the level and the body', () => {
    const c = makeCharacter({ skeleton: { overrides: { Head: [0, 1.62, 0.01], RightHandMiddle3: [-0.8, 1.45, 0] } } })
    const input = traceInput(c)
    applyFingerTrace(c, { level: 'full', redetect: true, from: 'full', input, result: trace(input, 'full') })
    expect(c.skeleton.fingerLevel).toBe('full')
    expect(c.skeleton.overrides).toEqual({ Head: [0, 1.62, 0.01] })
    expect(c.skeleton.stale!.map(o => o.joint)).toEqual(['RightHandMiddle3'])
    expect(c.skeleton.stale![0].reason).toContain('detected again')
  })

  it('can be restored at the level it was made at, through skeleton.stale', () => {
    const c = makeCharacter({ skeleton: { overrides: { LeftHandIndex2: [0.8, 1.4, 0] } } })
    const input = traceInput(c)
    applyFingerTrace(c, { level: 'full', redetect: true, from: 'full', input, result: trace(input, 'full') })
    const back = applyCommand(c, { type: 'skeleton.stale', action: 'restore' }).character
    expect(back.skeleton.overrides.LeftHandIndex2).toEqual([0.8, 1.4, 0])
    expect(back.skeleton.stale).toBeUndefined()
  })

  it('adds body joints it completed, and takes back a lift to the floor', () => {
    const c = makeCharacter()
    delete c.skeleton.detected!.HeadTop_End
    const input = traceInput(c)
    const result = trace(input, 'full', [0, 0.05, 0])
    result.HeadTop_End = [0, 1.85, 0]
    const lines = applyFingerTrace(c, { level: 'full', redetect: true, from: 'full', input, result })
    expect(c.skeleton.detected!.HeadTop_End![1]).toBeCloseTo(1.8, 9)
    expect(c.skeleton.detected!.LeftHandIndex1).toEqual(moved(humanJoints('full').LeftHandIndex1, 0.003).map(v => expect.closeTo(v, 9)))
    expect(lines.some(l => l.includes('HeadTop_End detected'))).toBe(true)
    expect(lines.some(l => l.includes('taken back'))).toBe(true)
  })

  it('takes the markers\' finger entries away, so their tips start again on the traced fingers', () => {
    const J = humanJoints('full')
    const c = makeCharacter({ skeleton: { markers: { set: 'human', base: { ...J, 'marker:groin': [0, 0.9, 0] }, positions: { chin: J.Head, wrist_l: J.LeftHand, index_tip_l: J.LeftHandIndex4, thumb_tip_r: J.RightHandThumb4 } } } })
    const input = traceInput(c)
    const lines = applyFingerTrace(c, { level: 'two', redetect: false, from: 'full', input, result: trace(input, 'two') })
    const m = c.skeleton.markers!
    expect(Object.keys(m.base).some(j => FINGER.test(j))).toBe(false)
    expect(m.base['marker:groin']).toEqual([0, 0.9, 0])
    expect(Object.keys(m.positions).sort()).toEqual(['chin', 'wrist_l'])
    expect(lines.some(l => l.startsWith('markers:'))).toBe(true)
  })

  it('is refused when the wrists moved or the level changed while it ran', () => {
    const c = makeCharacter()
    const input = traceInput(c)
    const result = trace(input, 'two')
    const moving = structuredClone(c)
    moving.skeleton.overrides.LeftHand = [0.66, 1.45, 0]
    expect(status(() => applyFingerTrace(moving, { level: 'two', redetect: false, from: 'full', input, result }))).toBe(409)
    const relevelled = structuredClone(c)
    relevelled.skeleton.fingerLevel = 'one'
    expect(status(() => applyFingerTrace(relevelled, { level: 'two', redetect: false, from: 'full', input, result }))).toBe(409)
  })
})

describe('a finger level and the weight lock', () => {
  const lock = { locked: true, lockReason: 'hand-fixed weights' }

  it('a new level on a rigged character with locked weights is refused, leaving it as it was', () => {
    const c = makeRigged({ skin: lock })
    const before = structuredClone(c)
    expect(status(() => { assertLevelUnlocked(c, 'two') })).toBe(409)
    const input = traceInput(c)
    expect(status(() => applyFingerTrace(c, { level: 'two', redetect: false, from: 'full', input, result: trace(input, 'two') }))).toBe(409)
    // (a level asked for with Detect again changes the bones just the same)
    expect(status(() => applyFingerTrace(c, { level: 'one', redetect: true, from: 'full', input, result: trace(input, 'one') }))).toBe(409)
    expect(c).toEqual(before)
    expect(phaseOf(c).phase).toBe('rigged')
  })

  it('the fingers detected again at the same level keep the bones, so the lock allows it', () => {
    const c = makeRigged({ skin: lock })
    expect(status(() => { assertLevelUnlocked(c, 'full') })).toBeUndefined()
    const input = traceInput(c)
    applyFingerTrace(c, { level: 'full', redetect: true, from: 'full', input, result: trace(input, 'full') })
    expect(c.skeleton.fingerLevel).toBe('full')
    expect(phaseOf(c).phase).toBe('rigged')
  })

  it('a new level goes through once unlocked, or with no rig to keep', () => {
    expect(status(() => { assertLevelUnlocked(makeRigged(), 'two') })).toBeUndefined()
    expect(status(() => { assertLevelUnlocked(makeCharacter({ skin: lock }), 'two') })).toBeUndefined()
    const c = makeRigged()
    const input = traceInput(c)
    applyFingerTrace(c, { level: 'two', redetect: false, from: 'full', input, result: trace(input, 'two') })
    expect(c.skeleton.fingerLevel).toBe('two')
    expect(phaseOf(c).phase).toBe('needs-rig')
  })
})

describe('a template switch', () => {
  const horse = Object.keys(TEMPLATE_PARENTS.horse)
  const fit = (): Joints => Object.fromEntries([...horse, 'stray'].map((j, i): [string, Vec3] => [j, [0, i * 0.02, 0]]))

  it('puts the fit in, and clears what was made for the old skeleton, clips too', () => {
    const c = makeCharacter({
      clips: [makeSlot()],
      skeleton: { overrides: { Hips: [0, 1.1, 0] }, stale: [{ joint: 'LeftHandIndex1', at: [0, 0, 0], reason: 'x', template: 'human', level: 'full' }], markers: { set: 'human', base: {}, positions: {} } },
    })
    const lines = applyTemplate(c, 'horse', fit())
    const s = c.skeleton
    expect(s.template).toBe('horse')
    expect(Object.keys(s.detected!).sort()).toEqual([...horse].sort())
    expect(s.overrides).toEqual({})
    expect(s.stale).toBeUndefined()
    expect(s.markers).toBeUndefined()
    expect(c.clips).toEqual([])
    expect(lines[0]).toContain('person -> horse')
    expect(lines.some(l => l.startsWith('cleared:') && l.includes('1 clip'))).toBe(true)
  })

  it('puts a rigged import on the Rigsmith rig, and leaves its files and status alone', () => {
    const c = makeCharacter({ status: 'rigged', files: { model: 'model.glb', rigged: 'rigged.glb' }, source: { kind: 'rigged' } })
    applyTemplate(c, 'horse', fit())
    expect(c.skeleton.converted).toBe(true)
    expect(c.status).toBe('rigged')
    expect(c.files.rigged).toBe('rigged.glb')
  })

  it('back to a person: the import\'s own detection, traced again only when it was at another level', () => {
    const imported = humanJoints('full')
    expect(humanSeed(makeCharacter({ skeleton: { imported } }), 'full')).toEqual({ joints: imported, trace: false })
    const two = humanSeed(makeCharacter({ skeleton: { imported } }), 'two')
    expect(two.trace).toBe(true)
    expect(Object.keys(two.joints).some(j => FINGER.test(j))).toBe(false)
    expect(Object.keys(two.joints)).toHaveLength(humanHierarchy('none').length)
    expect(humanSeed(makeCharacter({ skeleton: { imported: undefined } }), 'full')).toEqual({ joints: {}, trace: true })
  })

  it('with no joints found says so', () => {
    const c = makeCharacter({ skeleton: { template: 'horse' } })
    const lines = applyTemplate(c, 'human', undefined)
    expect(c.skeleton.detected).toBeUndefined()
    expect(lines[0]).toContain('place them by hand')
  })
})

describe('a refit and a conversion', () => {
  it('refit: the fit becomes detected, the placements stay and are reported', () => {
    const c = makeCharacter({ skeleton: { template: 'horse' } })
    const [first] = Object.keys(TEMPLATE_PARENTS.horse)
    c.skeleton.overrides[first] = [1, 1, 1]
    const fit = Object.fromEntries(Object.keys(TEMPLATE_PARENTS.horse).map((j): [string, Vec3] => [j, [0, 2, 0]]))
    const lines = applyRefit(c, fit, 'along the mesh')
    expect(c.skeleton.detected![first]).toEqual([0, 2, 0])
    expect(c.skeleton.overrides[first]).toEqual([1, 1, 1])
    expect(lines.some(l => l.includes('kept over the new fit'))).toBe(true)
  })

  it('convert: its own joints become detected, at its finger level; placements cleared', () => {
    const c = makeCharacter({ source: { kind: 'rigged' }, skeleton: { detected: undefined, overrides: { Hips: [0, 1, 0.1] } } })
    const own = { ...humanJoints('two'), mixamorig_Extra: [0, 0, 0] as Vec3 }
    const lines = applyConvert(c, own, 'two')
    expect(c.skeleton.converted).toBe(true)
    expect(c.skeleton.fingerLevel).toBe('two')
    expect(c.skeleton.detected).toEqual(humanJoints('two'))
    expect(c.skeleton.overrides).toEqual({})
    expect(lines[0]).toContain('converted')
  })

  it('convert is refused on a creature\'s skeleton', () => {
    const c = makeCharacter({ source: { kind: 'rigged' }, skeleton: { template: 'horse' } })
    expect(status(() => applyConvert(c, humanJoints('none'), 'none'))).toBe(409)
  })
})
