// A texture put into a GLB in place: each embedded image whose clean name has a file in a folder (the look's composite,
// textures/<clean name>.png, or a restore source) gets that file's bytes. Everything else in the file stays as it is:
// no re-import, no re-rig.
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { imageBytes, readGlb, setImageBytes, writeGlb, type Glb } from '../src/engine/glb.ts'

// (Blender's bpy.path.clean_name keeps ASCII letters, digits, _ and -, U+00FF and everything above it)
const kept = (c: number): boolean =>
  c === 0x2d || c === 0x5f || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c >= 0xff

/** Blender's bpy.path.clean_name, exactly: what textures/<name>.png is called and the server's one image name rule.
 * The browser keeps its own copy (src/engine/projection.ts cleanName); a test holds the two to the same names. */
export function cleanImageName (name: string): string {
  let out = ''
  for (const ch of name) out += kept(ch.codePointAt(0)!) ? ch : '_'
  return out
}

/** Whether two names are the same image however each was cleaned (before the rebuild '-' became _ as well). */
export const sameImage = (a: string, b: string): boolean => loose(a) === loose(b)
const loose = (name: string): string => name.replace(/[^A-Za-z0-9_]/g, '_')

/** The clean names of a GLB's named, embedded images, in its order. */
export async function imageNames (glbPath: string): Promise<string[]> {
  const glb = readGlb(await readFile(glbPath))
  return (glb.json.images ?? []).flatMap(i => (i.bufferView !== undefined && i.name !== undefined && i.name !== '' ? [cleanImageName(i.name)] : []))
}

export interface SwapReport {
  /** Images given the folder's file. */
  swapped: number
  /** Images given the restore source's file. */
  restored: number
  /** The clean names of the images either folder had a file for, changed or not. */
  matched: string[]
}

const same = (a: Uint8Array, b: Uint8Array): boolean => Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(b)

/**
 * Swap `glbPath`'s embedded images for the files in `dir` (<clean name>.png); an image with none there takes the one
 * in `restore` if it has one (the source's own image, when its layers went). Images found in neither stay as they are.
 */
export async function swapImages (glbPath: string, dir: string, restore?: string): Promise<SwapReport> {
  let glb: Glb
  try { glb = readGlb(await readFile(glbPath)) } catch { throw new Error(`${path.basename(glbPath)} is not a GLB`) }

  const report: SwapReport = { swapped: 0, restored: 0, matched: [] }
  // (each image's new bytes; only what differs)
  const replace = new Map<number, Uint8Array>()
  for (const [i, image] of (glb.json.images ?? []).entries()) {
    if (image.bufferView === undefined || image.name === undefined || image.name === '') continue
    const name = cleanImageName(image.name)
    const own = path.join(dir, `${name}.png`)
    const back = restore === undefined ? null : path.join(restore, `${name}.png`)
    const file = existsSync(own) ? own : back !== null && existsSync(back) ? back : null
    if (file === null) continue
    report.matched.push(name)
    const bytes = await readFile(file)
    const now = imageBytes(glb, i)
    if (now !== null && same(bytes, now)) continue
    replace.set(i, bytes)
    if (file === own) report.swapped++
    else report.restored++
  }
  if (replace.size === 0) return report

  // (the binary chunk laid out again in its views' order, each view's bytes or its new image's, 4-byte aligned)
  for (const [i, bytes] of replace) setImageBytes(glb, i, bytes)
  // (written beside it, then moved over it: never a half-written rig)
  const tmp = `${glbPath}.${process.pid}.tmp`
  await writeFile(tmp, writeGlb(glb.json, glb.bin))
  await rename(tmp, glbPath)
  return report
}
