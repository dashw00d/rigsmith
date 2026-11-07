// The Wardrobe's rules (src/app/gear/wardrobe.ts): names filed by culture, category and body part; each slot's choices
// as the pick engine rules them; a unit's pick as a dress and back through the locks; the drawer's tiles and filters;
// the pieces list's groups, selection and moves.
import { describe, expect, it } from 'vitest'
import { applyCommands } from '../../model/commands.ts'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { folkFromLegacy } from '../../model/folk.ts'
import type { Character, Gear } from '../../model/types.ts'
import { pick, worldOf } from '../../engine/folkpick.ts'
import { randomize, resolve } from '../../state/dressing.ts'
import {
  categoryOf, chipsOf, choicesFor, cleanTag, cultureOf, dressedFromPick, fixedFor, matches, moveCommands, NO_FILTER, partOf, pieceGroups,
  pieceLabel, selectClick, skinLabel, stepChoice, tilesOf,
} from './wardrobe.ts'

const piece = (id: string, over: Partial<Gear>): Gear => makeGear({ id, name: id, status: 'ready', attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...over })

function folk (): Character {
  const c = makeCharacter({
    id: 'folk-test',
    gear: [
      piece('n1', { name: 'Outfit_norse_a_forearm_L', outfit: 'norse_a' }), piece('n2', { name: 'Outfit_norse_a_leg_L', outfit: 'norse_a' }),
      piece('f1', { name: 'Outfit_hat_fur_head', outfit: 'hat_fur', tags: ['covers-hair'] }),
      piece('h1', { name: 'Hair_norse_a', role: 'hair', tags: ['long'] }), piece('h2', { name: 'Hair_hair_bun', role: 'hair', tags: ['fem', 'long'] }),
      piece('d1', { name: 'Beard_norse_a', role: 'beard' }),
      makeGear({ id: 'axe', name: 'Axe' }),
    ],
    look: {
      layers: [],
      skins: [{ name: '01_bran', file: 'skins/bran.png', hair: '#4a3020' }, { name: '13_asha', file: 'skins/asha.png', tags: ['female', 'beardless'] }],
      clothes: [{ name: 'long_blue', file: 'clothes/long_blue.png', tags: ['long-sleeves'] }, { name: 'green', file: 'clothes/green.png' }],
    },
  })
  const m = folkFromLegacy(c)!
  c.folk = m.folk
  c.look.cloth = m.cloth
  return c
}

describe('names', () => {
  it('files sets and pieces by culture, category and body part', () => {
    expect(cultureOf('Outfit_norse_a_forearm_L')).toBe('norse')
    expect(cultureOf('hat_fur')).toBe(null)
    expect(cultureOf('hat_fur', ['culture:gael'])).toBe('gael')
    expect(categoryOf({ name: 'arm_brigandine' })).toBe('armour')
    expect(categoryOf({ name: 'hood_veil' })).toBe('hood')
    expect(categoryOf({ name: 'swiss_b' })).toBe('outfit')
    expect(categoryOf({ name: 'swiss_b', tags: ['category:hat'] })).toBe('hat')
    expect(partOf({ name: 'Outfit_norse_a_forearm_L' })).toBe('forearm')
    expect(partOf({ name: 'Outfit_arm_mail_torso' })).toBe('torso')
    expect(partOf({ name: 'Hair_x', role: 'hair' })).toBe('hair')
    expect(pieceLabel('Hair_hair_mohawk')).toBe('mohawk')
    expect(pieceLabel('Beard_norse_a')).toBe('norse a')
    expect(skinLabel('13_asha')).toBe('asha')
  })

  it('takes a piece tag only as a short lower-case word', () => {
    expect(cleanTag(' Long Hair ')).toBe('long-hair')
    expect(cleanTag('culture:norse')).toBe(null)
    expect(cleanTag('')).toBe(null)
  })
})

describe('choices', () => {
  it('rules out what the engine would not pick, saying why', () => {
    const c = folk()
    const w = worldOf(c)
    const under = (outfit: string | null, skin: string | null) => ({ outfit, skin, clothing: null, hair: null, beard: null })
    const hair = choicesFor(c, w, under('norse_a', '01_bran'), 'hair')
    expect(hair.map(x => [x.value, x.ok])).toEqual([['h1', true], ['h2', false]])
    expect(hair[1].why).toMatch(/female/)
    expect(choicesFor(c, w, under('hat_fur', '13_asha'), 'hair').every(x => !x.ok && /covers-hair/.test(x.why ?? ''))).toBe(true)
    expect(choicesFor(c, w, under('norse_a', '13_asha'), 'beard')[0].why).toMatch(/beardless/)
    const long = choicesFor(c, w, under('norse_a', '01_bran'), 'clothing').find(x => x.value === 'long_blue')!
    // (norse_a has forearm pieces: bracers)
    expect(long.ok).toBe(false)
    expect(long.why).toMatch(/bracers/)
    const sets = choicesFor(c, w, under(null, null), 'outfit')
    expect(sets.map(x => x.value).sort()).toEqual(['hat_fur', 'norse_a'])
    expect(sets.every(x => x.ok && x.share === 0.5)).toBe(true)
  })

  it('steps round the list, skipping the ruled out when asked', () => {
    const list = [{ value: 'a', label: 'a', ok: true, share: 0.5 }, { value: 'b', label: 'b', ok: false, share: 0 }, { value: 'c', label: 'c', ok: true, share: 0.5 }]
    expect(stepChoice(list, 'a', 1)).toBe('b')
    expect(stepChoice(list, 'a', 1, true)).toBe('c')
    expect(stepChoice(list, 'a', -1)).toBe('c')
    expect(stepChoice(list, null, 1)).toBe('a')
    expect(stepChoice(list, null, -1)).toBe('c')
  })
})

describe('a unit as the dress', () => {
  it('is what the engine picks, and the locks hold through a new unit', () => {
    const c = folk()
    const w = worldOf(c)
    for (const uid of [1, 7, 13, 99, 1234]) {
      const d = dressedFromPick(c, pick(w, uid))
      expect(['norse_a', 'hat_fur']).toContain(d.outfit)
      if (d.outfit === 'hat_fur') expect(d.hair).toBe(null)
      if (d.skin === '13_asha') { expect(d.beard).toBe(null); expect(d.hair).not.toBe('h2x') }
      if (d.outfit === 'norse_a') expect(d.clothing).not.toBe('long_blue')
    }
    const worn = { outfit: 'norse_a', skin: '13_asha', clothing: 'green', hair: 'h2', beard: null }
    const fixed = fixedFor(c, worn, ['outfit', 'skin', 'clothing', 'hair'])
    for (const uid of [2, 3, 4, 5]) {
      const d = dressedFromPick(c, pick(w, uid, { fixed }))
      expect(d).toMatchObject({ outfit: 'norse_a', skin: '13_asha', clothing: 'green', hair: 'h2', beard: null })
    }
    expect(fixedFor(c, { ...worn, clothing: null }, ['clothing'])).toEqual({ bottom: null, top: null, over: null })
  })

  it('reads back through the dress', () => {
    const c = folk()
    const d = dressedFromPick(c, pick(worldOf(c), 42))
    expect(resolve(c, d)).toEqual(d)
  })
})

describe('the drawer', () => {
  it('tiles each tab with its badges and filters them', () => {
    const c = folk()
    const sets = tilesOf(c, 'sets')
    const fur = sets.find(t => t.value === 'hat_fur')!
    expect(fur.badges).toContain('covers hair')
    expect(fur.category).toBe('hat')
    const norse = sets.find(t => t.value === 'norse_a')!
    expect(norse.culture).toBe('norse')
    expect(norse.badges).toEqual(['no long sleeves', '2 pieces'])
    expect(norse.parts.sort()).toEqual(['forearm', 'leg'])
    expect(sets.filter(t => matches(t, { ...NO_FILTER, cultures: ['norse'] })).map(t => t.value)).toEqual(['norse_a'])
    expect(sets.filter(t => matches(t, { ...NO_FILTER, search: 'fur' })).map(t => t.value)).toEqual(['hat_fur'])
    expect(sets.filter(t => matches(t, { ...NO_FILTER, parts: ['head', 'leg'] })).map(t => t.value).sort()).toEqual(['hat_fur', 'norse_a'])
    expect(chipsOf(sets).categories).toEqual([['hat', 1], ['outfit', 1]])
    expect(tilesOf(c, 'skins').find(t => t.value === '13_asha')!.badges).toEqual(['female', 'beardless'])
    expect(tilesOf(c, 'clothes').find(t => t.value === 'long_blue')!.badges[0]).toBe('long sleeves')
    expect(tilesOf(c, 'hair').map(t => t.label)).toEqual(['norse a', 'bun'])
    expect(tilesOf(c, 'pieces').map(t => t.value)).toEqual(['n1', 'n2', 'f1', 'axe'])
  })
})

describe('the pieces list', () => {
  it('groups by set, the rest last, and searches', () => {
    const c = folk()
    expect(pieceGroups(c).map(g => [g.set, g.pieces.map(p => p.id)])).toEqual([
      ['hat_fur', ['f1']], ['norse_a', ['n1', 'n2']], [null, ['h1', 'h2', 'd1', 'axe']],
    ])
    expect(pieceGroups(c, 'leg').map(g => [g.set, g.pieces.map(p => p.id)])).toEqual([['norse_a', ['n2']]])
    expect(pieceGroups(c, 'norse').map(g => [g.set, g.pieces.map(p => p.id)])).toEqual([['norse_a', ['n1', 'n2']], [null, ['h1', 'd1']]])
  })

  it('selects by click, ctrl and shift', () => {
    const order = ['a', 'b', 'c', 'd']
    let s = selectClick([], null, order, 'b', {})
    expect(s).toEqual({ selected: ['b'], anchor: 'b' })
    s = selectClick(s.selected, s.anchor, order, 'd', { shift: true })
    expect(s.selected).toEqual(['b', 'c', 'd'])
    s = selectClick(s.selected, s.anchor, order, 'c', { toggle: true })
    expect(s.selected).toEqual(['b', 'd'])
    s = selectClick(s.selected, s.anchor, order, 'a', { shift: true, toggle: true })
    expect(s.selected.sort()).toEqual(['a', 'b', 'c', 'd'])
  })

  it('moves pieces into a set in one batch the model takes', () => {
    const c = folk()
    const fur = c.folk!.sets.find(s => s.name === 'hat_fur')!
    const cmds = moveCommands(c, ['n2'], fur.id)
    expect(cmds).toHaveLength(2)
    const after = applyCommands(c, cmds).character
    expect(after.folk!.sets.find(s => s.name === 'hat_fur')!.pieces).toEqual(['f1', 'n2'])
    expect(after.folk!.sets.find(s => s.name === 'norse_a')!.pieces).toEqual(['n1'])
    expect(moveCommands(after, ['n2'], fur.id)).toEqual([])
  })
})


it('applies preview culture and class to random picks and set choices', () => {
  const c = folk()
  const norse = c.folk!.sets.find(s => s.name === 'norse_a')!
  const gael = c.folk!.sets.find(s => s.name === 'hat_fur')!
  norse.tags = ['culture:norse']; gael.tags = ['culture:gael']
  c.folk!.kinds.push({ id: 'guard', name: 'Guard', tags: [], sets: [{ set: norse.id }] })
  const w = worldOf(c)
  for (let uid = 1; uid <= 300; uid++) {
    expect(resolve(c, randomize(c, undefined, uid, w, { tags: ['culture:gael'] })).outfit).toBe('hat_fur')
    expect(resolve(c, randomize(c, undefined, uid, w, { kind: 'guard' })).outfit).toBe('norse_a')
  }
  const choices = choicesFor(c, w, resolve(c, undefined), 'outfit', { tags: ['culture:gael'] })
  expect(choices.find(x => x.value === 'norse_a')).toMatchObject({ ok: false, why: 'not culture:gael' })
  expect(choices.find(x => x.value === 'hat_fur')?.ok).toBe(true)
})
