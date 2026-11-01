import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { WeightPainter } from './weightpaint.ts'

function strip (): THREE.SkinnedMesh {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1, 0, 0, 0, 0, 0, 1, 0, 0, -1, .5, 0, 0, .5, 0, 1, .5, 0], 3))
  g.setIndex([0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4])
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(24).fill(0), 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [1, 0, 0, 0]).flat(), 4))
  const hips = new THREE.Bone(); hips.name = 'Hips'
  const left = new THREE.Bone(); left.name = 'LeftArm'; left.position.x = 1; hips.add(left)
  const right = new THREE.Bone(); right.name = 'RightArm'; right.position.x = -1; hips.add(right)
  const mesh = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial())
  mesh.add(hips); mesh.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton([hips, left, right]))
  return mesh
}

const w = (p: WeightPainter, vertex: number, bone: number): number => p.weights(0, vertex).get(bone) ?? 0

describe('brush refinement regression cases', () => {
  it('uses strongest mirror coverage in one dab independently of point iteration order', () => {
    const run = (points: Array<[number, number]>): WeightPainter => {
      const p = new WeightPainter([strip()]); p.begin({ bounded: true })
      p.add(0, new Map(points), 1, .8); p.end(); return p
    }
    const weakFirst = run([[0, .2], [2, 1]])
    const strongFirst = run([[2, 1], [0, .2]])
    expect(w(weakFirst, 2, 1)).toBeCloseTo(.8)
    expect(w(weakFirst, 0, 2)).toBeCloseTo(.8)
    expect(weakFirst.edits().sort((a, b) => a.vertex - b.vertex)).toEqual(strongFirst.edits().sort((a, b) => a.vertex - b.vertex))
  })

  it('does not overwrite an asymmetric mirror twin at zero Add strength', () => {
    const mesh = strip(); mesh.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
    const before = { indices: Array.from(mesh.geometry.attributes.skinIndex.array), weights: Array.from(mesh.geometry.attributes.skinWeight.array) }
    const p = new WeightPainter([mesh]); p.begin({ bounded: true })
    p.add(0, new Map([[2, 1]]), 1, 0); p.end()
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(before.indices)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(before.weights)
    expect(p.editedCount).toBe(0)
    expect(p.stepBack()).toBe(false)
  })

  it('does not overwrite an asymmetric twin when Remove has no requested weight to remove', () => {
    const mesh = strip(); mesh.geometry.attributes.skinIndex.setXYZW(0, 1, 0, 0, 0)
    const before = { indices: Array.from(mesh.geometry.attributes.skinIndex.array), weights: Array.from(mesh.geometry.attributes.skinWeight.array) }
    const p = new WeightPainter([mesh]); p.begin({ bounded: true })
    p.remove(0, new Map([[2, 1]]), 1, .1); p.end()
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(before.indices)
    expect(Array.from(mesh.geometry.attributes.skinWeight.array)).toEqual(before.weights)
    expect(p.editedCount).toBe(0)
    expect(p.stepBack()).toBe(false)
  })

  it('applies a weak mirrored Add from each side\'s own source weights', () => {
    const mesh = strip(); mesh.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
    const p = new WeightPainter([mesh]); p.begin({ bounded: true })
    p.add(0, new Map([[2, 1]]), 1, .1); p.end()
    expect(w(p, 2, 1)).toBeCloseTo(.1)
    // This side already has full RightArm weight. Adding 10% RightArm must not erase 90% of it.
    expect(w(p, 0, 2)).toBeCloseTo(1)
  })

  it('blends mirrored Follow targets from each side\'s own authored source', () => {
    const mesh = strip(); mesh.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
    const before = Array.from(mesh.geometry.attributes.skinIndex.array)
    const p = new WeightPainter([mesh]); p.begin({ bounded: true })
    p.followUnder(0, new Map([[2, 1]]), .1); p.end()
    expect(w(p, 0, 2)).toBeGreaterThanOrEqual(.9 - 1e-6)
    expect(w(p, 2, 0)).toBeGreaterThanOrEqual(.9 - 1e-6)
    expect(p.stepBack()).toBe(true)
    expect(Array.from(mesh.geometry.attributes.skinIndex.array)).toEqual(before)
    expect(w(p, 0, 2)).toBe(1)
  })

  it('applies weak mirrored Remove, Smooth and Bone operations from each side\'s own source', () => {
    const removing = strip()
    removing.geometry.attributes.skinIndex.setXYZW(2, 1, 0, 0, 0)
    removing.geometry.attributes.skinWeight.setXYZW(2, .4, .6, 0, 0)
    removing.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
    removing.geometry.attributes.skinWeight.setXYZW(0, .8, .2, 0, 0)
    const remove = new WeightPainter([removing]); remove.begin({ bounded: true })
    remove.remove(0, new Map([[2, 1]]), 1, .1); remove.end()
    expect(w(remove, 2, 1)).toBeCloseTo(.36)
    expect(w(remove, 0, 2)).toBeCloseTo(.72)
    for (const tool of ['smooth', 'rigid'] as const) {
      const mesh = strip(); mesh.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
      const p = new WeightPainter([mesh]); p.begin({ bounded: true })
      p[tool](0, new Map([[2, 1]]), .1); p.end()
      expect(w(p, 2, 0)).toBeCloseTo(1)
      expect(w(p, 0, 2)).toBeCloseTo(.9)
      expect(w(p, 0, 0)).toBeCloseTo(.1)
    }
  })

  it('ignores nonpositive and nonfinite Strength without consuming coverage for a later dab', () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const p = new WeightPainter([strip()]); p.begin({ bounded: true })
      for (const tool of ['add', 'remove', 'smooth', 'rigid'] as const) {
        if (tool === 'add' || tool === 'remove') p[tool](0, new Map([[2, 1]]), 1, invalid)
        else p[tool](0, new Map([[2, 1]]), invalid)
      }
      expect(p.editedCount).toBe(0)
      expect(p.strokeBoneIndex).toBeNull()
      p.add(0, new Map([[2, 1]]), 1, .2)
      expect(w(p, 2, 1)).toBeCloseTo(.2)
      expect(w(p, 0, 2)).toBeCloseTo(.2)
    }
  })

  it('resolves overlapping twin dabs for every manual brush in bounded and iterative strokes', () => {
    for (const bounded of [false, true]) for (const tool of ['add', 'remove', 'smooth', 'rigid'] as const) {
      const run = (points: Array<[number, number]>): Array<{ vertex: number, weights: Array<[string, number]> }> => {
        const mesh = strip()
        mesh.geometry.attributes.skinIndex.setXYZW(0, 2, 0, 0, 0)
        mesh.geometry.attributes.skinWeight.setXYZW(0, .8, .2, 0, 0)
        mesh.geometry.attributes.skinIndex.setXYZW(2, 1, 0, 0, 0)
        mesh.geometry.attributes.skinWeight.setXYZW(2, .3, .7, 0, 0)
        const p = new WeightPainter([mesh]); p.begin({ bounded })
        if (tool === 'add' || tool === 'remove') p[tool](0, new Map(points), 1, .4)
        else p[tool](0, new Map(points), .4)
        p.end()
        return p.edits().sort((a, b) => a.vertex - b.vertex)
      }
      expect(run([[0, .2], [2, 1]])).toEqual(run([[2, 1], [0, .2]]))
      expect(run([[0, 1], [2, 1]])).toEqual(run([[2, 1], [0, 1]]))
    }
  })

  it('keeps raw tiny influences when the requested operation has no effect', () => {
    const mesh = strip(); const si = mesh.geometry.attributes.skinIndex; const sw = mesh.geometry.attributes.skinWeight
    for (const vertex of [0, 2]) {
      si.setXYZW(vertex, 0, 2, 0, 0); sw.setXYZW(vertex, .99997, .00003, 0, 0)
    }
    const before = { indices: Array.from(si.array), weights: Array.from(sw.array) }
    const p = new WeightPainter([mesh]); p.mirror = false; p.begin({ bounded: true })
    p.remove(0, new Map([[2, 1]]), 1, .5); p.end()
    expect(Array.from(si.array)).toEqual(before.indices)
    expect(Array.from(sw.array)).toEqual(before.weights)
    expect(p.stepBack()).toBe(false)
  })

  it('undo restores both independently painted mirror sources exactly', () => {
    const mesh = strip(); const si = mesh.geometry.attributes.skinIndex; const sw = mesh.geometry.attributes.skinWeight
    si.setXYZW(0, 2, 0, 2, 1); sw.setXYZW(0, .4, .00003, .59994, .00003)
    const before = { indices: Array.from(si.array), weights: Array.from(sw.array) }
    const p = new WeightPainter([mesh]); p.begin({ bounded: true })
    p.add(0, new Map([[2, 1]]), 1, .1); p.end()
    expect(p.stepBack()).toBe(true)
    expect(Array.from(si.array)).toEqual(before.indices)
    expect(Array.from(sw.array)).toEqual(before.weights)
    expect(p.editedCount).toBe(0)
  })
})
