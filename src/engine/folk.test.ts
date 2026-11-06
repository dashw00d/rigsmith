import { describe, expect, it } from 'vitest'
import type { Gear, Skin } from '../model/types.ts'
import { clothesFor, coversFace, coversHair, femaleOffset, fits, hairTint, outfitsOf, pickFolk, seeded, shownOutfit } from './folk.ts'

const piece = (id: string, extra: Partial<Gear>): Gear => ({
  id, name: id, status: 'ready', handles: [], attach: { kind: 'skin', policy: 'head', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...extra,
})

const gear: Gear[] = [
  piece('braids', { role: 'hair', swapSet: 'hair', tags: ['fem', 'long'] }),
  piece('crop', { role: 'hair', swapSet: 'hair', tags: ['short'] }),
  piece('tonsure', { role: 'hair', swapSet: 'hair', tags: ['masc'] }),
  piece('full', { role: 'beard', swapSet: 'beard' }),
  piece('helm', { outfit: 'mail', tags: ['covers-hair'], hidden: true }),
  piece('boots', { outfit: 'mail', hidden: true }),
  piece('clogs', { outfit: 'straw' }),
]
const asha: Skin = { name: 'asha', file: 'skins/asha.png', hair: '#1c1410', tags: ['female', 'beardless'] }
const bran: Skin = { name: 'bran', file: 'skins/bran.png', hair: '#5a3a22' }

describe('folk', () => {
  it('lists outfits and the one shown', () => {
    expect(outfitsOf(gear)).toEqual(['mail', 'straw'])
    expect(shownOutfit(gear)).toBe('straw')
  })

  it('matches hair and beards to a skin', () => {
    expect(fits(gear[0], asha)).toBe(true)
    expect(fits(gear[0], bran)).toBe(false)
    expect(fits(gear[2], asha)).toBe(false)
    expect(fits(gear[3], asha)).toBe(false)
    expect(fits(gear[3], bran)).toBe(true)
  })

  it('leaves the hair off under an outfit that covers it', () => {
    expect(coversHair(gear, 'mail')).toBe(true)
    expect(coversHair(gear, 'straw')).toBe(false)
    for (let s = 0; s < 20; s++) expect(pickFolk(gear, [asha, bran], 'mail', seeded(s)).hair).toBeNull()
  })

  it('picks only what fits, the same for the same seed', () => {
    for (let s = 0; s < 50; s++) {
      const p = pickFolk(gear, [asha, bran], 'straw', seeded(s))
      const skin = p.skin === 'asha' ? asha : bran
      if (p.hair !== null) expect(fits(gear.find(g => g.id === p.hair)!, skin)).toBe(true)
      if (skin === asha) expect(p.beard).toBeNull()
      expect(pickFolk(gear, [asha, bran], 'straw', seeded(s))).toEqual(p)
    }
  })

  it('tints a grey texture back to the colour', () => {
    const [r] = hairTint('#9e9e9e')
    expect(r * 0.62).toBeCloseTo(0x9e / 255, 5)
  })
  it('keeps beards off under a great helm and long sleeves out of bracers', () => {
    const more: Gear[] = [...gear, piece('greathelm', { outfit: 'plate', tags: ['covers-hair', 'covers-face'] }), piece('Outfit_plate_forearm_L', { outfit: 'plate' })]
    expect(coversFace(more, 'plate')).toBe(true)
    for (let s = 0; s < 20; s++) expect(pickFolk(more, [bran], 'plate', seeded(s)).beard).toBeNull()
    const clothes: Skin[] = [{ name: 'short', file: 'c/short.png' }, { name: 'long', file: 'c/long.png', tags: ['long-sleeves'] }]
    expect(clothesFor(more, 'plate', clothes).map(k => k.name)).toEqual(['short'])
    expect(clothesFor(more, 'straw', clothes).map(k => k.name)).toEqual(['short', 'long'])
  })
  it('is the same female shape as folk_female.py in the game (its FIELD_CHECK)', () => {
    const points = [[0.055, 0.655, 0.09], [0.11, 0.565, 0.0], [0.12, 0.48, -0.05], [0.3, 0.45, 0.02], [0.04, 0.845, 0.05]]
    const want = [[-1e-05, -0.006, 0.03199], [-0.012451, 0.0, 0.0], [0.015556, 0.0, -0.005989], [-0.018, -0.0, 0.0], [-0.006846, -0.0, -0.000318]]
    points.forEach((p, i) => femaleOffset(p[0], p[1], p[2]).forEach((d, k) => expect(d).toBeCloseTo(want[i][k], 5)))
  })
})
