// @vitest-environment node
// LODs on a real rigged character (skipped without the local workspace).
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { describe, expect, it } from 'vitest'
import { addLods, LOD_RATIOS } from './lods.ts'

const g = globalThis as Record<string, unknown>
g.self ??= globalThis
g.createImageBitmap ??= async () => { throw new Error('no images in tests') }

const RIG = path.resolve(__dirname, '../../../workspace/characters/huntress-a1f4b9/rigged.glb')

describe.skipIf(!existsSync(RIG))('distance LODs', () => {
  it('adds simplified skinned copies with fewer vertices, bound to the same skeleton', async () => {
    const data = readFileSync(RIG)
    const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) => {
      new GLTFLoader().parse(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), '', r => { resolve(r as never) }, reject)
    })
    const original = gltf.scene.getObjectByProperty('isSkinnedMesh', true) as THREE.SkinnedMesh
    const triangles = (original.geometry.index?.count ?? 0) / 3
    await addLods(gltf.scene, 3, 1)
    for (let level = 1; level <= 3; level++) {
      const lod = gltf.scene.getObjectByName(`${original.name}_LOD${level}`) as THREE.SkinnedMesh
      expect(lod).toBeDefined()
      expect(lod.skeleton).toBe(original.skeleton)
      const ratio = (lod.geometry.index!.count / 3) / triangles
      expect(ratio).toBeLessThan(LOD_RATIOS[level - 1] * 1.15)
      expect(ratio).toBeGreaterThan(LOD_RATIOS[level - 1] * 0.5)
      expect(lod.geometry.attributes.position.count).toBeLessThan(original.geometry.attributes.position.count)
      // Skin data follows the kept vertices: weights still sum to one.
      const w = lod.geometry.attributes.skinWeight
      for (let i = 0; i < w.count; i += 97) {
        let sum = 0
        for (let k = 0; k < 4; k++) sum += w.getComponent(i, k)
        expect(sum).toBeCloseTo(1, 2)
      }
      expect(lod.userData).toMatchObject({ lod: level, lodBegin: [12, 25, 50][level - 1], lodEnd: [25, 50, 0][level - 1] })
    }
    expect(original.userData).toMatchObject({ lod: 0, lodEnd: 12 })
  })
})
