import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear } from './fixtures.ts'
import { clothOf, folkFromLegacy, folkGearIds, grantsOf, isFolkCharacter, kindSets, piecesOf, poolsOf, regrant, setIdOf, setsOf, setsWith } from './folk.ts'
import type { Character, OutfitSet } from './types.ts'

const legacy = (): Character => makeCharacter({
  id: 'f',
  gear: [
    makeGear({ id: 'helm', name: 'Outfit_mail_helm', outfit: 'mail', tags: ['covers-hair'] }),
    makeGear({ id: 'hat', name: 'Outfit_straw_hat', outfit: 'straw' }),
    makeGear({ id: 'crop', name: 'Hair_crop', role: 'hair' }),
    makeGear({ id: 'axe', name: 'Axe' }),
  ],
  look: { layers: [], clothes: [{ name: 'plain', file: 'clothes/plain.png' }] },
})

describe('model/folk', () => {
  it('derives grants from the pieces: tags, and bracers from a forearm piece', () => {
    expect(grantsOf([{ name: 'Outfit_x_forearm_L' }, { name: 'helm', tags: ['covers-face', 'covers-hair', 'long'] }, { name: 'plate', tags: ['heavy'] }]))
      .toEqual(['bracers', 'covers-face', 'covers-hair', 'heavy'])
    expect(grantsOf([])).toEqual([])
  })

  it('regrants: what the pieces stop granting goes, what they newly grant comes, a hand-given grant stays', () => {
    const helm = { name: 'helm', tags: ['covers-hair'] }; const bracer = { name: 'forearm' }
    expect(regrant(['covers-hair', 'heavy'], [helm], [bracer])).toEqual(['bracers', 'heavy'])
    expect(regrant([], [helm], [helm, bracer])).toEqual(['bracers'])
  })

  it('reads a character never migrated through its old fields', () => {
    const c = legacy()
    expect(isFolkCharacter(c)).toBe(true)
    expect(isFolkCharacter(makeCharacter())).toBe(false)
    expect(setsOf(c).map(s => [s.name, s.pieces])).toEqual([['mail', ['helm']], ['straw', ['hat']]])
    expect(setsWith(c, 'helm').map(s => s.id)).toEqual([setIdOf('f', 'mail')])
    expect(setsWith(c, 'axe')).toEqual([])
    expect(poolsOf(c, 'hair').map(p => p.items)).toEqual([[{ ref: 'crop' }]])
    expect(clothOf(c).map(l => [l.name, l.slots])).toEqual([['plain', ['top', 'bottom']]])
    expect([...folkGearIds(c)].sort()).toEqual(['crop', 'hat', 'helm'])
    // (migrated: the same answers from the section)
    const m = folkFromLegacy(c)!
    const v5 = { ...c, folk: m.folk, look: { ...c.look, cloth: m.cloth } }
    expect(setsOf(v5)).toEqual(setsOf(c))
    expect(clothOf(v5)).toEqual(clothOf(c))
    expect(piecesOf(c, { pieces: ['hat', 'gone', 'helm'] }).map(g => g.id)).toEqual(['hat', 'helm'])
  })

  it('lists a kind\'s sets by list or tag query', () => {
    const sets: OutfitSet[] = [
      { id: 'a', name: 'A', pieces: [], tags: ['role:soldier'], grants: [], weight: 2 },
      { id: 'b', name: 'B', pieces: [], tags: ['role:villager'], grants: [] },
    ]
    expect(kindSets(sets, { sets: { query: ['role:soldier'] } }).map(x => [x.set.id, x.weight])).toEqual([['a', 2]])
    expect(kindSets(sets, { sets: { query: [] } }).map(x => x.set.id)).toEqual(['a', 'b'])
    expect(kindSets(sets, { sets: [{ set: 'b', weight: 3 }, { set: 'gone' }, { set: 'a' }] }).map(x => [x.set.id, x.weight])).toEqual([['b', 3], ['a', 2]])
    expect(kindSets(sets, undefined).map(x => x.set.id)).toEqual(['a', 'b'])
  })
})
