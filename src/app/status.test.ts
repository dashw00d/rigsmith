// The frame's words about a character (src/app/status.ts): the file shown, the top bar's ticks, the import's kind.
import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeRigged, makeSlot } from '../model/fixtures.ts'
import type { Job, TextureLayer } from '../model/types.ts'
import { autoRiggable, hasOwnRig, kindLabel, presetLabel, type ShipFacts, shipMark, shownFile, stepMark } from './status.ts'

const job = (kind: string): Job => ({ id: 'j', kind, label: kind, status: 'running', progress: 0.5, message: 'Working', createdAt: 0 })

describe('the file a character is shown with', () => {
  it('is the rig while the rig fits its skeleton', () => {
    expect(shownFile(makeRigged())).toBe('rigged.glb')
  })

  it('is the model once the skeleton has changed under the rig (a finger level, a template switch)', () => {
    const c = makeRigged()
    c.skeleton.fingerLevel = 'two'
    expect(shownFile(c)).toBe('model.glb')
  })

  it('keeps the old rig on show while a new one is made, if it still fits', () => {
    expect(shownFile({ ...makeRigged(), status: 'rigging' })).toBe('rigged.glb')
    const moved = { ...makeRigged(), status: 'rigging' as const }
    moved.skeleton = { ...moved.skeleton, template: 'horse' }
    expect(shownFile(moved)).toBe('model.glb')
  })

  it('is the model for an unrigged mesh and nothing for an animation file', () => {
    expect(shownFile(makeCharacter())).toBe('model.glb')
    expect(shownFile(makeCharacter({ files: {}, source: { kind: 'animation' } }))).toBeUndefined()
  })

  it('is the model after a failed rig', () => {
    expect(shownFile({ ...makeRigged(), status: 'error', error: 'Blender crashed' })).toBe('model.glb')
  })
})

describe('the top bar ticks', () => {
  it('says nothing without a character', () => {
    expect(stepMark(null, 'import')).toBeNull()
  })

  it('marks Import done once imported, and needing work when the import failed', () => {
    expect(stepMark(makeCharacter(), 'import')).toBe('done')
    expect(stepMark(makeCharacter({ status: 'error', error: 'bad file', source: { stats: undefined } }), 'import')).toBe('needs')
    expect(stepMark(makeCharacter({ status: 'importing', source: { stats: undefined } }), 'import')).toBeNull()
    expect(stepMark(makeCharacter(), 'import', job('reimport'))).toBeNull()
  })

  it('marks Skeleton and Skin done when rigged, Skeleton needing work when a rig is due', () => {
    expect(stepMark(makeRigged(), 'skeleton')).toBe('done')
    expect(stepMark(makeRigged(), 'skin')).toBe('done')
    expect(stepMark(makeCharacter(), 'skeleton')).toBe('needs')
    expect(stepMark(makeCharacter(), 'skin')).toBeNull()
    expect(stepMark(makeCharacter({ source: { kind: 'rigged' } }), 'skeleton')).toBe('needs')
    expect(stepMark(makeCharacter({ source: { kind: 'animation' } }), 'skeleton')).toBeNull()
    expect(stepMark(makeCharacter(), 'skeleton', job('rig'))).toBeNull()
  })

  it('marks Gear by its pieces', () => {
    expect(stepMark(makeCharacter(), 'gear')).toBeNull()
    expect(stepMark(makeCharacter({ gear: [makeGear()] }), 'gear')).toBe('done')
    expect(stepMark(makeCharacter({ gear: [makeGear(), makeGear({ id: 'g2', name: 'Bow', status: 'error', error: 'no mesh' })] }), 'gear')).toBe('needs')
  })

  it('marks Look needing a fill while the scan found holes no fill covers', () => {
    const holes = { scan: { images: [{ image: 'Body', coverage: 0.2 }], at: 1 }, layers: [] }
    expect(stepMark(makeCharacter({ look: holes }), 'look')).toBe('needs')
    const filled = { ...holes, layers: [{ id: 'l1', kind: 'fill' as const, image: 'Body', file: 'textures/layers/l1.png', enabled: true, at: 2 }] }
    expect(stepMark(makeCharacter({ look: filled }), 'look')).toBe('done')
    expect(stepMark(makeCharacter(), 'look')).toBeNull()
  })

  const layer = (over: Partial<TextureLayer>): TextureLayer => ({ id: 'l1', kind: 'fill', image: 'Body', file: 'textures/layers/l1.png', enabled: true, at: 2, ...over })

  it('takes an enabled earlier texture as covering the holes the scan found', () => {
    const scan = { images: [{ image: 'Body', coverage: 0.2 }], at: 1 }
    expect(stepMark(makeCharacter({ look: { scan, layers: [layer({ kind: 'snapshot' })] } }), 'look')).toBe('done')
    expect(stepMark(makeCharacter({ look: { scan, layers: [layer({ kind: 'snapshot', enabled: false })] } }), 'look')).toBe('needs')
  })

  it("matches a layer to the scanned image when their names differ only by '-' and '_'", () => {
    const scan = { images: [{ image: 'Body-Main', coverage: 0.2 }], at: 1 }
    expect(stepMark(makeCharacter({ look: { scan, layers: [layer({ image: 'Body_Main' })] } }), 'look')).toBe('done')
    const underscored = { images: [{ image: 'Body_Main', coverage: 0.2 }], at: 1 }
    expect(stepMark(makeCharacter({ look: { scan: underscored, layers: [layer({ image: 'Body-Main' })] } }), 'look')).toBe('done')
    expect(stepMark(makeCharacter({ look: { scan, layers: [layer({ image: 'Head_Main' })] } }), 'look')).toBe('needs')
  })

  it('marks Motion done once it has clips', () => {
    expect(stepMark(makeCharacter(), 'motion')).toBeNull()
    expect(stepMark(makeCharacter({ clips: [makeSlot()] }), 'motion')).toBe('done')
  })

  it('says nothing about Ship without its facts', () => {
    expect(stepMark(makeRigged({ clips: [makeSlot()] }), 'ship')).toBeNull()
    expect(stepMark(makeRigged({ clips: [makeSlot()] }), 'ship', null, null)).toBeNull()
  })

  it('marks Ship from its units, their checks and their last exports', () => {
    const exported = { status: 'done' as const, holdsFailed: [] }
    const facts = (units: ShipFacts['units'], failing = false): ShipFacts => ({ units, failing })
    expect(stepMark(makeRigged(), 'ship', null, facts([{ differs: false, last: exported }]))).toBe('done')
    expect(stepMark(makeRigged(), 'ship', null, facts([{ differs: false, last: exported }], true))).toBe('needs')
    expect(stepMark(makeRigged(), 'ship', null, facts([]))).toBeNull()
  })
})

describe('the Ship tick', () => {
  const done = { status: 'done' as const, holdsFailed: [] }

  it('says nothing for a character that is no unit', () => {
    expect(shipMark({ units: [], failing: false })).toBeNull()
    // (no unit: its checks can't fail, but say nothing either way)
    expect(shipMark({ units: [], failing: true })).toBeNull()
  })

  it('needs work while a check fails', () => {
    expect(shipMark({ units: [{ differs: true, last: null }], failing: true })).toBe('needs')
    expect(shipMark({ units: [{ differs: false, last: done }], failing: true })).toBe('needs')
  })

  it('needs work when a last export failed or its holds check did', () => {
    expect(shipMark({ units: [{ differs: true, last: { status: 'failed', holdsFailed: [] } }], failing: false })).toBe('needs')
    expect(shipMark({ units: [{ differs: false, last: { status: 'done', holdsFailed: ['HOLDS knight Attack Weapons_RightHand FAIL sinks'] } }], failing: false })).toBe('needs')
    expect(shipMark({ units: [{ differs: false, last: done }, { differs: true, last: { status: 'failed', holdsFailed: [] } }], failing: false })).toBe('needs')
  })

  it('is done once every unit went through and the game has its entry as Rigsmith does', () => {
    expect(shipMark({ units: [{ differs: false, last: done }], failing: false })).toBe('done')
    expect(shipMark({ units: [{ differs: false, last: done }, { differs: false, last: done }], failing: false })).toBe('done')
  })

  it('says nothing while a unit was never exported, its export was cancelled, or a change is not exported yet', () => {
    expect(shipMark({ units: [{ differs: true, last: null }], failing: false })).toBeNull()
    expect(shipMark({ units: [{ differs: false, last: done }, { differs: true, last: null }], failing: false })).toBeNull()
    expect(shipMark({ units: [{ differs: true, last: { status: 'cancelled', holdsFailed: [] } }], failing: false })).toBeNull()
    expect(shipMark({ units: [{ differs: true, last: done }], failing: false })).toBeNull()
  })
})

describe('what the import was', () => {
  it('names the kind', () => {
    expect(kindLabel(makeCharacter())).toBe('Unrigged mesh')
    expect(kindLabel(makeRigged())).toBe('Auto-rigged')
    expect(kindLabel(makeCharacter({ source: { kind: 'rigged' } }))).toBe('Rigged elsewhere')
    expect(kindLabel(makeCharacter({ source: { kind: 'rigged' }, skeleton: { converted: true } }))).toBe('Rigged elsewhere, converted')
    expect(kindLabel(makeCharacter({ source: { kind: 'animation' } }))).toBe('Animation only')
  })

  it('tells a rig made here from the imported file\'s own', () => {
    expect(hasOwnRig(makeRigged())).toBe(true)
    expect(hasOwnRig(makeCharacter())).toBe(false)
    expect(hasOwnRig(makeCharacter({ files: { model: 'model.glb', rigged: 'model.glb' } }))).toBe(false)
  })

  it('names the skeleton family', () => {
    expect(presetLabel('mixamo')).toBe('Mixamo')
    expect(presetLabel('something')).toBe('something')
    expect(presetLabel(undefined)).toBeNull()
  })
})

describe('Auto-rig all', () => {
  it('takes unrigged meshes with nothing working on them', () => {
    expect(autoRiggable(makeCharacter())).toBe(true)
    expect(autoRiggable(makeCharacter(), job('inspect'))).toBe(false)
    expect(autoRiggable(makeRigged())).toBe(false)
    expect(autoRiggable(makeCharacter({ status: 'importing' }))).toBe(false)
    expect(autoRiggable(makeCharacter({ source: { kind: 'rigged' } }))).toBe(false)
    expect(autoRiggable(makeCharacter({ skin: { locked: true } }))).toBe(false)
  })
})
