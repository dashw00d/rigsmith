import { describe, expect, it } from 'vitest'
import { BoxGeometry, Mesh, MeshBasicMaterial, Raycaster, Vector3 } from 'three'
import { pickGear } from './gearpick.ts'

const box = (z: number): Mesh => {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial())
  mesh.position.z = z
  mesh.updateMatrixWorld(true)
  return mesh
}

describe('gear viewport picking', () => {
  it('chooses the nearest shown piece across overlapping meshes', () => {
    const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1))
    expect(pickGear(ray, [
      { id: 'far', shown: true, meshes: [box(0)] },
      { id: 'near', shown: true, meshes: [box(2)] },
      { id: 'hidden', shown: false, meshes: [box(3)] },
    ])).toBe('near')
    expect(pickGear(new Raycaster(new Vector3(5, 5, 5), new Vector3(0, 0, -1)), [{ id: 'far', shown: true, meshes: [box(0)] }])).toBeNull()
  })
})

it('does not pick a piece behind the visible body, while a nearer piece remains pickable', () => {
  const ray = new Raycaster(new Vector3(0, 0, 5), new Vector3(0, 0, -1))
  const body = box(1)
  const far = { id: 'backpack', shown: true, meshes: [box(0)] }
  const near = { id: 'breastplate', shown: true, meshes: [box(2)] }
  expect(pickGear(ray, [far], [body])).toBeNull()
  expect(pickGear(ray, [far, near], [body])).toBe('breastplate')
  body.visible = false
  expect(pickGear(ray, [far], [body])).toBe('backpack')
})
