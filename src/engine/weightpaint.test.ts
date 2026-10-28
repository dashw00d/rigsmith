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

describe('mirrorName', () => {
  it('swaps a person\'s and a creature\'s side names, and leaves a middle bone', async () => {
    const { mirrorName } = await import('./weightpaint.ts')
    expect(mirrorName('front_leg_upper_l')).toBe('front_leg_upper_r')
    expect(mirrorName('LeftHand')).toBe('RightHand')
    expect(mirrorName('ear.L')).toBe('ear.R')
    expect(mirrorName('l_eye')).toBe('r_eye')
    expect(mirrorName('spine_01')).toBe('spine_01')
    expect(mirrorName('tail_lower')).toBe('tail_lower')
  })
})

describe('surface weight brushes', () => {
  it('removes the requested share from a rigid weight using the other neighbouring bones', () => {
    const painter = new WeightPainter([strip()]); painter.mirror = false
    painter.begin()
    painter.add(0, new Map([[1, 1], [3, 1]]), 1, .2)
    painter.remove(0, new Map([[0, 1]]), 0, .5)
    expect(weight(painter, 0, 0)).toBeCloseTo(.5)
    expect(weight(painter, 0, 1)).toBeCloseTo(.5)
    painter.stepBack()
    expect(weight(painter, 0, 0)).toBe(1)
  })

  it('stays on the picked surface when another sheet is close behind it', () => {
    const mesh = strip()
    const g = mesh.geometry
    const positions = Array.from(g.attributes.position.array)
    g.setAttribute('position', new THREE.Float32BufferAttribute([...positions, ...positions.map((x, i) => i % 3 === 2 ? .01 : x)], 3))
    g.setIndex([...Array.from(g.index!.array), ...Array.from(g.index!.array).map(i => i + 6)])
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(48).fill(0), 4))
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 12 }, () => [1, 0, 0, 0]).flat(), 4))
    const painter = new WeightPainter([mesh])
    const brush = painter.under(0, new THREE.Vector3(.1, .1, 0), 2, [1, 2, 4])
    expect(brush.size).toBeGreaterThan(2)
    expect([...brush.keys()].every(p => p < 6)).toBe(true)
  })

  it('does not average an entirely marked island with no good boundary to heal from', () => {
    const mesh = strip()
    const painter = new WeightPainter([mesh]); painter.mirror = false
    painter.begin(); painter.add(0, new Map([[2, 1]]), 1, 1)
    const before = Array.from(mesh.geometry.attributes.skinWeight.array)
    painter.mark(0, new Map(Array.from({ length: 6 }, (_, i) => [i, 1])))
    expect(painter.heal()).toBe(0)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(before)
  })
})
