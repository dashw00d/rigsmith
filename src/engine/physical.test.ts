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

it('rejects a contact-source substitute that drops or changes cloth corrections', () => {
  const geometry = new THREE.PlaneGeometry(1, 1)
  geometry.morphTargetsRelative = true
  const target = new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(.05), 3)
  target.name = 'skirt_squat'; geometry.morphAttributes.position = [target]
  const bone = new THREE.Bone(); bone.name = 'Hips'; const skeleton = new THREE.Skeleton([bone])
  const a = new THREE.SkinnedMesh(geometry); const b = new THREE.SkinnedMesh(geometry.clone())
  a.bind(skeleton); b.bind(skeleton)
  expect(samePhysicalSurface(a, b)).toBe(true)
  b.geometry.morphAttributes = {}; b.updateMorphTargets()
  expect(samePhysicalSurface(a, b)).toBe(false)
  b.geometry = geometry.clone(); b.updateMorphTargets()
  b.geometry.morphAttributes.position![0].setZ(0, .2)
  expect(samePhysicalSurface(a, b)).toBe(false)
})

it('requires matching morph modes, channel identity and initial weights for the contact source', () => {
  const geometry = new THREE.PlaneGeometry(1, 1)
  geometry.morphTargetsRelative = true
  const target = new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position.count * 3).fill(.05), 3)
  target.name = 'skirt_squat'; geometry.morphAttributes.position = [target]
  const bone = new THREE.Bone(); bone.name = 'Hips'; const skeleton = new THREE.Skeleton([bone])
  const a = new THREE.SkinnedMesh(geometry); const b = new THREE.SkinnedMesh(geometry.clone())
  a.bind(skeleton); b.bind(skeleton)
  b.geometry.morphTargetsRelative = false
  expect(samePhysicalSurface(a, b)).toBe(false)
  b.geometry.morphTargetsRelative = true
  b.morphTargetDictionary = { other_target: 0 }
  expect(samePhysicalSurface(a, b)).toBe(false)
  b.updateMorphTargets(); b.morphTargetInfluences![0] = .5
  expect(samePhysicalSurface(a, b)).toBe(false)
  b.morphTargetInfluences![0] = 0
  expect(samePhysicalSurface(a, b)).toBe(true)
})
