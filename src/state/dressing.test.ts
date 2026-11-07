// The dress on stage (src/state/dressing.ts): sets read in one place, the document's own look, a dress over it (a
// pick gone falling back), which pieces show, an outfit put on taking off what it leaves no room for, Randomize
// keeping what is locked and repeating its roll, "Make default"'s commands and the dress settling after them.
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../model/commands.ts'
import { makeCharacter, makeGear } from '../model/fixtures.ts'
import { folkFromLegacy } from '../model/folk.ts'
import { pick, worldOf } from '../engine/folkpick.ts'
import { dressedFromPick, fixedFor } from '../app/gear/wardrobe.ts'
import type { Character, Gear } from '../model/types.ts'
import { anchorOutfit, defaultCommands, differs, documentDress, randomize, resolve, settled, setsAfter, setsOf, shows, wearOutfit } from './dressing.ts'

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

  it('keeps valid per-slot layer and bare preview state, dropping stale layer ids', () => {
    const c = folk()
    c.look.cloth = [{ id: 'shorts', name: 'Shorts', file: 'shorts.png', slots: ['bottom'] }]
    expect(resolve(c, { layers: { bottom: 'shorts', top: 'removed', over: null }, bare: true })).toMatchObject({ layers: { bottom: 'shorts', over: null }, bare: true })
    expect(c.look.clothing).toBe('long_blue')
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
    expect(defaultCommands(c, d)).toEqual(defaultCommands(c, undefined))
  })

  it('can show a document-hidden piece for this preview without changing its default', () => {
    const c = folk()
    c.gear[1].hidden = true
    const d = { on: ['a2'] }
    expect(shows(c, c.gear[1], resolve(c, d), documentDress(c), d)).toBe(true)
    expect(c.gear[1].hidden).toBe(true)
    expect(wearOutfit(c, d, 'hat_fur').on).toBeUndefined()
  })

  it('obeys the saved set grants even when legacy gear tags disagree', () => {
    const c = folk()
    c.folk = folkFromLegacy(c)!.folk
    c.folk.sets.find(s => s.name === 'arm_leather')!.grants = ['covers-hair', 'covers-face']
    expect(wearOutfit(c, undefined, 'arm_leather')).toMatchObject({ hair: null, beard: null })
  })

  it('takes off what an outfit leaves no room for', () => {
    const c = folk()
    expect(wearOutfit(c, undefined, 'hat_fur')).toEqual({ outfit: 'hat_fur', hair: null })
    // (bracers: no long sleeves under them)
    expect(wearOutfit(c, undefined, 'arm_plate')).toEqual({ outfit: 'arm_plate', clothing: 'green' })
  })
})

describe('randomize', () => {
  it('retains every layer the folk picker chose in its occupied slots', () => {
    const c = folk()
    c.look.cloth = [
      { id: 'bottom', name: 'Bottom', file: 'bottom.png', slots: ['bottom'] },
      { id: 'top', name: 'Top', file: 'top.png', slots: ['top', 'over'] },
    ]
    c.folk = { sets: [], kinds: [], stances: [], pools: [
      { id: 'bottoms', name: 'Bottoms', kind: 'cloth', slot: 'bottom', items: [{ ref: 'bottom' }] },
      { id: 'tops', name: 'Tops', kind: 'cloth', slot: 'top', items: [{ ref: 'top' }] },
    ] }
    const world = worldOf(c)
    const picked = pick(world, 42)
    const expected = Object.fromEntries(picked.layers.flatMap(id => world.layers.find(l => l.id === id)!.slots.map(slot => [slot, id])))
    expect(randomize(c, undefined, 42, world).layers).toEqual(expected)
    expect(picked.layers.length).toBeGreaterThan(0)
  })
  it('uses the same pick engine and fixed fields as the Wardrobe', () => {
    const c = folk()
    const d = { skin: 'asha', locks: ['skin' as const] }
    const world = worldOf(c)
    const expected = dressedFromPick(c, pick(world, 42, { fixed: fixedFor(c, resolve(c, d), d.locks) }))
    expect(resolve(c, randomize(c, d, 42))).toEqual(expected)
  })

  it('picks as the game would, the same roll the same pick', () => {
    const c = folk()
    const locked = { locks: ['outfit' as const] }
    const a = randomize(c, locked, 42)
    expect(randomize(c, locked, 42)).toEqual(a)
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

it('keeps a previewed set through rename and undo, preserving eye overrides', () => {
  const c = folk()
  c.folk = folkFromLegacy(c)!.folk
  const set = c.folk.sets.find(s => s.name === 'hat_fur')!
  const preview = { ...wearOutfit(c, undefined, set.name), off: ['b1'] }
  const renamed = applyCommands(c, [{ type: 'folk.set.update', id: set.id, patch: { name: 'fur renamed' } }]).character
  expect(resolve(renamed, preview).outfit).toBe('fur renamed')
  expect(shows(renamed, renamed.gear.find(g => g.id === 'b1')!, resolve(renamed, preview), documentDress(renamed), preview)).toBe(false)
  expect(resolve(c, preview).outfit).toBe('hat_fur')
})


it('upgrades old stored names to set ids and writes a renamed set as the document default', () => {
  const c = folk()
  c.folk = folkFromLegacy(c)!.folk
  const set = c.folk.sets.find(s => s.name === 'hat_fur')!
  const d = anchorOutfit(c, { outfit: 'hat_fur' })!
  expect(d.outfitId).toBe(set.id)
  const renamed = applyCommands(c, [{ type: 'folk.set.update', id: set.id, patch: { name: 'fur renamed' } }]).character
  const commands = defaultCommands(renamed, d)
  expect(commands.every(cmd => cmd.type !== 'gear.outfit.show')).toBe(true)
  const saved = applyCommands(renamed, commands).character
  expect(documentDress(saved).outfit).toBe('fur renamed')
  expect(defaultCommands(saved, d)).toEqual([])
  expect(settled(saved, d)).toEqual({})
})

it('removes every slot of a long-sleeve layer when selecting bracers', () => {
  const c = folk()
  c.folk = folkFromLegacy(c)!.folk
  c.folk.sets.find(s => s.name === 'arm_plate')!.grants = ['bracers']
  c.look.cloth = [
    { id: 'sleeved', name: 'Sleeved', file: 'sleeved.png', slots: ['top', 'over'], shapes: ['long_sleeve'] },
    { id: 'trousers', name: 'Trousers', file: 'trousers.png', slots: ['bottom'] },
    { id: 'tagged', name: 'Tagged', file: 'tagged.png', slots: ['top'], tags: ['long-sleeves'] },
  ]
  const first = wearOutfit(c, { layers: { top: 'sleeved', over: 'sleeved', bottom: 'trousers' } }, 'arm_plate')
  expect(first.layers).toEqual({ top: null, over: null, bottom: 'trousers' })
  const second = wearOutfit(c, { layers: { top: 'tagged' } }, 'arm_plate')
  expect(second.layers).toEqual({ top: null })
  expect(wearOutfit(c, { layers: { top: 'tagged' } }, 'arm_leather').layers).toEqual({ top: 'tagged' })
})

it.fails('refuses adding a set with another set’s name', () => {
  const c = folk(); c.folk = folkFromLegacy(c)!.folk
  expect(() => applyCommands(c, [{ type: 'folk.set.add', set: { id: 'duplicate', name: 'hat_fur', pieces: [], tags: [], grants: [] } }])).toThrow()
})

it.fails('refuses renaming a set to another set’s name', () => {
  const c = folk(); c.folk = folkFromLegacy(c)!.folk
  const set = c.folk.sets.find(s => s.name === 'arm_plate')!
  expect(() => applyCommands(c, [{ type: 'folk.set.update', id: set.id, patch: { name: 'hat_fur' } }])).toThrow()
})

it.fails('refuses duplicating a set with another set’s explicit name', () => {
  const c = folk(); c.folk = folkFromLegacy(c)!.folk
  const set = c.folk.sets.find(s => s.name === 'arm_plate')!
  expect(() => applyCommands(c, [{ type: 'folk.set.duplicate', id: set.id, newId: 'copy1', name: 'hat_fur' }])).toThrow()
})
