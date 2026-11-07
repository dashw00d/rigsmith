// UV-space cloth operations shared by the viewer, worker and export. All pixels are straight-alpha RGBA.
import type { ClothCut, ClothSlot } from '../model/types.ts'

export interface BodyGeometry {
  positions: ArrayLike<number> // xyz, in rest space
  uv: ArrayLike<number> // uv per vertex
  index: ArrayLike<number> // triangle indices
}
export interface BodyField { region: Int16Array, y: Float32Array, width: number, height: number }
export interface RegionInfo { id: number, material: string, x: number, minX?: number, maxX?: number, sideMargin?: number }
export interface Pixels { rgba: Uint8ClampedArray, width: number, height: number }
export interface ClothPixels extends Pixels { id: string, slots: readonly ClothSlot[] }

const fields = new Map<string, BodyField>()
/** Rasterise the body at texel centres. The caller's bodyKey must identify geometry, regions and height. */
export function bodyField (geometry: BodyGeometry, regions: ArrayLike<number>, height: number, size: number | { width: number, height: number }, bodyKey?: string): BodyField {
  const width = typeof size === 'number' ? size : size.width
  const h = typeof size === 'number' ? size : size.height
  if (!Number.isInteger(width) || !Number.isInteger(h) || width < 1 || h < 1 || !(height > 0)) throw new Error('Invalid body field dimensions or height')
  const key = bodyKey === undefined ? undefined : `${bodyKey}:${width}:${h}:${height}`
  const cached = key === undefined ? undefined : fields.get(key)
  if (cached !== undefined) return cached
  const region = new Int16Array(width * h).fill(-1)
  const y = new Float32Array(width * h)
  let sole = Infinity
  for (let i = 1; i < geometry.positions.length; i += 3) sole = Math.min(sole, geometry.positions[i])
  const { uv, index, positions } = geometry
  for (let i = 0; i + 2 < index.length; i += 3) {
    const a = index[i]; const b = index[i + 1]; const c = index[i + 2]
    const id = regions[a]
    if (id < 0 || id > 32767 || regions[b] !== id || regions[c] !== id) continue
    const ax = uv[a * 2] * width; const ay = uv[a * 2 + 1] * h
    const bx = uv[b * 2] * width; const by = uv[b * 2 + 1] * h
    const cx = uv[c * 2] * width; const cy = uv[c * 2 + 1] * h
    const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if (Math.abs(det) < 1e-12) continue
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 0.5)); const x1 = Math.min(width - 1, Math.floor(Math.max(ax, bx, cx) - 0.5))
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 0.5)); const y1 = Math.min(h - 1, Math.floor(Math.max(ay, by, cy) - 0.5))
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const x = px + 0.5; const yy = py + 0.5
      const wa = ((by - cy) * (x - cx) + (cx - bx) * (yy - cy)) / det
      const wb = ((cy - ay) * (x - cx) + (ax - cx) * (yy - cy)) / det
      const wc = 1 - wa - wb
      if (wa < -1e-7 || wb < -1e-7 || wc < -1e-7) continue
      const p = py * width + px
      region[p] = id
      y[p] = (wa * positions[a * 3 + 1] + wb * positions[b * 3 + 1] + wc * positions[c * 3 + 1] - sole) / height
    }
  }
  const result = { region, y, width, height: h }
  if (key !== undefined) fields.set(key, result)
  return result
}

/** Return a copy with the cut applied. Unmapped texels retain their original alpha. */
export function cutAlpha (rgba: Uint8ClampedArray, w: number, h: number, field: BodyField, cut: ClothCut, maskRgba?: Uint8ClampedArray): Uint8ClampedArray {
  if (rgba.length !== w * h * 4 || field.width !== w || field.height !== h || (maskRgba !== undefined && maskRgba.length !== rgba.length)) throw new Error('Mismatched cut image dimensions')
  const out = new Uint8ClampedArray(rgba)
  const drops = new Set(cut.drop ?? [])
  for (let i = 0; i < w * h; i++) {
    const r = field.region[i]
    let alpha = drops.has(r) && r >= 0 ? 0 : 1
    for (const rule of cut.below ?? []) if (rule.regions.includes(r)) {
      const t = rule.feather <= 0 ? Number(field.y[i] >= rule.y) : Math.max(0, Math.min(1, (field.y[i] - (rule.y - rule.feather)) / (2 * rule.feather)))
      alpha *= t * t * (3 - 2 * t)
    }
    if (maskRgba !== undefined) alpha *= (0.2126 * maskRgba[i * 4] + 0.7152 * maskRgba[i * 4 + 1] + 0.0722 * maskRgba[i * 4 + 2]) / 255
    out[i * 4 + 3] = rgba[i * 4 + 3] * alpha
  }
  return out
}

/** Composite layers once at their first slot, bottom to top. */
export function composeCloth ({ base, layers }: { base: Pixels, layers: readonly ClothPixels[] }): Pixels {
  const out = new Uint8ClampedArray(base.rgba)
  const seen = new Set<string>()
  for (const slot of ['bottom', 'top', 'over'] as const) for (const layer of layers) {
    if (!layer.slots.includes(slot) || seen.has(layer.id)) continue
    if (layer.width !== base.width || layer.height !== base.height || layer.rgba.length !== out.length) throw new Error('Mismatched cloth image dimensions')
    seen.add(layer.id)
    for (let i = 0; i < out.length; i += 4) {
      const a = layer.rgba[i + 3] / 255; const b = out[i + 3] / 255; const combined = a + b * (1 - a)
      if (combined > 0) for (let c = 0; c < 3; c++) out[i + c] = (layer.rgba[i + c] * a + out[i + c] * b * (1 - a)) / combined
      out[i + 3] = combined * 255
    }
  }
  return { rgba: out, width: base.width, height: base.height }
}

/** Composite each selected layer only over its garment slots. A cut reveals the bare skin in that layer's zone;
 * without a bare image it fades back to the painted base. The same two-slot layer is drawn once. */
export function composeSlots ({ base, bare, field, regions, layers }: {
  base: Pixels, bare: Pixels | null, field: BodyField, regions: readonly RegionInfo[],
  layers: readonly (ClothPixels & { cut?: ClothCut, mask?: Uint8ClampedArray })[]
}): Pixels {
  const { width, height } = base
  if (base.rgba.length !== width * height * 4 || field.width !== width || field.height !== height ||
      (bare !== null && (bare.width !== width || bare.height !== height || bare.rgba.length !== base.rgba.length))) throw new Error('Mismatched composition image dimensions')
  const zones = new Map<number, 'top' | 'bottom'>()
  for (const r of regions) {
    const material = r.material.toLowerCase()
    if (/trouser|pants|bottom|leg/.test(material)) zones.set(r.id, 'bottom')
    else if (/shirt|sleeve|top/.test(material)) zones.set(r.id, 'top')
  }
  // Give islands a two-pixel gutter for bilinear sampling. Never replace another mapped body region.
  let region = new Int16Array(field.region); let heights = new Float32Array(field.y)
  for (let pass = 0; pass < 2; pass++) {
    const nextRegion = new Int16Array(region); const nextHeights = new Float32Array(heights)
    for (let p = 0; p < region.length; p++) if (region[p] === -1) {
      const x = p % width; const y = Math.floor(p / width)
      search: for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue
        const q = yy * width + xx
        if (zones.has(region[q])) { nextRegion[p] = region[q]; nextHeights[p] = heights[q]; break search }
      }
    }
    region = nextRegion; heights = nextHeights
  }
  const padded: BodyField = { region, y: heights, width, height }
  const out = new Uint8ClampedArray(base.rgba); const seen = new Set<string>()
  for (const slot of ['bottom', 'top', 'over'] as const) for (const layer of layers) {
    if (!layer.slots.includes(slot) || seen.has(layer.id)) continue
    if (layer.width !== width || layer.height !== height || layer.rgba.length !== out.length) throw new Error('Mismatched cloth image dimensions')
    seen.add(layer.id)
    const white = layer.cut === undefined ? undefined : new Uint8ClampedArray(out.length).fill(255)
    const alpha = white === undefined ? undefined : cutAlpha(white, width, height, padded, layer.cut!, layer.mask)
    for (let p = 0; p < padded.region.length; p++) {
      const zone = zones.get(padded.region[p])
      if (zone === undefined || (!layer.slots.includes(zone) && !layer.slots.includes('over'))) continue
      const i = p * 4; const cut = alpha === undefined ? 1 : alpha[i + 3] / 255
      const a = layer.rgba[i + 3] / 255 * (bare === null ? cut : 1)
      const b = out[i + 3] / 255; const combined = a + b * (1 - a)
      if (combined > 0) for (let c = 0; c < 3; c++) out[i + c] = (layer.rgba[i + c] * a + out[i + c] * b * (1 - a)) / combined
      out[i + 3] = combined * 255
      if (bare !== null && cut < 1) {
        const bareAlpha = bare.rgba[i + 3] / 255; const currentAlpha = out[i + 3] / 255
        const mixedAlpha = currentAlpha * cut + bareAlpha * (1 - cut)
        if (mixedAlpha > 0) for (let c = 0; c < 3; c++) out[i + c] = (out[i + c] * currentAlpha * cut + bare.rgba[i + c] * bareAlpha * (1 - cut)) / mixedAlpha
        out[i + 3] = mixedAlpha * 255
      }
    }
  }
  return { rgba: out, width, height }
}

/** Group cloth regions for editing by material and side of the body. */
export function limbGroups (list: readonly RegionInfo[]): Array<{ name: string, regions: number[] }> {
  const groups = new Map<string, number[]>()
  for (const r of list) {
    const material = r.material.toLowerCase()
    const part = /trouser|pants|bottom|leg/.test(material) ? 'leg' : /shirt|sleeve|top/.test(material) ? 'sleeve' : null
    if (part === null) continue
    // glTF's character faces +Z: +X is the character's left. A region touching the midline is torso/hip,
    // even when its centroid is off-centre. Older callers without bounds retain centroid-based grouping.
    const margin = r.sideMargin ?? 0
    const side = r.minX !== undefined && r.maxX !== undefined
      ? r.minX > margin ? 'left' : r.maxX < -margin ? 'right' : null
      : r.x > 0 ? 'left' : r.x < 0 ? 'right' : null
    if (side === null) continue
    const name = `${side} ${part}`
    const ids = groups.get(name) ?? []; ids.push(r.id); groups.set(name, ids)
  }
  return [...groups].map(([name, regions]) => ({ name, regions }))
}

/** Median face/neck/hand texels, ignoring transparent pixels. */
export function skinTone (rgba: Uint8ClampedArray, field: BodyField, regions: readonly number[]): [number, number, number] {
  const ids = new Set(regions); const channels: number[][] = [[], [], []]
  for (let p = 0; p < field.region.length; p++) if (ids.has(field.region[p]) && rgba[p * 4 + 3] > 0) for (let c = 0; c < 3; c++) channels[c].push(rgba[p * 4 + c])
  if (channels[0].length === 0) throw new Error('No skin texels found')
  return channels.map(ch => { ch.sort((a, b) => a - b); return ch[Math.floor(ch.length / 2)] }) as [number, number, number]
}

/** Fill garment texels, extending two pixels into unmapped UV space without touching other body regions. */
export function makeBare (rgba: Uint8ClampedArray, field: BodyField, skinRegions: readonly number[], clothesRegions: readonly number[]): Uint8ClampedArray {
  if (rgba.length !== field.width * field.height * 4) throw new Error('Mismatched skin image dimensions')
  const tone = skinTone(rgba, field, skinRegions); const clothes = new Set(clothesRegions)
  const out = new Uint8ClampedArray(rgba); let filled = new Uint8Array(field.region.length)
  for (let p = 0; p < filled.length; p++) if (clothes.has(field.region[p])) filled[p] = 1
  for (let pass = 0; pass < 2; pass++) {
    const next = new Uint8Array(filled)
    for (let p = 0; p < filled.length; p++) if (filled[p]) {
      const x = p % field.width; const y = Math.floor(p / field.width)
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx; const yy = y + dy
        if (xx < 0 || yy < 0 || xx >= field.width || yy >= field.height) continue
        const q = yy * field.width + xx
        if (field.region[q] === -1) next[q] = 1
      }
    }
    filled = next
  }
  for (let p = 0; p < filled.length; p++) if (filled[p]) for (let c = 0; c < 3; c++) out[p * 4 + c] = tone[c]
  return out
}
