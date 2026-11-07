// The export uses exactly the same body field and cut alpha as the stage, on straight-alpha PNG pixels.
import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { bodyField, composeSlots, type BodyGeometry, type RegionInfo } from '../../src/engine/clothcut.ts'
import type { ClothCut, ClothSlot } from '../../src/model/types.ts'
import { writeIfChanged } from './atomic.ts'

export function bakeClothPng (source: Uint8Array, geometry: BodyGeometry, regions: ArrayLike<number>, height: number, cut: ClothCut, mask: Uint8Array | undefined, selection: { slots: readonly ClothSlot[], regions: readonly RegionInfo[] }): Buffer {
  const image = PNG.sync.read(Buffer.from(source))
  const maskImage = mask === undefined ? undefined : PNG.sync.read(Buffer.from(mask))
  if (maskImage !== undefined && (maskImage.width !== image.width || maskImage.height !== image.height)) throw new Error('Cloth mask dimensions do not match the layer PNG')
  const field = bodyField(geometry, regions, height, { width: image.width, height: image.height })
  const sourcePixels = Uint8ClampedArray.from(image.data)
  const result = composeSlots({
    base: { rgba: new Uint8ClampedArray(sourcePixels.length), width: image.width, height: image.height },
    bare: null, field, regions: selection.regions,
    layers: [{ id: 'export', slots: selection.slots, width: image.width, height: image.height, rgba: sourcePixels, cut,
      mask: maskImage === undefined ? undefined : Uint8ClampedArray.from(maskImage.data) }],
  })
  // Preserve source RGB in transparent texels so linear filtering does not introduce a black fringe.
  for (let i = 3; i < sourcePixels.length; i += 4) sourcePixels[i] = result.rgba[i]
  image.data = Buffer.from(sourcePixels)
  return PNG.sync.write(image)
}

/** Write atomically and keep the prior inode and mtime if the cut produces the same bytes. */
export function writeClothPng (source: string, target: string, geometry: BodyGeometry, regions: ArrayLike<number>, height: number, cut: ClothCut, mask: string | undefined, selection: { slots: readonly ClothSlot[], regions: readonly RegionInfo[] }): boolean {
  return writeIfChanged(target, bakeClothPng(readFileSync(source), geometry, regions, height, cut, mask === undefined ? undefined : readFileSync(mask), selection))
}
