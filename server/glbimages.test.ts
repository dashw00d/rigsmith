// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanImageName, swapImages } from './glbimages.ts'

let dir = ''
beforeEach(async () => { dir = await mkdtemp(path.join(os.tmpdir(), 'rigsmith-glbimages-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

/** A GLB: some vertex data (6 bytes: not a multiple of 4), an image, more data after it. */
function glb (image: Buffer, name = 'tex-1 a.b'): Buffer {
  const before = Buffer.from([1, 2, 3, 4, 5, 6]); const after = Buffer.from([9, 8, 7, 6])
  const pad = (n: number): number => (n + 3) & ~3
  const offsets = [0, pad(before.length), pad(pad(before.length) + image.length)]
  const bin = Buffer.alloc(offsets[2] + after.length)
  before.copy(bin, offsets[0]); image.copy(bin, offsets[1]); after.copy(bin, offsets[2])
  const gltf = {
    asset: { version: '2.0' },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: offsets[0], byteLength: before.length }, { buffer: 0, byteOffset: offsets[1], byteLength: image.length }, { buffer: 0, byteOffset: offsets[2], byteLength: after.length }],
    images: [{ name, bufferView: 1, mimeType: 'image/png' }],
  }
  let json = Buffer.from(JSON.stringify(gltf))
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)])
  const out = Buffer.alloc(28 + json.length + bin.length)
  out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
  out.writeUInt32LE(bin.length, 20 + json.length); out.writeUInt32LE(0x004E4942, 24 + json.length); bin.copy(out, 28 + json.length)
  return out
}

/** Each buffer view's bytes, by index. */
async function views (file: string): Promise<Buffer[]> {
  const b = await readFile(file)
  const n = b.readUInt32LE(12)
  const gltf = JSON.parse(b.subarray(20, 20 + n).toString()) as { bufferViews: Array<{ byteOffset: number, byteLength: number }>, buffers: Array<{ byteLength: number }> }
  const bin = b.subarray(28 + n, 28 + n + b.readUInt32LE(20 + n))
  expect(gltf.buffers[0].byteLength).toBe(bin.length)
  expect(b.readUInt32LE(8)).toBe(b.length)
  return gltf.bufferViews.map(v => { expect(v.byteOffset % 4).toBe(0); return Buffer.from(bin.subarray(v.byteOffset, v.byteOffset + v.byteLength)) })
}

describe('a texture put into a GLB in place', () => {
  it('swaps the image by its clean name and keeps every other byte', async () => {
    const rig = path.join(dir, 'rigged.glb')
    await writeFile(rig, glb(Buffer.from('old image')))
    await mkdir(path.join(dir, 'textures'))
    const painted = Buffer.from('a longer painted image!')
    await writeFile(path.join(dir, 'textures', `${cleanImageName('tex-1 a.b')}.png`), painted)
    expect(await swapImages(rig, path.join(dir, 'textures'))).toBe(1)
    const [before, image, after] = await views(rig)
    expect(before).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
    expect(image).toEqual(painted)
    expect(after).toEqual(Buffer.from([9, 8, 7, 6]))
    // (the same again: nothing to do)
    expect(await swapImages(rig, path.join(dir, 'textures'))).toBe(0)
  })

  it('puts an image back as the original has it when its override is gone', async () => {
    const rig = path.join(dir, 'rigged.glb'); const model = path.join(dir, 'model.glb')
    await writeFile(rig, glb(Buffer.from('painted over')))
    await writeFile(model, glb(Buffer.from('as made')))
    expect(await swapImages(rig, path.join(dir, 'no-textures'), model)).toBe(1)
    expect((await views(rig))[1]).toEqual(Buffer.from('as made'))
  })
})
