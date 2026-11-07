// @vitest-environment node
import { expect, it } from 'vitest'
import { makeCharacter } from '../model/fixtures.ts'
import { groupCharacters, searchCharacters, sortCharacters } from './list.ts'
it('searches, sorts and groups characters', () => {
  const a = makeCharacter({ id: 'folk', name: 'Folk', updatedAt: 1, folk: { sets: [{ id: 's', name: 'S', pieces: [], tags: [], grants: [] }], pools: [], kinds: [], stances: [] } })
  const b = makeCharacter({ id: 'human', name: 'Human', updatedAt: 2, status: 'rigged' })
  const horse = makeCharacter({ id: 'horse', name: 'Horse', status: 'rigged', skeleton: { ...b.skeleton, template: 'horse' } })
  const c = makeCharacter({ id: 'unrigged', name: 'Other', status: 'ready' })
  expect(searchCharacters([a, b], 'FOLK')).toEqual([a])
  expect(sortCharacters([a, b], 'updated')).toEqual([b, a])
  expect(groupCharacters([a, b, horse, c], 'body').map(g => g.name)).toEqual(['Dynamic', 'Humanoid', 'horse', 'Not rigged'])
})
