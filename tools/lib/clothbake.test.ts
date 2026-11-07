// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PNG } from 'pngjs'
import { expect, it } from 'vitest'
import { bodyField, cutAlpha } from '../../src/engine/clothcut.ts'
import { bakeClothPng, writeClothPng } from './clothbake.ts'

const geometry = { positions: [0, 0, 0, 0, 1, 0, 1, 0, 0], uv: [0, 0, 0, 1, 1, 0], index: [0, 1, 2] }
const regions = [0, 0, 0]
const image = (width: number, height: number, fill: number[]): Buffer => {
  const png = new PNG({ width, height })
  for (let p = 0; p < width * height; p++) png.data.set(fill, p * 4)
  return PNG.sync.write(png)
}

it('bakes PNG alpha byte-for-byte as viewer cutAlpha, including feather and mask', () => {
  const src = image(8, 8, [120, 80, 40, 255]); const mask = image(8, 8, [192, 192, 192, 255])
  const cut = { below: [{ regions: [0], y: 0.5, feather: 0.1 }] }
  const actual = PNG.sync.read(bakeClothPng(src, geometry, regions, 1, cut, mask))
  const decoded = PNG.sync.read(src); const maskDecoded = PNG.sync.read(mask)
  const expected = cutAlpha(Uint8ClampedArray.from(decoded.data), 8, 8, bodyField(geometry, regions, 1, 8), cut, Uint8ClampedArray.from(maskDecoded.data))
  expect([...actual.data]).toEqual([...expected])
  expect(actual.data[3]).toBeLessThan(5)
  expect(actual.data[(6 * 8) * 4 + 3]).toBe(192)
  expect([...actual.data.slice(0, 3)]).toEqual([120, 80, 40])
  expect(() => bakeClothPng(src, geometry, regions, 1, cut, image(2, 2, [255, 255, 255, 255]))).toThrow(/dimensions/)
})

it('leaves an unchanged exported PNG inode and mtime alone', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'rigsmith-clothbake-'))
  try {
    const source = path.join(dir, 'source.png'); const target = path.join(dir, 'cut.png')
    writeFileSync(source, image(8, 8, [10, 30, 50, 255]))
    const cut = { below: [{ regions: [0], y: 0.4, feather: 0 }] }
    expect(writeClothPng(source, target, geometry, regions, 1, cut)).toBe(true)
    const before = statSync(target); const bytes = readFileSync(target)
    expect(writeClothPng(source, target, geometry, regions, 1, cut)).toBe(false)
    const after = statSync(target)
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs])
    expect(readFileSync(target)).toEqual(bytes)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
