import { expect, it } from 'vitest'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { app } from '../../state/app.svelte.ts'
import { dress } from '../../state/dress.svelte.ts'
import { wardrobe } from './wardrobe.svelte.ts'

it('removes sleeves when the already selected bracers tile is picked again', () => {
  const c = makeCharacter({ id: 'bracer-preview', gear: [makeGear({ id: 'brace' })],
    folk: { sets: [{ id: 'guard', name: 'Guard', pieces: ['brace'], tags: [], grants: ['bracers'] }], pools: [], kinds: [], stances: [] },
    look: { cloth: [{ id: 'shirt', name: 'Shirt', file: 'shirt.png', slots: ['top', 'bottom'], shapes: ['long_sleeve'] }] },
  })
  app.upsert(c)
  dress.reset(c)
  dress.wearOutfit(c, 'Guard')
  dress.setLayer(c, 'top', 'shirt')
  expect(dress.worn(c).layers?.top).toBe('shirt')
  wardrobe.pin(c, { outfit: 'Guard' })
  expect(dress.worn(c).layers).toEqual({ top: null, bottom: null })
})
