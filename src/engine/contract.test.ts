import { describe, expect, it } from 'vitest'
import type { Gear } from '../model/types.ts'
import { budgetOf, budgetRatio, clipProblem, DEFAULT_LODS, gearExported, gearLeftOut, meshNameOf, SWAPPED } from './contract.ts'

const gear = (over: Partial<Gear> = {}): Gear => ({
  id: 'g1',
  name: 'Weapons_RightHand',
  model: 'garments/g1/model.glb',
  status: 'ready',
  attach: { kind: 'bone', bone: 'RightHand', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } },
  handles: [],
  from: 'emberhold:berserker/Weapons_RightHand',
  ...over,
})

describe('the game contract', () => {
  it('knows the swapped parts by name', () => {
    for (const name of ['GearAxe', 'HeadBald', 'WearApron']) expect(SWAPPED.test(name)).toBe(true)
    for (const name of ['Weapons_RightHand', 'Shield', 'gearbox']) expect(SWAPPED.test(name)).toBe(false)
    expect(DEFAULT_LODS).toEqual([0.45, 0.15])
  })

  it('names game gear by the part it came from', () => {
    expect(meshNameOf(gear({ name: 'Renamed' }))).toBe('Weapons_RightHand')
    expect(meshNameOf(gear({ from: 'catalog:sword.glb', name: 'Sword' }))).toBe('Sword')
    expect(meshNameOf(gear({ from: undefined, name: 'Pouch' }))).toBe('Pouch')
  })

  it('takes only ready gear the game built, hidden only when swapped', () => {
    expect(gearExported(gear())).toBe(true)
    expect(gearLeftOut(gear({ status: 'importing' }))).toBe('not ready')
    expect(gearLeftOut(gear({ model: undefined }))).toBe('not ready')
    expect(gearLeftOut(gear({ hidden: true }))).toBe('hidden')
    expect(gearLeftOut(gear({ hidden: true, name: 'GearHoe', from: 'emberhold:villager/GearHoe' }))).toBeNull()
    expect(gearLeftOut(gear({ from: undefined }))).toMatch(/not a part the game built/)
    // (catalog gear has no model of its own, and is still not the game's)
    expect(gearLeftOut(gear({ model: undefined, catalog: 'sword.glb', from: 'catalog:sword.glb' }))).toMatch(/not a part the game built/)
  })

  it('leaves the body what its gear does not take, swapped parts free', () => {
    expect(budgetOf(8000, [{ name: 'Weapons_RightHand', triangles: 500 }, { name: 'GearHoe', triangles: 900 }, { name: 'HeadHood', triangles: 300 }])).toBe(7500)
    expect(budgetRatio(4000, 8000)).toBe(1)
    expect(budgetRatio(10000, 7500)).toBeCloseTo(0.7425, 6)
  })

  it('refuses a walk that does not step and an idle that sits', () => {
    expect(clipProblem('Walk', { footSwing: 0.05, hipsMedian: 0.5 }, 0.5)).toMatch(/doesn't walk/)
    expect(clipProblem('Walk', { footSwing: 0.2, hipsMedian: 0.2 }, 0.5)).toBeNull()
    expect(clipProblem('Idle', { footSwing: 0, hipsMedian: 0.3 }, 0.5)).toMatch(/not standing/)
    expect(clipProblem('Idle', { footSwing: 0, hipsMedian: 0.45 }, 0.5)).toBeNull()
    expect(clipProblem('Attack', { footSwing: 0, hipsMedian: 0.1 }, 0.5)).toBeNull()
  })
})
