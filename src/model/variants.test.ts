// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { makeCharacter, makeSlot } from './fixtures.ts'
import { exportName, gameNameOf, nextVariantName, variantOf, variantsField, variantsOf, withVariants } from './variants.ts'

const GAME = ['Idle', 'Walk', 'Attack', 'Die']
const set = (...names: string[]): ReturnType<typeof makeCharacter> => makeCharacter({ clips: names.map((name, i) => makeSlot({ id: `s${i}`, name })) })

describe('variants', () => {
  it('knows a variant by its game clip and number, 2 on', () => {
    expect(variantOf('Attack 2', GAME)).toEqual({ base: 'Attack', n: 2 })
    expect(variantOf('Die 12', GAME)).toEqual({ base: 'Die', n: 12 })
    for (const n of ['Attack', 'Attack 1', 'Attack 01', 'Attack2', 'Lunge 2', 'Attack 2b']) expect(variantOf(n, GAME), n).toBeNull()
  })

  it('exports a variant as <clip>_<n>, and reads it back', () => {
    expect(exportName('Attack 3', GAME)).toBe('Attack_3')
    expect(exportName('Lunge 2', GAME)).toBe('Lunge 2')
    expect(gameNameOf('Attack_3', GAME)).toBe('Attack')
    expect(gameNameOf('Walk', GAME)).toBe('Walk')
  })

  it('lists each game clip followed by its variants, by number, and names the next one free', () => {
    const c = set('Idle', 'Attack 3', 'Attack', 'Trial', 'Attack 2', 'Die')
    expect(withVariants(c, GAME).map(s => s.name)).toEqual(['Idle', 'Attack', 'Attack 2', 'Attack 3', 'Die'])
    expect(variantsOf(c, 'Attack', GAME).map(s => s.name)).toEqual(['Attack 2', 'Attack 3'])
    expect(nextVariantName(c, 'Attack')).toBe('Attack 4')
    expect(nextVariantName(set('Attack', 'Attack 3'), 'Attack')).toBe('Attack 2')
  })

  it('gives the events file its variants field only when some clip has one', () => {
    expect(variantsField(set('Idle', 'Attack', 'Attack 2', 'Die', 'Die 2', 'Die 3'), GAME)).toEqual({ Attack: ['Attack', 'Attack_2'], Die: ['Die', 'Die_2', 'Die_3'] })
    expect(variantsField(set('Idle', 'Attack'), GAME)).toBeUndefined()
  })
})
