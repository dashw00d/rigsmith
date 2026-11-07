// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { clothesFor, coversFace, coversHair, outfitsOf } from '../../src/engine/folk.ts'
import { pick, type FolkPick, type FolkWorld } from '../../src/engine/folkpick.ts'
import { meshNameOf } from '../../src/engine/contract.ts'
import { makeCharacter, makeGear } from '../../src/model/fixtures.ts'
import { migrate } from '../../src/model/migrate.ts'
import type { Character, Gear } from '../../src/model/types.ts'
import { atlasGroupOf, folkLeftOut, folkManifestData, folkScope, scopedGearLeftOut, stanceExportPlan, type ManifestPiece } from './folk_export.ts'

const piece = (id: string, name: string, extra: Partial<Gear> = {}): Gear =>
  makeGear({ id, name, from: `emberhold:gear/${name}`, model: `garments/${id}/model.glb`, attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...extra })

function folk (): Character {
  const v4 = makeCharacter({
    id: 'folk-e',
    gear: [
      piece('helm', 'Outfit_mail_helm', { outfit: 'mail', tags: ['covers-hair'] }),
      piece('bracer', 'Outfit_mail_forearm_L', { outfit: 'mail' }),
      piece('hat', 'Outfit_straw_hat', { outfit: 'straw' }),
      piece('braids', 'Hair_braids', { role: 'hair', tags: ['fem'] }),
      piece('crop', 'Hair_crop', { role: 'hair' }),
      piece('full', 'Beard_full', { role: 'beard' }),
      piece('wip', 'Hair_wip', { role: 'hair', status: 'importing' }),
    ],
    clips: [{ id: 'idle', name: 'Idle', clip: { id: 'x' }, speed: 1, loop: true, inPlace: true, adjustments: [] }, { id: 'idle-s', name: 'Idle_shield', clip: { id: 'x' }, speed: 1, loop: true, inPlace: true, adjustments: [] }],
    look: {
      layers: [],
      skins: [{ name: 'asha', file: 'skins/a.png', tags: ['female', 'beardless'], hair: '#202020' }, { name: 'bran', file: 'skins/b.png', bare: 'skins/b.bare.png' }],
      clothes: [{ name: 'plain', file: 'clothes/plain.png' }, { name: 'long', file: 'clothes/long.png', tags: ['long-sleeves'] }],
    },
  })
  return migrate({ ...v4, schema: 4 }).character
}

const pieceOf = (g: Gear): ManifestPiece => ({ mesh: meshNameOf(g), hides: g.id === 'helm' ? [3, 4] : [], mask: g.id === 'helm' ? 24 : 0, tags: g.tags ?? [] })
const manifest = (c: Character, spec: Parameters<typeof folkManifestData>[1] = {}): Record<string, unknown> => folkManifestData(c, spec, {
  exportable: g => g.status === 'ready',
  pieceOf,
  regionMask: hides => hides.reduce((m, r) => m | (1 << r), 0),
  regions: { count: 28 },
  files: { skins: { bran: { file: 'skins/bran.png', bare: 'skins/bran.bare.png' } }, layers: {}, clothes: {} },
  bodies: [{ mesh: 'folk', shapes: [] }, { mesh: 'FolkBody_F', shapes: ['female'] }],
  hairGreyMean: 0.62,
  femaleShape: 'female',
})

describe('folkScope', () => {
  it('exports a hidden set-held piece so the stance can wear it', () => {
    const c = folk(); const piece = c.gear.find(g => g.id === 'helm')!
    piece.hidden = true; piece.name = 'HeldShield'; piece.from = 'emberhold:gear/HeldShield'
    expect(scopedGearLeftOut(piece, folkScope(c, {}))).toBeNull()
    expect(scopedGearLeftOut(piece, null)).toBe('hidden')
  })
  it('plans scoped stance overrides and variants and rejects conflicting held pieces', () => {
    const c = folk()
    const shield = piece('shield', 'Shield', { attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })
    c.gear.push(shield)
    c.folk!.sets[0].stance = 'shield'; c.folk!.sets[0].pieces.push('shield')
    c.folk!.stances.push({ id: 'shield', name: 'Shield', clips: { Idle: ['idle-s', 'idle'], Walk: ['idle'] } })
    const plans = stanceExportPlan(c, {}, ['Idle'], ['Idle'])
    expect(plans).toHaveLength(1)
    expect(plans[0].setId).toBe(c.folk!.sets[0].id)
    expect(plans[0].clips).toEqual({ Idle: ['Idle@shield', 'Idle_2@shield'] })
    expect(plans[0].slots.map(s => [s.id, s.name])).toEqual([['idle-s', 'Idle@shield'], ['idle', 'Idle_2@shield']])
    c.folk!.sets[1].stance = 'shield'
    expect(() => stanceExportPlan(c, {}, ['Idle'], ['Idle'])).toThrow(/shield.*mail.*straw/i)
    c.folk!.sets[1].pieces.push('shield')
    expect(stanceExportPlan(c, {}, ['Idle'], ['Idle'])).toHaveLength(1)
    expect(() => stanceExportPlan(c, {}, ['Idle'], ['Idle', 'Idle@shield'])).toThrow(/Idle@shield/)
    c.folk!.stances[0].clips.Idle = ['missing']
    expect(() => stanceExportPlan(c, {}, ['Idle'], ['Idle'])).toThrow(/missing/)
  })
  it('carries every set and pool by default, a kind\'s sets for spec.folk.kind, schema 4\'s outfits and hair: false', () => {
    const c = folk()
    expect(folkScope(c, {}).sets.map(s => s.name)).toEqual(['mail', 'straw'])
    expect([...folkScope(c, {}).carried].sort()).toEqual(['bracer', 'braids', 'crop', 'full', 'hat', 'helm', 'wip'])
    expect([...folkScope(c, {}, g => g.status === 'ready').carried]).not.toContain('wip')
    const mail = c.folk!.sets.find(s => s.name === 'mail')!.id
    c.folk!.kinds.push({ id: 'guard', name: 'Guard', tags: [], sets: [{ set: mail }] })
    const guard = folkScope(c, { folk: { kind: 'guard' } })
    expect(guard.sets.map(s => s.name)).toEqual(['mail'])
    expect(guard.kinds.map(k => k.id)).toEqual(['guard'])
    expect(folkLeftOut(guard, c.gear.find(g => g.id === 'hat')!)).toBe('another kind\'s outfit')
    expect(folkLeftOut(guard, c.gear.find(g => g.id === 'helm')!)).toBeNull()
    expect(folkScope(c, { folk: { outfits: ['straw'] } }).sets.map(s => s.name)).toEqual(['straw'])
    const bald = folkScope(c, { folk: { hair: false } })
    expect(bald.pools.map(p => p.kind)).toEqual(['skin', 'cloth'])
    expect(folkLeftOut(bald, c.gear.find(g => g.id === 'crop')!)).toBe('hair and beards are another unit\'s file\'s')
    expect(folkScope(c, { folk: { pools: ['hair', c.folk!.pools[0].id] } }).pools.map(p => p.kind)).toEqual(['skin', 'hair'])
    expect(() => folkScope(c, { folk: { kind: 'nope' } })).toThrow(/folk kind nope/)
  })

  it('groups a piece by its old outfit or role, else its first set or pool', () => {
    const c = folk()
    expect(atlasGroupOf(c, c.gear.find(g => g.id === 'helm')!)).toBe('mail')
    expect(atlasGroupOf(c, c.gear.find(g => g.id === 'crop')!)).toBe('hair')
    const cape = piece('cape', 'Outfit_new_cape')
    c.gear.push(cape)
    c.folk!.sets[1].pieces.push('cape')
    expect(atlasGroupOf(c, cape)).toBe('straw')
  })
})

describe('the folk manifest, schema 2', () => {
  it('carries the program, the world and goldens the engine reproduces from the file alone', () => {
    const m = JSON.parse(JSON.stringify(manifest(folk()))) as Record<string, unknown>
    expect(m.schema).toBe(2)
    expect(m.packing).toMatchObject({ x: 'skin', y: 'top|bottom<<8|over<<16', z: 'mask', w: 'hair' })
    expect((m.program as Array<{ id: string }>).map(s => s.id)).toEqual(['set', 'skin', 'bottom', 'top', 'over', 'hair', 'beard', 'accessory'])
    const world = { program: m.program, sets: m.sets, kinds: m.kinds, pools: m.pools, skins: m.skins, layers: m.layers, pieces: m.pieces } as FolkWorld
    const golden = m.golden as Array<{ uid: number, inputs: { kind: string | null, tags: string[] }, pick: FolkPick }>
    expect(golden).toHaveLength(32)
    for (const g of golden) expect(pick(world, g.uid, { kind: g.inputs.kind ?? undefined, tags: g.inputs.tags })).toEqual(g.pick)
    // (gear by its mesh, never a piece not ready)
    const hair = (m.pools as Array<{ kind: string, items: Array<{ ref: string }> }>).find(p => p.kind === 'hair')!
    expect(hair.items.map(i => i.ref)).toEqual(['Hair_braids', 'Hair_crop'])
    expect(golden.some(g => g.pick.picks.hair === 'Hair_crop')).toBe(true)
    expect((m.pieces as Array<{ id: string }>).map(p => p.id).sort()).toEqual(['Beard_full', 'Hair_braids', 'Hair_crop'])
    expect((m.skins as Array<Record<string, unknown>>)[1]).toMatchObject({ name: 'bran', file: 'skins/bran.png', bare: 'skins/bran.bare.png' })
    expect((m.layers as Array<Record<string, unknown>>).map(l => [l.name, l.index, l.slots, l.shapes])).toEqual([['plain', 0, ['top', 'bottom'], []], ['long', 1, ['top', 'bottom'], ['long_sleeve']]])
    expect((m.sets as Array<Record<string, unknown>>)[0]).toMatchObject({ name: 'mail', grants: ['bracers', 'covers-hair'], hides: [3, 4], mask: 24 })
    expect(m.bodies).toEqual([{ mesh: 'folk', shapes: [] }, { mesh: 'FolkBody_F', shapes: ['female'] }])
  })

  it('keeps schema 1\'s view as the old rules made it', () => {
    const c = folk()
    const m = manifest(c)
    const outfits = m.outfits as Record<string, { coversHair: boolean, coversFace: boolean, clothes: string[], pieces: ManifestPiece[] }>
    expect(Object.keys(outfits)).toEqual(outfitsOf(c.gear))
    for (const o of outfitsOf(c.gear)) {
      expect(outfits[o].coversHair).toBe(coversHair(c.gear, o))
      expect(outfits[o].coversFace).toBe(coversFace(c.gear, o))
      expect(outfits[o].clothes).toEqual(clothesFor(c.gear, o, c.look.clothes ?? []).map(k => k.name))
      expect(outfits[o].pieces.map(p => p.mesh)).toEqual(c.gear.filter(g => g.outfit === o).map(meshNameOf))
    }
    expect((m.hair as ManifestPiece[]).map(p => p.mesh)).toEqual(['Hair_braids', 'Hair_crop'])
    expect((m.beard as ManifestPiece[]).map(p => p.mesh)).toEqual(['Beard_full'])
    expect((m.clothes as Array<Record<string, unknown>>).map(k => [k.name, k.longSleeves])).toEqual([['plain', false], ['long', true]])
    expect(manifest(c, { folk: { hair: false } }).hair).toEqual([])
  })

  it('names a stance\'s clips by slot name', () => {
    const c = folk()
    c.folk!.stances.push({ id: 'shield', name: 'Shield', clips: { Idle: ['idle-s'] }, overlay: 'idle' })
    expect(manifest(c).stances).toEqual([{ id: 'shield', name: 'Shield', clips: { Idle: ['Idle_shield'] }, overlay: 'Idle' }])
  })

  it('marks only actually baked cuts and retains the exported bare skin path', () => {
    const c = folk()
    c.look.cloth = [{ id: 'shorts', name: 'Shorts', file: 'clothes/plain.png', slots: ['bottom'], cut: { drop: [1] } }]
    const m = folkManifestData(c, {}, {
      pieceOf, regionMask: () => 0, regions: {}, bodies: [], hairGreyMean: 0.62, femaleShape: 'female',
      files: { skins: { bran: { file: 'skins/bran.png', bare: 'skins/bran.bare.png' } }, layers: { shorts: { file: 'clothes/Shorts.png', baked: true } }, clothes: {} },
    })
    expect((m.layers as Array<Record<string, unknown>>)[0]).toMatchObject({ file: 'clothes/Shorts.png', cut: { drop: [1], baked: true } })
    expect((m.skins as Array<Record<string, unknown>>)[1]).toMatchObject({ bare: 'skins/bran.bare.png' })
  })
})
