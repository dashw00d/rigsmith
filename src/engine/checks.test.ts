import { describe, expect, it } from 'vitest'
import { makeCharacter, makeGear, makeRigged, makeSlot } from '../model/fixtures.ts'
import type { Character, Gear } from '../model/types.ts'
import type { UnitSpec } from '../model/unit.ts'
import { failing, gearBones, keyedGear, leftOut, unitChecks, type Check } from './checks.ts'

const spec = (over: Partial<UnitSpec> = {}): UnitSpec => ({ character: 'tester-000001', height: 2, budget: 8000, clips: ['Idle'], ...over })

const gameGear = (over: Partial<Gear> = {}): Gear => makeGear({
  id: 'w1', name: 'Weapons_RightHand', model: 'garments/w1/model.glb', from: 'emberhold:knight/Weapons_RightHand',
  attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } }, ...over,
})

const rule = (checks: Check[], r: string): Check[] => checks.filter(x => x.rule === r)

describe('the Ship checks', () => {
  it('pass a rigged unit whose clips are slots', () => {
    const c = makeRigged({ clips: [makeSlot()] })
    const checks = unitChecks({ unit: 'tester', spec: spec(), character: c })
    expect(failing(checks)).toEqual([])
    expect(rule(checks, 'clips')[0].status).toBe('pass')
    expect(rule(checks, 'lods')[0].text).toContain('tester_LOD1 at 45 %')
  })

  it('fail a character that is gone, not rigged, or plays a clip it has no slot for', () => {
    expect(unitChecks({ unit: 'x', spec: spec(), character: null }).map(x => x.status)).toEqual(['fail'])
    const raw = makeCharacter({ clips: [makeSlot()] })
    expect(rule(unitChecks({ unit: 'x', spec: spec(), character: raw }), 'rigged')[0].status).toBe('fail')
    const c = makeRigged({ clips: [makeSlot()] })
    const clips = rule(unitChecks({ unit: 'x', spec: spec({ clips: ['Idle', 'Walk', 'Walk'] }), character: c }), 'clips')
    expect(clips.every(x => x.status === 'fail')).toBe(true)
    expect(clips.map(x => x.text).join(' ')).toContain('No slot named Walk')
    expect(clips.map(x => x.text).join(' ')).toContain('Listed twice: Walk')
  })

  it('fail bad sizes and levels', () => {
    const c = makeRigged({ clips: [makeSlot()] })
    const checks = unitChecks({ unit: 'x', spec: spec({ height: 0, budget: -1, lods: [0.2, 0.4] }), character: c })
    expect(failing(checks).map(x => x.rule).sort()).toEqual(['budget', 'height', 'lods'])
  })

  it('warns of an attack without blow timing', () => {
    const c = makeRigged({ clips: [makeSlot({ id: 'a', name: 'Attack', loop: false })] })
    expect(rule(unitChecks({ unit: 'x', spec: spec({ clips: ['Attack'] }), character: c }), 'blow')[0].status).toBe('warn')
    c.clips[0].time = { fit: { enabled: true, at: 0.45 } }
    expect(rule(unitChecks({ unit: 'x', spec: spec({ clips: ['Attack'] }), character: c }), 'blow')).toEqual([])
  })

  it('says which gear stays out and why', () => {
    const catalog = makeGear({ id: 'c1', name: 'Sword', catalog: 'sword.glb', from: 'catalog:sword.glb' })
    const legacy = gameGear({ id: 'l1', name: 'Weapons_LeftHand', from: 'emberhold:knight/Weapons_LeftHand', attach: { kind: 'bone', bone: 'LeftHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 }, legacyFrame: 'grip' } })
    const hidden = gameGear({ id: 'h1', name: 'Shield', from: 'emberhold:knight/Shield', hidden: true })
    expect(leftOut(catalog)).toContain('not a part the game built')
    expect(leftOut(legacy)).toContain('old catalog frame')
    expect(leftOut(hidden)).toBe('hidden')
    const c = makeRigged({ clips: [makeSlot()], gear: [catalog, legacy, hidden, gameGear()] })
    const gear = rule(unitChecks({ unit: 'x', spec: spec(), character: c }), 'gear')
    expect(gear.filter(x => x.status === 'warn').map(x => x.text)).toEqual([
      expect.stringContaining('Sword is left out'), expect.stringContaining('Weapons_LeftHand is left out'),
    ])
    expect(gear.find(x => x.status === 'pass')?.text).toContain('Weapons_RightHand')
  })

  it("holds game gear to the game's names: its part's name, Weapons_<bone> on that bone", () => {
    const c = makeRigged({
      clips: [makeSlot()],
      gear: [gameGear({ name: 'Sword' }), gameGear({ id: 'w2', name: 'Weapons_LeftHand', from: 'emberhold:knight/Weapons_LeftHand' })],
    })
    const checks = unitChecks({ unit: 'x', spec: spec(), character: c })
    expect(rule(checks, 'gear-name')[0].text).toBe('Sword goes in as Weapons_RightHand, the game\'s name for it')
    expect(rule(checks, 'weapons')[0].text).toContain('Weapons_LeftHand rides RightHand: the game hangs it from LeftHand')
    expect(rule(checks, 'mesh-names')).toEqual([])
    const twice = makeRigged({ clips: [makeSlot()], gear: [gameGear(), gameGear({ id: 'w3', name: 'Spare' })] })
    expect(rule(unitChecks({ unit: 'x', spec: spec(), character: twice }), 'mesh-names')[0].text).toBe('Weapons_RightHand, Spare would all be meshes named Weapons_RightHand: rename one')
  })

  it('names the gear bones a unit gets and fails when two would clash', () => {
    const bow = gameGear({
      id: 'bow', name: 'Bow', from: 'emberhold:archer/Bow',
      handles: [{ id: 'p1', name: 'Draw', kind: 'pull', hand: 'Right', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] } }],
    })
    const keys = [{ u: 0, q: [0, 0, 0, 1] as [number, number, number, number] }]
    const c = makeRigged({ clips: [makeSlot({ gear: { bow: { keys } } })], gear: [bow] })
    expect([...keyedGear(c, ['Idle'])]).toEqual(['bow'])
    expect(gearBones(c, ['Idle']).map(x => x.bone)).toEqual(['Prop_Bow', 'Prop_Bow_Draw'])
    expect(rule(unitChecks({ unit: 'x', spec: spec(), character: c }), 'bone-names')[0].status).toBe('pass')
    // (a piece named so its keyed bone is another's pull bone)
    const clash = gameGear({ id: 'b2', name: 'Bow Draw', from: 'emberhold:archer/Bow Draw' })
    const both = makeRigged({ clips: [makeSlot({ gear: { bow: { keys }, b2: { keys } } })], gear: [bow, clash] })
    // (a muted piece's keys don't play: it gets no bone of its own)
    expect([...keyedGear(makeRigged({ clips: [makeSlot({ gear: { bow: { keys } }, muted: ['gear:bow'] })], gear: [bow] }), ['Idle'])]).toEqual([])
    expect(rule(unitChecks({ unit: 'x', spec: spec(), character: both }), 'bone-names')[0].text).toContain('Two bones would be named Prop_Bow_Draw')
  })

  it("checks a rider's seat against the unit's companion", () => {
    const horse = makeRigged({ id: 'horse-1', name: 'Horse', skeleton: { template: 'horse' } })
    const bone = Object.keys(horse.skin.rigJoints!)[1]
    const ridden = spec({ companion: { character: 'horse-1', height: 2.3, prefix: 'Horse_', budget: 7000, material: 'horse', ridden: true } })
    const onFoot = makeRigged({ clips: [makeSlot()] })
    expect(rule(unitChecks({ unit: 'x', spec: ridden, character: onFoot, companion: horse }), 'mount')[0].status).toBe('fail')
    const rider: Character = { ...onFoot, mount: { character: 'horse-1', bone, position: [0, 0, 0], rotation: [0, 0, 0], freeze: ['Hips'], pose: {}, gear: ['tack'] } }
    const checks = unitChecks({ unit: 'x', spec: ridden, character: rider, companion: horse })
    expect(failing(checks)).toEqual([])
    expect(rule(checks, 'companion')[0].text).toBe('Rides Horse, 2.3 tall')
    expect(rule(checks, 'mount-gear')[0].status).toBe('info')
    expect(rule(checks, 'motion')).toEqual([])
    const other = { ...rider, mount: { ...rider.mount!, character: 'pony-2' } }
    expect(rule(unitChecks({ unit: 'x', spec: ridden, character: other, companion: horse }), 'mount')[0].text).toContain('pick the same horse')
    expect(rule(unitChecks({ unit: 'x', spec: spec(), character: rider }), 'mount')[0].status).toBe('info')
    expect(rule(unitChecks({ unit: 'x', spec: ridden, character: rider, companion: null }), 'companion')[0].status).toBe('fail')
  })
})

it('warns when a cut layer can meet a skin without a bare image and clears the warning when provided', () => {
  const c = makeRigged({ clips: [makeSlot()], look: { skins: [{ name: 'A', file: 'skins/a.png' }, { name: 'B', file: 'skins/b.png', bare: 'skins/b-bare.png' }],
    cloth: [{ id: 'shorts', name: 'Shorts', file: 'clothes/shorts.png', slots: ['bottom'], cut: { drop: [1] } }] } })
  const checks = () => rule(unitChecks({ unit: 'x', spec: spec(), character: c }), 'cut-bare')
  expect(checks()).toEqual([{ rule: 'cut-bare', status: 'warn', text: 'Shorts has a cut but skin A has no bare version' }])
  c.look.skins![0].bare = 'skins/a-bare.png'
  expect(checks()).toEqual([])
  delete c.look.cloth![0].cut; delete c.look.skins![0].bare
  expect(checks()).toEqual([])
})
