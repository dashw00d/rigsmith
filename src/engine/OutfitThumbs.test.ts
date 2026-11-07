import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { makeGear } from '../model/fixtures.ts'

const calls = vi.hoisted(() => ({ wear: vi.fn(), takeOff: vi.fn(), dispose: vi.fn() }))
vi.mock('./CharacterView.ts', () => ({ CharacterView: { load: async () => ({
  bodySkinned: [], meshes: [], root: new THREE.Group(), height: 1,
  box: new THREE.Box3(new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 1, 0)), dispose: calls.dispose,
}) } }))
vi.mock('./garments.ts', () => ({ wear: calls.wear, takeOff: calls.takeOff }))
vi.mock('./folkview.ts', () => ({ showSkin: vi.fn(async () => {}), showDressed: vi.fn(async () => {}), shapeFemale: vi.fn(), tint: vi.fn() }))
vi.mock('./lighting.ts', () => ({ light: vi.fn() }))
vi.mock('./offscreen.ts', () => ({
  offscreen: async (_w: number, _h: number, draw: (renderer: { render: () => void }) => unknown) => draw({ render: () => {} }),
  grab: () => ({}), encode: async () => new Blob(['tile']),
}))

describe('contact sheet rendering', () => {
  it('keeps the same fitted pieces across sequential skins and releases them on dispose', async () => {
    calls.wear.mockReset().mockResolvedValue({ gear: 'g', meshes: [] })
    calls.takeOff.mockReset(); calls.dispose.mockReset()
    const { OutfitThumbs } = await import('./OutfitThumbs.ts')
    const renderer = new OutfitThumbs()
    const gear = makeGear({ id: 'g' })
    const spec = { body: '/body.glb', pieces: [{ gear, url: '/gear.glb', place: gear.attach.place }], framing: 'body' as const }
    await renderer.render({ ...spec, skin: '/one.png' }, true)
    await renderer.render({ ...spec, skin: '/two.png' }, true)
    expect(calls.wear).toHaveBeenCalledTimes(1)
    expect(calls.takeOff).not.toHaveBeenCalled()
    renderer.dispose()
    expect(calls.takeOff).toHaveBeenCalledTimes(1)
  })
})
