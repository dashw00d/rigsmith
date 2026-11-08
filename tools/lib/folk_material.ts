// Embedded PBR maps carried to the game's folk atlas builder. Values are linear except albedo.
import { createHash } from 'node:crypto'
import { baseColorImage, imageBytes, type Glb } from '../../src/engine/glb.ts'

interface Texture { index: number, texCoord?: number, extensions?: unknown }
interface Material {
  pbrMetallicRoughness?: { baseColorTexture?: Texture, metallicRoughnessTexture?: Texture, metallicFactor?: number, roughnessFactor?: number, baseColorFactor?: number[] }
  normalTexture?: Texture & { scale?: number }
  occlusionTexture?: Texture & { strength?: number }
}

export function folkMaterial (glb: Glb): { maps: Record<string, number | null>, factors: { metallic: number, roughness: number, occlusion: number } } {
  const materials = (glb.json.materials ?? []) as Material[]
  const m = materials.find(m => m.pbrMetallicRoughness?.metallicRoughnessTexture !== undefined) ?? materials[0]
  const image = (t: Texture | undefined): number | null => {
    const i = t === undefined ? undefined : glb.json.textures?.[t.index]?.source
    return i !== undefined && glb.json.images?.[i]?.bufferView !== undefined ? i : null
  }
  return {
    maps: { albedo: baseColorImage(glb), normal: image(materials.find(m => m.normalTexture !== undefined)?.normalTexture), mr: image(m?.pbrMetallicRoughness?.metallicRoughnessTexture), occlusion: image(m?.occlusionTexture) },
    factors: { metallic: m?.pbrMetallicRoughness?.metallicFactor ?? 1, roughness: m?.pbrMetallicRoughness?.roughnessFactor ?? 1, occlusion: m?.occlusionTexture?.strength ?? 1 },
  }
}

/** A shared atlas is opt-in and must really be the same material on UV0. Never silently share unlike maps. */
export function sharedMaterialKey (glb: Glb): string {
  if (glb.json.materials?.length !== 1) throw new Error('A shared folk atlas requires one material per piece')
  const m = glb.json.materials[0] as Material
  if (m.pbrMetallicRoughness?.baseColorTexture === undefined) throw new Error('A shared folk atlas needs embedded albedo')
  if ((m.pbrMetallicRoughness.baseColorFactor ?? [1, 1, 1, 1]).some(v => v !== 1) || (m.normalTexture?.scale ?? 1) !== 1) {
    throw new Error('Bake base colour factors and normal strength into shared folk atlas maps first')
  }
  for (const t of [m.pbrMetallicRoughness?.baseColorTexture, m.pbrMetallicRoughness?.metallicRoughnessTexture, m.normalTexture, m.occlusionTexture]) {
    if (t !== undefined && ((t.texCoord ?? 0) !== 0 || t.extensions !== undefined)) throw new Error('A shared folk atlas requires untransformed UV0 textures')
  }
  const { maps, factors } = folkMaterial(glb)
  if (maps.albedo === null) throw new Error('A shared folk atlas needs embedded albedo')
  const hash = createHash('sha256')
  hash.update(JSON.stringify({ factors, base: m.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1], normal: m.normalTexture?.scale ?? 1 }))
  for (const [kind, index] of Object.entries(maps)) {
    hash.update(kind)
    if (index === null) { hash.update('absent'); continue }
    const bytes = imageBytes(glb, index)
    if (bytes === null) throw new Error('A shared folk atlas requires embedded maps')
    hash.update(createHash('sha256').update(bytes).digest())
  }
  return hash.digest('hex')
}
