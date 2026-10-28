import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { covariance, firstSkinned, gearNode, principalAxis, safeName, smallestAxis, symmetricEigen, wp } from './geom.ts'

describe('geom', () => {
  it('names a gear piece\'s node from its bone-safe name', () => {
    expect(safeName('Gear Axe (old)')).toBe('Gear_Axe_old_')
    expect(gearNode({ name: 'Gear Axe' })).toBe('Gear_Axe_place')
  })

  it('finds the long axis of a cloud of points and its reach', () => {
    const dir = new THREE.Vector3(1, 2, 0.5).normalize()
    const side = new THREE.Vector3(0, -0.25, 1).normalize()
    const points = Array.from({ length: 21 }, (_, i) => dir.clone().multiplyScalar(i / 10 - 1).addScaledVector(side, i % 2 === 0 ? 0.05 : -0.05).add(new THREE.Vector3(3, 0, 0)))
    const { center, axis, lo, hi } = principalAxis(points)
    expect(Math.abs(axis.dot(dir))).toBeCloseTo(1, 3)
    expect(center.x).toBeCloseTo(3, 1)
    expect(hi - lo).toBeCloseTo(2, 1)
    expect(principalAxis([])).toMatchObject({ lo: 0, hi: 0 })
  })

  it('solves a symmetric 3 x 3 matrix, smallest value first', () => {
    // (diag(1, 4, 9) turned 30° about z and 20° about x: its values stay, its vectors turn with it)
    const turn = new THREE.Matrix4().makeRotationX(0.35).multiply(new THREE.Matrix4().makeRotationZ(Math.PI / 6))
    const r = new THREE.Matrix3().setFromMatrix4(turn)
    const d = new THREE.Matrix3().set(1, 0, 0, 0, 4, 0, 0, 0, 9)
    const m = r.clone().multiply(d).multiply(r.clone().transpose())
    const e = m.elements // (column major; symmetric, so the same read as rows)
    const { values, vectors } = symmetricEigen([[e[0], e[3], e[6]], [e[1], e[4], e[7]], [e[2], e[5], e[8]]])
    expect(values[0]).toBeCloseTo(1, 6)
    expect(values[1]).toBeCloseTo(4, 6)
    expect(values[2]).toBeCloseTo(9, 6)
    const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(a => a.applyMatrix3(r))
    vectors.forEach((v, i) => { expect(v.length()).toBeCloseTo(1, 6); expect(Math.abs(v.dot(axes[i]))).toBeCloseTo(1, 6) })
    expect(symmetricEigen([[0, 0, 0], [0, 0, 0], [0, 0, 0]]).vectors[0].toArray()).toEqual([1, 0, 0])
  })

  it('finds the thin axis of a flat cloud of points and its covariance', () => {
    const normal = new THREE.Vector3(1, 1, 0).normalize()
    const a = new THREE.Vector3(-1, 1, 0).normalize(); const b = new THREE.Vector3(0, 0, 1)
    const points: THREE.Vector3[] = []
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) points.push(a.clone().multiplyScalar(i * 0.1).addScaledVector(b, j * 0.05).addScaledVector(normal, (i + j) % 2 === 0 ? 0.002 : -0.002))
    expect(Math.abs(smallestAxis(points).dot(normal))).toBeCloseTo(1, 3)
    expect(covariance([new THREE.Vector3(1, 2, 0), new THREE.Vector3(-1, -2, 0)], new THREE.Vector3())).toEqual([[2, 4, 0], [4, 8, 0], [0, 0, 0]])
  })

  it('finds the first skinned mesh and world positions', () => {
    const root = new THREE.Group()
    const bone = new THREE.Bone(); bone.position.set(0, 1, 0); root.add(bone)
    expect(firstSkinned(root)).toBeNull()
    const mesh = new THREE.SkinnedMesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())
    root.add(mesh)
    expect(firstSkinned(root)).toBe(mesh)
    root.position.set(1, 0, 0)
    root.updateMatrixWorld(true)
    expect(wp(bone).toArray()).toEqual([1, 1, 0])
  })
})
