import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../model/commands.ts'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { addPiecesCommands, setsByCulture, wornBy } from './sets.ts'

function fixture () {
  return makeCharacter({ gear: [makeGear({ id: 'hat', tags: ['covers-hair'] }), makeGear({ id: 'cape' })], folk: {
    sets: [
      { id: 'a', name: 'Alpha', tags: ['culture:gael', 'role:soldier'], pieces: ['cape'], grants: ['heavy'] },
      { id: 'b', name: 'Beta', tags: [], pieces: ['hat'], grants: ['covers-hair'] },
      { id: 'c', name: 'C', tags: ['culture:norse', 'culture:gael'], pieces: [], grants: [] },
    ], pools: [], stances: [], kinds: [
      { id: 'listed', name: 'Listed', tags: [], sets: [{ set: 'a' }] },
      { id: 'query', name: 'Query', tags: [], sets: { query: ['role:soldier'] } },
      { id: 'other', name: 'Other', tags: [], sets: [{ set: 'b' }] },
    ],
  } })
}
describe('sets editor rules', () => {
  it('groups by culture tags, with untagged sets last and multi-culture sets in each group', () => {
    expect(setsByCulture(fixture()).map(g => [g.culture, g.sets.map(s => s.id)])).toEqual([
      ['gael', ['a', 'c']], ['norse', ['c']], [null, ['b']],
    ])
  })
  it('finds classes with listed and query membership', () => {
    const c = fixture()
    expect(wornBy(c, c.folk!.sets[0]).map(k => k.id)).toEqual(['listed', 'query'])
    expect(wornBy(c, c.folk!.sets[1]).map(k => k.id)).toEqual(['other'])
  })
  it('deduplicates additions, retains other sets, and regrants via the actual reducer', () => {
    const c = fixture()
    const commands = addPiecesCommands(c, 'a', ['cape', 'hat', 'hat', 'missing'])
    const after = applyCommands(c, commands).character
    expect(after.folk!.sets[0].pieces).toEqual(['cape', 'hat'])
    expect(after.folk!.sets[0].grants).toEqual(['covers-hair', 'heavy'])
    expect(after.folk!.sets[1].pieces).toEqual(['hat'])
    expect(addPiecesCommands(after, 'a', ['hat'])).toEqual([])
    expect(addPiecesCommands(c, 'missing', ['hat'])).toEqual([])
  })
})
