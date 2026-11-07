import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { app } from '../../state/app.svelte.ts'
import { assets } from '../../state/assets.svelte.ts'
import { gear } from '../../state/gear.svelte.ts'
import { viewer } from '../../state/viewer.svelte.ts'
import { makeCharacter, makeGear } from '../../model/fixtures.ts'
import type { Stage } from '../../engine/Stage.ts'

const piece = () => makeGear({ id: 'coat', attach: { kind: 'skin', policy: 'body', place: { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 } } })

beforeEach(async () => {
  vi.spyOn(assets, 'load').mockResolvedValue(undefined)
  const c = makeCharacter({ gear: [piece()] })
  app.upsert(c)
  await app.select(c.id)
  await app.go('gear')
  gear.select('coat')
  gear.fit('coat')
  const camera = new THREE.PerspectiveCamera(50, 1, .1, 100)
  camera.position.z = 5
  camera.updateMatrixWorld(true)
  viewer.stage = { camera, renderer: { domElement: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }) } } } as unknown as Stage
  ;(gear as unknown as { rider: unknown }).rider = { id: c.id, rider: true, pieces: new Map(), view: { rest: null, meshes: [] } }
})

describe('fit selection', () => {
  it('keeps fitting and its cancel snapshot when the empty stage is clicked', () => {
    const start = gear.fitStart
    gear.pickAt({ clientX: 50, clientY: 50 })
    expect(gear.selected).toBe('coat')
    expect(gear.fitting).toBe('coat')
    expect(gear.fitStart).toBe(start)
  })
  it('rebinds the old fitted piece when a list selection ends fitting', () => {
    const sync = vi.spyOn(gear as unknown as { syncAll: () => void }, 'syncAll')
    gear.select(null)
    expect(gear.fitting).toBeNull()
    expect(sync).toHaveBeenCalledOnce()
  })
})

describe('placement Escape', () => {
  it('lets origin drag, picking, typing, and the open drawer consume Escape before cancelling the placement', async () => {
    const { mount, unmount, flushSync } = await import('svelte')
    const { default: GearPanel } = await import('../steps/GearPanel.svelte')
    const target = document.createElement('div')
    document.body.append(target)
    const panel = mount(GearPanel, { target, props: { character: app.selected! } })
    flushSync()
    const escape = (target: EventTarget = window): void => { target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) }
    gear.placingOrigin = 'coat'
    escape()
    expect(gear.fitting).toBe('coat')
    gear.placingOrigin = null
    gear.picking = { kind: 'spot', gear: 'coat' }
    escape()
    expect(gear.fitting).toBe('coat')
    gear.picking = null
    const input = target.querySelector('input[aria-label="Name"]')!
    escape(input)
    expect(gear.fitting).toBe('coat')
    app.drawer = 'wardrobe'
    escape()
    expect(gear.fitting).toBe('coat')
    app.drawer = null
    escape()
    expect(gear.fitting).toBeNull()
    await unmount(panel)
    target.remove()
  })
})

describe('showing a folk piece', () => {
  const folk = () => makeCharacter({ id: 'show-folk', gear: [
    makeGear({ id: 'a', outfit: 'set-a' }), makeGear({ id: 'b', outfit: 'set-b', hidden: true }),
    makeGear({ id: 'h1', role: 'hair' }), makeGear({ id: 'h2', role: 'hair', hidden: true }),
    makeGear({ id: 'd1', role: 'beard' }), makeGear({ id: 'd2', role: 'beard', hidden: true }),
    makeGear({ id: 'plain' }),
  ] })
  it.each(['h2', 'd2', 'b'])('shows the currently unworn %s', async id => {
    const { dress } = await import('../../state/dress.svelte.ts')
    const c = folk()
    dress.reset(c)
    const g = c.gear.find(x => x.id === id)!
    expect(gear.shownOnStage(c, g)).toBe(false)
    await gear.setShown(c, g, true)
    expect(gear.shownOnStage(c, g)).toBe(true)
  })
  it('ignores a stale folk hide after a piece leaves its set', async () => {
    const { dress } = await import('../../state/dress.svelte.ts')
    const c = folk()
    dress.reset(c)
    dress.setShown(c, 'plain', false)
    expect(gear.shownOnStage(c, c.gear.find(x => x.id === 'plain')!)).toBe(true)
  })
})

describe('hand pose picking', () => {
  it('does not select gear from a click while a hand pose is being edited', async () => {
    const { hands } = await import('../../state/hands.svelte.ts')
    gear.fit(null)
    hands.editing = { character: app.selectedId!, pose: 'hand' }
    gear.pickAt({ clientX: 50, clientY: 50 })
    expect(gear.selected).toBe('coat')
    hands.editing = null
    gear.pickAt({ clientX: 50, clientY: 50 })
    expect(gear.selected).toBeNull()
  })
})
