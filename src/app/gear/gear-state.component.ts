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
