// A texture changed (painted, filled, restored) put into a GLB in place: each embedded image whose name has an
// override (<dir>/<clean name>.png, as Blender's import takes them: bpy.path.clean_name) gets the override's bytes.
// Everything else in the file stays as it is: no re-import, no re-rig.
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'

interface Gltf {
  images?: Array<{ name?: string, bufferView?: number, uri?: string, mimeType?: string }>
  bufferViews: Array<{ buffer: number, byteOffset?: number, byteLength: number, byteStride?: number }>
  buffers: Array<{ byteLength: number, uri?: string }>
}

/** Blender's bpy.path.clean_name: every character but ASCII letters, digits and _ made _. */
export const cleanImageName = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')

const pad4 = (n: number): number => (n + 3) & ~3

/**
 * Swap `glbPath`'s embedded images for the overrides in `dir` (by name); with `restore`, images with no override go
 * back to `original`'s (the same file as first made: an override taken away). Returns how many images changed.
 */
export async function swapImages (glbPath: string, dir: string, original?: string): Promise<number> {
  const glb = await readFile(glbPath)
  if (glb.readUInt32LE(0) !== 0x46546C67) throw new Error(`${path.basename(glbPath)} is not a GLB`)
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf
  const binStart = 20 + jsonLength + 8
  const binLength = glb.readUInt32LE(20 + jsonLength)
  const bin = glb.subarray(binStart, binStart + binLength)

  // (each image's new bytes, by its buffer view)
  const replace = new Map<number, { bytes: Buffer, image: number }>()
  let from: { gltf: Gltf, bin: Buffer } | null = null
  for (const [i, image] of (gltf.images ?? []).entries()) {
    if (image.bufferView === undefined || image.name === undefined) continue
    const file = path.join(dir, `${cleanImageName(image.name)}.png`)
    if (existsSync(file)) { replace.set(image.bufferView, { bytes: await readFile(file), image: i }); continue }
    if (original === undefined || !existsSync(original)) continue
    // (no override: the image as the original file has it, found by the same name)
    from ??= await openGlb(original)
    const theirs = from.gltf.images?.find(x => x.name === image.name && x.bufferView !== undefined)
    if (theirs === undefined) continue
    const view = from.gltf.bufferViews[theirs.bufferView!]
    const bytes = from.bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    replace.set(image.bufferView, { bytes: Buffer.from(bytes), image: i })
  }
  // (only what differs)
  for (const [v, r] of [...replace]) {
    const view = gltf.bufferViews[v]
    const now = bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    if (now.equals(r.bytes)) replace.delete(v)
  }
  if (replace.size === 0) return 0

  // The binary chunk laid out again in its views' order, each view's bytes (or its new image's), 4-byte aligned.
  const order = gltf.bufferViews.map((v, i) => i).filter(i => gltf.bufferViews[i].buffer === 0)
    .sort((a, b) => (gltf.bufferViews[a].byteOffset ?? 0) - (gltf.bufferViews[b].byteOffset ?? 0))
  const pieces: Buffer[] = []
  let at = 0
  for (const i of order) {
    const view = gltf.bufferViews[i]
    const r = replace.get(i)
    const bytes = r !== undefined ? r.bytes : bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
    const start = pad4(at)
    if (start > at) pieces.push(Buffer.alloc(start - at))
    pieces.push(bytes)
    view.byteOffset = start
    view.byteLength = bytes.length
    at = start + bytes.length
    if (r !== undefined) gltf.images![r.image].mimeType = 'image/png'
  }
  if (pad4(at) > at) pieces.push(Buffer.alloc(pad4(at) - at))
  const newBin = Buffer.concat(pieces)
  gltf.buffers[0].byteLength = newBin.length

  let json = Buffer.from(JSON.stringify(gltf), 'utf8')
  if (json.length % 4 !== 0) json = Buffer.concat([json, Buffer.alloc(4 - (json.length % 4), 0x20)])
  const out = Buffer.alloc(12 + 8 + json.length + 8 + newBin.length)
  out.writeUInt32LE(0x46546C67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(out.length, 8)
  out.writeUInt32LE(json.length, 12); out.writeUInt32LE(0x4E4F534A, 16); json.copy(out, 20)
  const b = 20 + json.length
  out.writeUInt32LE(newBin.length, b); out.writeUInt32LE(0x004E4942, b + 4); newBin.copy(out, b + 8)
  // (written beside it, then moved over it: never a half-written rig)
  const tmp = `${glbPath}.${process.pid}.tmp`
  await writeFile(tmp, out)
  await rename(tmp, glbPath)
  return replace.size
}

async function openGlb (file: string): Promise<{ gltf: Gltf, bin: Buffer }> {
  const glb = await readFile(file)
  const jsonLength = glb.readUInt32LE(12)
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf
  const binStart = 20 + jsonLength + 8
  return { gltf, bin: glb.subarray(binStart, binStart + glb.readUInt32LE(20 + jsonLength)) }
}
