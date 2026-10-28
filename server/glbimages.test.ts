// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cleanName } from '../src/engine/projection.ts'
import { cleanImageName, imageNames, sameImage, swapImages } from './glbimages.ts'

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
    expect(await swapImages(rig, path.join(dir, 'textures'))).toEqual({ swapped: 1, restored: 0, matched: ['tex-1_a_b'] })
    const [before, image, after] = await views(rig)
    expect(before).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]))
    expect(image).toEqual(painted)
    expect(after).toEqual(Buffer.from([9, 8, 7, 6]))
    // (the same again: nothing to do, though the image still has its file)
    expect(await swapImages(rig, path.join(dir, 'textures'))).toEqual({ swapped: 0, restored: 0, matched: ['tex-1_a_b'] })
  })

  it('puts an image back from the restore source when its composite is gone', async () => {
    const rig = path.join(dir, 'rigged.glb')
    await writeFile(rig, glb(Buffer.from('painted over')))
    await mkdir(path.join(dir, 'restore'))
    await writeFile(path.join(dir, 'restore', 'tex-1_a_b.png'), Buffer.from('as the source has it'))
    expect(await swapImages(rig, path.join(dir, 'no-textures'), path.join(dir, 'restore'))).toEqual({ swapped: 0, restored: 1, matched: ['tex-1_a_b'] })
    expect((await views(rig))[1]).toEqual(Buffer.from('as the source has it'))
  })

  it('prefers the composite to the restore source, and leaves images neither has', async () => {
    const rig = path.join(dir, 'rigged.glb')
    await writeFile(rig, glb(Buffer.from('old'), 'Body'))
    await mkdir(path.join(dir, 'textures')); await mkdir(path.join(dir, 'restore'))
    await writeFile(path.join(dir, 'textures', 'Body.png'), Buffer.from('composite'))
    await writeFile(path.join(dir, 'restore', 'Body.png'), Buffer.from('source'))
    expect((await swapImages(rig, path.join(dir, 'textures'), path.join(dir, 'restore'))).swapped).toBe(1)
    expect((await views(rig))[1]).toEqual(Buffer.from('composite'))
    expect(await swapImages(rig, path.join(dir, 'restore-elsewhere'))).toEqual({ swapped: 0, restored: 0, matched: [] })
    expect(await imageNames(rig)).toEqual(['Body'])
  })
})

describe('image names', () => {
  // What Blender 5.2's bpy.path.clean_name makes of each (it keeps '-', U+00FF and everything above U+00FF).
  const names: Array<[string, string]> = [
    ['Diffuse Texture', 'Diffuse_Texture'],
    ['tripo_rgb_c141c76d-3257-46b4-83da-8d803f5a26f2', 'tripo_rgb_c141c76d-3257-46b4-83da-8d803f5a26f2'],
    ['tex-1 a.b', 'tex-1_a_b'],
    ['Image_0', 'Image_0'],
    ['_albedo', '_albedo'],
    ['a/b\\c:d', 'a_b_c_d'],
    ['Üé ÿ', '___ÿ'],
    ['名前.png', '名前_png'],
    ['x\u0000y~z', 'x_y_z'],
    ['', ''],
  ]

  it('cleans as Blender does, the same on the server and in the browser', () => {
    for (const [name, clean] of names) {
      expect(cleanImageName(name)).toBe(clean)
      expect(cleanName(name)).toBe(clean)
    }
  })

  it('takes a name cleaned before the rebuild (- made _) for the same image', () => {
    expect(sameImage('tripo_rgb_c141c76d_3257', 'tripo_rgb_c141c76d-3257')).toBe(true)
    expect(sameImage('Diffuse Texture', 'Diffuse_Texture')).toBe(true)
    expect(sameImage('Image_0', 'Image_1')).toBe(false)
  })
})
