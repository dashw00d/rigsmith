// A dynamic character's look on stage (folk.ts): the skin shown laid on the body's own UVs, hair and beard pieces
// tinted to its hair colour. The body's own texture comes back with no skin; a piece's own colour with no tint.
import * as THREE from 'three'
import { FEMALE, femaleOffsets, hairTint, LONG_SLEEVE } from './folk.ts'

const loader = new THREE.TextureLoader()
const textures = new Map<string, Promise<THREE.Texture>>()

function texture (url: string): Promise<THREE.Texture> {
  let t = textures.get(url)
  if (t === undefined) {
    t = loader.loadAsync(url).then(tex => {
      // (as glTF images: not flipped, sRGB colour)
      tex.flipY = false
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })
    textures.set(url, t)
  }
  return t
}

type Textured = THREE.Material & { map?: THREE.Texture | null }

const images = new THREE.ImageLoader()
const composed = new Map<string, Promise<THREE.Texture>>()

/** The skin with the clothes laid over it (their alpha: where they cover), on a canvas the skin's size. */
function dressed (skin: string, clothes: string): Promise<THREE.Texture> {
  const key = `${skin}|${clothes}`
  let t = composed.get(key)
  if (t === undefined) {
    t = Promise.all([images.loadAsync(skin), images.loadAsync(clothes)]).then(([a, b]) => {
      const canvas = document.createElement('canvas')
      canvas.width = a.width; canvas.height = a.height
      const g = canvas.getContext('2d')!
      g.drawImage(a, 0, 0)
      g.drawImage(b, 0, 0, a.width, a.height)
      const tex = new THREE.CanvasTexture(canvas)
      tex.flipY = false
      tex.colorSpace = THREE.SRGBColorSpace
      return tex
    })
    composed.set(key, t)
  }
  return t
}

/** The body's meshes wear the skin at `url` (null: their own texture again), with the clothes at `clothes` over it
 * (null: none) and the long-sleeve shape on or off. */
export async function showSkin (body: readonly THREE.Mesh[], url: string | null, clothes: string | null = null, long = false): Promise<void> {
  for (const mesh of body) {
    const k = mesh.morphTargetDictionary?.[LONG_SLEEVE]
    if (k !== undefined && mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = long ? 1 : 0
  }
  const own = body[0]?.material as Textured | undefined
  const ownImage = ((own?.userData.ownMap as THREE.Texture | null | undefined) ?? own?.map)?.image as HTMLImageElement | ImageBitmap | undefined
  const base = url ?? (ownImage !== undefined && 'src' in ownImage ? ownImage.src : null)
  const tex = clothes !== null && base !== null ? await dressed(base, clothes) : url === null ? null : await texture(url)
  for (const mesh of body) {
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Textured[]) {
      if (!('map' in m)) continue
      if (m.userData.ownMap === undefined) m.userData.ownMap = m.map ?? null
      const next = tex ?? (m.userData.ownMap as THREE.Texture | null)
      if (m.map !== next) { m.map = next; m.needsUpdate = true }
    }
  }
}

/** A piece's meshes drawn in `hex` (#rrggbb; null: their own colour). Each gets its own material copy first: models
 * are cached and shared. */
export function tint (meshes: readonly THREE.Object3D[], hex: string | null): void {
  const rgb = hex === null ? null : hairTint(hex)
  for (const o of meshes) {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh !== true) continue
    if (mesh.userData.ownTintMaterial !== true) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone()
      mesh.userData.ownTintMaterial = true
    }
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      if (m.color === undefined) continue
      // (linear: three's colours are; the tint may pass 1 to lift a grey texture back to the colour)
      if (rgb === null) m.color.setRGB(1, 1, 1)
      else m.color.setRGB(rgb[0], rgb[1], rgb[2], THREE.SRGBColorSpace)
    }
  }
}

/** The female shape on (a skin tagged female) or off: the body's own morph, and on each worn piece the same field
 * where it sits (added to its geometry the first time), so the gear follows the body. `height`: the rest space's. */
export function shapeFemale (body: readonly THREE.Mesh[], gear: readonly THREE.Object3D[], on: boolean, height: number): void {
  for (const mesh of body) {
    const k = mesh.morphTargetDictionary?.[FEMALE]
    if (k !== undefined && mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = on ? 1 : 0
  }
  for (const o of gear) {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh !== true) continue
    if (mesh.morphTargetDictionary?.[FEMALE] === undefined) {
      if (!on) continue
      const geometry = mesh.geometry
      if (Object.keys(geometry.morphAttributes).length > 0) continue // (a piece with shapes of its own keeps them)
      geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(femaleOffsets(geometry.attributes.position.array, height), 3)]
      geometry.morphTargetsRelative = true
      mesh.updateMorphTargets()
      mesh.morphTargetDictionary = { [FEMALE]: 0 }
    }
    const k = mesh.morphTargetDictionary![FEMALE]
    if (mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = on ? 1 : 0
  }
}
