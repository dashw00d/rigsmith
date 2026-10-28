import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Handle } from '../model/types.ts'
import {
  clearPulls, defaultPullWeights, findHolds, holdFactor, pullBoneName, pullPosition, pullWeightKeys, pullWeightName, registerPulls,
  splitStrand, strandMiddle, strandNear, strandSegment, tickPulls,
} from './pulls.ts'

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
    // (its middle: the string's, not the limb's beside it)
    expect(s.center.length()).toBeLessThan(0.002)
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
    const { indices, weights } = defaultPullWeights(split, [{ rest: [0, 0, 0] }])
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

describe('pull handles', () => {
  const draw: Handle = { id: 'h1', name: 'Draw', kind: 'pull', pull: { bone: 'RightHand', grip: [0, 0, 0], rest: [0, 0, 0] } }

  it('keys painted weights by handle id, and reads ones painted under the bone names', () => {
    const keys = pullWeightKeys('Bow', [{ id: 'carry', name: 'Carried', kind: 'carry' }, draw])
    expect(pullWeightName(draw)).toBe('pull:h1')
    expect(keys.get('PropRoot')).toBe('PropRoot')
    expect(keys.get('pull:h1')).toBe('pull:h1')
    expect(keys.get('Prop_Bow_Draw')).toBe('pull:h1')
    expect(keys.has('pull:carry')).toBe(false)
  })

  it('finds the bowstring among a bow\'s meshes, and its ends', () => {
    const limb = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.02, 0.6).translate(-0.1, 0, 0))
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.002, 0.002, 0.7, 6, 1).rotateX(Math.PI / 2))
    string.position.set(0.05, 0, 0)
    string.updateMatrix()
    const middle = strandMiddle([limb, string])!
    expect(middle.x).toBeCloseTo(0.05, 3)
    expect(Math.abs(middle.z)).toBeLessThan(0.01)
    const line = strandSegment([limb, string], [0.05, 0, 0.1])!
    expect(line.distance()).toBeCloseTo(0.7, 2)
    expect(line.start.x).toBeCloseTo(0.05, 3)
    expect(strandMiddle([])).toBeNull()
  })

  it('draws a pull to the hand only while the playing slot holds it, by gear and handle id', () => {
    const owner = {}
    const root = new THREE.Object3D()
    const bone = new THREE.Object3D()
    root.add(bone)
    const hand = new THREE.Object3D()
    hand.position.set(0, 0, -0.5)
    hand.updateMatrixWorld(true)
    registerPulls(owner, [{ gear: 'g1', handle: 'h1', grip: [0, 0, 0], rest: [0, 0, 0.1], root, bone, hand }])
    tickPulls(null, 0.5)
    expect(bone.position.toArray()).toEqual([0, 0, 0.1])
    tickPulls([{ gear: 'g1', handle: 'h1', bone: 'RightHand', windows: [[0.2, 0.8]] }], 0.5)
    expect(bone.position.z).toBeCloseTo(-0.5, 5)
    // another piece's plan leaves it at rest
    tickPulls([{ gear: 'g2', handle: 'h1', bone: 'RightHand', windows: [[0, 1]] }], 0.5)
    expect(bone.position.z).toBeCloseTo(0.1, 5)
    clearPulls(owner, 'g1')
    tickPulls([{ gear: 'g1', handle: 'h1', bone: 'RightHand', windows: [[0, 1]] }], 0.5)
    expect(bone.position.z).toBeCloseTo(0.1, 5)
  })

  it('finds when a slot holds a pull: from the hand reaching the string to the release, or a full draw', () => {
    // a string along x from -0.35 to 0.35 at the piece's origin; the hand comes in, nocks at u 0.25, draws back in z
    const node = new THREE.Object3D()
    const hand = new THREE.Object3D()
    const strand = new THREE.Line3(new THREE.Vector3(-0.35, 0, 0), new THREE.Vector3(0.35, 0, 0))
    const path = (u: number): number => (u < 0.25 ? 1 - u * 4 : u <= 0.6 ? -(u - 0.25) : 1)
    const seek = (u: number): void => { hand.position.set(0.1, 0, path(u)); hand.updateMatrixWorld(true) }
    const probe = { seek, hand, grip: [0, 0, 0] as [number, number, number], node, strand, reach: 0.05, samples: 100 }
    const found = findHolds(probe)
    expect(found).toHaveLength(1)
    expect(found[0][0]).toBeCloseTo(0.24, 2)
    expect(found[0][1]).toBeCloseTo(0.6, 2)
    // its release (a blow) ends it
    expect(findHolds({ ...probe, release: 0.45 })[0][1]).toBeCloseTo(0.45, 2)
    // never reached
    expect(findHolds({ ...probe, seek: (u: number) => { hand.position.set(0, 2, u); hand.updateMatrixWorld(true) } })).toEqual([])
  })
})
