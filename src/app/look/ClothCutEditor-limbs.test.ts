import { expect, it } from 'vitest'
import * as THREE from 'three'
import { clothBody } from '../../engine/folkview.ts'
import { cutLimbGroups, duplicateCut } from './clothdraft.ts'

it('labels the character left at +X and excludes an asymmetric torso from sleeve cuts', () => {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.10, 0.4, 0, 0.20, 0.4, 0, 0.15, 0.8, 0,
    0.20, 0.6, 0, 0.40, 0.6, 0, 0.30, 0.9, 0,
    -0.40, 0.6, 0, -0.20, 0.6, 0, -0.30, 0.9, 0,
    0, 0, 0, 0, 1, 0, 0.01, 0, 0,
  ], 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(new Array(24).fill(0), 2))
  geometry.setIndex([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  const material = new THREE.MeshBasicMaterial(); material.name = 'Shirt'
  const body = clothBody([new THREE.SkinnedMesh(geometry, material)])
  const torso = body.list.find(r => r.x > 0 && r.x < 0.1)!
  const left = body.list.find(r => r.x > 0.2)!
  const right = body.list.find(r => r.x < -0.2)!
  const groups = cutLimbGroups(body.list)
  expect(groups).toEqual([{ name: 'left sleeve', regions: [left.id] }, { name: 'right sleeve', regions: [right.id] }])
  const copy = duplicateCut({ id: 'shirt', name: 'Shirt', file: 'shirt.png', slots: ['top'] }, 'short', 'sleeves', body.list)
  expect(copy.cut?.below?.flatMap(rule => rule.regions)).not.toContain(torso.id)
  expect(copy.cut?.below?.flatMap(rule => rule.regions)).toEqual([left.id, right.id])
})
