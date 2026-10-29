// A piece's shape read off its mesh (src/engine/gearfit.ts): which end is held, where the fist goes, which way is its
// widest, and the placement that puts it in a fist; also its middle and base at rest.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { fistAt, fitMatrix, heldAt, inFist, offBox, onShaft, restPoints, shapeOf, surfacePoints, type HandAt } from './gearfit.ts'

const part = (geometry: THREE.BufferGeometry, at: [number, number, number]): THREE.Mesh => {
  const m = new THREE.Mesh(geometry)
  m.position.set(...at)
  return m
}
/** A sword along +Y, modelled 0.8 above its file's origin: a thin grip, a pommel, a guard, a wide flat blade. */
const sword = (): THREE.Mesh[] => [
  part(new THREE.CylinderGeometry(0.015, 0.015, 0.18, 12), [0, 0.8 + 0.11, 0]),
  part(new THREE.SphereGeometry(0.025, 10, 8), [0, 0.8 + 0.01, 0]),
  part(new THREE.BoxGeometry(0.16, 0.02, 0.03), [0, 0.8 + 0.21, 0]),
  part(new THREE.BoxGeometry(0.06, 0.7, 0.008), [0, 0.8 + 0.57, 0]),
]
/** An axe along +Y: a long handle, its head at the top reaching out to +X (the blade). */
const axe = (): THREE.Mesh[] => [
  part(new THREE.CylinderGeometry(0.018, 0.018, 0.6, 12), [0, 0.3, 0]),
  part(new THREE.BoxGeometry(0.2, 0.12, 0.02), [0.08, 0.54, 0]),
]
/** A right hand at rest, palm in, fingers forward; its grip line up (the thumb's side) and its fist in front. */
const hand = (): HandAt => ({
  position: new THREE.Vector3(-0.7, 1.4, 0.05),
  quaternion: new THREE.Quaternion().setFromEuler(new THREE.Euler(0.3, -0.4, 1.1)),
  grip: { axis: new THREE.Vector3(0, 0, 1), fist: new THREE.Vector3(0.02, 0.07, 0.03) },
  fingers: new THREE.Vector3(0.1, -0.2, 0.9).normalize(),
})

describe('gearfit', () => {
  it('holds a sword by its grip, its blade far, its widest way across the blade', () => {
    const s = shapeOf(surfacePoints(sword()))!
    expect(s.axis.y).toBeGreaterThan(0.99)
    expect(s.grip.y).toBeGreaterThan(0.84)
    expect(s.grip.y).toBeLessThan(0.99)
    expect(Math.abs(s.side.x)).toBeGreaterThan(0.95)
    expect(onShaft(s, s.grip)).toBe(true)
    expect(onShaft(s, new THREE.Vector3())).toBe(false)
  })

  it('holds an axe by its handle, its head\'s blade to the side it reaches', () => {
    const s = shapeOf(surfacePoints(axe()))!
    expect(s.axis.y).toBeGreaterThan(0.99)
    expect(s.grip.y).toBeLessThan(0.25)
    expect(s.side.x).toBeGreaterThan(0.9)
  })

  it('takes the end nearer the hand when the ends are as thick', () => {
    const staff = [part(new THREE.CylinderGeometry(0.02, 0.02, 1.5, 12), [0, 0.75, 0])]
    const pts = surfacePoints(staff)
    expect(shapeOf(pts, new THREE.Vector3(0, 2, 0))!.axis.y).toBeLessThan(-0.99)
    expect(shapeOf(pts, new THREE.Vector3(0, -1, 0))!.axis.y).toBeGreaterThan(0.99)
    // (held at a point of it instead: the far end the one farther away)
    const s = heldAt(shapeOf(pts)!, new THREE.Vector3(0, 1.2, 0))
    expect(s.grip.y).toBeCloseTo(1.2, 6)
    expect(s.axis.y).toBeLessThan(-0.99)
  })

  it('fits the grip into the fist, the long axis along the grip line, the blade along the fingers', () => {
    const s = shapeOf(surfacePoints(sword()))!
    const h = hand()
    const m = fitMatrix(s, h, 1.2)
    expect(s.grip.clone().applyMatrix4(m).distanceTo(fistAt(h))).toBeLessThan(1e-9)
    const axis = s.axis.clone().transformDirection(m)
    expect(axis.dot(h.grip.axis.clone().applyQuaternion(h.quaternion))).toBeGreaterThan(1 - 1e-9)
    const side = s.side.clone().transformDirection(m)
    const A = h.grip.axis.clone().applyQuaternion(h.quaternion)
    expect(side.dot(h.fingers.clone().addScaledVector(A, -h.fingers.dot(A)).normalize())).toBeGreaterThan(0.99)
    expect(new THREE.Vector3().setFromMatrixScale(m).x).toBeCloseTo(1.2, 9)
    expect(inFist(s, m, h, 1.8)).not.toBeNull()
    expect(inFist(s, new THREE.Matrix4(), h, 1.8)).toBeNull()
  })

  it('finds its middle and base at rest, and how far a point is off it', () => {
    const pts = surfacePoints(sword())
    const place = new THREE.Matrix4().makeRotationZ(Math.PI / 2)
    const { middle, base } = restPoints(pts, place)
    // (turned on its side: its base is the lowest point at rest, the blade's flat side)
    expect(middle.y).toBeCloseTo((0.785 + 1.72) / 2, 2)
    expect(base.clone().applyMatrix4(place).y).toBeCloseTo(-0.08, 2)
    expect(offBox(pts, new THREE.Vector3())).toBeCloseTo(0.81 - 0.025, 2)
    expect(offBox(pts, middle)).toBe(0)
  })
})
