import { describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { makeGear } from '../model/fixtures.ts'

const calls = vi.hoisted(() => ({ wear: vi.fn(), takeOff: vi.fn(), dispose: vi.fn(), shapeFemale: vi.fn() }))
vi.mock('./CharacterView.ts', () => ({ CharacterView: { load: async () => ({
  bodySkinned: [], meshes: [], root: new THREE.Group(), height: 1,
  box: new THREE.Box3(new THREE.Vector3(-0.5, 0, 0), new THREE.Vector3(0.5, 1, 0)), dispose: calls.dispose,
}) } }))
vi.mock('./garments.ts', () => ({ wear: calls.wear, takeOff: calls.takeOff }))
vi.mock('./folkview.ts', () => ({ showSkin: vi.fn(async () => {}), showDressed: vi.fn(async () => {}), shapeFemale: calls.shapeFemale, tint: vi.fn() }))
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


it('shapes the body but not held or unbound fitting meshes', async () => {
  const { OutfitThumbs } = await import('./OutfitThumbs.ts')
  const weapon = makeGear({ id: 'weapon' })
  const coat = makeGear({ id: 'coat', attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })
  const held = new THREE.Mesh(); const unbound = new THREE.Mesh()
  calls.wear.mockReset().mockResolvedValueOnce({ gear: 'weapon', node: new THREE.Group(), meshes: [held] })
    .mockResolvedValueOnce({ gear: 'coat', node: new THREE.Group(), meshes: [unbound] })
  calls.shapeFemale.mockReset()
  const renderer = new OutfitThumbs()
  await renderer.render({ body: '/body.glb', pieces: [weapon, coat].map(gear => ({ gear, url: `/${gear.id}.glb`, place: gear.attach.place })), female: true, framing: 'body' })
  expect(calls.shapeFemale).toHaveBeenCalledWith([], [], true, 1)
  renderer.dispose()
})
