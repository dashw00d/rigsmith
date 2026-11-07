// The dress on stage (src/state/dressing.ts): sets read in one place, the document's own look, a dress over it (a
// pick gone falling back), which pieces show, an outfit put on taking off what it leaves no room for, Randomize
// keeping what is locked and repeating its roll, "Make default"'s commands and the dress settling after them.
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../model/commands.ts'
import { makeCharacter, makeGear } from '../model/fixtures.ts'
import type { Character, Gear } from '../model/types.ts'
import { defaultCommands, differs, documentDress, randomize, resolve, settled, setsAfter, setsOf, shows, wearOutfit } from './dressing.ts'

const skinPiece = (id: string, over: Partial<Gear>): Gear => makeGear({ id, name: id, attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...over })

function folk (): Character {
  return makeCharacter({
    gear: [
      skinPiece('a1', { outfit: 'arm_leather' }), skinPiece('a2', { outfit: 'arm_leather' }),
      skinPiece('b1', { outfit: 'hat_fur', hidden: true, tags: ['covers-hair'] }),
      skinPiece('c1', { outfit: 'arm_plate', hidden: true, name: 'plate_forearm' }),
      skinPiece('h1', { role: 'hair' }), skinPiece('h2', { role: 'hair', hidden: true, tags: ['fem'] }),
      skinPiece('d1', { role: 'beard', hidden: true }),
      makeGear({ id: 'axe', name: 'Axe' }),
    ],
    look: {
      layers: [],
      skins: [{ name: 'bran', file: 'skins/bran.png' }, { name: 'asha', file: 'skins/asha.png', tags: ['female', 'beardless'] }],
      skin: 'bran',
      clothes: [{ name: 'long_blue', file: 'clothes/long_blue.png', tags: ['long-sleeves'] }, { name: 'green', file: 'clothes/green.png' }],
      clothing: 'long_blue',
    },
  })
}

describe('sets', () => {
  it('groups the pieces by outfit, sorted', () => {
    expect(setsOf(folk())).toEqual([
      { name: 'arm_leather', pieces: ['a1', 'a2'] }, { name: 'arm_plate', pieces: ['c1'] }, { name: 'hat_fur', pieces: ['b1'] },
    ])
  })

  it('names the next sets round the list', () => {
    const sets = setsOf(folk())
    expect(setsAfter(sets, 'arm_plate', 2).map(s => s.name)).toEqual(['hat_fur', 'arm_leather'])
    expect(setsAfter(sets, null, 1).map(s => s.name)).toEqual(['arm_leather'])
    expect(setsAfter(sets, 'hat_fur', 5).map(s => s.name)).toEqual(['arm_leather', 'arm_plate'])
  })
})

describe('the dress', () => {
  it('is the document\'s own look when there is none', () => {
    const c = folk()
    expect(documentDress(c)).toEqual({ outfit: 'arm_leather', skin: 'bran', clothing: 'long_blue', hair: 'h1', beard: null })
    expect(resolve(c, undefined)).toEqual(documentDress(c))
    expect(differs(c, undefined)).toBe(false)
  })

  it('lays its picks over the document, a pick gone falling back to it', () => {
    const c = folk()
    expect(resolve(c, { skin: 'asha', hair: null, outfit: 'gone' })).toEqual({ outfit: 'arm_leather', skin: 'asha', clothing: 'long_blue', hair: null, beard: null })
    expect(resolve(c, { hair: 'axe' }).hair).toBe('h1')
  })

  it('shows a set\'s pieces with their set, the hair and beard picked, the rest as the document has them', () => {
    const c = folk()
    const d = resolve(c, { outfit: 'hat_fur', hair: 'h2' })
    const own = documentDress(c)
    const on = c.gear.filter(g => shows(c, g, d, own)).map(g => g.id)
    expect(on).toEqual(['b1', 'h2', 'axe'])
  })

  it('keeps a piece of the document\'s own set hidden as the document has it', () => {
    const c = folk()
    c.gear[1].hidden = true
    const own = documentDress(c)
    expect(c.gear.filter(g => shows(c, g, own, own)).map(g => g.id)).toEqual(['a1', 'h1', 'axe'])
  })

  it('hides a piece only in the preview, and clears overrides on an outfit change', () => {
    const c = folk()
    const d = { off: ['a1'] }
    expect(shows(c, c.gear[0], resolve(c, d), documentDress(c), d)).toBe(false)
    expect(c.gear[0].hidden).not.toBe(true)
    expect(wearOutfit(c, d, 'hat_fur').off).toBeUndefined()
  })

  it('takes off what an outfit leaves no room for', () => {
    const c = folk()
    expect(wearOutfit(c, undefined, 'hat_fur')).toEqual({ outfit: 'hat_fur', hair: null })
    // (bracers: no long sleeves under them)
    expect(wearOutfit(c, undefined, 'arm_plate')).toEqual({ outfit: 'arm_plate', clothing: 'green' })
  })
})

describe('randomize', () => {
  it('picks as the game would, the same roll the same pick', () => {
    const c = folk()
    const a = randomize(c, undefined, 42)
    expect(randomize(c, undefined, 42)).toEqual(a)
    expect(a.seed).toBe(42)
    expect(a.outfit).toBe('arm_leather')
  })

  it('keeps the locked fields', () => {
    const c = folk()
    for (let seed = 1; seed < 40; seed++) {
      const d = randomize(c, { skin: 'asha', hair: 'h2', locks: ['skin', 'hair'] }, seed)
      expect(d.skin).toBe('asha')
      expect(d.hair).toBe('h2')
      // (asha is beardless)
      expect(d.beard).toBeNull()
    }
  })
})

describe('make default', () => {
  it('writes the dress into the document, then follows it again', () => {
    const c = folk()
    const d = { outfit: 'hat_fur', skin: 'asha', clothing: 'green', hair: null, beard: null, locks: ['skin' as const] }
    const commands = defaultCommands(c, d)
    expect(commands).toEqual([
      { type: 'gear.outfit.show', outfit: 'hat_fur' },
      { type: 'look.skin.show', name: 'asha' },
      { type: 'look.clothing.show', name: 'green' },
      { type: 'gear.update', id: 'h1', patch: { hidden: true } },
    ])
    const after = applyCommands(c, commands).character
    expect(documentDress(after)).toEqual(resolve(c, d))
    expect(defaultCommands(after, d)).toEqual([])
    expect(settled(after, d)).toEqual({ locks: ['skin'] })
  })

  it('has nothing to do for the document\'s own look', () => {
    expect(defaultCommands(folk(), undefined)).toEqual([])
  })
})
