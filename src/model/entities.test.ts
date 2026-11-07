// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommands } from './commands.ts'
import { entitiesOf, hashOf, restoreEntities, stableJson, touchedBy, undoConflicts, undoRecord } from './entities.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import type { Character, Gear } from './types.ts'

/** A write and how to take it back, as the store keeps them. */
function write (c: Character, ...cmds: Command[]): { after: Character, undo: ReturnType<typeof undoRecord> } {
  const after = applyCommands(c, cmds).character
  return { after, undo: undoRecord(c, after) }
}

const axe = makeGear({ id: 'axe', name: 'Axe', model: 'garments/axe/model.glb' })
const cap = makeGear({ id: 'cap', name: 'Cap', model: 'garments/cap/model.glb' })
const base = (): Character => makeCharacter({
  gear: [axe, cap],
  clips: [makeSlot({ id: 'walk', name: 'Walk' }), makeSlot({ id: 'run', name: 'Run', gear: { axe: { keys: [{ u: 0, q: [0, 0, 0, 1] }] } } })],
  look: { layers: [{ id: 'l1', kind: 'fill', image: 'Body', file: 'textures/layers/l1.png', enabled: true, at: 0 }] },
})

describe('stableJson', () => {
  it('reads the same whatever the key order', () => {
    expect(stableJson({ b: 1, a: { d: [1, { y: 2, x: undefined }], c: null } })).toBe('{"a":{"c":null,"d":[1,{"y":2}]},"b":1}')
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }))
    expect(hashOf(undefined)).toBe(hashOf(null))
  })
})

describe('entities', () => {
  it('cuts a character into its entities, leaving out what jobs own', () => {
    const c = base()
    const keys = [...entitiesOf(c).keys()]
    expect(keys).toEqual(['name', 'skeleton', 'skinLock', 'hands', 'gearOrder', 'gear:axe', 'gearModel:axe', 'gearPaint:axe', 'gear:cap', 'gearModel:cap', 'gearPaint:cap', 'slotOrder', 'slot:walk', 'slot:run', 'layerOrder', 'layer:l1'])
    expect(entitiesOf(c).get('gear:axe')).not.toHaveProperty('model')
    expect(entitiesOf(c).get('gear:axe')).not.toHaveProperty('status')
    expect(entitiesOf(c).get('skinLock')).toEqual({ locked: false })
    expect(entitiesOf({ ...c, mount: { character: 'h', bone: 'b', position: [0, 0, 0], rotation: [0, 0, 0], freeze: [], pose: {} } }).has('mount')).toBe(true)
  })

  it("tracks painted counts while ignoring other job fields", () => {
    const c = base()
    const after = applyCommands(c, [{ type: 'gear.place', id: 'axe', place: { position: [1, 1, 1], rotation: [0, 0, 0], scale: 1 } }]).character
    expect(touchedBy(c, after)).toEqual(['gear:axe'])
    const job = structuredClone(c)
    job.gear[0].status = 'error'
    job.gear[0].painted = 3
    job.status = 'rigged'
    job.source.scale = 2
    expect(touchedBy(c, job)).toEqual(['gearPaint:axe'])
    expect(touchedBy(c, applyCommands(c, [{ type: 'slot.reorder', ids: ['run', 'walk'] }]).character)).toEqual(['slotOrder'])
  })
})

describe('undo', () => {
  it('brings a removed piece back as it was, files and all, where it was', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'gear.remove', id: 'axe' })
    expect(undo.entities.map(e => e.key)).toEqual(['gearOrder', 'slot:run', 'gear:axe'])
    expect(undo.entities.find(e => e.key === 'gear:axe')?.before).toEqual(axe)
    expect(undoConflicts(after, undo)).toEqual([])
    expect(restoreEntities(after, undo)).toEqual(c)
  })

  it('takes an added piece out again', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'gear.add', gear: makeGear({ id: 'pick', name: 'Pick' }) })
    expect(undo.entities.find(e => e.key === 'gear:pick')?.before).toBeNull()
    expect(restoreEntities(after, undo)).toEqual(c)
  })

  it('keeps what a job wrote to a piece since', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'gear.update', id: 'axe', patch: { name: 'Big axe' } })
    after.gear[0].status = 'error'
    after.gear[0].error = 'the import failed'
    expect(undoConflicts(after, undo)).toEqual([])
    const back = restoreEntities(after, undo)
    expect(back.gear[0]).toEqual({ ...axe, status: 'error', error: 'the import failed' } satisfies Gear)
  })

  it('tracks model changes separately and detects a later model replacement', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'gear.update', id: 'axe', patch: { model: 'garments/axe/new.glb' } })
    expect(undo.entities.map(e => e.key)).toEqual(['gearModel:axe'])
    const job = structuredClone(after)
    job.gear[0].status = 'error'
    expect(restoreEntities(job, undo).gear[0]).toMatchObject({ model: c.gear[0].model, status: 'error' })
    job.gear[0].model = 'garments/axe/later.glb'
    expect(undoConflicts(job, undo)).toEqual(['gearModel:axe'])
  })

  it('merges orders: the old order of what is there, newcomers after', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'slot.reorder', ids: ['run', 'walk'] })
    const later = applyCommands(after, [{ type: 'slot.add', slot: makeSlot({ id: 'jump', name: 'Jump' }), index: 0 }, { type: 'slot.remove', id: 'run' }]).character
    expect(undoConflicts(later, undo)).toEqual([])
    expect(restoreEntities(later, undo).clips.map(s => s.id)).toEqual(['walk', 'jump'])
  })

  it('names the entities a later write moved on', () => {
    const c = base()
    const { after, undo } = write(c, { type: 'gear.place', id: 'axe', place: { position: [1, 1, 1], rotation: [0, 0, 0], scale: 1 } }, { type: 'character.rename', name: 'Hero' })
    const later = applyCommands(after, [{ type: 'gear.place', id: 'axe', place: { position: [2, 2, 2], rotation: [0, 0, 0], scale: 1 } }]).character
    expect(undoConflicts(later, undo)).toEqual(['gear:axe'])
    expect(undoConflicts(applyCommands(after, [{ type: 'gear.remove', id: 'axe' }]).character, undo)).toEqual(['gear:axe'])
  })

  it('puts the lock and the mount back', () => {
    const c = makeCharacter({ skin: { locked: true, lockReason: 'hand-fixed weights' } })
    const { after, undo } = write(c, { type: 'skin.lock', locked: false },
      { type: 'mount.set', mount: { character: 'horse-1', bone: 'spine_3', position: [0, 0, 0], rotation: [0, 0, 0], freeze: [], pose: {} } })
    expect(undo.entities.map(e => e.key)).toEqual(['skinLock', 'mount'])
    expect(undo.entities[1].before).toBeNull()
    expect(restoreEntities(after, undo)).toEqual(c)
  })
})
