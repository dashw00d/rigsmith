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
  return explainRetain(generated, reference, severe, referenceSevere).retain
}

const percent = (a: number, b: number): number => Math.round((a / Math.max(b, 1e-12) - 1) * 100)

/**
 * retainReference with its reason, for the rig report: what the generated skin did against the reference on the tests
 * (`names`, one per test), as a phrase with no subject ("strained Air squat 15% more", "was no worse on any of the 8
 * tests (6% less strain)"). The first rule that keeps the reference is the one given.
 * layers: each test's count of points gone through the layer they covered at rest (layers.ts), for both skins. A skin
 * that lets clearly more through is refused; one that lets clearly fewer through wins whatever it does to the stretch
 * (said in `why`), unless it strains half as much again in all (a broken fit, not a trade): a stretch can be painted
 * out, a thigh through a coat can't (the designer, 2026-11-01: "stretching is something i can fix, the layer poking
 * through i cannot").
 */
export function explainRetain (generated: number[], reference: number[], severe: number[], referenceSevere: number[], names: string[] = [], layers?: { generated: number[], reference: number[] }): { retain: boolean, why: string } {
  const n = generated.length
  if (n === 0 || [generated, reference, severe, referenceSevere, ...(layers === undefined ? [] : [layers.generated, layers.reference])].some(a => a.length !== n || a.some(x => !Number.isFinite(x) || x < 0))) throw new Error('Invalid deformation scores')
  const sum = (a: number[]): number => a.reduce((s,x) => s+x, 0)
  const name = (i: number): string => names[i] ?? `test ${i + 1}`
  const tests = n === 1 ? 'the test' : `the ${n} tests`
  if (layers !== undefined) {
    // (a couple of points a test either way is noise)
    const through = sum(layers.generated), before = sum(layers.reference), slack = 2 * n
    if (through > before * 1.1 + slack) return { retain: true, why: `let ${through - before} more points through the layer under them on ${tests}` }
    if (through < before * 0.8 - slack) {
      if (sum(generated) > sum(reference)*1.5) return { retain: true, why: `strained ${tests} ${percent(sum(generated), sum(reference))}% more in all` }
      const strain = percent(sum(generated), sum(reference))
      return { retain: false, why: `kept the layers apart (${-percent(through, before)}% fewer points through the layer under them on ${tests}${strain === 0 ? '' : `, ${Math.abs(strain)}% ${strain > 0 ? 'more' : 'less'} strain`})` }
    }
  }
  if (sum(generated) > sum(reference)*1.01) return { retain: true, why: `strained ${tests} ${percent(sum(generated), sum(reference))}% more in all` }
  const worse = generated.findIndex((x,i) => x > reference[i]*1.1)
  if (worse >= 0) return { retain: true, why: `strained ${name(worse)} ${percent(generated[worse], reference[worse])}% more` }
  const torn = severe.findIndex((x,i) => x > referenceSevere[i])
  if (torn >= 0) {
    const more = severe[torn] - referenceSevere[torn]
    return { retain: true, why: `stretched ${more} more ${more === 1 ? 'edge' : 'edges'} past double length on ${name(torn)}` }
  }
  const gain = -percent(sum(generated), sum(reference))
  return { retain: false, why: `was no worse on ${n === 1 ? 'the test' : `any of ${tests}`}${gain >= 1 ? ` (${gain}% less strain)` : ''}` }
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
