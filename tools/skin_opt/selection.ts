/** Connected surface islands, with UV/material splits at the same bind position
 * joined. Switching a whole island cannot introduce a weight discontinuity. */
export function surfaceIslands (positions: ArrayLike<number>, indices: ArrayLike<number>): { labels: Int32Array, count: number } {
  const n = positions.length / 3
  const parent = Int32Array.from({ length: n }, (_, i) => i)
  const find = (v: number): number => {
    while (parent[v] !== v) { parent[v] = parent[parent[v]]; v = parent[v] }
    return v
  }
  const join = (a: number, b: number): void => { parent[find(a)] = find(b) }
  for (let i = 0; i < indices.length; i += 3) { join(indices[i], indices[i + 1]); join(indices[i], indices[i + 2]) }
  const seams = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const key = [0, 1, 2].map(k => Math.round(positions[i * 3 + k] * 1e6)).join(',')
    const other = seams.get(key)
    if (other !== undefined) join(i, other)
    else seams.set(key, i)
  }
  const groups = new Map<number, number>()
  const labels = Int32Array.from(parent, (_, i) => {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, groups.size)
    return groups.get(root)!
  })
  return { labels, count: groups.size }
}

/** An average improvement cannot excuse an increase in extreme deformation on
 * another motion. Keep the existing RMS guard too, then select individual islands. */
export function retainReference (generated: number[], reference: number[], severe: number[], referenceSevere: number[]): boolean {
  const n = generated.length
  if (n === 0 || [generated, reference, severe, referenceSevere].some(a => a.length !== n || a.some(x => !Number.isFinite(x) || x < 0))) throw new Error('Invalid deformation scores')
  const sum = (a: number[]): number => a.reduce((s,x) => s+x, 0)
  return sum(generated) > sum(reference)*1.01 || generated.some((x,i) => x > reference[i]*1.1) || severe.some((x,i) => x > referenceSevere[i])
}

/** Start with the whole-model winner. Use the other skin on an island only when
 * it improves the average AND does not worsen any individual motion test. */
export function selectIslands (generated: number[][], reference: number[][], retainReference: boolean): boolean[] {
  if (generated.length !== reference.length || generated.length === 0) throw new Error('Mismatched deformation samples')
  const n = generated[0].length
  if ([...generated, ...reference].some(r => r.length !== n || r.some(x => !Number.isFinite(x) || x < 0))) throw new Error('Invalid island deformation scores')
  return Array.from({ length: n }, (_, c) => {
    const best = retainReference ? reference : generated
    const other = retainReference ? generated : reference
    const sum = (a: number[][]): number => a.reduce((s, r) => s + r[c], 0)
    const improves = sum(other) < sum(best) * .9999 && other.every((r, k) => r[c] <= best[k][c] + 1e-12)
    return improves ? !retainReference : retainReference
  })
}
