import { expect, it } from 'vitest'
import type { Character } from '../src/model/types.ts'
import { clipUseCounts } from './clipedits.ts'
it('counts slots across characters in one pass', () => {
  const characters = [{ clips: [{ clip: { id: 'walk' } }, { clip: { id: 'walk' } }] }, { clips: [{ clip: { id: 'walk' } }, { clip: { id: 'idle' } }] }] as Character[]
  expect({ ...clipUseCounts(characters) }).toEqual({ walk: 3, idle: 1 })
})
