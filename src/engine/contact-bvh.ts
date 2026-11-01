import type * as THREE from 'three'
import { MeshBVH } from 'three-mesh-bvh'

type RangeCallback = (offset: number, count: number) => boolean
type Root = { bounds: Float32Array, words: Uint32Array, halves: Uint16Array }

/** Read-only views of the public version-1 serialization. Reject an unfamiliar layout before using it. */
function packedRoots (serialized: unknown): Root[] | null {
  if (serialized === null || typeof serialized !== 'object') return null
  const { version, roots } = serialized as { version?: unknown, roots?: unknown }
  if (version !== 1 || !Array.isArray(roots)) return null
  const result: Root[] = []
  for (const buffer of roots) {
    if (!(buffer instanceof ArrayBuffer) && !(typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer)) return null
    if (buffer.byteLength === 0 || buffer.byteLength % 32 !== 0) return null
    const bounds = new Float32Array(buffer)
    const words = new Uint32Array(buffer)
    const halves = new Uint16Array(buffer)
    if (words.length > 0xffffffff) return null
    // Packed nodes occupy eight words, with their left subtree immediately following the parent. A branch's
    // word at offset six is its relative right-node offset; the last word is its split axis. Leaves end in 0xffff.
    const ends = new Uint32Array(words.length / 8)
    for (let node = words.length - 8; node >= 0; node -= 8) {
      if (halves[node * 2 + 15] === 0xffff) ends[node / 8] = node + 8
      else {
        const right = node + words[node + 6] * 8
        if (words[node + 7] > 2 || right <= node + 8 || right >= words.length || ends[node / 8 + 1] !== right) return null
        ends[node / 8] = ends[right / 8]
      }
    }
    if (ends[0] !== words.length) return null
    result.push({ bounds, words, halves })
  }
  return result
}

/** The contact guard needs only the stock BVH's intersecting leaf ranges, in the stock left-to-right order.
 * Traverse its public packed serialization without constructing a Box3 for every node. These views share the
 * tree's buffers so full and partial refits remain visible; bounds, leaf ranges and triangle addressing stay
 * unchanged. An unsupported serialization uses MeshBVH.shapecast instead. */
export class ContactBVH {
  private readonly tree: MeshBVH
  private readonly roots: Root[] | null
  private readonly stack: number[] = []
  private queries = 0

  constructor (tree: MeshBVH) {
    this.tree = tree
    try { this.roots = packedRoots(MeshBVH.serialize(tree, { cloneBuffers: false })) }
    catch { this.roots = null }
  }

  shapecast (box: THREE.Box3, callback: RangeCallback): boolean {
    if (this.roots === null) return this.tree.shapecast({
      intersectsBounds: bounds => bounds.intersectsBox(box),
      intersectsRange: callback,
    })
    // A callback can query this same object again. Keep that traversal's pending nodes separate. Each query's
    // pending count is local, so an early stop or exception leaves no traversal state for the next query.
    const stack = this.queries++ === 0 ? this.stack : []
    try {
      for (const { bounds, words, halves } of this.roots) {
        let pending = 0
        let node = 0
        while (true) {
          // Stock shapecast does not test a root's own box, including when that root is a single leaf. Match
          // Box3.intersectsBox's positive comparisons in their original order, including its NaN behavior.
          if (node === 0 || (box.max.x >= bounds[node] && box.min.x <= bounds[node + 3] &&
            box.max.y >= bounds[node + 1] && box.min.y <= bounds[node + 4] &&
            box.max.z >= bounds[node + 2] && box.min.z <= bounds[node + 5])) {
            if (halves[node * 2 + 15] === 0xffff) {
              if (callback(words[node + 6], halves[node * 2 + 14])) return true
            } else {
              stack[pending++] = node + words[node + 6] * 8
              node += 8
              continue
            }
          }
          if (pending === 0) break
          node = stack[--pending]
        }
      }
      return false
    } finally {
      this.queries--
    }
  }
}
