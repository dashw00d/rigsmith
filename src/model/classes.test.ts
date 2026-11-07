// @vitest-environment node
import { expect, it } from 'vitest'
import { makeCharacter } from './fixtures.ts'
import { cultures, kindsWearing } from './classes.ts'
it('finds listed and queried classes and tagged or named cultures', () => {
  const c = makeCharacter({ folk: { sets: [{ id: 'n', name: 'norse_a', tags: [], pieces: [], grants: [] }, { id: 'g', name: 'G', tags: ['culture:gael'], pieces: [], grants: [] }], pools: [], kinds: [{ id: 'l', name: 'L', tags: [], sets: [{ set: 'n' }] }, { id: 'q', name: 'Q', tags: [], sets: { query: ['culture:gael'] } }], stances: [] } })
  expect(kindsWearing(c, 'n').map(k => k.id)).toEqual(['l'])
  expect(kindsWearing(c, 'g').map(k => k.id)).toEqual(['q'])
  expect(cultures(c)).toEqual([{ value: 'gael', tagged: true }, { value: 'norse', tagged: false }])
})
