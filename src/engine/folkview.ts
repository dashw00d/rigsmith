// A dynamic character's look on stage (folk.ts): the skin shown laid on the body's own UVs, hair and beard pieces
// tinted to its hair colour. The body's own texture comes back with no skin; a piece's own colour with no tint.
import * as THREE from 'three'
import { FEMALE, femaleOffsets, hairTint, LONG_SLEEVE } from './folk.ts'
import { Lru, MB, textureBytes } from './lru.ts'

type Picture = ImageBitmap | HTMLImageElement | HTMLCanvasElement

const sizeOf = (p: { width: number, height: number }): number => p.width * p.height * 4
/** Decoded images by URL (content-addressed: src/engine/assetUrls.ts), decoded off the main thread where the browser
 * can. Not closed when let go: a texture made from one may still be drawn. */
const pictures = new Lru<Picture>({ budget: 640 * MB, max: 96, size: sizeOf })
/** Textures made from them: a skin, or a skin with clothes laid over it (by both URLs), on the GPU once drawn. */
const textures = new Lru<THREE.Texture>({ budget: 384 * MB, max: 48, size: textureBytes, dispose: t => { t.dispose() } })

const images = new THREE.ImageLoader()

/** An image decoded (createImageBitmap off the main thread; else an <img>), as glTF images are: not flipped, colour
 * as it is in the file. */
async function picture (url: string): Promise<Picture> {
  return await pictures.load(url, async () => {
    if (typeof createImageBitmap !== 'function' || typeof fetch !== 'function') return await images.loadAsync(url)
    const res = await fetch(url)
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.split('?')[0]}`)
    return await createImageBitmap(await res.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  })
}

function glTexture<T extends THREE.Texture> (tex: T): T {
  // (as glTF images: not flipped, sRGB colour)
  tex.flipY = false
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

async function texture (url: string): Promise<THREE.Texture> {
  return await textures.load(url, async () => glTexture(new THREE.Texture(await picture(url) as never)))
}

type Textured = THREE.Material & { map?: THREE.Texture | null }

/** The skin with the clothes laid over it (their alpha: where they cover), on a canvas the skin's size. `skin` is a
 * URL, or the body's own picture (its key `own`). */
async function dressed (skin: string | { own: Picture, key: string }, clothes: string): Promise<THREE.Texture> {
  const key = `${typeof skin === 'string' ? skin : skin.key}|${clothes}`
  return await textures.load(key, async () => {
    const [a, b] = await Promise.all([typeof skin === 'string' ? picture(skin) : skin.own, picture(clothes)])
    const canvas = document.createElement('canvas')
    canvas.width = a.width; canvas.height = a.height
    const g = canvas.getContext('2d')!
    g.drawImage(a, 0, 0)
    g.drawImage(b, 0, 0, a.width, a.height)
    return glTexture(new THREE.CanvasTexture(canvas))
  })
}

/** Skins' and clothes' images fetched and decoded ahead (the next ones Randomize or the pickers may show), when
 * there is time. */
export async function preloadPictures (urls: Iterable<string>): Promise<void> {
  for (const url of urls) await picture(url).catch(() => {})
}

// (the newest call per body wins: a skin that loads after the next was picked is not put on)
const turns = new WeakMap<object, number>()

/** The body's meshes wear the skin at `url` (null: their own texture again), with the clothes at `clothes` over it
 * (null: none) and the long-sleeve shape on or off. */
export async function showSkin (body: readonly THREE.Mesh[], url: string | null, clothes: string | null = null, long = false): Promise<void> {
  const first = body[0]
  if (first === undefined) return
  const turn = (turns.get(first) ?? 0) + 1
  turns.set(first, turn)
  const own = first.material as Textured
  const ownMap = (own.userData.ownMap as THREE.Texture | null | undefined) ?? own.map ?? null
  const ownImage = ownMap?.image as Picture | undefined
  const base = url ?? (ownImage !== undefined && ownImage !== null && 'width' in ownImage ? { own: ownImage, key: `own:${ownMap!.uuid}` } : null)
  const tex = clothes !== null && base !== null ? await dressed(base, clothes) : url === null ? null : await texture(url)
  if (turns.get(first) !== turn) return
  for (const mesh of body) {
    const k = mesh.morphTargetDictionary?.[LONG_SLEEVE]
    if (k !== undefined && mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = long ? 1 : 0
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as Textured[]) {
      if (!('map' in m)) continue
      if (m.userData.ownMap === undefined) m.userData.ownMap = m.map ?? null
      const next = tex ?? (m.userData.ownMap as THREE.Texture | null)
      // (a map for a map needs no new shader; none for one, or one for none, does)
      if (m.map !== next) { if ((m.map == null) !== (next === null)) m.needsUpdate = true; m.map = next }
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

/** Whether the body has the female shape (its own morph). */
export function hasFemaleShape (body: readonly THREE.Mesh[]): boolean {
  return body.some(m => m.morphTargetDictionary?.[FEMALE] !== undefined)
}

/** The female shape's field put on a worn piece's meshes (off), where they lack it: done as it is worn, so a female
 * skin shown later only turns it on (a shape added then would make every piece's shaders compile again). A piece
 * with shapes of its own keeps them. */
export function prepareFemale (gear: readonly THREE.Object3D[], height: number): void {
  for (const o of gear) {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh !== true || mesh.morphTargetDictionary?.[FEMALE] !== undefined) continue
    const geometry = mesh.geometry
    if (Object.keys(geometry.morphAttributes).length > 0) continue
    geometry.morphAttributes.position = [new THREE.Float32BufferAttribute(femaleOffsets(geometry.attributes.position.array, height), 3)]
    geometry.morphTargetsRelative = true
    mesh.updateMorphTargets()
    mesh.morphTargetDictionary = { [FEMALE]: 0 }
    if (mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[0] = 0
  }
}

/** The female shape on (a skin tagged female) or off: the body's own morph, and on each worn piece the same field
 * where it sits (added to its geometry the first time: prepareFemale), so the gear follows the body. `height`: the
 * rest space's. */
export function shapeFemale (body: readonly THREE.Mesh[], gear: readonly THREE.Object3D[], on: boolean, height: number): void {
  for (const mesh of body) {
    const k = mesh.morphTargetDictionary?.[FEMALE]
    if (k !== undefined && mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = on ? 1 : 0
  }
  if (on) prepareFemale(gear, height)
  for (const o of gear) {
    const mesh = o as THREE.Mesh
    const k = mesh.isMesh === true ? mesh.morphTargetDictionary?.[FEMALE] : undefined
    if (k !== undefined && mesh.morphTargetInfluences !== undefined) mesh.morphTargetInfluences[k] = on ? 1 : 0
  }
}
