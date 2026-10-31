import { expect, it } from 'vitest'
import * as THREE from 'three'
import { samePhysicalSurface } from './physical.ts'

it('accepts UV seam splits while rejecting changed geometry or painted weights', () => {
  const g = new THREE.PlaneGeometry(2, 2)
  const n = g.attributes.position.count
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4))
  const w = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) w[i * 4] = 1
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w, 4))
  const bone = new THREE.Bone(); bone.name = 'Hips'
  const skeleton = new THREE.Skeleton([bone])
  const a = new THREE.SkinnedMesh(g), b = new THREE.SkinnedMesh(g.toNonIndexed())
  a.bind(skeleton); b.bind(skeleton)
  b.geometry.attributes.uv.setXY(0, .3, .7)
  expect(samePhysicalSurface(a, b)).toBe(true)
  b.geometry.attributes.skinWeight.setX(0, .8)
  expect(samePhysicalSurface(a, b)).toBe(false)
  b.geometry.attributes.skinWeight.setX(0, 1)
  b.geometry.attributes.position.setX(0, 3)
  expect(samePhysicalSurface(a, b)).toBe(false)
})
