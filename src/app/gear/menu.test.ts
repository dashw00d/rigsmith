import { describe, expect, it, vi } from 'vitest'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import { buildGearMenu, gearListMatches } from './menu.ts'

describe('gear list tools', () => {
  it('searches piece names, set names and tags without matching other pieces', () => {
    const c = makeCharacter({ gear: [makeGear({ id: 'g1', name: 'Coat', outfit: 'arm_norse', tags: ['heavy'] }), makeGear({ id: 'g2', name: 'Axe' })] })
    expect(gearListMatches(c, c.gear[0], 'norse')).toBe(true)
    expect(gearListMatches(c, c.gear[0], 'HEAVY')).toBe(true)
    expect(gearListMatches(c, c.gear[1], 'norse')).toBe(false)
  })
  it('builds a show action and an add-to-set submenu without duplicating membership', () => {
    const toggle = vi.fn()
    const add = vi.fn()
    const menu = buildGearMenu({ shown: false, renameable: true, sets: [{ id: 'a', name: 'A', contains: true }, { id: 'b', name: 'B', contains: false }],
      select: vi.fn(), toggle, rename: vi.fn(), addToSet: add, tag: vi.fn(), remove: vi.fn() })
    menu.find(i => i.label === 'Show')!.run()
    const children = menu.find(i => i.label === 'Add to set')!.children!
    expect(children[0].disabled).toBe(true)
    children[1].run()
    expect(toggle).toHaveBeenCalledOnce()
    expect(add).toHaveBeenCalledWith('b')
  })
})
