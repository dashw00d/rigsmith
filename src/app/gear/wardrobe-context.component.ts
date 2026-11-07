import { expect, it } from 'vitest'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { app } from '../../state/app.svelte.ts'
import { dress } from '../../state/dress.svelte.ts'
import { wardrobe } from './wardrobe.svelte.ts'

it('uses each character’s context for rolls and typed units, independently of locks', () => {
  const c = makeCharacter({ id: 'context-preview', gear: [makeGear({ id: 'north' }), makeGear({ id: 'west', hidden: true })],
    folk: { sets: [
      { id: 'north-set', name: 'norse_a', pieces: ['north'], tags: ['culture:norse'], grants: [] },
      { id: 'west-set', name: 'gael_a', pieces: ['west'], tags: ['culture:gael'], grants: [] },
    ], pools: [], kinds: [
      { id: 'all', name: 'All', tags: [], sets: { query: [] } },
      { id: 'north-kind', name: 'North', tags: [], sets: [{ set: 'north-set' }] },
    ], stances: [] },
  })
  app.upsert(c); dress.reset(c)
  wardrobe.setCulture(c, 'gael')
  expect(wardrobe.ctx(c)).toEqual({ tags: ['culture:gael'] })
  for (let uid = 1; uid <= 30; uid++) { wardrobe.showUnit(c, uid); expect(dress.worn(c).outfit).toBe('gael_a') }
  dress.toggleLock(c, 'outfit')
  wardrobe.setCulture(c, null); wardrobe.setKind(c, 'north-kind')
  wardrobe.showUnit(c, 1)
  expect(dress.worn(c).outfit).toBe('norse_a')
  expect(dress.locked(c.id, 'outfit')).toBe(true)
  const other = makeCharacter({ id: 'other-context' })
  expect(wardrobe.ctx(other)).toEqual({ tags: [] })
})
