import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { defaultPullWeights, holdFactor, pullBoneName, pullPosition, splitStrand, strandNear } from './pulls.ts'

// A bow: a limb (a box beside) and a string (a thin straight tube along z with vertices only at its ends).
function bow (): THREE.BufferGeometry {
  const limb = new THREE.BoxGeometry(0.02, 0.02, 0.6).translate(-0.1, 0, 0)
  const string = new THREE.CylinderGeometry(0.002, 0.002, 0.7, 6, 1).rotateX(Math.PI / 2)
  return mergeIndexed([limb, string])
}
function mergeIndexed (parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const pos: number[] = []; const uv: number[] = []; const index: number[] = []
  for (const g of parts) {
    const base = pos.length / 3
    pos.push(...(g.attributes.position.array as Float32Array)); uv.push(...(g.attributes.uv.array as Float32Array))
    index.push(...Array.from(g.index!.array as ArrayLike<number>, i => i + base))
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  out.setIndex(index)
  return out
}

describe('pull sockets', () => {
  it('finds the strand by a point and its long axis', () => {
    const s = strandNear(bow(), new THREE.Vector3(0, 0, 0))
    expect(Math.abs(s.axis.z)).toBeCloseTo(1, 3)
    expect(s.length).toBeCloseTo(0.7, 3)
  })

  it('splits a straight strand at the pull point, so it has a ring there to bend at, and leaves the rest', () => {
    const g = bow()
    const before = g.attributes.position.count
    const split = splitStrand(g, new THREE.Vector3(0, 0, 0.1))
    const pos = split.attributes.position
    let ring = 0
    for (let i = before; i < pos.count; i++) { expect(pos.getZ(i)).toBeCloseTo(0.1, 5); ring++ }
    expect(ring).toBeGreaterThanOrEqual(6)
    // every attribute came along, interpolated
    expect(split.attributes.uv.count).toBe(pos.count)
    // the limb's triangles are untouched; split again at the same place: nothing to do
    expect(splitStrand(split, new THREE.Vector3(0, 0, 0.1))).toBe(split)
  })

  it('leaves soft only the strand by the pull point; the rest rigid', () => {
    const split = splitStrand(bow(), new THREE.Vector3(0, 0, 0))
    const { indices, weights } = defaultPullWeights(split, [{ id: 'a', name: 'Draw', bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] }])
    const pos = split.attributes.position
    for (let i = 0; i < pos.count; i++) {
      expect(weights[i * 4]).toBe(1)
      const middle = Math.abs(pos.getZ(i)) < 0.01 && Math.abs(pos.getX(i)) < 0.01
      expect(indices[i * 4]).toBe(middle ? 1 : 0)
    }
  })

  it('is held inside its windows, eased in before, let go fast after', () => {
    const h: Array<[number, number]> = [[0.3, 0.45]]
    expect(holdFactor(h, 0.1)).toBe(0)
    expect(holdFactor(h, 0.4)).toBe(1)
    expect(holdFactor(h, 0.29)).toBeGreaterThan(0)
    expect(holdFactor(h, 0.29)).toBeLessThan(1)
    expect(holdFactor(h, 0.47)).toBe(0)
    expect(holdFactor(undefined, 0.4)).toBe(0)
  })

  it('sits at rest let go, at the grip held, and is named as the game allows', () => {
    const p = { id: 'a', name: 'Draw', bone: 'RightHand', grip: [0, 0, 0] as [number, number, number], rest: [0, 0, 0.1] as [number, number, number] }
    expect(pullPosition(p, 0, new THREE.Vector3(1, 1, 1)).toArray()).toEqual([0, 0, 0.1])
    expect(pullPosition(p, 1, new THREE.Vector3(1, 1, 1)).toArray()).toEqual([1, 1, 1])
    expect(pullBoneName('Weapons LeftHand', p)).toBe('Prop_Weapons_LeftHand_Draw')
  })
})
