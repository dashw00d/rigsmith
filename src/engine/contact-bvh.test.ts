import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { AVERAGE, CENTER, MeshBVH, SAH, type SerializedBVH } from 'three-mesh-bvh'
import { ContactBVH } from './contact-bvh.ts'

type Range = [number, number]

function random (initial: number): () => number {
  let seed = initial
  return () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32
}

function geometry (count: number, seed = 17): THREE.BufferGeometry {
  const next = random(seed)
  const positions: number[] = []
  for (let i = 0; i < count; i++) {
    const x = next() * 20 - 10; const y = next() * 20 - 10; const z = next() * 20 - 10
    positions.push(x, y, z, x + next(), y, z, x, y + next(), z + next())
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float64Array(positions), 3))
  g.setIndex(Array.from({ length: count * 3 }, (_, i) => i))
  return g
}

function stock (tree: MeshBVH, box: THREE.Box3, stop = Infinity): { ranges: Range[], stopped: boolean } {
  const ranges: Range[] = []
  const stopped = tree.shapecast({
    intersectsBounds: bounds => bounds.intersectsBox(box),
    intersectsRange: (offset, count) => { ranges.push([offset, count]); return ranges.length >= stop },
  })
  return { ranges, stopped }
}

function contact (tree: ContactBVH, box: THREE.Box3, stop = Infinity): { ranges: Range[], stopped: boolean } {
  const ranges: Range[] = []
  const stopped = tree.shapecast(box, (offset, count) => { ranges.push([offset, count]); return ranges.length >= stop })
  return { ranges, stopped }
}

const all = new THREE.Box3(new THREE.Vector3(-Infinity, -Infinity, -Infinity), new THREE.Vector3(Infinity, Infinity, Infinity))
afterEach(() => vi.restoreAllMocks())

describe('contact BVH leaf traversal', () => {
  it.each([CENTER, AVERAGE, SAH])('matches stock ranges and order before and after repeated live refits (strategy=%s)', strategy => {
    const next = random(131)
    const g = geometry(384)
    const tree = new MeshBVH(g, { indirect: true, targetLeafSize: 4, strategy })
    const accelerated = new ContactBVH(tree)
    const stockCast = vi.spyOn(tree, 'shapecast')
    expect(Array.from({ length: 384 }, (_, i) => tree.resolveTriangleIndex(i)).some((id, i) => id !== i)).toBe(true)
    for (let iteration = 0; iteration < 4; iteration++) {
      for (let query = 0; query < 240; query++) {
        const center = new THREE.Vector3(next() * 28 - 14, next() * 28 - 14, next() * 28 - 14)
        const half = new THREE.Vector3(next() * 8, next() * 8, next() * 8)
        const box = new THREE.Box3(center.clone().sub(half), center.clone().add(half))
        const expected = stock(tree, box)
        stockCast.mockClear()
        expect(contact(accelerated, box)).toEqual(expected)
        expect(stockCast).not.toHaveBeenCalled()
      }
      const position = g.attributes.position
      for (let p = 0; p < position.count; p++) position.setXYZ(p,
        position.getX(p) + (next() - .5) * 3,
        position.getY(p) + (next() - .5) * 3,
        position.getZ(p) + (next() - .5) * 3)
      tree.refit()
    }
    // Refit just a public shapecast node set as used by local cap updates.
    const nodes = new Set<number>()
    tree.shapecast({ intersectsBounds: (_box, _leaf, _score, _depth, node) => { nodes.add(node); return true } })
    g.attributes.position.setX(0, -50)
    tree.refit(nodes)
    expect(contact(accelerated, all)).toEqual(stock(tree, all))
    expect(contact(accelerated, new THREE.Box3(new THREE.Vector3(-51, -20, -20), new THREE.Vector3(-40, 20, 20))))
      .toEqual(stock(tree, new THREE.Box3(new THREE.Vector3(-51, -20, -20), new THREE.Vector3(-40, 20, 20))))
  })

  it('calls an out-of-bounds root leaf even for empty and NaN query boxes', () => {
    const tree = new MeshBVH(geometry(2), { indirect: true })
    const accelerated = new ContactBVH(tree)
    for (const box of [new THREE.Box3(), new THREE.Box3(new THREE.Vector3(1e9, 1e9, 1e9), new THREE.Vector3(1e9 + 1, 1e9 + 1, 1e9 + 1)),
      new THREE.Box3(new THREE.Vector3(NaN, 0, 0), new THREE.Vector3(NaN, 0, 0))]) {
      expect(contact(accelerated, box)).toEqual({ ranges: [[0, 2]], stopped: false })
      expect(contact(accelerated, box)).toEqual(stock(tree, box))
    }
  })

  it('preserves multiple roots and early stops across their leaf ranges', () => {
    const g = geometry(90)
    g.addGroup(0, 9, 0); g.addGroup(9, 120, 1); g.addGroup(129, 141, 2)
    const tree = new MeshBVH(g, { targetLeafSize: 4 })
    expect(MeshBVH.serialize(tree, { cloneBuffers: false }).roots.length).toBe(3)
    const accelerated = new ContactBVH(tree)
    const expected = stock(tree, all)
    expect(contact(accelerated, all)).toEqual(expected)
    for (let stop = 1; stop <= expected.ranges.length + 1; stop++) expect(contact(accelerated, all, stop)).toEqual(stock(tree, all, stop))
  })

  it('uses the same positive Box3 comparisons for NaN, infinite, inverted and boundary queries', () => {
    const tree = new MeshBVH(geometry(64), { indirect: true, targetLeafSize: 2 })
    const accelerated = new ContactBVH(tree)
    const queries = [all, new THREE.Box3(), new THREE.Box3(new THREE.Vector3(2, 2, 2), new THREE.Vector3(-2, -2, -2))]
    for (const axis of ['x', 'y', 'z'] as const) for (const endpoint of ['min', 'max'] as const) {
      const box = all.clone(); box[endpoint][axis] = NaN; queries.push(box)
    }
    const root = MeshBVH.serialize(tree, { cloneBuffers: false }).roots[0]
    const bounds = new Float32Array(root)
    for (let node = 8; node < bounds.length; node += 8) {
      const min = new THREE.Vector3().fromArray(bounds, node)
      const max = new THREE.Vector3().fromArray(bounds, node + 3)
      queries.push(new THREE.Box3(min, max), new THREE.Box3(min.clone(), min.clone()), new THREE.Box3(max.clone(), max.clone()))
    }
    for (const box of queries) expect(contact(accelerated, box)).toEqual(stock(tree, box))
    bounds[8] = NaN
    expect(contact(accelerated, all)).toEqual(stock(tree, all))
  })

  it.each([1e-5, 1, 1e5])('keeps the exact Float32 refit planes at scale %s', scale => {
    const g = geometry(32)
    const position = g.attributes.position
    for (let p = 0; p < position.count; p++) position.setZ(p, (1.00000008 + p * .01) * scale)
    const tree = new MeshBVH(g, { indirect: true, targetLeafSize: 2 })
    const accelerated = new ContactBVH(tree)
    for (let p = 0; p < position.count; p++) position.setZ(p, position.getZ(p) + .00000007 * scale)
    tree.refit()
    const roots = MeshBVH.serialize(tree, { cloneBuffers: false }).roots
    for (const root of roots) {
      const bounds = new Float32Array(root)
      for (let node = 8; node < bounds.length; node += 8) for (const z of [bounds[node + 2], bounds[node + 5]]) for (const delta of [-1e-12, 0, 1e-12]) {
        const box = new THREE.Box3(new THREE.Vector3(-20, -20, z + delta * scale), new THREE.Vector3(20, 20, z + delta * scale))
        expect(contact(accelerated, box)).toEqual(stock(tree, box))
      }
    }
  })

  it('keeps the pending outer traversal intact after nested queries and caught nested exceptions', () => {
    const tree = new MeshBVH(geometry(100), { indirect: true, targetLeafSize: 2 })
    const accelerated = new ContactBVH(tree)
    const expected = stock(tree, all)
    const inner = new THREE.Box3(new THREE.Vector3(-5, -5, -5), new THREE.Vector3(5, 5, 5))
    const expectedInner = stock(tree, inner)
    const outer: Range[] = []
    let nested = false
    expect(accelerated.shapecast(all, (offset, count) => {
      outer.push([offset, count])
      if (!nested) {
        nested = true
        expect(contact(accelerated, inner)).toEqual(expectedInner)
        expect(() => accelerated.shapecast(all, () => { throw new Error('nested failure') })).toThrow('nested failure')
      }
      return false
    })).toBe(false)
    expect(outer).toEqual(expected.ranges)
    expect(() => accelerated.shapecast(all, () => { throw new Error('outer failure') })).toThrow('outer failure')
    expect(contact(accelerated, all)).toEqual(expected)
    expect(contact(accelerated, all, 1)).toEqual(stock(tree, all, 1))
    expect(contact(accelerated, all)).toEqual(expected)
  })

  it('reads query box mutations made by a range callback before testing later nodes', () => {
    const tree = new MeshBVH(geometry(80), { indirect: true, targetLeafSize: 2 })
    const accelerated = new ContactBVH(tree)
    const run = (fast: boolean): Range[] => {
      const box = all.clone(); const ranges: Range[] = []
      const callback = (offset: number, count: number): boolean => {
        ranges.push([offset, count]); box.min = new THREE.Vector3(1e9, 1e9, 1e9); box.max = box.min.clone(); return false
      }
      if (fast) accelerated.shapecast(box, callback)
      else tree.shapecast({ intersectsBounds: bounds => bounds.intersectsBox(box), intersectsRange: callback })
      return ranges
    }
    expect(run(true)).toEqual(run(false))
  })

  it.each(['version', 'missing-version', 'misaligned', 'invalid-branch', 'non-buffer', 'serialize-throws'])('falls back to stock for unsupported serialization: %s', reason => {
    const tree = new MeshBVH(geometry(48), { indirect: true, targetLeafSize: 2 })
    const serialized = MeshBVH.serialize(tree)
    const unsupported = { ...serialized, version: 1 } as SerializedBVH & { version?: number }
    if (reason === 'version') unsupported.version = 2
    if (reason === 'missing-version') delete unsupported.version
    if (reason === 'misaligned') unsupported.roots = [new ArrayBuffer(31)]
    if (reason === 'invalid-branch') new Uint32Array(unsupported.roots[0])[6] = 0
    if (reason === 'non-buffer') unsupported.roots = [new Uint8Array(32) as unknown as ArrayBuffer]
    const serialize = vi.spyOn(MeshBVH, 'serialize')
    if (reason === 'serialize-throws') serialize.mockImplementationOnce(() => { throw new Error('unsupported serialization') })
    else serialize.mockReturnValueOnce(unsupported)
    const accelerated = new ContactBVH(tree)
    const expected = stock(tree, all)
    const stockCast = vi.spyOn(tree, 'shapecast')
    expect(contact(accelerated, all)).toEqual(expected)
    expect(stockCast).toHaveBeenCalledOnce()
    expect(contact(accelerated, all, 1)).toEqual(stock(tree, all, 1))
  })

  it('uses shared serialized buffers when the BVH is built with SharedArrayBuffer', () => {
    const g = geometry(64)
    const tree = new MeshBVH(g, { indirect: true, targetLeafSize: 2, useSharedArrayBuffer: true })
    const accelerated = new ContactBVH(tree)
    expect(contact(accelerated, all)).toEqual(stock(tree, all))
    g.attributes.position.setX(0, 1e4); tree.refit()
    const box = new THREE.Box3(new THREE.Vector3(9999, -20, -20), new THREE.Vector3(10001, 20, 20))
    expect(contact(accelerated, box)).toEqual(stock(tree, box))
  })
})
