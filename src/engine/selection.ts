// Texel helpers for the painting mask (src/engine/surfacemask.ts): a colour distance, so a brush can stop where the
// colour changes, and growing or shrinking a binary mask.

/** Perceptual-ish color distance in YCbCr, 0..~1. */
export function colorDistance (c: Uint8ClampedArray, i: number, r: number, g: number, b: number): number {
  const dr = c[i] - r
  const dg = c[i + 1] - g
  const db = c[i + 2] - b
  const dy = 0.299 * dr + 0.587 * dg + 0.114 * db
  const dcb = -0.169 * dr - 0.331 * dg + 0.5 * db
  const dcr = 0.5 * dr - 0.419 * dg - 0.081 * db
  return Math.sqrt(dy * dy * 0.6 + dcb * dcb * 1.4 + dcr * dcr * 1.4) / 160
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
