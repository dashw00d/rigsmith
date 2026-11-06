// Layer order, as the pose optimizer keeps it (tools/skin_opt/layers.py): a sheet over another at rest (a coat over the
// thigh, a shirt over the belly) must stay over it when posed. The validator counts the points that went through, so a
// skin that lets the thigh come up through the coat loses to one that doesn't (the designer, 2026-11-01: "this is an
// issue many of the models have for many animations").
//
// Pairs are found at rest: from each point along its normal, both ways, the nearest triangle whose front faces it,
// within `reach` of the height, outside the point's own two rings of edges (seams welded). Only pairs weights can
// answer: the trunk over the trunk or a leg, a leg over its own leg; an arm and the body, or one leg and the other,
// meet because the clip puts them there. A pair has crossed when the point is behind its triangle's plane as posed
// while still over the triangle (its foot within twice the rest gap and a hundredth of the height of the hit point).

/** The limbs a bone belongs to: its first ancestor (or itself) among these, else the trunk. */
const LIMBS = new Map([['LeftArm', 'LeftArm'], ['RightArm', 'RightArm'], ['LeftShoulder', 'LeftArm'], ['RightShoulder', 'RightArm'],
  ['LeftUpLeg', 'LeftUpLeg'], ['RightUpLeg', 'RightUpLeg'], ['Neck', 'Head'], ['Head', 'Head']])

/** Each bone's limb (`parents[i]`: the index of its parent, -1 for a root). */
export function limbOf (names: readonly string[], parents: readonly number[]): string[] {
  return names.map((_, b) => {
    for (let c = b; c >= 0; c = parents[c]) {
      const limb = LIMBS.get(names[c])
      if (limb !== undefined) return limb
    }
    return 'trunk'
  })
}

/** Whether weights can keep these limbs' layers apart (a: the point's limb, b: the triangle's). */
export function keepPair (a: string, b: string): boolean {
  if (a.includes('Arm') || b.includes('Arm') || a === 'Head' || b === 'Head') return false
  return a === b || a === 'trunk' || b === 'trunk'
}

export interface LayerPairs {
  /** The point over another layer (a vertex index of the positions). */
  point: Int32Array
  /** The triangle under it (three vertex indices each) and where the ray met it (three barycentric weights each). */
  tri: Int32Array
  bary: Float64Array
  /** The rest gap, > 0. */
  gap: Float64Array
}

/**
 * The layer pairs of a surface at rest. positions: x, y, z per vertex; triangles: three vertex indices each;
 * bone: each vertex's main bone (an index into `names`); reach: how far apart two layers may be (of the height).
 */
export function findLayerPairs (positions: ArrayLike<number>, triangles: ArrayLike<number>, bone: ArrayLike<number>, names: readonly string[], parents: readonly number[], reach = 0.05): LayerPairs {
  const n = positions.length / 3
  // Welded: a UV seam's copies are one point.
  const weld = new Int32Array(n)
  const keys = new Map<string, number>()
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n; i++) {
    lo = Math.min(lo, positions[i * 3 + 1]); hi = Math.max(hi, positions[i * 3 + 1])
    const key = `${Math.round(positions[i * 3] * 1e6)},${Math.round(positions[i * 3 + 1] * 1e6)},${Math.round(positions[i * 3 + 2] * 1e6)}`
    const had = keys.get(key)
    if (had === undefined) { keys.set(key, i); weld[i] = i } else weld[i] = had
  }
  const height = Math.max(hi - lo, 1e-9)
  const far = reach * height
  const tris: number[] = []
  for (let i = 0; i + 2 < triangles.length; i += 3) {
    const a = weld[triangles[i]], b = weld[triangles[i + 1]], c = weld[triangles[i + 2]]
    if (a !== b && b !== c && a !== c) tris.push(a, b, c)
  }
  const t = tris.length / 3
  const P = (v: number, k: number): number => positions[v * 3 + k]
  // Triangle normals, vertex normals (area weighted), edges.
  const fn = new Float64Array(t * 3)
  const vn = new Float64Array(n * 3)
  const ring = new Map<number, Set<number>>()
  const link = (a: number, b: number): void => {
    let s = ring.get(a); if (s === undefined) ring.set(a, s = new Set()); s.add(b)
  }
  for (let f = 0; f < t; f++) {
    const [a, b, c] = [tris[f * 3], tris[f * 3 + 1], tris[f * 3 + 2]]
    const e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)]
    const e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)]
    const x = e1[1] * e2[2] - e1[2] * e2[1], y = e1[2] * e2[0] - e1[0] * e2[2], z = e1[0] * e2[1] - e1[1] * e2[0]
    for (const v of [a, b, c]) { vn[v * 3] += x; vn[v * 3 + 1] += y; vn[v * 3 + 2] += z }
    const l = Math.hypot(x, y, z) || 1
    fn[f * 3] = x / l; fn[f * 3 + 1] = y / l; fn[f * 3 + 2] = z / l
    link(a, b); link(b, a); link(b, c); link(c, b); link(c, a); link(a, c)
  }
  // Limbs: each point's, and each triangle's (the most common main bone of its corners).
  const limbs = limbOf(names, parents)
  const limbAt = (v: number): string => limbs[bone[v]] ?? 'trunk'
  const triLimb = (f: number): string => {
    const [a, b, c] = [bone[tris[f * 3]], bone[tris[f * 3 + 1]], bone[tris[f * 3 + 2]]]
    return limbs[a === b || a === c ? a : b === c ? b : a] ?? 'trunk'
  }
  // A grid of `far`-sized cells over the triangles' boxes.
  const cell = (x: number): number => Math.floor(x / far)
  const grid = new Map<string, number[]>()
  for (let f = 0; f < t; f++) {
    const box = [0, 1, 2].map(k => [Math.min(P(tris[f * 3], k), P(tris[f * 3 + 1], k), P(tris[f * 3 + 2], k)), Math.max(P(tris[f * 3], k), P(tris[f * 3 + 1], k), P(tris[f * 3 + 2], k))])
    for (let x = cell(box[0][0]); x <= cell(box[0][1]); x++) {
      for (let y = cell(box[1][0]); y <= cell(box[1][1]); y++) {
        for (let z = cell(box[2][0]); z <= cell(box[2][1]); z++) {
          const key = `${x},${y},${z}`
          const list = grid.get(key)
          if (list === undefined) grid.set(key, [f]); else list.push(f)
        }
      }
    }
  }
  const point: number[] = [], tri: number[] = [], bary: number[] = [], gap: number[] = []
  for (let i = 0; i < n; i++) {
    if (weld[i] !== i || !ring.has(i)) continue
    const nl = Math.hypot(vn[i * 3], vn[i * 3 + 1], vn[i * 3 + 2])
    if (nl === 0) continue
    const N = [vn[i * 3] / nl, vn[i * 3 + 1] / nl, vn[i * 3 + 2] / nl]
    const O = [P(i, 0), P(i, 1), P(i, 2)]
    const near = new Set<number>([i])
    for (const a of ring.get(i)!) { near.add(a); for (const b of ring.get(a) ?? []) near.add(b) }
    const seen = new Set<number>()
    const mine = limbAt(i)
    let best = Infinity, bf = -1, bu = 0, bv = 0
    const [cx, cy, cz] = O.map(cell)
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (let z = cz - 1; z <= cz + 1; z++) {
          for (const f of grid.get(`${x},${y},${z}`) ?? []) {
            if (seen.has(f)) continue
            seen.add(f)
            const a = tris[f * 3], b = tris[f * 3 + 1], c = tris[f * 3 + 2]
            if (near.has(a) || near.has(b) || near.has(c)) continue
            for (const sign of [1, -1]) {
              const D = [N[0] * sign, N[1] * sign, N[2] * sign]
              if (D[0] * fn[f * 3] + D[1] * fn[f * 3 + 1] + D[2] * fn[f * 3 + 2] >= -0.3) continue // (into its front)
              const e1 = [P(b, 0) - P(a, 0), P(b, 1) - P(a, 1), P(b, 2) - P(a, 2)]
              const e2 = [P(c, 0) - P(a, 0), P(c, 1) - P(a, 1), P(c, 2) - P(a, 2)]
              const p = [D[1] * e2[2] - D[2] * e2[1], D[2] * e2[0] - D[0] * e2[2], D[0] * e2[1] - D[1] * e2[0]]
              const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2]
              if (Math.abs(det) < 1e-18) continue
              const inv = 1 / det
              const tv = [O[0] - P(a, 0), O[1] - P(a, 1), O[2] - P(a, 2)]
              const u = (tv[0] * p[0] + tv[1] * p[1] + tv[2] * p[2]) * inv
              if (u < 0 || u > 1) continue
              const q = [tv[1] * e1[2] - tv[2] * e1[1], tv[2] * e1[0] - tv[0] * e1[2], tv[0] * e1[1] - tv[1] * e1[0]]
              const v = (D[0] * q[0] + D[1] * q[1] + D[2] * q[2]) * inv
              if (v < 0 || u + v > 1) continue
              const d = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv
              if (d <= 1e-5 * height || d >= far || d >= best) continue
              if (!keepPair(mine, triLimb(f))) continue
              best = d; bf = f; bu = u; bv = v
            }
          }
        }
      }
    }
    if (bf < 0) continue
    const [a, b, c] = [tris[bf * 3], tris[bf * 3 + 1], tris[bf * 3 + 2]]
    const w = [1 - bu - bv, bu, bv]
    const h = [0, 1, 2].map(k => w[0] * P(a, k) + w[1] * P(b, k) + w[2] * P(c, k))
    const g = (O[0] - h[0]) * fn[bf * 3] + (O[1] - h[1]) * fn[bf * 3 + 1] + (O[2] - h[2]) * fn[bf * 3 + 2]
    if (g <= 1e-5 * height) continue
    point.push(i); tri.push(a, b, c); bary.push(...w); gap.push(g)
  }
  return { point: Int32Array.from(point), tri: Int32Array.from(tri), bary: Float64Array.from(bary), gap: Float64Array.from(gap) }
}

/** Whether pair `k` has crossed in a pose (posed: x, y, z per vertex, the same vertices as at rest). */
export function crossed (posed: ArrayLike<number>, pairs: LayerPairs, k: number, height: number): boolean {
  const [a, b, c] = [pairs.tri[k * 3], pairs.tri[k * 3 + 1], pairs.tri[k * 3 + 2]]
  const Q = (v: number, i: number): number => posed[v * 3 + i]
  const e1 = [0, 1, 2].map(i => Q(b, i) - Q(a, i))
  const e2 = [0, 1, 2].map(i => Q(c, i) - Q(a, i))
  const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0]
  const l = Math.hypot(nx, ny, nz)
  if (l === 0) return false
  const w = [pairs.bary[k * 3], pairs.bary[k * 3 + 1], pairs.bary[k * 3 + 2]]
  const d = [0, 1, 2].map(i => Q(pairs.point[k], i) - (w[0] * Q(a, i) + w[1] * Q(b, i) + w[2] * Q(c, i)))
  const g = (d[0] * nx + d[1] * ny + d[2] * nz) / l
  const lateral = Math.sqrt(Math.max(d[0] * d[0] + d[1] * d[1] + d[2] * d[2] - g * g, 0))
  return g < 0 && lateral < 2 * pairs.gap[k] + 0.01 * height
}
