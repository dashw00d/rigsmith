// @vitest-environment node
import { expect, it } from 'vitest'
import type { Glb } from '../../src/engine/glb.ts'
import { folkMaterial, sharedMaterialKey } from './folk_material.ts'

function fixture (): Glb {
  return {
    json: {
      asset: { version: '2.0' },
      images: [0, 1, 2].map(bufferView => ({ bufferView, mimeType: 'image/png' })),
      bufferViews: [0, 1, 2].map(i => ({ buffer: 0, byteOffset: i * 4, byteLength: 4 })),
      textures: [{ source: 2 }, { source: 0 }, { source: 1 }],
      materials: [{ name: 'Helmet', pbrMetallicRoughness: { baseColorTexture: { index: 2 }, metallicRoughnessTexture: { index: 0 }, metallicFactor: .7, roughnessFactor: .8 }, normalTexture: { index: 1 } }] as unknown as Glb['json']['materials'],
    },
    bin: new Uint8Array([1, 2, 3, 4, 10, 20, 30, 40, 50, 60, 70, 80]),
  }
}

it('follows texture source indices for MR, normal and albedo, retaining glTF factors', () => {
  expect(folkMaterial(fixture())).toEqual({ maps: { albedo: 1, normal: 0, mr: 2, occlusion: null }, factors: { metallic: .7, roughness: .8, occlusion: 1 } })
})
it('allows identical atlases with different material names and refuses differing PBR payloads', () => {
  const a = fixture(), b = fixture(); b.json.materials![0].name = 'Boot'
  expect(sharedMaterialKey(a)).toBe(sharedMaterialKey(b))
  b.bin![11]++
  expect(sharedMaterialKey(a)).not.toBe(sharedMaterialKey(b))
})
it('rejects a shared atlas whose images use UV1 or a texture transform', () => {
  const a = fixture(); a.json.materials![0].normalTexture = { index: 1, texCoord: 1 }
  expect(() => sharedMaterialKey(a)).toThrow(/UV0/)
  a.json.materials![0].normalTexture = { index: 1, extensions: { KHR_texture_transform: { offset: [.1, 0] } } }
  expect(() => sharedMaterialKey(a)).toThrow(/UV0/)
})
