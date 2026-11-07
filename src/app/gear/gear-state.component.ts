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

describe('cancel placement with IK lead keys', () => {
  it('rebases the current lead keys back with the origin in the same cancel batch', async () => {
    const { makeSlot } = await import('../../model/fixtures.ts')
    const { applyCommands } = await import('../../model/commands.ts')
    const { fitSnapshot } = await import('./fit.ts')
    const keys = [{ u: 0.5, q: [0, 0, 0, 1] as [number, number, number, number], p: [0, 0, 0] as [number, number, number] }]
    const moved = [{ ...keys[0], p: [1, 0, 0] as [number, number, number] }]
    const initial = makeCharacter({ gear: [piece()], clips: [makeSlot({ id: 'lead', ik: { hands: [], lead: ['coat'] }, gear: { coat: { keys } } })] })
    const edited = applyCommands(initial, [{ type: 'gear.origin', id: 'coat', origin: [1, 0, 0], lead: { lead: moved } }]).character
    gear.fitStart = fitSnapshot(initial.id, initial.gear[0])
    vi.spyOn(app, 'byId').mockReturnValue(edited)
    const leadKeys = vi.spyOn(gear as unknown as { leadKeys: (...args: unknown[]) => Promise<Record<string, typeof keys>> }, 'leadKeys').mockResolvedValue({ lead: keys })
    let restored = edited
    const send = vi.spyOn(app, 'do').mockImplementation(async (_id, commands) => {
      restored = applyCommands(edited, Array.isArray(commands) ? commands : [commands]).character
      return { seq: 1 } as never
    })
    await gear.cancelFit()
    expect(leadKeys).toHaveBeenCalledWith(edited, edited.gear[0], [-1, 0, 0])
    expect(restored.gear[0].origin ?? null).toBeNull()
    expect(restored.clips[0].gear?.coat.keys).toEqual(keys)
    leadKeys.mockRestore(); send.mockRestore(); vi.mocked(app.byId).mockRestore()
  })
})

describe('Wardrobe hover', () => {
  it('restores per-piece hides and shows after preview', async () => {
    const { dress } = await import('../../state/dress.svelte.ts')
    const { wardrobe } = await import('./wardrobe.svelte.ts')
    const c = makeCharacter({ id: 'hover-folk', gear: [
      makeGear({ id: 'a', outfit: 'set-a' }), makeGear({ id: 'hidden', outfit: 'set-a', hidden: true }),
      makeGear({ id: 'b', outfit: 'set-b', hidden: true }),
    ] })
    dress.reset(c)
    dress.setShown(c, 'a', false)
    dress.setShown(c, 'hidden', true)
    dress.toggleLock(c, 'hair')
    const before = structuredClone(dress.of(c.id))
    vi.useFakeTimers()
    wardrobe.preview(c, { outfit: 'set-b' }, 0)
    vi.advanceTimersByTime(0)
    expect(dress.worn(c).outfit).toBe('set-b')
    wardrobe.unpreview(c)
    expect(dress.of(c.id)).toMatchObject(before!)
    expect(dress.worn(c).outfit).toBe('set-a')
    expect(gear.shownOnStage(c, c.gear[0])).toBe(false)
    expect(gear.shownOnStage(c, c.gear[1])).toBe(true)
    vi.useRealTimers()
  })
})
