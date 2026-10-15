// Edge-aware selection for painting masks: region growing on the view's color, constrained by an edge
// map built from color, surface normals and depth (so selections stop at seams, creases and silhouettes).

export interface Analysis {
  width: number
  height: number
  /** Flat (unlit) texture colors, RGBA, row 0 = top. */
  color: Uint8ClampedArray
  /** View-space normals encoded as RGB, row 0 = top. */
  normal: Uint8ClampedArray
  /** Normalized depth 0..255 (255 = nearest), 0 where there's no character. */
  depth: Uint8ClampedArray
  /** Edge strength per pixel, 0..1 (1 = hard edge / outside the character). */
  edges: Float32Array
}

/** Perceptual-ish color distance in YCbCr, 0..~1. */
function colorDistance (c: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const dr = c[i] - r
  const dg = c[i + 1] - g
  const db = c[i + 2] - b
  const dy = 0.299 * dr + 0.587 * dg + 0.114 * db
  const dcb = -0.169 * dr - 0.331 * dg + 0.5 * db
  const dcr = 0.5 * dr - 0.419 * dg - 0.081 * db
  return Math.sqrt(dy * dy * 0.6 + dcb * dcb * 1.4 + dcr * dcr * 1.4) / 160
}

export function buildEdges (a: Omit<Analysis, 'edges'>): Float32Array {
  const { width: w, height: h, color, normal, depth } = a
  const edges = new Float32Array(w * h)
  const at = (x: number, y: number): number => (y * w + x) * 4
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (color[p * 4 + 3] < 128) { edges[p] = 1; continue }
      const xl = Math.max(x - 1, 0)
      const xr = Math.min(x + 1, w - 1)
      const yu = Math.max(y - 1, 0)
      const yd = Math.min(y + 1, h - 1)
      // Color gradient (central differences in YCbCr space).
      const l = at(xl, y)
      const r = at(xr, y)
      const u = at(x, yu)
      const d = at(x, yd)
      const gc = Math.max(
        colorDistance(color, l, color[r], color[r + 1], color[r + 2]),
        colorDistance(color, u, color[d], color[d + 1], color[d + 2]),
      )
      // Normal gradient: angle change between neighbors (creases, folds, part boundaries).
      const nx = (i: number): number => normal[i] / 127.5 - 1
      const ny = (i: number): number => normal[i + 1] / 127.5 - 1
      const nz = (i: number): number => normal[i + 2] / 127.5 - 1
      const dot = (i: number, j: number): number => nx(i) * nx(j) + ny(i) * ny(j) + nz(i) * nz(j)
      const gn = Math.max(1 - dot(l, r), 1 - dot(u, d)) * 1.6
      // Depth discontinuity (a part in front of another).
      const gd = Math.max(Math.abs(depth[l] - depth[r]), Math.abs(depth[u] - depth[d])) / 18
      // Silhouette.
      const ga = color[l + 3] < 128 || color[r + 3] < 128 || color[u + 3] < 128 || color[d + 3] < 128 ? 1 : 0
      edges[p] = Math.min(1, Math.max(gc * 1.4, gn, gd, ga))
    }
  }
  return edges
}

export interface GrowOptions {
  /** 0..1: how different a color may be from the seed's before it stops. */
  tolerance: number
  /** Only grow within this circle (smart brush); omit for the whole view. */
  limit?: { x: number, y: number, radius: number }
  /** false = select every matching pixel in the view (not just connected ones). */
  contiguous?: boolean
  /** Reference color (defaults to the seed pixel's). */
  reference?: [number, number, number]
}

/** Grow a region from a seed pixel; returns the indices of selected pixels. */
export function grow (a: Analysis, seedX: number, seedY: number, options: GrowOptions): Int32Array {
  const { width: w, height: h, color, edges } = a
  const sx = Math.round(seedX)
  const sy = Math.round(seedY)
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return new Int32Array(0)
  const seed = sy * w + sx
  if (color[seed * 4 + 3] < 128) return new Int32Array(0)
  const ref = options.reference ?? [color[seed * 4], color[seed * 4 + 1], color[seed * 4 + 2]]
  const tolerance = 0.04 + options.tolerance * 0.5
  const edgeLimit = 0.25 + options.tolerance * 0.55
  const limit = options.limit
  const r2 = limit === undefined ? Infinity : limit.radius * limit.radius
  const inside = (p: number): boolean => {
    if (color[p * 4 + 3] < 128) return false
    if (limit !== undefined) {
      const dx = (p % w) - limit.x
      const dy = Math.floor(p / w) - limit.y
      if (dx * dx + dy * dy > r2) return false
    }
    return colorDistance(color, p * 4, ref[0], ref[1], ref[2]) <= tolerance
  }
  if (options.contiguous === false) {
    const out: number[] = []
    for (let p = 0; p < w * h; p++) if (inside(p) && edges[p] < 1) out.push(p)
    return Int32Array.from(out)
  }
  const visited = new Uint8Array(w * h)
  const queue = new Int32Array(w * h)
  let head = 0
  let tail = 0
  queue[tail++] = seed
  visited[seed] = 1
  while (head < tail) {
    const p = queue[head++]
    const x = p % w
    const y = (p - x) / w
    // Don't step across an edge: a strong edge pixel can be selected but not grown through.
    if (edges[p] > edgeLimit && p !== seed) continue
    const neighbors = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, y > 0 ? p - w : -1, y < h - 1 ? p + w : -1]
    for (const n of neighbors) {
      if (n < 0 || visited[n] === 1) continue
      visited[n] = 1
      if (inside(n)) queue[tail++] = n
    }
  }
  return queue.slice(0, tail)
}

/** Dilate (grow > 0) or erode (grow < 0) a binary mask by |grow| pixels. */
export function morph (mask: Uint8Array, w: number, h: number, grow: number): Uint8Array {
  let current = mask
  const on = grow > 0 ? 1 : 0
  for (let step = 0; step < Math.abs(grow); step++) {
    const next = current.slice()
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (current[p] === on) continue
        if ((x > 0 && current[p - 1] === on) || (x < w - 1 && current[p + 1] === on) || (y > 0 && current[p - w] === on) || (y < h - 1 && current[p + w] === on)) next[p] = on
      }
    }
    current = next
  }
  return current
}
