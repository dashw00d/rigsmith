// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { expect, it } from 'vitest'
import { bodyField, composeSlots } from '../../src/engine/clothcut.ts'
import { bakeClothPng, writeClothPng } from './clothbake.ts'

const geometry = { positions: [0, 0, 0, 0, 1, 0, 1, 0, 0], uv: [0, 0, 0, 1, 1, 0], index: [0, 1, 2] }
const regions = [0, 0, 0]
const selection = { slots: ['top' as const], regions: [{ id: 0, material: 'Shirt', x: 1 }] }
const image = (width: number, height: number, fill: number[]): Buffer => {
  const png = new PNG({ width, height })
  for (let p = 0; p < width * height; p++) png.data.set(fill, p * 4)
  return PNG.sync.write(png)
}

it('bakes PNG alpha byte-for-byte as viewer composition, including feather and mask', () => {
  const src = image(8, 8, [120, 80, 40, 255]); const mask = image(8, 8, [192, 192, 192, 255])
  const cut = { below: [{ regions: [0], y: 0.5, feather: 0.1 }] }
  const actual = PNG.sync.read(bakeClothPng(src, geometry, regions, 1, cut, mask, selection))
  const decoded = PNG.sync.read(src); const maskDecoded = PNG.sync.read(mask)
  const expected = composeSlots({ base: { rgba: new Uint8ClampedArray(decoded.data.length), width: 8, height: 8 }, bare: null, field: bodyField(geometry, regions, 1, 8), regions: selection.regions, layers: [{ id: 'top', slots: selection.slots, rgba: Uint8ClampedArray.from(decoded.data), width: 8, height: 8, cut, mask: Uint8ClampedArray.from(maskDecoded.data) }] })
  expect(Array.from({ length: 64 }, (_, p) => actual.data[p * 4 + 3])).toEqual(Array.from({ length: 64 }, (_, p) => expected.rgba[p * 4 + 3]))
  expect(actual.data[3]).toBeLessThan(5)
  expect(actual.data[(6 * 8) * 4 + 3]).toBe(192)
  expect([...actual.data.slice(0, 3)]).toEqual([120, 80, 40])
  expect(() => bakeClothPng(src, geometry, regions, 1, cut, image(2, 2, [255, 255, 255, 255]), selection)).toThrow(/dimensions/)
})

it('leaves an unchanged exported PNG inode and mtime alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-clothbake-'))
  try {
    const source = path.join(dir, 'source.png'); const target = path.join(dir, 'cut.png')
    writeFileSync(source, image(8, 8, [10, 30, 50, 255]))
    const cut = { below: [{ regions: [0], y: 0.4, feather: 0 }] }
    expect(writeClothPng(source, target, geometry, regions, 1, cut, undefined, selection)).toBe(true)
    const before = statSync(target); const bytes = readFileSync(target)
    expect(writeClothPng(source, target, geometry, regions, 1, cut, undefined, selection)).toBe(false)
    const after = statSync(target)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect(readFileSync(target)).toEqual(bytes)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

it('exports the same slot-limited cut alpha and gutter as the stage', async () => {
  const { composeSlots } = await import('../../src/engine/clothcut.ts')
  const geo = {
    positions: [0, 0, 0, 0, 1, 0, 1, 0, 0, 1, 0, 0, 1, 1, 0, 2, 0, 0],
    uv: [0, 0, 0, 1, 0.3, 0, 0.7, 0, 0.7, 1, 1, 0], index: [0, 1, 2, 3, 4, 5],
  }
  const ids = [0, 0, 0, 1, 1, 1]
  const info = [{ id: 0, material: 'Shirt', x: -1 }, { id: 1, material: 'Trousers', x: 1 }]
  const src = image(12, 6, [120, 80, 40, 255]); const original = PNG.sync.read(src)
  const cut = { below: [{ regions: [1], y: 0.4, feather: 0 }] }
  const expected = composeSlots({ base: { width: 12, height: 6, rgba: new Uint8ClampedArray(12 * 6 * 4) }, bare: null,
    field: bodyField(geo, ids, 1, { width: 12, height: 6 }), regions: info,
    layers: [{ id: 'shorts', slots: ['bottom'], width: 12, height: 6, rgba: Uint8ClampedArray.from(original.data), cut }] })
  const baked = PNG.sync.read(bakeClothPng(src, geo, ids, 1, cut, undefined, { slots: ['bottom'], regions: info }))
  expect(Array.from({ length: 72 }, (_, p) => baked.data[p * 4 + 3])).toEqual(Array.from({ length: 72 }, (_, p) => expected.rgba[p * 4 + 3]))
})
