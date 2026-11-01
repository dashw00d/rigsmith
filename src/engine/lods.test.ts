// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { compact, invertedUvVertices, ready, simplify, triangles, uvSeamLock } from './lods.ts'

beforeAll(async () => { await ready })

/** A finely cut plane (normals, UVs), skinned to two bones blended across it. */
function skinnedPlane (): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(2, 2, 40, 40)
  const n = g.attributes.position.count
  const si = new Uint16Array(n * 4); const sw = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const t = (g.attributes.position.getX(i) + 1) / 2
    si[i * 4] = 0; si[i * 4 + 1] = 1; sw[i * 4] = 1 - t; sw[i * 4 + 1] = t
  }
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4))
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4))
  return g
}

/** The vertices of a ring round the plane's middle (a strand's loop). */
const ringOf = (g: THREE.BufferGeometry): Uint8Array => {
  const p = g.attributes.position
  return Uint8Array.from({ length: p.count }, (_, i) => Math.abs(Math.hypot(p.getX(i), p.getY(i)) - 0.5) < 0.04 ? 1 : 0)
}

const has = (g: THREE.BufferGeometry, x: number, y: number): boolean => {
  const p = g.attributes.position
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i) - x) < 1e-6 && Math.abs(p.getY(i) - y) < 1e-6) return true
  return false
}

describe('lods', () => {
  it('detects a UV fold even when the replacement triangle still faces forward in 3D', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 1,1,0, 0,1,0, .9,.1,0], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 1,0, 1,1, 0,1, .1,.9], 2))
    g.setIndex([0,1,4, 1,2,4, 2,3,4, 3,0,4])
    expect(invertedUvVertices(g, Uint32Array.from(g.index!.array)).size).toBe(0)
    expect([...invertedUvVertices(g, Uint32Array.from([0,4,2]))]).toEqual([0,4,2])
    // The same fold in a mirrored chart still needs protection.
    for (let i = 0; i < g.attributes.uv.count; i++) g.attributes.uv.setX(i, -g.attributes.uv.getX(i))
    expect([...invertedUvVertices(g, Uint32Array.from([0,4,2]))]).toEqual([0,4,2])
  })
  it('protects both copies of a packed UV seam without locking ordinary interior vertices', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([
      -1, 0, 0, 0, 0, 0, 0, 1, 0,
       0, 0, 0, 1, 0, 0, 0, 1, 0,
    ], 3))
    g.setAttribute('uv', new THREE.Float32BufferAttribute([
      0, 0, .4, 0, .4, 1,
      .6, 0, 1, 0, .6, 1,
    ], 2))
    expect(Array.from(uvSeamLock(g)!)).toEqual([0, 1, 1, 1, 0, 1])
    g.attributes.uv.setXY(3, .4, 0)
    g.attributes.uv.setXY(5, .4, 1)
    expect(Array.from(uvSeamLock(g)!)).toEqual([0, 0, 0, 0, 0, 0])
  })
  it('counts triangles of indexed and unindexed geometry', () => {
    const g = skinnedPlane()
    expect(triangles(g)).toBe(40 * 40 * 2)
    expect(triangles(g.toNonIndexed())).toBe(40 * 40 * 2)
  })

  it('compacts to the vertices used, every attribute following', () => {
    const g = skinnedPlane()
    const index = g.index!
    const kept = Uint32Array.from({ length: 6 }, (_, i) => index.getX(i + 300))
    const c = compact(g, kept)
    expect(c.attributes.position.count).toBe(new Set(kept).size)
    expect(c.index!.array).toBeInstanceOf(Uint16Array)
    expect(c.attributes.skinIndex.array).toBeInstanceOf(Uint16Array)
    for (let i = 0; i < 6; i++) {
      const v = c.index!.getX(i)
      expect(c.attributes.position.getX(v)).toBe(g.attributes.position.getX(kept[i]))
      expect(c.attributes.skinWeight.getX(v)).toBe(g.attributes.skinWeight.getX(kept[i]))
      expect(c.attributes.uv.getY(v)).toBe(g.attributes.uv.getY(kept[i]))
    }
  })

  it.each([true, false])('compacts named correction targets with the same skin vertex mapping (relative=%s)', relative => {
    const g = skinnedPlane(); const pos = g.attributes.position
    g.morphTargetsRelative = relative
    g.morphAttributes.position = [0, 1].map(t => {
      const array = Float32Array.from(pos.array, (value, i) => (relative ? 0 : value) + (t + 1) * .001 * (i % 7))
      const attr = new THREE.BufferAttribute(array, 3); attr.name = `cloth_${t}`; return attr
    })
    g.morphAttributes.normal = [0, 1].map(t => new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3).fill(.01 * t), 3))
    const kept = Uint32Array.from([93, 51, 7, 7, 51, 12])
    const result = compact(g, kept)
    expect(result.morphTargetsRelative).toBe(relative)
    const mesh = new THREE.SkinnedMesh(result)
    expect(mesh.morphTargetDictionary).toEqual({ cloth_0: 0, cloth_1: 1 })
    for (let i = 0; i < kept.length; i++) for (const key of ['position', 'normal'] as const) for (let t = 0; t < 2; t++) {
      const a = result.morphAttributes[key]![t]; const b = g.morphAttributes[key]![t]
      for (let k = 0; k < 3; k++) expect(a.getComponent(result.index!.getX(i), k)).toBe(b.getComponent(kept[i], k))
    }
  })

  it('preserves normalized integer and interleaved values while compacting', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 1,1,0], 3))
    g.setAttribute('skinWeight', new THREE.Uint16BufferAttribute([65535,0, 32768,32767, 16384,49151, 0,65535], 2, true))
    const data = new THREE.InterleavedBuffer(Uint8Array.from([255,0,8, 64,191,8, 128,127,8, 0,255,8]), 3)
    g.setAttribute('color', new THREE.InterleavedBufferAttribute(data, 2, 0, true))
    const kept = Uint32Array.from([3, 1, 2]); const result = compact(g, kept)
    for (let i = 0; i < kept.length; i++) for (const key of ['skinWeight', 'color']) for (let k = 0; k < 2; k++) {
      expect(result.attributes[key].getComponent(i, k)).toBe(g.attributes[key].getComponent(kept[i], k))
    }
  })

  it('retains correction targets on the vertices kept by simplification', () => {
    const g = skinnedPlane(); const pos = g.attributes.position
    g.morphTargetsRelative = true
    g.morphAttributes.position = [0, 1].map(t => {
      const array = Float32Array.from(pos.array, (value, i) => .01 * (t + 1) * Math.sin(value + i))
      const attr = new THREE.BufferAttribute(array, 3); attr.name = `cloth_${t}`; return attr
    })
    const result = simplify(g, .3)
    expect(result.morphAttributes.position).toHaveLength(2)
    const lookup = new Map(Array.from({ length: pos.count }, (_, i) => [`${pos.getX(i)},${pos.getY(i)}`, i]))
    for (let i = 0; i < result.attributes.position.count; i++) {
      const source = lookup.get(`${result.attributes.position.getX(i)},${result.attributes.position.getY(i)}`)!
      expect(source).toBeDefined()
      for (let t = 0; t < 2; t++) for (let k = 0; k < 3; k++) expect(result.morphAttributes.position![t].getComponent(i, k)).toBe(g.morphAttributes.position[t].getComponent(source, k))
    }
  })

  it('keeps half-float attributes decoded and simultaneous correction bounds conservative', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute([-1,0,0, 1,0,0, 0,1,0], 3))
    const half = new THREE.Float16BufferAttribute(new Uint16Array(9), 3)
    for (let i = 0; i < 3; i++) half.setXYZ(i, .5, .25, 0)
    g.setAttribute('color', half)
    g.morphTargetsRelative = true
    g.morphAttributes.position = [0, 1].map(() => new THREE.Float32BufferAttribute([-1,0,0, 1,0,0, 0,0,0], 3))
    const result = compact(g, Uint32Array.from([0, 1, 2]))
    expect(result.attributes.color).toBeInstanceOf(THREE.Float16BufferAttribute)
    expect(result.attributes.color.getX(0)).toBe(.5)
    const mesh = new THREE.Mesh(result); mesh.morphTargetInfluences = [1, 1]
    for (let i = 0; i < 3; i++) expect(result.boundingSphere!.containsPoint(mesh.getVertexPosition(i, new THREE.Vector3()))).toBe(true)
  })

  it('simplifies to about the ratio, with fewer vertices, skin weights still whole', () => {
    const g = skinnedPlane()
    for (const ratio of [0.45, 0.15]) {
      const s = simplify(g, ratio)
      expect(triangles(s) / triangles(g)).toBeLessThanOrEqual(ratio * 1.05)
      expect(triangles(s)).toBeGreaterThan(0)
      expect(s.attributes.position.count).toBeLessThan(g.attributes.position.count)
      expect(Object.keys(s.attributes).sort()).toEqual(Object.keys(g.attributes).sort())
      const w = s.attributes.skinWeight
      for (let i = 0; i < w.count; i++) expect(w.getX(i) + w.getY(i) + w.getZ(i) + w.getW(i)).toBeCloseTo(1, 5)
    }
  })

  it('keeps locked vertices where they are', () => {
    const g = skinnedPlane()
    const lock = ringOf(g)
    const ring = [...lock.keys()].filter(i => lock[i] === 1).map(i => [g.attributes.position.getX(i), g.attributes.position.getY(i)])
    expect(ring.length).toBeGreaterThan(8)
    const locked = simplify(g, 0.1, lock)
    for (const [x, y] of ring) expect(has(locked, x, y)).toBe(true)
    // (left free, the ring goes)
    const free = simplify(g, 0.1)
    expect(ring.filter(([x, y]) => has(free, x, y)).length).toBeLessThan(ring.length)
  })

  it('takes a lock on geometry with no normals or UVs', () => {
    const g = skinnedPlane()
    g.deleteAttribute('normal'); g.deleteAttribute('uv')
    const lock = ringOf(g)
    const s = simplify(g, 0.2, lock)
    expect(triangles(s)).toBeLessThan(triangles(g))
    for (let i = 0; i < lock.length; i++) if (lock[i] === 1) expect(has(s, g.attributes.position.getX(i), g.attributes.position.getY(i))).toBe(true)
  })
})
