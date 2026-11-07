import { describe, expect, it } from 'vitest'
import { makeCharacter } from '../model/fixtures.ts'
import { fnv1a } from '../model/ids.ts'
import { folkFromLegacy, setIdOf } from '../model/folk.ts'
import type { Character, ClothLayer, FolkSection, Gear, Skin } from '../model/types.ts'
import { clothesFor, coversFace, coversHair, fits } from './folk.ts'
import { candidates, draw, fmix32, goldens, pick, PROGRAM, tagsAfter, weighted, worldOf, type FolkWorld } from './folkpick.ts'

const piece = (id: string, extra: Partial<Gear>): Gear => ({
  id, name: id, status: 'ready', handles: [], attach: { kind: 'skin', policy: 'head', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...extra,
})

const gear: Gear[] = [
  piece('braids', { role: 'hair', tags: ['fem', 'long'] }),
  piece('crop', { role: 'hair', tags: ['short'] }),
  piece('tonsure', { role: 'hair', tags: ['masc'] }),
  piece('full', { role: 'beard' }),
  piece('goatee', { role: 'beard', tags: ['masc'] }),
  piece('helm', { outfit: 'mail', tags: ['covers-hair'] }),
  piece('boots', { outfit: 'mail' }),
  piece('clogs', { outfit: 'straw' }),
  piece('greathelm', { outfit: 'plate', tags: ['covers-hair', 'covers-face'] }),
  piece('Outfit_plate_forearm_L', { outfit: 'plate' }),
  piece('wip', { role: 'hair', status: 'importing' }),
]
const skins: Skin[] = [
  { name: 'asha', file: 'skins/asha.png', hair: '#1c1410', tags: ['female', 'beardless'] },
  { name: 'bran', file: 'skins/bran.png', hair: '#5a3a22' },
  { name: 'cora', file: 'skins/cora.png', tags: ['female'] },
  { name: 'dag', file: 'skins/dag.png', tags: ['elderly'] },
]
const clothes: Skin[] = [{ name: 'short', file: 'clothes/short.png' }, { name: 'long', file: 'clothes/long.png', tags: ['long-sleeves'] }]

function legacy (): Character {
  return makeCharacter({ id: 'folk-test', gear: structuredClone(gear), look: { layers: [], skins, clothes } })
}
/** The same character migrated: its folk section and cloth layers made from its old fields. */
function migrated (): Character {
  const c = legacy()
  const m = folkFromLegacy(c)!
  c.folk = m.folk
  c.look.cloth = m.cloth
  return c
}
const set = (o: string): string => setIdOf('folk-test', o)
const layer = (c: Character, name: string): string => c.look.cloth!.find(l => l.name === name)!.id

describe('folkpick draws', () => {
  it('is the same draw for the same unit, salt and k, spread over [0, 1)', () => {
    expect(draw(17, 'skin', 1)).toBe(draw('17', 'skin', 1))
    expect(draw(17, 'skin', 1)).not.toBe(draw(17, 'hair', 1))
    expect(draw(17, 'skin', 0)).not.toBe(draw(17, 'skin', 1))
    const buckets = new Array(10).fill(0)
    let mean = 0
    for (let u = 0; u < 5000; u++) { const r = draw(u, 'skin', 1); expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(1); buckets[Math.floor(r * 10)]++; mean += r / 5000 }
    expect(mean).toBeCloseTo(0.5, 1)
    for (const b of buckets) expect(Math.abs(b - 500)).toBeLessThan(90)
  })

  it('is fnv1a32 then fmix32 over "<uid>|<salt>|<k>" (what the game reproduces)', () => {
    // (pinned: a change here changes every unit's look in the game)
    expect(fmix32(0)).toBe(0)
    expect(fnv1a('1|set|1')).toBe(3652927439)
    expect(fmix32(3652927439)).toBe(620292890)
    expect([draw(1, 'set', 1), draw(7, 'skin', 0), draw(1234, 'hair', 1)].map(r => r * 4294967296)).toEqual([620292890, 2755214799, 2735793653])
  })

  it('picks by weight, never a weight 0', () => {
    const items = [{ id: 'a', weight: 1 }, { id: 'b', weight: 3 }, { id: 'c', weight: 0 }]
    expect(weighted(items, 0)?.id).toBe('a')
    expect(weighted(items, 0.24)?.id).toBe('a')
    expect(weighted(items, 0.26)?.id).toBe('b')
    expect(weighted(items, 0.9999)?.id).toBe('b')
    expect(weighted([], 0.5)).toBeNull()
    expect(weighted([{ weight: 0 }], 0.5)).toBeNull()
  })
})

describe('folkpick rules (today\'s, as data)', () => {
  const c = migrated()
  const w = worldOf(c)
  const allowed = (step: string, o: { set?: string | null, skin?: string | null }): string[] =>
    candidates(w, step, tagsAfter(w, o)).filter(x => x.ok).map(x => x.ref).sort()

  it('fem hair only on a female skin, masc only on one that isn\'t', () => {
    expect(allowed('hair', { set: set('straw'), skin: 'asha' })).toEqual(['braids', 'crop'])
    expect(allowed('hair', { set: set('straw'), skin: 'bran' })).toEqual(['crop', 'tonsure'])
    expect(candidates(w, 'hair', tagsAfter(w, { set: set('straw'), skin: 'bran' })).find(x => x.ref === 'braids')?.why).toBe('needs female')
  })

  it('no beard on a beardless skin or under a great helm; no hair under what covers it', () => {
    expect(allowed('beard', { set: set('straw'), skin: 'asha' })).toEqual([])
    expect(allowed('beard', { set: set('straw'), skin: 'cora' })).toEqual(['full'])
    expect(allowed('beard', { set: set('straw'), skin: 'bran' })).toEqual(['full', 'goatee'])
    expect(allowed('beard', { set: set('plate'), skin: 'bran' })).toEqual([])
    expect(allowed('beard', { set: set('mail'), skin: 'bran' })).toEqual(['full', 'goatee'])
    expect(allowed('hair', { set: set('mail'), skin: 'bran' })).toEqual([])
    expect(candidates(w, 'hair', tagsAfter(w, { set: set('mail'), skin: 'bran' }))[0].why).toBe('not with covers-hair')
  })

  it('no long sleeves under bracers', () => {
    expect(allowed('bottom', { set: set('plate'), skin: 'bran' })).toEqual([layer(c, 'short')])
    expect(allowed('bottom', { set: set('straw'), skin: 'bran' })).toEqual([layer(c, 'long'), layer(c, 'short')].sort())
  })

  it('never picks gear that isn\'t ready', () => {
    expect(allowed('hair', { set: set('straw'), skin: 'dag' })).not.toContain('wip')
  })

  it('allows exactly what the old functions allowed, for every outfit and skin', () => {
    const old = legacy()
    for (const outfit of ['mail', 'straw', 'plate', null]) {
      for (const skin of [...skins, undefined]) {
        const o = { set: outfit === null ? null : set(outfit), skin: skin?.name ?? null }
        const ready = old.gear.filter(g => g.status === 'ready')
        const hairs = coversHair(old.gear, outfit) ? [] : ready.filter(g => g.role === 'hair' && fits(g, skin)).map(g => g.id)
        const beards = coversFace(old.gear, outfit) ? [] : ready.filter(g => g.role === 'beard' && fits(g, skin)).map(g => g.id)
        const wear = clothesFor(old.gear, outfit, clothes).map(k => layer(c, k.name))
        expect(allowed('hair', o)).toEqual(hairs.sort())
        expect(allowed('beard', o)).toEqual(beards.sort())
        expect(allowed('bottom', o)).toEqual(wear.sort())
      }
    }
  })

  it('reads a character never migrated the same as its migrated self', () => {
    for (let u = 0; u < 40; u++) expect(pick(worldOf(legacy()), u)).toEqual(pick(w, u))
  })
})

describe('folkpick runs', () => {
  const c = migrated()
  const w = worldOf(c)

  it('picks only what is allowed, the same for the same unit', () => {
    for (let u = 0; u < 300; u++) {
      const p = pick(w, u)
      expect(pick(w, u)).toEqual(p)
      const tags = tagsAfter(w, { set: p.picks.set, skin: p.picks.skin })
      for (const step of ['hair', 'beard']) {
        if (p.picks[step] !== null) expect(candidates(w, step, tags).find(x => x.ref === p.picks[step])?.ok).toBe(true)
      }
      expect(p.picks.skin).not.toBeNull()
      expect(p.picks.bottom).not.toBeNull()
      // (the old clothes fill top and bottom: the top step has nothing left to fill)
      expect(p.picks.top).toBeNull()
      expect(p.layers).toEqual([p.picks.bottom])
      const female = (skins.find(k => k.name === p.picks.skin)?.tags ?? []).includes('female')
      expect(p.shapes.includes('female')).toBe(female)
      expect(p.shapes.includes('long_sleeve')).toBe(p.picks.bottom === layer(c, 'long'))
    }
  })

  it('wears a beard about half the time it can', () => {
    let could = 0; let did = 0
    for (let u = 0; u < 4000; u++) {
      const p = pick(w, u, { fixed: { set: set('straw') } })
      if (p.picks.skin !== 'bran' && p.picks.skin !== 'dag') continue
      could++
      if (p.picks.beard !== null) did++
    }
    expect(did / could).toBeGreaterThan(0.45)
    expect(did / could).toBeLessThan(0.55)
  })

  it('spreads the picks over the items', () => {
    const counts: Record<string, number> = {}
    for (let u = 0; u < 4000; u++) { const s = pick(w, u).picks.skin!; counts[s] = (counts[s] ?? 0) + 1 }
    for (const k of skins) expect(Math.abs(counts[k.name] - 1000)).toBeLessThan(120)
  })

  it('keeps the face and hair of a villager who becomes a spearman', () => {
    const f = c.folk!
    f.kinds = [
      { id: 'villager', name: 'Villager', tags: [], sets: [{ set: set('straw') }] },
      { id: 'spearman', name: 'Spearman', tags: ['role:soldier'], sets: [{ set: set('mail') }, { set: set('plate') }] },
      { id: 'monk', name: 'Monk', tags: [], sets: [{ set: set('straw') }] },
    ]
    const v = worldOf(c)
    let hairKept = 0
    for (let u = 0; u < 200; u++) {
      const a = pick(v, u, { kind: 'villager' })
      const b = pick(v, u, { kind: 'spearman' })
      expect(b.picks.skin).toBe(a.picks.skin)
      expect(b.picks.hair).toBeNull() // (both its sets cover the hair)
      expect(pick(v, u, { kind: 'monk' }).picks).toEqual(a.picks)
      expect(b.tags).toContain('role:soldier')
      if (b.picks.set === set('mail') && b.picks.beard !== null) hairKept++
    }
    expect(hairKept).toBeGreaterThan(0)
  })

  it('picks a kind\'s sets by weight, by tag query, and by culture with a fallback', () => {
    const f: FolkSection = structuredClone(c.folk!)
    f.sets.find(s => s.name === 'mail')!.tags = ['culture:norse', 'role:soldier']
    f.sets.find(s => s.name === 'plate')!.tags = ['culture:gael', 'role:soldier']
    f.sets.find(s => s.name === 'straw')!.tags = ['role:villager']
    f.kinds = [
      { id: 'soldier', name: 'Soldier', tags: [], sets: { query: ['role:soldier'] } },
      { id: 'weighted', name: 'Weighted', tags: [], sets: [{ set: set('mail'), weight: 3 }, { set: set('straw'), weight: 1 }, { set: set('plate'), weight: 0 }] },
    ]
    const v = worldOf({ ...c, folk: f })
    const sets = (kind: string, tags: string[] = []): Record<string, number> => {
      const out: Record<string, number> = {}
      for (let u = 0; u < 2000; u++) { const s = pick(v, u, { kind, tags }).picks.set!; out[s] = (out[s] ?? 0) + 1 }
      return out
    }
    expect(Object.keys(sets('soldier')).sort()).toEqual([set('mail'), set('plate')].sort())
    expect(Object.keys(sets('soldier', ['culture:norse']))).toEqual([set('mail')])
    expect(Object.keys(sets('soldier', ['culture:gael']))).toEqual([set('plate')])
    // (no soldier set of that culture: any of the kind's)
    expect(Object.keys(sets('soldier', ['culture:swiss'])).sort()).toEqual([set('mail'), set('plate')].sort())
    const wsets = sets('weighted')
    expect(wsets[set('plate')]).toBeUndefined()
    expect(wsets[set('mail')] / 2000).toBeCloseTo(0.75, 1)
    // (a set that names no culture goes with any; the norse one doesn't go with a gael, the gael one weighs nothing)
    expect(Object.keys(sets('weighted', ['culture:gael']))).toEqual([set('straw')])
  })

  it('takes fixed choices as given, their tags joining', () => {
    for (let u = 0; u < 30; u++) {
      const p = pick(w, u, { fixed: { set: set('mail'), skin: 'bran', beard: null } })
      expect(p.picks).toMatchObject({ set: set('mail'), skin: 'bran', hair: null, beard: null })
      expect(p.tags).toContain('covers-hair')
    }
  })

  it('fills cloth slots once: a layer over two slots skips the later step, an over layer by its chance', () => {
    const cc = structuredClone(c)
    const extra: ClothLayer[] = [
      { id: 'shorts', name: 'Shorts', slots: ['bottom'], file: 'clothes/shorts.png' },
      { id: 'shirt', name: 'Shirt', slots: ['top'], file: 'clothes/shirt.png', shapes: ['long_sleeve'] },
      { id: 'cloak', name: 'Cloak', slots: ['over'], file: 'clothes/cloak.png', tags: ['warm'] },
    ]
    cc.look.cloth!.push(...extra)
    cc.folk!.pools.push(
      { id: 'tops', name: 'Tops', kind: 'cloth', slot: 'top', items: [{ ref: 'shirt', excludes: ['bracers'] }] },
      { id: 'overs', name: 'Overs', kind: 'cloth', slot: 'over', chance: 0.3, items: [{ ref: 'cloak' }] },
    )
    cc.folk!.pools.find(p => p.kind === 'cloth' && p.slot === 'bottom')!.items.push({ ref: 'shorts', weight: 2 })
    const v = worldOf(cc)
    let shorts = 0; let cloaks = 0
    for (let u = 0; u < 1000; u++) {
      const p = pick(v, u, { fixed: { set: set('straw') } })
      if (p.picks.bottom === 'shorts') {
        shorts++
        expect(p.picks.top).toBe('shirt')
        expect(p.layers.slice(0, 2)).toEqual(['shorts', 'shirt'])
        expect(p.shapes).toContain('long_sleeve')
      } else {
        expect(p.picks.top).toBeNull()
      }
      if (p.picks.over === 'cloak') { cloaks++; expect(p.tags).toContain('warm'); expect(p.layers[p.layers.length - 1]).toBe('cloak') }
      // (bracers: the long-sleeved shirt is out, and the top stays bare)
      const q = pick(v, u, { fixed: { set: set('plate') } })
      expect(q.picks.top).toBeNull()
    }
    expect(shorts / 1000).toBeCloseTo(0.5, 1)
    expect(cloaks / 1000).toBeCloseTo(0.3, 1)
  })

  it('draws from the pools a kind names', () => {
    const cc = structuredClone(c)
    cc.folk!.pools.push({ id: 'monk-hair', name: 'Monk hair', kind: 'hair', items: [{ ref: 'tonsure' }] })
    cc.folk!.kinds = [{ id: 'monk', name: 'Monk', tags: [], sets: [{ set: set('straw') }], pools: { hair: 'monk-hair' } }]
    const v = worldOf(cc)
    for (let u = 0; u < 100; u++) {
      const p = pick(v, u, { fixed: { skin: 'bran' } })
      expect(p.picks.hair).toBe('tonsure')
    }
  })

  it('takes the stance of the set, else the kind\'s', () => {
    const cc = structuredClone(c)
    cc.folk!.sets.find(s => s.name === 'mail')!.stance = 'shield'
    cc.folk!.kinds = [{ id: 'k', name: 'K', tags: [], sets: [{ set: set('mail') }, { set: set('straw') }], stance: 'plain' }]
    const v = worldOf(cc)
    for (let u = 0; u < 40; u++) {
      const p = pick(v, u)
      expect(p.stance).toBe(p.picks.set === set('mail') ? 'shield' : 'plain')
    }
  })

  it('picks nothing from nothing', () => {
    const empty: FolkWorld = { program: PROGRAM, sets: [], kinds: [], pools: [], skins: [], layers: [], pieces: [] }
    const p = pick(empty, 5)
    expect(p.kind).toBeNull()
    expect(Object.values(p.picks).every(x => x === null)).toBe(true)
    expect(p.layers).toEqual([])
  })

  it('makes the same goldens every time, over the kinds and cultures', () => {
    const g = goldens(w)
    expect(g).toHaveLength(32)
    expect(goldens(worldOf(migrated()))).toEqual(g)
    for (const x of g) expect(pick(w, x.uid, { kind: x.inputs.kind ?? undefined, tags: x.inputs.tags })).toEqual(x.pick)
  })
})
