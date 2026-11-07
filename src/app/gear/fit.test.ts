import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../model/commands.ts'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { fitRestore, fitSnapshot } from './fit.ts'

const piece = () => makeGear({
  id: 'coat', attach: { kind: 'skin', policy: 'body', place: { position: [0, 1, 0], rotation: [0, 0, 0], scale: 1 } },
})

describe('cancel placing', () => {
  it('restores origin and placement in one command batch, including origin rebase', () => {
    const initial = piece()
    const c = makeCharacter({ gear: [initial] })
    const start = fitSnapshot(c.id, initial)
    const edited = applyCommands(c, [
      { type: 'gear.origin', id: initial.id, origin: [0.3, 0, 0] },
      { type: 'gear.place', id: initial.id, place: { ...initial.attach.place, position: [2, 1, 0] } },
    ]).character
    const commands = fitRestore(start, edited.gear[0])
    expect(commands.map(x => x.type)).toEqual(['gear.origin', 'gear.place'])
    const restored = applyCommands(edited, commands).character.gear[0]
    expect(restored.origin ?? null).toEqual(initial.origin ?? null)
    expect(restored.attach.place).toEqual(initial.attach.place)
    expect(fitRestore(start, restored)).toEqual([])
  })
})
