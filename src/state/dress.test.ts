import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeCharacter } from '../model/fixtures.ts'

vi.mock('./app.svelte.ts', () => ({ app: {} }))
vi.mock('./assets.svelte.ts', () => ({ asset: () => null }))
vi.mock('../engine/garments.ts', () => ({ preloadModel: vi.fn() }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('localStorage', { length: 0, key: () => null, getItem: () => null, setItem: () => {}, removeItem: () => {} })
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('dress view state', () => {
  it('keeps multi-slot layers coherent and restores all preview overrides', async () => {
    const { dress } = await import('./dress.svelte.ts')
    const c = makeCharacter({ id: 'restore-test', look: { cloth: [
      { id: 'both', name: 'Both', file: 'both.png', slots: ['bottom', 'top'] },
      { id: 'top', name: 'Top', file: 'top.png', slots: ['top'] },
    ] } })
    const snapshot = { layers: { bottom: 'both', top: 'both' }, bare: true, locks: ['skin' as const], off: ['hide'], on: ['show'] }
    dress.restore(c, snapshot)
    expect(dress.of(c.id)).toEqual(snapshot)
    dress.setLayer(c, 'top', 'top')
    expect(dress.worn(c).layers).toEqual({ top: 'top' })
    dress.restore(c, snapshot)
    expect(dress.of(c.id)).toEqual(snapshot)
    dress.restore(c, undefined)
    expect(dress.of(c.id)).toBeUndefined()
  })
})
