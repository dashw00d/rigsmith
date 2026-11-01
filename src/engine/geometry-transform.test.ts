// @vitest-environment node
import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { applyGeometryMatrix } from './geometry-transform.ts'

function corrected (relative: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute([.1, .2, .3, -.3, .6, .1, .2, -.4, .5], 3))
  g.setAttribute('normal', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1], 3))
  g.morphTargetsRelative = relative
  for (const key of ['position', 'normal'] as const) {
    const base = g.attributes[key]
    g.morphAttributes[key] = [0, 1].map(t => {
      const values = new Float32Array(9)
      for (let i = 0; i < 3; i++) for (let k = 0; k < 3; k++) values[i * 3 + k] = (relative ? 0 : base.getComponent(i, k)) + .1 * (t + 1) * (i + k - 1)
      const attr = new THREE.BufferAttribute(values, 3); attr.name = `cloth_${t}`
      return attr
    })
  }
  return g
}

function blendedNormal (geometry: THREE.BufferGeometry, vertex: number, weights: number[]): THREE.Vector3 {
  const base = new THREE.Vector3().fromBufferAttribute(geometry.attributes.normal, vertex)
  const result = base.clone().multiplyScalar(geometry.morphTargetsRelative ? 1 : 1 - weights.reduce((a, b) => a + b, 0))
  for (let t = 0; t < weights.length; t++) result.addScaledVector(new THREE.Vector3().fromBufferAttribute(geometry.morphAttributes.normal![t], vertex), weights[t])
  return result
}

const transform = (): THREE.Matrix4 => new THREE.Matrix4().compose(new THREE.Vector3(4, -3, 2),
  new THREE.Quaternion().setFromEuler(new THREE.Euler(.4, -.7, .2)), new THREE.Vector3(-2, .5, 3))

describe('baking geometry transforms with cloth correction targets', () => {
  it.each([true, false])('preserves all blended positions and normals (relative=%s)', relative => {
    const source = corrected(relative); const matrix = transform()
    const before = new THREE.Mesh(source)
    const baked = applyGeometryMatrix(source.clone(), matrix); const after = new THREE.Mesh(baked)
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix)
    for (const weights of [[0, 0], [.2, .7], [1, 0], [-.2, 1.3]]) {
      before.morphTargetInfluences = [...weights]; after.morphTargetInfluences = [...weights]
      for (let v = 0; v < 3; v++) {
        const expected = before.getVertexPosition(v, new THREE.Vector3()).applyMatrix4(matrix)
        expect(after.getVertexPosition(v, new THREE.Vector3()).distanceTo(expected)).toBeLessThan(1e-6)
        const n = blendedNormal(source, v, weights).applyMatrix3(normalMatrix).normalize()
        expect(blendedNormal(baked, v, weights).normalize().distanceTo(n)).toBeLessThan(1e-6)
      }
    }
    expect(Object.keys(after.morphTargetDictionary!)).toEqual(['cloth_0', 'cloth_1'])
    expect(Array.from(source.attributes.position.array)).toEqual(Array.from(corrected(relative).attributes.position.array))
  })

  it('keeps target directions and lengths through repeated world and game transforms', () => {
    const source = corrected(true)
    const world = transform(); const game = new THREE.Matrix4().makeScale(.2, .2, .2).setPosition(0, -1, .5)
    const sequential = applyGeometryMatrix(applyGeometryMatrix(source.clone(), world), game)
    const once = applyGeometryMatrix(source.clone(), game.clone().multiply(world))
    for (const key of ['position', 'normal'] as const) for (let t = 0; t < 2; t++) {
      const a = sequential.morphAttributes[key]![t]; const b = once.morphAttributes[key]![t]
      for (let i = 0; i < a.array.length; i++) expect(a.array[i]).toBeCloseTo(b.array[i], 6)
    }
  })

  it('expands quantized morphs before a transform exceeds their encoded range', () => {
    const g = corrected(true)
    const target = new THREE.Int16BufferAttribute([16384, -8192, 0, 0, 0, 0, 0, 0, 0], 3, true)
    target.name = 'cloth_quantized'; g.morphAttributes.position = [target]
    const expected = new THREE.Vector3().fromBufferAttribute(target, 0).multiplyScalar(10)
    applyGeometryMatrix(g, new THREE.Matrix4().makeScale(10, 10, 10))
    const result = g.morphAttributes.position[0]
    expect(result.array).toBeInstanceOf(Float32Array)
    expect(result.name).toBe('cloth_quantized')
    expect(new THREE.Vector3().fromBufferAttribute(result, 0).distanceTo(expected)).toBeLessThan(1e-6)
  })

  it('validates missing base normals before modifying positions', () => {
    const g = corrected(true); g.deleteAttribute('normal')
    const positions = Array.from(g.attributes.position.array); const target = Array.from(g.morphAttributes.position![0].array)
    expect(() => applyGeometryMatrix(g, transform())).toThrow('Normal correction targets need base normals')
    expect(Array.from(g.attributes.position.array)).toEqual(positions)
    expect(Array.from(g.morphAttributes.position![0].array)).toEqual(target)
  })

  it('transforms shared interleaved channels once each without corrupting their shared source', () => {
    const g = corrected(true)
    const data = new THREE.InterleavedBuffer(Float32Array.from([1,0,0,7, 1,0,0,7, 1,0,0,7]), 4)
    const a = new THREE.InterleavedBufferAttribute(data, 3, 0); a.name = 'a'
    const b = new THREE.InterleavedBufferAttribute(data, 3, 0); b.name = 'b'
    g.morphAttributes.position = [a, b]
    const before = new THREE.Mesh(g); before.morphTargetInfluences = [.5, .5]
    const matrix = new THREE.Matrix4().makeScale(2, 2, 2)
    const baked = applyGeometryMatrix(g.clone(), matrix); const after = new THREE.Mesh(baked); after.morphTargetInfluences = [.5, .5]
    for (let i = 0; i < 3; i++) expect(after.getVertexPosition(i, new THREE.Vector3()).distanceTo(before.getVertexPosition(i, new THREE.Vector3()).applyMatrix4(matrix))).toBeLessThan(1e-6)
    expect(a.getX(0)).toBe(1)
    expect(baked.morphAttributes.position![0].array).not.toBe(baked.morphAttributes.position![1].array)
  })

  it('decodes half-float target values before materializing transformed morphs', () => {
    const g = corrected(true); const half = new THREE.Float16BufferAttribute(new Uint16Array(9), 3)
    for (let i = 0; i < 3; i++) half.setXYZ(i, .5, 0, 0)
    g.morphAttributes.position = [half]
    applyGeometryMatrix(g, new THREE.Matrix4().makeScale(2, 2, 2))
    expect(g.morphAttributes.position[0].getX(0)).toBe(1)
  })

  it('keeps simultaneous relative corrections inside an already cached sphere', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1,0,0, 1,0,0, 0,1,0], 3))
    g.morphTargetsRelative = true
    g.morphAttributes.position = [0, 1].map(() => new THREE.Float32BufferAttribute([-1,0,0, 1,0,0, 0,0,0], 3))
    g.computeBoundingSphere(); const matrix = new THREE.Matrix4().makeScale(2, 2, 2)
    applyGeometryMatrix(g, matrix)
    const mesh = new THREE.Mesh(g); mesh.morphTargetInfluences = [1, 1]
    for (let i = 0; i < 3; i++) expect(g.boundingSphere!.containsPoint(mesh.getVertexPosition(i, new THREE.Vector3()))).toBe(true)
  })
})
