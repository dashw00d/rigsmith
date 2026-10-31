// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { compact, ready, simplify, triangles, uvSeamLock } from './lods.ts'

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
