// @vitest-environment node
// The Ship step's checks (src/engine/checks.ts) on the contract tests' unit (./fixture.ts, the document alone): it passes
// as it is (./unit.test.ts exports it), and each rule the game holds a unit to fails where the unit breaks it.
import { BOW, BOW_NAME, BOW_PLACE, fixtureCharacter, fixtureSpec, UNIT } from './fixture.ts'
import { describe, expect, it } from 'vitest'
import { failing, gearBones, unitChecks, type Check } from '../../src/engine/checks.ts'
import { makeRigged } from '../../src/model/fixtures.ts'
import { hierarchyOf, slotByName } from '../../src/model/select.ts'
import type { Adjustment, Character, Gear, Mount } from '../../src/model/types.ts'
import type { UnitSpec } from '../../src/model/unit.ts'

const rule = (checks: Check[], r: string): Check[] => checks.filter(x => x.rule === r)
const check = (character: Character, spec: UnitSpec = fixtureSpec(), companion?: Character | null): Check[] =>
  unitChecks({ unit: UNIT, spec, character, companion })
const bow = (c: Character): Gear => c.gear.find(g => g.id === BOW)!

/** A game part keyed in Walk whose own bone would be named as the bow's string's (Prop_<name> = Prop_<bow>_String). */
function clashing (c: Character, keyed = true): Character {
  c.gear.push({
    id: 'c1a50001', name: `${BOW_NAME} String`, model: 'garments/c1a50001/model.glb', status: 'ready', from: `emberhold:${UNIT}/Quiver`,
    attach: { kind: 'bone', bone: 'Spine2', place: { position: [0, 1.5, -0.12], rotation: [0, 0, 0], scale: 1 } }, handles: [],
  })
  if (keyed) {
    const keys = slotByName(c, 'Walk')!.adjustments.find((a): a is Extract<Adjustment, { kind: 'keys' }> => a.kind === 'keys')!
    keys.gear = { ...keys.gear, c1a50001: [{ u: 0, q: [0, 0, 0, 1] }] }
  }
  return c
}

describe('the Ship checks on the contract unit', () => {
  it('pass it, naming the gear bones its export makes', () => {
    const c = fixtureCharacter()
    const checks = check(c)
    expect(failing(checks)).toEqual([])
    expect(checks.filter(x => x.status === 'warn')).toEqual([])
    expect(rule(checks, 'rigged')[0].status).toBe('pass')
    expect(rule(checks, 'clips')[0].text).toBe('Plays Idle, Walk, Run, Attack')
    expect(rule(checks, 'gear')).toEqual([{ rule: 'gear', status: 'pass', text: `1 piece of gear goes in: ${BOW_NAME}` }])
    expect(rule(checks, 'bone-names')).toEqual([{ rule: 'bone-names', status: 'pass', text: `Gear bones: Prop_${BOW_NAME}, Prop_${BOW_NAME}_String` }])
    expect(gearBones(c, fixtureSpec().clips).map(x => x.bone)).toEqual([`Prop_${BOW_NAME}`, `Prop_${BOW_NAME}_String`])
    // (over budget only before the export simplifies it)
    expect(rule(checks, 'budget')[0].status).toBe('info')
  })

  it('fail a Weapons_<bone> part that rides another bone, or none', () => {
    const c = fixtureCharacter()
    bow(c).attach = { kind: 'bone', bone: 'LeftHand', place: structuredClone(BOW_PLACE) }
    let checks = check(c)
    expect(failing(checks).map(x => x.rule)).toEqual(['weapons'])
    expect(rule(checks, 'weapons')[0].text).toBe(`${BOW_NAME} rides LeftHand: the game hangs it from RightHand`)

    bow(c).attach = { kind: 'skin', policy: 'body', place: structuredClone(BOW_PLACE) }
    checks = check(c)
    expect(failing(checks).map(x => x.rule)).toEqual(['weapons'])
    expect(rule(checks, 'weapons')[0].text).toBe(`${BOW_NAME} is not on a bone: the game hangs it from RightHand`)
  })

  it('fail two gear bones of one name, and only when a clip keys the piece that would make the second', () => {
    const checks = check(clashing(fixtureCharacter()))
    expect(failing(checks).map(x => x.rule)).toEqual(['bone-names'])
    expect(rule(checks, 'bone-names')[0].text).toContain(`Two bones would be named Prop_${BOW_NAME}_String`)
    // (unkeyed, it rides its bone with no bone of its own)
    const unkeyed = check(clashing(fixtureCharacter(), false))
    expect(failing(unkeyed)).toEqual([])
    expect(rule(unkeyed, 'bone-names')[0].status).toBe('pass')
  })

  it('fail a seat on another horse than the unit\'s companion, and a ridden unit without one', () => {
    const horse = makeRigged({ id: 'horse-0001', name: 'Horse', skeleton: { template: 'horse' } })
    const [, [seat]] = hierarchyOf(horse)
    const ridden: UnitSpec = { ...fixtureSpec(), companion: { character: horse.id, height: 2.6, prefix: 'Horse_', budget: 4000, material: 'horse', ridden: true } }
    const mount: Mount = { character: horse.id, bone: seat, position: [0, 0, 0], rotation: [0, 0, 0], freeze: ['Hips', 'LeftUpLeg', 'RightUpLeg'], pose: {} }
    const rider: Character = { ...fixtureCharacter(), mount }

    const seated = check(rider, ridden, horse)
    expect(failing(seated)).toEqual([])
    expect(rule(seated, 'mount')[0].status).toBe('pass')
    expect(rule(seated, 'companion')[0].text).toBe('Rides Horse, 2.6 tall')
    // (a rider's steps are his horse's: nothing to check on his clips' feet)
    expect(rule(seated, 'motion')).toEqual([])

    const elsewhere = check({ ...rider, mount: { ...mount, character: 'pony-0002' } }, ridden, horse)
    expect(failing(elsewhere).map(x => x.rule)).toEqual(['mount'])
    expect(rule(elsewhere, 'mount')[0].text).toBe(`Sits on pony-0002 here but the unit's companion is ${horse.id}: pick the same horse`)

    const unseated = check(fixtureCharacter(), ridden, horse)
    expect(failing(unseated).map(x => x.rule)).toEqual(['mount'])

    const gone = check({ ...rider, mount: { ...mount, bone: 'no_such_bone' } }, ridden, horse)
    expect(rule(gone, 'mount')[0]).toMatchObject({ status: 'fail', text: 'Sits on no_such_bone, which Horse has no longer' })

    // (the horse's own gear on his mount is said, not failed: it has never shipped)
    expect(rule(check({ ...rider, mount: { ...mount, gear: ['tack'] } }, ridden, horse), 'mount-gear')[0].status).toBe('info')
    // (seated here, on foot in the game)
    expect(rule(check(rider), 'mount')[0].status).toBe('info')
  })
})
