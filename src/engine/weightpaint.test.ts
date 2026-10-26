import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

// A strip across the body: a left point, a middle one, a right one (and a second row, so it has triangles), skinned to
// Hips, LeftArm and RightArm.
function strip (): THREE.SkinnedMesh {
  const xs = [-1, 0, 1]
  const position: number[] = []
  for (const y of [0, 0.5]) for (const x of xs) position.push(x, y, 0)
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3))
  g.setIndex([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4])
  // every point all Hips to begin with
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 6 }, () => [0, 0, 0, 0]).flat(), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.set(1, 0, 0); hips.add(left)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.set(-1, 0, 0); hips.add(right)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  mesh.add(hips)
  mesh.updateMatrixWorld(true)
  mesh.bind(new THREE.Skeleton([hips, left, right]))
  return mesh
}

const weight = (p: WeightPainter, v: number, bone: number): number => p.weights(0, v).get(bone) ?? 0

describe('mirrored weight painting', () => {
  it('a stroke on one side lands on the other, the bone swapped', () => {
    const p = new WeightPainter([strip()])
    p.begin()
    p.add(0, new Map([[2, 1]]), 1, 0.5)   // the body's left point (+x) takes LeftArm
    expect(weight(p, 2, 1)).toBeCloseTo(0.5)
    expect(weight(p, 0, 2)).toBeCloseTo(0.5)   // its twin (-x) takes RightArm
    expect(weight(p, 0, 1)).toBe(0)
  })

  it('a middle point is evened between its sides', () => {
    const p = new WeightPainter([strip()])
    p.begin()
    p.add(0, new Map([[1, 1]]), 1, 0.5)
    expect(weight(p, 1, 1)).toBeCloseTo(weight(p, 1, 2))
  })

  it('without mirror only the brushed side changes; copying a side makes them match', () => {
    const p = new WeightPainter([strip()])
    p.mirror = false
    p.begin()
    p.add(0, new Map([[2, 1]]), 1, 0.5)
    expect(weight(p, 0, 2)).toBe(0)
    p.copySide(1)
    expect(weight(p, 0, 2)).toBeCloseTo(0.5)
    expect(p.stepBack()).toBe(true)
    expect(weight(p, 0, 2)).toBe(0)
  })
})
