// The export uses exactly the same body field and cut alpha as the stage, on straight-alpha PNG pixels.
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { bodyField, cutAlpha, type BodyGeometry } from '../../src/engine/clothcut.ts'
import type { ClothCut } from '../../src/model/types.ts'
import { writeIfChanged } from './atomic.ts'

export function bakeClothPng (source: Uint8Array, geometry: BodyGeometry, regions: ArrayLike<number>, height: number, cut: ClothCut, mask?: Uint8Array): Buffer {
  const image = PNG.sync.read(Buffer.from(source))
  const maskImage = mask === undefined ? undefined : PNG.sync.read(Buffer.from(mask))
  if (maskImage !== undefined && (maskImage.width !== image.width || maskImage.height !== image.height)) throw new Error('Cloth mask dimensions do not match the layer PNG')
  const field = bodyField(geometry, regions, height, { width: image.width, height: image.height })
  const pixels = cutAlpha(Uint8ClampedArray.from(image.data), image.width, image.height, field, cut,
    maskImage === undefined ? undefined : Uint8ClampedArray.from(maskImage.data))
  image.data = Buffer.from(pixels)
  return PNG.sync.write(image)
}

/** Write atomically and keep the prior inode and mtime if the cut produces the same bytes. */
export function writeClothPng (source: string, target: string, geometry: BodyGeometry, regions: ArrayLike<number>, height: number, cut: ClothCut, mask?: string): boolean {
  return writeIfChanged(target, bakeClothPng(readFileSync(source), geometry, regions, height, cut, mask === undefined ? undefined : readFileSync(mask)))
}
