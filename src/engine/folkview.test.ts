import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { clothBody } from './folkview.ts'
import { limbGroups } from './clothcut.ts'

function mesh (material: string, x: number): THREE.SkinnedMesh {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([x, 0, 0, x, 1, 0, x + 0.1, 0, 0, x, 2, 0, x + 0.1, 2, 0, x, 3, 0], 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0], 2))
  geometry.setIndex([0, 1, 2])
  const body = new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ name: material }))
  body.userData.fullIndex = new THREE.Uint16BufferAttribute([0, 1, 2, 3, 4, 5], 1)
  return body
}

describe('cloth body', () => {
  it('uses full rest topology and the same region ids on every mesh', () => {
    const data = clothBody([mesh('Trousers', -2), mesh('Shirt', 2)])
    expect(Array.from(data.geometry.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    expect([...data.regions]).toEqual([0, 0, 0, 1, 1, 1, 2, 2, 2, 3, 3, 3])
    expect(limbGroups(data.list)).toEqual([{ name: 'left leg', regions: [0, 1] }, { name: 'right sleeve', regions: [2, 3] }])
  })
})

it('composes and cuts a Skin forearm adjoining a shirt without painting the face', async () => {
  const make = (name: string, positions: number[], uv: number[]): THREE.SkinnedMesh => {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geometry.setIndex([0, 1, 2])
    return new THREE.SkinnedMesh(geometry, new THREE.MeshBasicMaterial({ name }))
  }
  const shirt = make('Shirt', [1, 0.7, 0, 1.2, 0.7, 0, 1, 1, 0], [0, 0, 0.3, 0, 0, 1])
  const arm = make('Skin', [1, 0.7, 0, 1.2, 0.7, 0, 1.1, 0.4, 0], [0.35, 0, 0.65, 0, 0.5, 1])
  const face = make('Face', [0, 1, 0, 0.1, 1, 0, 0, 1.2, 0], [0.7, 0, 1, 0, 0.7, 1])
  const body = clothBody([shirt, arm, face])
  const armId = body.regions[3]
  expect(limbGroups(body.list).find(g => g.name === 'left sleeve')?.regions).toContain(armId)
  const { composeSlots } = await import('./clothcut.ts')
  const pixel = (v: number) => ({ width: 2, height: 1, rgba: new Uint8ClampedArray([v, v, v, 255, v, v, v, 255]) })
  const result = composeSlots({ base: pixel(20), bare: null, field: { width: 2, height: 1, region: Int16Array.from([armId, body.regions[6]]), y: Float32Array.from([0.5, 1]) }, regions: body.list, layers: [{ ...pixel(200), id: 'sleeve', slots: ['top'] }] })
  expect([result.rgba[0], result.rgba[4]]).toEqual([200, 20])
})
