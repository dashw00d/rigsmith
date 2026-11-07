/// <reference lib="webworker" />
import { bodyField, makeBare } from '../clothcut.ts'
import { regionsOf } from '../regions.ts'

interface MeshData { positions: Float32Array, uv: Float32Array, index: Uint32Array | Uint16Array | null, matrix: number[], material: string }
interface Request { url: string, meshes: MeshData[], height: number }
const worker = self as unknown as DedicatedWorkerGlobalScope
worker.onmessage = (event: MessageEvent<Request>) => { void run(event.data).catch((error: unknown) => worker.postMessage({ error: error instanceof Error ? error.message : String(error) })) }
async function run ({ url, meshes, height }: Request): Promise<void> {
  worker.postMessage({ progress: 0.05 })
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Skin image: HTTP ${response.status}`)
  const bitmap = await createImageBitmap(await response.blob())
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (ctx === null) throw new Error('Cannot read skin image')
  ctx.drawImage(bitmap, 0, 0); bitmap.close()
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  let count = 0; let triangles = 0
  for (const mesh of meshes) { count += mesh.positions.length / 3; triangles += mesh.index?.length ?? mesh.positions.length / 3 }
  const positions = new Float32Array(count * 3); const uv = new Float32Array(count * 2); const index = new Uint32Array(triangles)
  let offset = 0; let at = 0
  const ranges: Array<{ start: number, end: number, material: string }> = []
  for (const mesh of meshes) {
    const n = mesh.positions.length / 3; const m = mesh.matrix
    ranges.push({ start: offset, end: offset + n, material: mesh.material })
    for (let i = 0; i < n; i++) {
      const x = mesh.positions[i * 3]; const y = mesh.positions[i * 3 + 1]; const z = mesh.positions[i * 3 + 2]
      positions.set([m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]], (offset + i) * 3)
      uv.set(mesh.uv.subarray(i * 2, i * 2 + 2), (offset + i) * 2)
    }
    for (let i = 0; i < (mesh.index?.length ?? n); i++) index[at++] = offset + (mesh.index?.[i] ?? i)
    offset += n
  }
  const regions = regionsOf(index, count)
  const skin = new Set<number>(); const clothes = new Set<number>()
  for (const range of ranges) {
    const target = /face|skin|neck|hand/i.test(range.material) ? skin : /shirt|trouser|pants/i.test(range.material) ? clothes : null
    if (target !== null) for (let i = range.start; i < range.end; i++) if (regions.of[i] >= 0) target.add(regions.of[i])
  }
  if (skin.size === 0 || clothes.size === 0) throw new Error('Body needs named Skin/Face and Shirt/Trousers materials')
  worker.postMessage({ progress: 0.3 })
  const field = bodyField({ positions, uv, index }, regions.of, height, { width: canvas.width, height: canvas.height })
  worker.postMessage({ progress: 0.65 })
  image.data.set(makeBare(image.data, field, [...skin], [...clothes]))
  ctx.putImageData(image, 0, 0)
  const png = await canvas.convertToBlob({ type: 'image/png' })
  worker.postMessage({ progress: 1, png })
}
