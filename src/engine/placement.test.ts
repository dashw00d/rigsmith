import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Placement } from '../model/types.ts'
import { smallestAxis } from './geom.ts'
import { counterpart, mirroredPlacement, nearerMirror, placementFromMatrix, placementMatrix, placementOf } from './placement.ts'

const close = (a: THREE.Matrix4, b: THREE.Matrix4, digits = 3): void => {
  a.elements.forEach((v, i) => expect(v).toBeCloseTo(b.elements[i], digits))
}

// An axe head: a flat blade (thin along z) on a handle along y, all in the model's own space.
function axe (): THREE.Vector3[] {
  const out: THREE.Vector3[] = []
  for (let y = 0; y <= 10; y++) out.push(new THREE.Vector3(0, y * 0.06, 0), new THREE.Vector3(0.01, y * 0.06, 0.005))
  for (let x = 0; x <= 6; x++) for (let y = 0; y <= 4; y++) out.push(new THREE.Vector3(0.02 + x * 0.02, 0.5 + y * 0.02, (x + y) % 2 === 0 ? 0.004 : -0.004))
  return out
}

describe('placement', () => {
  it('reads back the placement a matrix was made from', () => {
    const place: Placement = { position: [0.1, 1.25, -0.05], rotation: [-30, 45, 10], scale: 1.2 }
    const back = placementFromMatrix(placementMatrix(place))
    expect(back.position).toEqual(place.position)
    expect(back.scale).toBeCloseTo(1.2, 4)
    close(placementMatrix(back), placementMatrix(place))
  })

  it('keeps what a node holds, rounded, -0 as 0', () => {
    const node = new THREE.Object3D()
    node.position.set(0.123456, -0.00001, 2)
    node.scale.setScalar(0.5)
    const p = placementOf(node)
    expect(p.position).toEqual([0.1235, 0, 2])
    expect(Object.is(p.position[1], -0)).toBe(false)
    expect(p.rotation).toEqual([0, 0, 0])
    expect(p.scale).toBe(0.5)
  })

  it('pairs a bone with the other side\'s', () => {
    expect(counterpart('LeftHand')).toBe('RightHand')
    expect(counterpart('RightForeArm')).toBe('LeftForeArm')
    expect(counterpart('Spine2')).toBeNull()
  })

  it('tells a piece sitting by the other side', () => {
    const rightHand = new THREE.Vector3(-0.7, 1.4, 0)
    expect(nearerMirror([0.68, 1.4, 0.05], rightHand)).toBe(true)
    expect(nearerMirror([-0.68, 1.4, 0.05], rightHand)).toBe(false)
  })

  it('finds the direction a flat thing is thinnest in (the plane it is turned over)', () => {
    const pts = axe()
    const c = pts.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(pts.length)
    expect(Math.abs(smallestAxis(pts, c).z)).toBeGreaterThan(0.95)
    expect(Math.abs(smallestAxis(pts).z)).toBeGreaterThan(0.95)
  })

  it('carries a piece across the body held the same way, turned not flipped', () => {
    const pts = axe()
    const place: Placement = { position: [0.7, 1.4, 0.05], rotation: [0, 0, -90], scale: 1 }
    const next = mirroredPlacement(place, pts)!
    // across the middle
    expect(next.position[0]).toBeLessThan(0)
    // a proper turn: the mesh isn't turned inside out
    expect(placementMatrix(next).determinant()).toBeGreaterThan(0)
    // the placed piece is the mirror image of where it was (its blade is symmetric about its own plane)
    const before = pts.map(p => p.clone().applyMatrix4(placementMatrix(place)).multiply(new THREE.Vector3(-1, 1, 1)))
    const after = pts.map(p => p.clone().applyMatrix4(placementMatrix(next)))
    const cb = before.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(before.length)
    const ca = after.reduce((s, p) => s.add(p), new THREE.Vector3()).divideScalar(after.length)
    expect(ca.distanceTo(cb)).toBeLessThan(0.01)
    expect(mirroredPlacement(place, pts.slice(0, 2))).toBeNull()
  })
})
