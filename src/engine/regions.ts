// The body's regions: the pieces its seams cut it into. A seam is where the body's vertices are split (a material
// border, a UV island border), so a region is a connected run of triangles sharing vertices. Gear hides the body by
// whole regions: a piece that covers a region (nearly) everywhere hides all of it, so the body always stops at a seam
// it covers (a boot over the trouser cuff hides the foot and the cuff band, up to the highest ring it covers), never
// along a ragged line of triangles. The game gets the regions with the body (each vertex's region) and what each
// piece hides, so a unit can hide them for whichever pieces it wears (the dynamic character's outfits).

/** Every vertex's region (-1: in no triangle), the regions' sizes. */
export interface Regions {
  of: Int32Array
  count: number
  /** Vertices per region. */
  vertices: Int32Array
}

/** The connected runs of triangles of `index` (shared vertex = connected), numbered by their smallest vertex, so the
 * same mesh always numbers them the same. */
export function regionsOf (index: ArrayLike<number>, vertexCount: number): Regions {
  const parent = new Int32Array(vertexCount)
  for (let i = 0; i < vertexCount; i++) parent[i] = i
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  const used = new Uint8Array(vertexCount)
  for (let t = 0; t + 2 < index.length; t += 3) {
    const a = find(index[t]); const b = find(index[t + 1]); const c = find(index[t + 2])
    used[index[t]] = used[index[t + 1]] = used[index[t + 2]] = 1
    // (the smaller root wins: stable numbering whatever the triangle order)
    const r = Math.min(a, b, c)
    parent[a] = r; parent[b] = r; parent[c] = r
  }
  // (a component's root is its smallest vertex: regions numbered in that order, whatever the triangle order)
  const of = new Int32Array(vertexCount).fill(-1)
  const ids = new Map<number, number>()
  const sizes: number[] = []
  for (let v = 0; v < vertexCount; v++) {
    if (used[v] === 0) continue
    const root = find(v)
    let id = ids.get(root)
    if (id === undefined) { id = ids.size; ids.set(root, id); sizes.push(0) }
    of[v] = id
    sizes[id]++
  }
  return { of, count: ids.size, vertices: Int32Array.from(sizes) }
}

/** A region is hidden when at least this share of its vertices is covered: a stray vertex a piece's edge misses
 * doesn't keep it, while a piece stopping partway along it (a bracer on half the forearm) does. High, because a region
 * hidden where the piece doesn't quite reach is a hole, worse than skin the piece (skinned like the body) mostly keeps
 * under it anyway. */
export const HIDE_SHARE = 0.97

/** The regions `covered` (per vertex, 1 = a piece lies just outside it) hides, ascending. */
export function hiddenRegions (regions: Regions, covered: ArrayLike<number>, share = HIDE_SHARE): number[] {
  const hits = new Int32Array(regions.count)
  for (let v = 0; v < regions.of.length; v++) {
    const r = regions.of[v]
    if (r >= 0 && covered[v] !== 0) hits[r]++
  }
  const out: number[] = []
  for (let r = 0; r < regions.count; r++) if (regions.vertices[r] > 0 && hits[r] >= share * regions.vertices[r]) out.push(r)
  return out
}

/** `index` without the triangles of the `hidden` regions. */
export function withoutRegions (index: ArrayLike<number>, regions: Regions, hidden: Iterable<number>): number[] {
  const gone = new Set(hidden)
  const kept: number[] = []
  for (let t = 0; t + 2 < index.length; t += 3) {
    if (gone.has(regions.of[index[t]])) continue
    kept.push(index[t], index[t + 1], index[t + 2])
  }
  return kept
}

/** Regions as a bit mask (the game's per-unit "hidden regions" value): region r is bit r. Regions past 31 can't be
 * hidden by mask; `bits` says which did not fit. */
export function regionMask (hidden: Iterable<number>): { mask: number, unfit: number[] } {
  let mask = 0
  const unfit: number[] = []
  for (const r of hidden) {
    if (r >= 0 && r < 31) mask |= 1 << r
    else unfit.push(r)
  }
  return { mask, unfit }
}
