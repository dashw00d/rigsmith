import { describe, expect, it } from 'vitest'
import { tabsFor } from './wardrobe.ts'

describe('wardrobe tabs', () => {
  it('offers all tabs for folk and only Pieces and Props for other characters', () => {
    expect(tabsFor(true).map(t => t.id)).toEqual(['sets', 'skins', 'clothes', 'hair', 'beards', 'pieces', 'props'])
    expect(tabsFor(false).map(t => t.id)).toEqual(['pieces', 'props'])
  })
})
