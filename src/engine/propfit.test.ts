// @vitest-environment node
// The prop fit's grip move (src/engine/propfit.ts movedSocket): sliding along the shaft and rolling round it through the fist.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { movedSocket } from './propfit.ts'

const socket = { id: 'a', name: 'Left grip', position: [0.1, 0.2, 0.3] as [number, number, number], rotation: new THREE.Quaternion(0.1, 0.2, 0.3, 0.9).normalize().toArray() as [number, number, number, number] }
const fist = new THREE.Vector3(0.02, 0.01, 0.03)
const fistOf = (s: typeof socket): THREE.Vector3 => fist.clone().applyQuaternion(new THREE.Quaternion(...s.rotation).normalize()).add(new THREE.Vector3(...s.position))

describe('movedSocket', () => {
  it('slides the fist along the shaft by the distance asked, its turn kept', () => {
    const d = new THREE.Vector3(0, 0, 1)
    const moved = movedSocket(socket, d, 0.25, 0, fist)
    const a = fistOf(socket); const b = fistOf(moved)
    expect(b.clone().sub(a).distanceTo(new THREE.Vector3(0, 0, 0.25))).toBeLessThan(2e-4)
    const q0 = new THREE.Quaternion(...socket.rotation).normalize(); const q1 = new THREE.Quaternion(...moved.rotation).normalize()
    expect(Math.abs(q0.dot(q1))).toBeGreaterThan(0.99999)
  })
  it('rolls the hand about the shaft through the fist: the fist stays where it was, the hand turns', () => {
    const d = new THREE.Vector3(1, 0, 0)
    const moved = movedSocket(socket, d, 0, 0.5, fist)
    expect(fistOf(moved).distanceTo(fistOf(socket))).toBeLessThan(2e-4)
    const q0 = new THREE.Quaternion(...socket.rotation).normalize(); const q1 = new THREE.Quaternion(...moved.rotation).normalize()
    expect(q1.angleTo(q0)).toBeCloseTo(0.5, 3)
    expect(moved.id).toBe('a')
  })
})
