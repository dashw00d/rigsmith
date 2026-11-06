// The byte-budget LRU every client cache is: least recently used out first, held to its budget and count, what falls
// out disposed, loads shared while pending and not kept when they fail; three.js sizes.
import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import { Lru, geometryBytes, objectBytes, textureBytes, disposeObject } from './lru.ts'

describe('Lru', () => {
  const make = (budget: number, max?: number): { lru: Lru<{ n: number }>, gone: number[] } => {
    const gone: number[] = []
    return { lru: new Lru<{ n: number }>({ budget, max, size: v => v.n, dispose: v => { gone.push(v.n) } }), gone }
  }

  it('drops the least recently used past its budget, disposing it', () => {
    const { lru, gone } = make(10)
    lru.set('a', { n: 4 }); lru.set('b', { n: 4 })
    lru.get('a')
    lru.set('c', { n: 4 })
    expect(lru.keys()).toEqual(['a', 'c'])
    expect(gone).toEqual([4])
    expect(lru.bytes).toBe(8)
  })

  it('keeps to its count', () => {
    const { lru } = make(Infinity, 2)
    lru.set('a', { n: 1 }); lru.set('b', { n: 1 }); lru.set('c', { n: 1 })
    expect(lru.keys()).toEqual(['b', 'c'])
  })

  it('keeps one value bigger than the budget while it is the newest', () => {
    const { lru } = make(5)
    lru.set('big', { n: 9 })
    expect(lru.get('big')?.n).toBe(9)
  })

  it('loads once for every caller meanwhile', async () => {
    const { lru } = make(100)
    let calls = 0
    const load = async (): Promise<{ n: number }> => { calls++; await Promise.resolve(); return { n: 1 } }
    const [x, y] = await Promise.all([lru.load('k', load), lru.load('k', load)])
    expect(x).toBe(y)
    expect(calls).toBe(1)
    expect(lru.bytes).toBe(1)
  })

  it('keeps no failed load', async () => {
    const { lru } = make(100)
    await expect(lru.load('k', async () => { throw new Error('404') })).rejects.toThrow('404')
    expect(lru.has('k')).toBe(false)
  })

  it('never drops an entry still loading', async () => {
    const { lru } = make(3)
    let release!: (v: { n: number }) => void
    const slow = lru.load('slow', async () => await new Promise(resolve => { release = resolve }))
    lru.set('a', { n: 2 }); lru.set('b', { n: 2 })
    expect(lru.has('slow')).toBe(true)
    release({ n: 1 })
    await slow
    expect(lru.has('slow')).toBe(true)
  })

  it('replacing a key disposes the old value', () => {
    const { lru, gone } = make(100)
    lru.set('a', { n: 1 }); lru.set('a', { n: 2 })
    expect(gone).toEqual([1])
    expect(lru.bytes).toBe(2)
  })
})

describe('three.js sizes', () => {
  it('counts geometry and each texture once', () => {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(30), 3))
    expect(geometryBytes(g)).toBe(120)
    const t = new THREE.Texture({ width: 4, height: 4 } as never)
    t.generateMipmaps = false
    expect(textureBytes(t)).toBe(64)
    const m = new THREE.MeshStandardMaterial({ map: t })
    const root = new THREE.Group()
    root.add(new THREE.Mesh(g, m), new THREE.Mesh(g, m))
    expect(objectBytes(root)).toBe(184)
    let disposed = 0
    g.addEventListener('dispose', () => { disposed++ })
    t.addEventListener('dispose', () => { disposed++ })
    disposeObject(root)
    expect(disposed).toBe(2)
  })
})
