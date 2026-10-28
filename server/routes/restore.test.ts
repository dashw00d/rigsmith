// @vitest-environment node
// restoreCommands: a build record (schema 2 and schema 1) as one batch on a character: gear named by the record found
// and placed, references by gear name mapped onto this character's gear, what it lacks added, --replace semantics.
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../src/model/commands.ts'
import { makeGear, makeRigged, makeSlot } from '../../src/model/fixtures.ts'
import type { Character, Gear, Slot } from '../../src/model/types.ts'
import { restoreCommands, type RestoreRequest } from './restore.ts'

let n = 0
const ids = (): string => `n${(n++).toString().padStart(7, '0')}`
const file = (g: Gear, i: number): string => `garments/${g.id}/model.new${i}.glb`

function apply (c: Character, req: RestoreRequest): { after: Character, notes: string[] } {
  const plan = restoreCommands(c, req, ids, file)
  return { after: applyCommands(c, plan.commands).character, notes: plan.notes }
}

const bow = (): Gear => makeGear({
  id: 'bowid001', name: 'Weapons_LeftHand', from: 'emberhold:archer/Weapons_LeftHand',
  attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [
    { id: 'carry', name: 'Carried', kind: 'carry', hand: 'Left' },
    { id: 'string1', name: 'String', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0.1, 0] } },
  ],
})

/** A schema 2 record as unit_export writes it: gear named by name, handle ids its own. */
function v2Record (): Record<string, unknown> {
  const slots: Slot[] = [
    makeSlot({ id: 'src-idle', name: 'Idle', clip: { id: 'mixamo-Idle' } }),
    makeSlot({
      id: 'src-attack', name: 'Attack', clip: { id: 'mixamo-Shoot' }, loop: false,
      adjustments: [
        { id: 'a1', kind: 'handleHold', enabled: true, gear: 'Weapons_LeftHand', handle: 'h-old', windows: [[0.2, 0.6]] },
        { id: 'a2', kind: 'keys', enabled: true, gear: { Weapons_LeftHand: [{ u: 0.5, q: [0, 0, 0, 1] }] } },
        { id: 'a3', kind: 'blowTiming', enabled: true, at: 0.45 },
      ],
    }),
    makeSlot({ id: 'src-walk', name: 'Walk', clip: { id: 'mixamo-Walk' }, adjustments: [{ id: 'a4', kind: 'pace', enabled: true, like: 'src-idle' }] }),
  ]
  return {
    schema: 2, unit: 'archer', slots, hands: { Right: 'default' },
    gearIds: { 'src-bow': { name: 'Weapons_LeftHand', from: 'emberhold:archer/Weapons_LeftHand', handles: { carry: 'Carried', 'h-old': 'String' } } },
  }
}

describe('restoreCommands', () => {
  it('maps a schema 2 record onto this character by gear and handle name', () => {
    const c = makeRigged({ gear: [bow()] })
    const { after } = apply(c, { record: v2Record(), replace: true })
    expect(after.clips.map(s => s.name)).toEqual(['Idle', 'Attack', 'Walk'])
    const attack = after.clips.find(s => s.name === 'Attack')!
    expect(attack.id).not.toBe('src-attack')
    const hold = attack.adjustments.find(a => a.kind === 'handleHold')
    expect(hold).toMatchObject({ gear: 'bowid001', handle: 'string1', windows: [[0.2, 0.6]] })
    expect(attack.adjustments.find(a => a.kind === 'keys')).toMatchObject({ gear: { bowid001: [{ u: 0.5 }] } })
    const walk = after.clips.find(s => s.name === 'Walk')!
    expect(walk.adjustments[0]).toMatchObject({ kind: 'pace', like: after.clips.find(s => s.name === 'Idle')!.id })
    expect(after.hands.hold).toEqual({ Right: 'default' })
  })

  it('takes only the named clips, in their order', () => {
    const c = makeRigged({ gear: [bow()] })
    const { after, notes } = apply(c, { record: v2Record(), replace: true, clips: ['Walk', 'Idle', 'Run'] })
    expect(after.clips.map(s => s.name)).toEqual(['Walk', 'Idle'])
    expect(notes.join('\n')).toMatch(/no clip Run/)
  })

  it('without replace adds only the clips it lacks and keeps its own hands', () => {
    const own = makeSlot({ id: 'mine', name: 'Idle', clip: { id: 'mixamo-Breathing' } })
    const c = makeRigged({ gear: [bow()], clips: [own], hands: { poses: [], hold: { Left: 'clip' } } })
    const { after, notes } = apply(c, { record: v2Record() })
    expect(after.clips.map(s => s.name)).toEqual(['Idle', 'Attack', 'Walk'])
    expect(after.clips[0]).toEqual(own)
    // (Walk paced like the record's Idle: now this character's own Idle)
    expect(after.clips[2].adjustments[0]).toMatchObject({ kind: 'pace', like: 'mine' })
    expect(after.hands.hold).toEqual({ Left: 'clip' })
    expect(notes.join('\n')).toMatch(/kept as they are here: Idle/)
  })

  it('replace removes gear the build did not name; parts it names are placed, renamed and shown as built', () => {
    const extra = makeGear({ id: 'cat00001', name: 'Sword', catalog: 'sword.glb', from: 'catalog:sword.glb' })
    const uploaded = makeGear({ id: 'up000001', name: 'Weapons RightHand', from: 'emberhold:archer/Weapons_RightHand', hidden: true })
    const c = makeRigged({ gear: [bow(), extra, uploaded] })
    const place = { position: [0.1, 0.2, 0.3] as [number, number, number], rotation: [0, 90, 0] as [number, number, number], scale: 1.5 }
    const { after } = apply(c, {
      replace: true,
      gear: [
        { from: 'emberhold:archer/Weapons_LeftHand' },
        { from: 'emberhold:archer/Weapons_RightHand', name: 'Weapons_RightHand', bone: 'RightHand', place, hidden: false, model: 'Z2xURg==' },
      ],
    })
    expect(after.gear.map(g => g.id)).toEqual(['bowid001', 'up000001'])
    const g = after.gear[1]
    expect(g.name).toBe('Weapons_RightHand')
    expect(g.from).toBe('emberhold:archer/Weapons_RightHand')
    expect(g.hidden).toBeUndefined()
    expect(g.model).toBe('garments/up000001/model.new1.glb')
    expect(g.attach).toEqual({ kind: 'bone', bone: 'RightHand', place })
    // (on a hand now: it has its carry handle)
    expect(g.handles.some(h => h.kind === 'carry' && h.hand === 'Right')).toBe(true)
  })

  it('reads a schema 1 record: clips with their lift and keys, and scripts as adjustments and hands', () => {
    const c = makeRigged({ gear: [bow()] })
    const record = {
      clips: {
        Idle: { clip: 'mixamo-Idle', loop: true, inPlace: true, speed: 1, lift: 0.02 },
        Attack: { clip: 'mixamo-Shoot', loop: false, inPlace: true, speed: 1.2, keyData: { props: { Weapons_LeftHand: [{ u: 0.3, q: [0, 0, 0, 1] }] } } },
      },
      scripts: [
        { id: 's1', kind: 'grip', enabled: true, side: 'Right', clip: 'mixamo-Holding', did: 'held' },
        { id: 's2', kind: 'blow', enabled: true, clip: 'Attack', at: 0.45, did: { blow: 0.3 } },
      ],
    }
    const { after } = apply(c, { record, replace: true })
    expect(after.clips.map(s => [s.name, s.speed])).toEqual([['Idle', 1], ['Attack', 1.2]])
    expect(after.clips[0].adjustments).toMatchObject([{ kind: 'ground', lift: 0.02 }])
    expect(after.clips[1].adjustments.map(a => a.kind).sort()).toEqual(['blowTiming', 'keys'])
    expect(after.clips[1].adjustments.find(a => a.kind === 'keys')).toMatchObject({ gear: { bowid001: [{ u: 0.3 }] } })
    expect(after.hands.hold).toEqual({ Right: { fist: 'mixamo-Holding' } })
  })

  it('a hand pose the character lacks becomes the default fist, noted only for what is restored', () => {
    const c = makeRigged({ gear: [bow()], clips: [makeSlot({ id: 'mine', name: 'Idle', clip: { id: 'mixamo-Breathing' } })] })
    const record = v2Record()
    const slots = record.slots as Slot[]
    slots[0].adjustments.push({ id: 'p0', kind: 'handPose', enabled: true, hand: 'Left', pose: { pose: 'gone0001' } })
    slots[1].adjustments.push({ id: 'p1', kind: 'handPose', enabled: true, hand: 'Left', pose: { pose: 'gone0002' } })
    record.hands = { Right: { pose: 'gone0003' } }
    const { after, notes } = apply(c, { record })
    expect(after.clips.find(s => s.name === 'Attack')!.adjustments.find(a => a.kind === 'handPose')).toMatchObject({ pose: 'default' })
    expect(after.hands.hold).toEqual({ Right: 'default' })
    const said = notes.join('\n')
    expect(said).toMatch(/Attack: its hand pose gone0002/)
    expect(said).toMatch(/right hand held in every clip: its hand pose gone0003/)
    // (Idle is this character's own and stays: nothing said about the record's)
    expect(said).not.toMatch(/gone0001/)
  })

  it('a dry run notes parts not brought in yet; a real one refuses them', () => {
    const c = makeRigged()
    const req: RestoreRequest = { gear: [{ from: 'emberhold:archer/GearAxe', name: 'GearAxe' }], dryRun: true }
    expect(restoreCommands(c, req, ids, file).notes.join('\n')).toMatch(/GearAxe: not here yet/)
    expect(() => restoreCommands(c, { ...req, dryRun: false }, ids, file)).toThrow(/bring it in first/)
  })
})
