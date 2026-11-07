// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Command } from './command-types.ts'
import { applyCommands, CommandError } from './commands.ts'
import { entitiesOf, restoreEntities, touchedBy, undoConflicts, undoRecord } from './entities.ts'
import { makeCharacter, makeGear, makeSlot } from './fixtures.ts'
import { folkFromLegacy, setIdOf } from './folk.ts'
import type { Character, ClothLayer } from './types.ts'

const run = (c: Character, ...cmds: Command[]): Character => applyCommands(c, cmds).character
const said = (c: Character, ...cmds: Command[]): string[] => applyCommands(c, cmds).changes
const fails = (c: Character, cmd: Command, status: number, message?: RegExp): void => {
  try {
    applyCommands(c, [cmd])
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError)
    expect((e as CommandError).status).toBe(status)
    if (message !== undefined) expect((e as Error).message).toMatch(message)
    return
  }
  throw new Error(`${cmd.type} did not fail`)
}
/** Undo as the store does it: the before values back. */
const undo = (before: Character, after: Character): Character => restoreEntities(after, undoRecord(before, after))

const layer = (id: string, over: Partial<ClothLayer> = {}): ClothLayer => ({ id, name: id, slots: ['bottom'], file: `clothes/${id}.png`, ...over })

function folk (): Character {
  const c = makeCharacter({
    id: 'folk-t',
    gear: [
      makeGear({ id: 'helm', name: 'Outfit_mail_helm', outfit: 'mail', tags: ['covers-hair'] }),
      makeGear({ id: 'bracer', name: 'Outfit_mail_forearm_L', outfit: 'mail' }),
      makeGear({ id: 'hat', name: 'Outfit_straw_hat', outfit: 'straw' }),
      makeGear({ id: 'braids', name: 'Hair_braids', role: 'hair', tags: ['fem'] }),
      makeGear({ id: 'full', name: 'Beard_full', role: 'beard' }),
      makeGear({ id: 'cape', name: 'Cape' }),
    ],
    clips: [makeSlot({ id: 'idle', name: 'Idle' }), makeSlot({ id: 'idle-shield', name: 'Idle_shield' }), makeSlot({ id: 'arm', name: 'Arm_up' })],
    look: { layers: [], skins: [{ name: 'asha', file: 'skins/a.png', tags: ['female'] }, { name: 'bran', file: 'skins/b.png' }], clothes: [{ name: 'plain', file: 'clothes/plain.png' }] },
  })
  const m = folkFromLegacy(c)!
  c.folk = m.folk
  c.look.cloth = m.cloth
  return c
}
const MAIL = setIdOf('folk-t', 'mail')
const STRAW = setIdOf('folk-t', 'straw')

describe('folk.set.*', () => {
  it('adds a set (grants from its pieces), updates, duplicates, reorders and removes it', () => {
    const c = folk()
    const a = run(c, { type: 'folk.set.add', set: { id: 'guard', name: 'Guard', pieces: ['helm', 'cape'], tags: ['culture:norse', 'role:soldier'], grants: undefined as unknown as string[] }, index: 0 })
    expect(a.folk!.sets[0]).toEqual({ id: 'guard', name: 'Guard', pieces: ['helm', 'cape'], tags: ['culture:norse', 'role:soldier'], grants: ['covers-hair'] })
    const b = run(a, { type: 'folk.set.update', id: 'guard', patch: { name: 'Town guard', grants: ['heavy'], weight: 2, note: 'from the forge', stance: null } })
    expect(b.folk!.sets[0]).toMatchObject({ name: 'Town guard', grants: ['heavy'], weight: 2, note: 'from the forge' })
    expect(run(b, { type: 'folk.set.update', id: 'guard', patch: { weight: null, note: null } }).folk!.sets[0]).not.toHaveProperty('weight')
    const d = run(b, { type: 'folk.set.duplicate', id: 'guard', newId: 'guard2' })
    expect(d.folk!.sets.map(s => s.id)).toEqual(['guard', 'guard2', MAIL, STRAW])
    expect(d.folk!.sets[1]).toMatchObject({ name: 'Town guard copy', pieces: ['helm', 'cape'], tags: ['culture:norse', 'role:soldier'] })
    const r = run(d, { type: 'folk.set.reorder', ids: [STRAW, MAIL] })
    expect(r.folk!.sets.map(s => s.id)).toEqual([STRAW, MAIL, 'guard', 'guard2'])
    const k = run(r, { type: 'folk.kind.add', kind: { id: 'guards', name: 'Guards', tags: [], sets: [{ set: 'guard' }, { set: MAIL }] } })
    const gone = applyCommands(k, [{ type: 'folk.set.remove', id: 'guard' }])
    expect(gone.character.folk!.sets.map(s => s.id)).toEqual([STRAW, MAIL, 'guard2'])
    expect(gone.character.folk!.kinds.find(x => x.id === 'guards')!.sets).toEqual([{ set: MAIL }])
    expect(gone.changes).toEqual(['set Town guard: removed', 'kind Guards: no longer wears Town guard'])
  })

  it('keeps the grants with the pieces, and a grant given by hand', () => {
    const c = run(folk(), { type: 'folk.set.update', id: STRAW, patch: { grants: ['heavy'] } })
    const a = run(c, { type: 'folk.set.pieces', id: STRAW, pieces: ['hat', 'helm', 'bracer'] })
    expect(a.folk!.sets.find(s => s.id === STRAW)!.grants).toEqual(['bracers', 'covers-hair', 'heavy'])
    const b = run(a, { type: 'folk.set.pieces', id: STRAW, pieces: ['hat', 'bracer'] })
    expect(b.folk!.sets.find(s => s.id === STRAW)!.grants).toEqual(['bracers', 'heavy'])
    // (taken off by hand: stays off while the pieces don't change what they grant)
    const off = run(b, { type: 'folk.set.update', id: STRAW, patch: { grants: [] } }, { type: 'folk.set.pieces', id: STRAW, pieces: ['bracer', 'hat'] })
    expect(off.folk!.sets.find(s => s.id === STRAW)!.grants).toEqual([])
    expect(said(b, { type: 'folk.set.pieces', id: STRAW, pieces: ['hat', 'bracer'] })).toEqual([])
  })

  it('refuses what isn\'t there or is taken, and malformed tags', () => {
    const c = folk()
    fails(c, { type: 'folk.set.add', set: { id: MAIL, name: 'x', pieces: [], tags: [], grants: [] } }, 409)
    fails(c, { type: 'folk.set.add', set: { id: 'n', name: 'x', pieces: ['nope'], tags: [], grants: [] } }, 404, /No gear nope/)
    fails(c, { type: 'folk.set.add', set: { id: 'n', name: 'x', pieces: ['hat', 'hat'], tags: [], grants: [] } }, 400)
    fails(c, { type: 'folk.set.add', set: { id: 'n', name: 'x', pieces: [], tags: ['Culture Norse'], grants: [] } }, 400)
    fails(c, { type: 'folk.set.update', id: 'nope', patch: { name: 'x' } }, 404)
    fails(c, { type: 'folk.set.update', id: MAIL, patch: { pieces: [] } as never }, 400)
    fails(c, { type: 'folk.set.update', id: MAIL, patch: { stance: 'nope' } }, 404)
    fails(c, { type: 'folk.set.duplicate', id: MAIL, newId: STRAW }, 409)
    fails(makeCharacter(), { type: 'folk.set.reorder', ids: [] }, 404)
  })
})

describe('folk.pool.*', () => {
  it('adds, updates, fills and removes a pool; a kind\'s pools follow', () => {
    const c = folk()
    const a = run(c,
      { type: 'folk.pool.add', pool: { id: 'capes', name: 'Capes', kind: 'accessory', chance: 0.25, items: [{ ref: 'cape', weight: 2, excludes: ['heavy'] }] } },
      { type: 'folk.kind.add', kind: { id: 'k', name: 'K', tags: [], sets: { query: [] }, pools: { accessory: 'capes' } } },
    )
    expect(a.folk!.pools.at(-1)).toEqual({ id: 'capes', name: 'Capes', kind: 'accessory', chance: 0.25, items: [{ ref: 'cape', weight: 2, excludes: ['heavy'] }] })
    const b = run(a, { type: 'folk.pool.update', id: 'capes', patch: { chance: null, requires: ['culture:norse'], name: 'Cloaks' } })
    expect(b.folk!.pools.at(-1)).toEqual({ id: 'capes', name: 'Cloaks', kind: 'accessory', requires: ['culture:norse'], items: [{ ref: 'cape', weight: 2, excludes: ['heavy'] }] })
    const items = run(b, { type: 'folk.pool.items', id: 'capes', items: [{ ref: 'cape' }, { ref: 'hat', weight: 1 }] })
    expect(items.folk!.pools.at(-1)!.items).toEqual([{ ref: 'cape' }, { ref: 'hat' }])
    const r = applyCommands(b, [{ type: 'folk.pool.remove', id: 'capes' }])
    expect(r.character.folk!.pools.some(p => p.id === 'capes')).toBe(false)
    expect(r.character.folk!.kinds.find(k => k.id === 'k')).not.toHaveProperty('pools')
    expect(r.changes).toEqual(['pool Cloaks: removed', 'kind K: its accessory from the default pool'])
  })

  it('checks items against the pool\'s kind and a slot only on cloth', () => {
    const c = folk()
    const skins = c.folk!.pools.find(p => p.kind === 'skin')!
    expect(run(c, { type: 'folk.pool.items', id: skins.id, items: [{ ref: 'bran' }] }).folk!.pools.find(p => p.id === skins.id)!.items).toEqual([{ ref: 'bran' }])
    fails(c, { type: 'folk.pool.items', id: skins.id, items: [{ ref: 'helm' }] }, 404, /No skin helm/)
    fails(c, { type: 'folk.pool.items', id: skins.id, items: [{ ref: 'bran' }, { ref: 'bran' }] }, 400)
    fails(c, { type: 'folk.pool.add', pool: { id: 'x', name: 'X', kind: 'hair', slot: 'top', items: [] } }, 400)
    fails(c, { type: 'folk.pool.add', pool: { id: 'x', name: 'X', kind: 'cloth', items: [{ ref: 'nope' }] } }, 404, /No cloth layer/)
    fails(c, { type: 'folk.pool.add', pool: { id: 'x', name: 'X', kind: 'beard', chance: 2, items: [] } }, 400)
    fails(c, { type: 'folk.pool.update', id: skins.id, patch: { slot: 'top' } }, 400)
  })
})

describe('folk.kind.* and folk.stance.*', () => {
  it('adds kinds, sets what they wear, and stances with their clips', () => {
    const c = run(folk(),
      { type: 'folk.stance.add', stance: { id: 'shield', name: 'Shield', clips: { Idle: ['idle-shield'] }, overlay: 'arm' } },
      { type: 'folk.kind.add', kind: { id: 'spear', name: 'Spearman', tags: ['role:soldier'], sets: [{ set: MAIL, weight: 2 }], stance: 'shield' } },
      { type: 'folk.set.update', id: MAIL, patch: { stance: 'shield' } },
    )
    expect(c.folk!.stances).toEqual([{ id: 'shield', name: 'Shield', clips: { Idle: ['idle-shield'] }, overlay: 'arm' }])
    expect(c.folk!.kinds.at(-1)).toEqual({ id: 'spear', name: 'Spearman', tags: ['role:soldier'], sets: [{ set: MAIL, weight: 2 }], stance: 'shield' })
    const q = run(c, { type: 'folk.kind.sets', id: 'spear', sets: { query: ['role:soldier'] } })
    expect(q.folk!.kinds.at(-1)!.sets).toEqual({ query: ['role:soldier'] })
    const st = run(c, { type: 'folk.stance.clip', id: 'shield', clip: 'Walk', slots: ['idle', 'idle-shield'] }, { type: 'folk.stance.clip', id: 'shield', clip: 'Idle', slots: null })
    expect(st.folk!.stances[0].clips).toEqual({ Walk: ['idle', 'idle-shield'] })
    const u = run(c, { type: 'folk.kind.update', id: 'spear', patch: { name: 'Spear', tags: [], stance: null, pools: { hair: c.folk!.pools.find(p => p.kind === 'hair')!.id } } })
    expect(u.folk!.kinds.at(-1)).toEqual({ id: 'spear', name: 'Spear', tags: [], sets: [{ set: MAIL, weight: 2 }], pools: { hair: c.folk!.pools.find(p => p.kind === 'hair')!.id } })
    // (a stance removed: off every set and kind)
    const r = applyCommands(c, [{ type: 'folk.stance.remove', id: 'shield' }])
    expect(r.character.folk!.stances).toEqual([])
    expect(r.character.folk!.sets.find(s => s.id === MAIL)).not.toHaveProperty('stance')
    expect(r.character.folk!.kinds.at(-1)).not.toHaveProperty('stance')
    expect(run(c, { type: 'folk.kind.remove', id: 'spear' }).folk!.kinds.map(k => k.id)).toEqual(['folk'])
    fails(c, { type: 'folk.kind.sets', id: 'spear', sets: [{ set: 'nope' }] }, 404)
    fails(c, { type: 'folk.kind.add', kind: { id: 'x', name: 'X', tags: [], sets: [], pools: { hair: 'nope' } } }, 404)
    fails(c, { type: 'folk.stance.clip', id: 'shield', clip: 'Idle', slots: ['nope'] }, 404)
    fails(c, { type: 'folk.stance.add', stance: { id: 'shield', name: 'Again', clips: {} } }, 409)
  })

  it('takes a removed slot out of the stances, and slots a clip set replaced', () => {
    const c = run(folk(), { type: 'folk.stance.add', stance: { id: 'shield', name: 'Shield', clips: { Idle: ['idle-shield'], Walk: ['idle', 'idle-shield'] }, overlay: 'arm' } })
    const a = applyCommands(c, [{ type: 'slot.remove', id: 'idle-shield' }, { type: 'slot.remove', id: 'arm' }])
    expect(a.character.folk!.stances[0]).toEqual({ id: 'shield', name: 'Shield', clips: { Walk: ['idle'] } })
    expect(a.changes).toContain('stance Shield: Idle out of it (a slot is gone)')
    const b = run(c, { type: 'clips.replace', slots: [makeSlot({ id: 'new', name: 'Idle' })] })
    expect(b.folk!.stances[0]).toEqual({ id: 'shield', name: 'Shield', clips: {} })
  })

  it('makes the section with the first thing added on a character without one', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'cape', name: 'Cape' })] })
    const a = run(c, { type: 'folk.set.add', set: { id: 's', name: 'S', pieces: ['cape'], tags: [], grants: [] } })
    expect(a.folk).toEqual({ sets: [{ id: 's', name: 'S', pieces: ['cape'], tags: [], grants: [] }], pools: [], kinds: [], stances: [] })
    // (and an undo of it leaves none)
    expect(undo(c, a)).toEqual(c)
  })
})

describe('look.cloth.* and look.skin.bare', () => {
  it('renames a skin and its selected and pool references, validates hair, and undoes', () => {
    const c = folk()
    c.look.skin = 'asha'
    const next = run(c, { type: 'look.skin.update', name: 'asha', patch: { name: 'asha-new', hair: '#AABBCC' } })
    expect(next.look.skin).toBe('asha-new')
    expect(next.look.skins!.find(s => s.name === 'asha-new')?.hair).toBe('#aabbcc')
    expect(next.folk!.pools.filter(p => p.kind === 'skin').flatMap(p => p.items.map(i => i.ref))).toContain('asha-new')
    expect(next.folk!.pools.filter(p => p.kind === 'skin').flatMap(p => p.items.map(i => i.ref))).not.toContain('asha')
    fails(c, { type: 'look.skin.update', name: 'asha', patch: { hair: 'red' } }, 400, /hair/)
    fails(c, { type: 'look.skin.update', name: 'asha', patch: { name: 'bran' } }, 409)
    expect(undo(c, next)).toEqual(c)
  })
  it('adds, updates, reorders and removes cloth layers; a removed one leaves the pools', () => {
    const c = folk()
    const pool = c.folk!.pools.find(p => p.kind === 'cloth')!
    const a = run(c,
      { type: 'look.cloth.add', layer: layer('shorts', { cut: { below: [{ regions: [20, 21], y: 0.3, feather: 0.02 }] }, tags: ['culture:gael'] }) },
      { type: 'folk.pool.items', id: pool.id, items: [...pool.items, { ref: 'shorts' }] },
    )
    expect(a.look.cloth!.at(-1)).toEqual({ id: 'shorts', name: 'shorts', slots: ['bottom'], file: 'clothes/shorts.png', cut: { below: [{ regions: [20, 21], y: 0.3, feather: 0.02 }] }, tags: ['culture:gael'] })
    const u = applyCommands(a, [{ type: 'look.cloth.update', id: 'shorts', patch: { name: 'Shorts', slots: ['bottom', 'top'], shapes: ['long_sleeve'], cut: null, trim: 'clothes/shorts.trim.png', coverage: [0, 0.5] } }])
    expect(u.character.look.cloth!.at(-1)).toEqual({ id: 'shorts', name: 'Shorts', slots: ['bottom', 'top'], file: 'clothes/shorts.png', shapes: ['long_sleeve'], trim: 'clothes/shorts.trim.png', tags: ['culture:gael'], coverage: [0, 0.5] })
    expect(u.changes[0]).toBe('cloth shorts: renamed Shorts')
    expect(run(a, { type: 'look.cloth.reorder', ids: ['shorts'] }).look.cloth!.map(l => l.id)).toEqual(['shorts', c.look.cloth![0].id])
    const r = applyCommands(a, [{ type: 'look.cloth.remove', id: 'shorts' }])
    expect(r.character.look.cloth!.map(l => l.id)).toEqual([c.look.cloth![0].id])
    expect(r.character.folk!.pools.find(p => p.id === pool.id)!.items.map(i => i.ref)).toEqual([c.look.cloth![0].id])
    expect(r.changes).toEqual(['cloth shorts: removed', 'pool Clothes: the layer taken out'])
    fails(c, { type: 'look.cloth.add', layer: layer('bad', { slots: [] }) }, 400)
    fails(c, { type: 'look.cloth.add', layer: layer('bad', { file: '../x.png' }) }, 400)
    fails(c, { type: 'look.cloth.add', layer: layer(c.look.cloth![0].id) }, 409)
    fails(c, { type: 'look.cloth.update', id: 'nope', patch: { name: 'x' } }, 404)
    fails(c, { type: 'look.cloth.update', id: c.look.cloth![0].id, patch: { slots: ['sleeves'] } as never }, 400)
  })

  it('gives a skin a bare version, kept when the skins are set again', () => {
    const c = run(folk(), { type: 'look.skin.bare', name: 'bran', file: 'skins/bare/b.png' })
    expect(c.look.skins!.find(k => k.name === 'bran')!.bare).toBe('skins/bare/b.png')
    const again = run(c, { type: 'look.skins.set', skins: [{ name: 'bran', file: 'skins/b2.png' }] })
    expect(again.look.skins).toEqual([{ name: 'bran', file: 'skins/b2.png', bare: 'skins/bare/b.png' }])
    expect(run(c, { type: 'look.skin.bare', name: 'bran', file: null }).look.skins!.find(k => k.name === 'bran')).not.toHaveProperty('bare')
    fails(c, { type: 'look.skin.bare', name: 'nope', file: 'x.png' }, 404)
  })
})

describe('gear and the old commands keep the folk data in step', () => {
  it('takes removed gear out of its sets (grants following) and pools', () => {
    const c = folk()
    const a = applyCommands(c, [{ type: 'gear.remove', id: 'helm' }, { type: 'gear.remove', id: 'braids' }])
    expect(a.character.folk!.sets.find(s => s.id === MAIL)).toMatchObject({ pieces: ['bracer'], grants: ['bracers'] })
    expect(a.character.folk!.pools.find(p => p.kind === 'hair')!.items).toEqual([])
    expect(a.changes).toContain('set mail: Outfit_mail_helm taken out')
    expect(a.changes).toContain('pool Hair: Hair_braids taken out')
    // (and an undo puts it all back)
    expect(undo(c, a.character)).toEqual(c)
  })

  it('moves a piece between sets and pools when its outfit, role or tags change', () => {
    const c = folk()
    const a = run(c, { type: 'gear.update', id: 'cape', patch: { outfit: 'straw' } })
    expect(a.folk!.sets.find(s => s.id === STRAW)!.pieces).toEqual(['hat', 'cape'])
    const b = applyCommands(a, [{ type: 'gear.update', id: 'cape', patch: { outfit: 'cloaked', tags: ['covers-hair'] } }])
    expect(b.character.folk!.sets.find(s => s.id === STRAW)!.pieces).toEqual(['hat'])
    expect(b.character.folk!.sets.at(-1)).toEqual({ id: setIdOf('folk-t', 'cloaked'), name: 'cloaked', pieces: ['cape'], tags: [], grants: ['covers-hair'] })
    expect(b.changes).toContain('set cloaked: added')
    const hat = run(c, { type: 'gear.update', id: 'hat', patch: { tags: ['covers-hair'] } })
    expect(hat.folk!.sets.find(s => s.id === STRAW)!.grants).toEqual(['covers-hair'])
    const hair = run(c, { type: 'gear.update', id: 'braids', patch: { role: 'beard', tags: ['masc'] } })
    expect(hair.folk!.pools.find(p => p.kind === 'hair')!.items).toEqual([])
    expect(hair.folk!.pools.find(p => p.kind === 'beard')!.items).toEqual([{ ref: 'full' }, { ref: 'braids', excludes: ['female'] }])
    const fem = run(c, { type: 'gear.update', id: 'full', patch: { tags: ['fem'] } })
    expect(fem.folk!.pools.find(p => p.kind === 'beard')!.items).toEqual([{ ref: 'full', requires: ['female'] }])
    // (gear added by a tool with an outfit or a role)
    const added = run(c, { type: 'gear.add', gear: makeGear({ id: 'crop', name: 'Hair_crop', role: 'hair' }) }, { type: 'gear.add', gear: makeGear({ id: 'boots', name: 'Outfit_mail_boots', outfit: 'mail' }) })
    expect(added.folk!.pools.find(p => p.kind === 'hair')!.items.map(i => i.ref)).toEqual(['braids', 'crop'])
    expect(added.folk!.sets.find(s => s.id === MAIL)!.pieces).toEqual(['helm', 'bracer', 'boots'])
  })

  it('keeps the skin and cloth pools with look.skins.set and look.clothes.set', () => {
    const c = folk()
    const plain = c.look.cloth![0]
    const a = run(c,
      { type: 'look.cloth.update', id: plain.id, patch: { trim: 'clothes/plain.trim.png' } },
      { type: 'look.skins.set', skins: [{ name: 'bran', file: 'skins/b.png' }, { name: 'cora', file: 'skins/c.png' }] },
      { type: 'look.clothes.set', clothes: [{ name: 'plain', file: 'clothes/plain2.png', tags: ['long-sleeves'] }, { name: 'smock', file: 'clothes/smock.png' }] },
    )
    expect(a.folk!.pools.find(p => p.kind === 'skin')!.items).toEqual([{ ref: 'bran' }, { ref: 'cora' }])
    expect(a.look.cloth!.map(l => [l.name, l.file, l.shapes ?? [], l.trim ?? null])).toEqual([['plain', 'clothes/plain2.png', ['long_sleeve'], 'clothes/plain.trim.png'], ['smock', 'clothes/smock.png', [], null]])
    expect(a.look.cloth![0].id).toBe(plain.id)
    expect(a.folk!.pools.find(p => p.kind === 'cloth')!.items).toEqual([{ ref: plain.id, excludes: ['bracers'] }, { ref: a.look.cloth![1].id }])
    expect(run(a, { type: 'look.clothes.set', clothes: [] }).look.cloth).toBeUndefined()
  })
})

describe('folk undo entities', () => {
  it('names each set, pool, kind, stance and cloth layer, and their orders', () => {
    const c = run(folk(), { type: 'folk.stance.add', stance: { id: 'st', name: 'St', clips: {} } })
    const keys = [...entitiesOf(c).keys()]
    for (const k of [`set:${MAIL}`, `set:${STRAW}`, 'setOrder', 'poolOrder', 'kindOrder', 'kind:folk', 'stanceOrder', 'stance:st', 'clothOrder', `cloth:${c.look.cloth![0].id}`]) expect(keys).toContain(k)
    const a = run(c, { type: 'folk.set.update', id: MAIL, patch: { name: 'Mail' } })
    expect(touchedBy(c, a)).toEqual([`set:${MAIL}`])
    const r = run(c, { type: 'folk.set.reorder', ids: [STRAW] })
    expect(touchedBy(c, r)).toEqual(['setOrder'])
  })

  it('puts a removed set, pool, kind, stance or layer back where it was', () => {
    const c = run(folk(), { type: 'folk.stance.add', stance: { id: 'st', name: 'St', clips: { Idle: ['idle'] } } }, { type: 'folk.set.update', id: MAIL, patch: { stance: 'st' } })
    for (const cmd of [
      { type: 'folk.set.remove', id: MAIL },
      { type: 'folk.pool.remove', id: c.folk!.pools[0].id },
      { type: 'folk.kind.remove', id: 'folk' },
      { type: 'folk.stance.remove', id: 'st' },
      { type: 'look.cloth.remove', id: c.look.cloth![0].id },
    ] satisfies Command[]) {
      const after = run(c, cmd)
      expect(undo(c, after)).toEqual(c)
    }
  })

  it('sees a later change to a set as a conflict', () => {
    const c = folk()
    const a = run(c, { type: 'folk.set.update', id: MAIL, patch: { name: 'Mail' } })
    const rec = undoRecord(c, a)
    const later = run(a, { type: 'folk.set.update', id: MAIL, patch: { tags: ['heavy'] } })
    expect(undoConflicts(later, rec)).toEqual([`set:${MAIL}`])
    expect(undoConflicts(a, rec)).toEqual([])
  })
})
