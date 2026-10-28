import { describe, expect, it } from 'vitest'
import { applyEdits, partSpot, partWeights } from './garments.ts'
import * as THREE from 'three'

describe('accessory weights', () => {
  it('a part takes one set of weights for every vertex', () => {
    const { indices, weights } = partWeights(3, [[4, 0.75], [2, 0.25]])
    for (let v = 0; v < 3; v++) {
      expect([...indices.slice(v * 4, v * 4 + 2)]).toEqual([4, 2])
      expect(weights[v * 4]).toBeCloseTo(0.75)
      expect(weights[v * 4 + 1]).toBeCloseTo(0.25)
      expect(weights[v * 4 + 2]).toBe(0)
    }
  })

  it("a part's spot is its anchor, else the middle of its meshes", () => {
    const g = new THREE.BoxGeometry(2, 2, 2).translate(1, 5, 0)
    const mesh = new THREE.Mesh(g)
    expect(partSpot({}, [mesh]).toArray()).toEqual([1, 5, 0])
    expect(partSpot({ anchor: [0, 1, 2] }, [mesh]).toArray()).toEqual([0, 1, 2])
  })

  it('painted weights are laid over computed ones by mesh, vertex and bone name, normalized', () => {
    const indices = new Uint16Array(8); const weights = new Float32Array(8)
    weights[0] = 1; weights[4] = 1
    const n = applyEdits(indices, weights, [
      { mesh: 0, vertex: 1, weights: [['Spine', 2], ['Hips', 2]] },
      { mesh: 1, vertex: 0, weights: [['Spine', 1]] },   // another mesh: left alone
      { mesh: 0, vertex: 0, weights: [['Nope', 1]] },    // no such bone: left alone
    ], 0, ['Hips', 'Spine'])
    expect(n).toBe(1)
    expect(weights[0]).toBe(1)
    expect(indices[4]).toBe(1); expect(weights[4]).toBeCloseTo(0.5)
    expect(indices[5]).toBe(0); expect(weights[5]).toBeCloseTo(0.5)
  })
})
