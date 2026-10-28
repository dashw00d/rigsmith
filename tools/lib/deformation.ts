// The deformation tests a rig is checked on (tools/skin_opt/validate.ts, tools/dev/verify_rigs.ts): the Skin step's
// tests (static/templates/tests.json) and, extended, a deterministic spread of library motions besides.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { ROOT, WORKSPACE } from './node3d.ts'

export interface Motion { id: string, name: string, url?: string }

/** A library manifest entry, as much of it as the spread reads. */
export interface CatalogClip extends Motion { category: string, source: string, duplicateOf?: string | null }

// The spread: in each of these categories (its clips sorted by id), the clips a third and two thirds of the way through.
const CATEGORIES = ['locomotion', 'combat', 'jump', 'crouch-prone', 'work', 'dance', 'sit-lie', 'climb']
const SPREAD = [1 / 3, 2 / 3]
// Where a top-up looks next in each category, before it takes the rest of its clips in order.
const TOP_UP = [1 / 2, 1 / 6, 5 / 6, 1 / 12, 5 / 12, 7 / 12, 11 / 12]

/** The places in a category of n clips the spread takes (`first`) and, in order, where a top-up looks after (`then`). */
function places (n: number): { first: number[], then: number[] } {
  const unique = (xs: number[]): number[] => [...new Set(xs)].filter(i => i < n)
  const first = unique(SPREAD.map(f => Math.floor(n * f)))
  const then = unique([...TOP_UP.map(f => Math.floor(n * f)), ...Array.from({ length: n }, (_, i) => i)]).filter(i => !first.includes(i))
  return { first, then }
}

/**
 * A person's tests with the library spread added: `base` (tests.json's), then two clips of each category. `exclude`:
 * clips the set must not have (the ones the pose optimizer trained on, so its check scores motion it hasn't seen).
 * Those are left out and the spread takes more clips of its categories in their place (then of any category), so the
 * set is as big as it is without exclusions. Without exclusions it is the spread as it always was.
 */
export function extendTests (base: Motion[], catalog: CatalogClip[], exclude: Iterable<string> = []): Motion[] {
  const skip = new Set(exclude)
  const eligible = (c: CatalogClip): boolean => c.source === 'mixamo-catalog' && (c.duplicateOf ?? '') === '' && !base.some(t => t.id === c.id)
  const byId = (a: Motion, b: Motion): number => a.id.localeCompare(b.id)
  const categories = CATEGORIES.map(category => catalog.filter(c => c.category === category && eligible(c)).sort(byId))
  // (the set's size without exclusions: the base tests and each category's spread)
  const size = base.length + categories.reduce((n, pool) => n + places(pool.length).first.length, 0)

  const out = base.filter(t => !skip.has(t.id))
  const add = (c: Motion): void => { out.push({ id: c.id, name: c.name }) }
  const pools = categories.map(pool => pool.filter(c => !skip.has(c.id)))
  const at = pools.map(pool => places(pool.length))
  for (const [k, pool] of pools.entries()) for (const i of at[k].first) add(pool[i])
  // (topped up a clip per category per round, so no one category fills the gap)
  for (let round = 0; out.length < size && at.some(p => round < p.then.length); round++) {
    for (const [k, pool] of pools.entries()) {
      const i = at[k].then[round]
      if (i !== undefined && out.length < size) add(pool[i])
    }
  }
  if (out.length < size) {
    const taken = new Set(out.map(t => t.id))
    for (const c of catalog.filter(c => eligible(c) && !skip.has(c.id) && !taken.has(c.id)).sort(byId)) {
      if (out.length >= size) break
      add(c)
    }
  }
  return out
}

/** Rig stress tests by template plus, `extended`, a person's spread of library motions (extendTests). The extra clips
 * are validation cases, not mandatory optimizer training poses. `exclude`: clip ids no set may have (extendTests). */
export function deformationTests (extended = false, exclude: Iterable<string> = []): Record<string, Motion[]> {
  const all = JSON.parse(readFileSync(path.join(ROOT, 'static/templates/tests.json'), 'utf8')) as Record<string, Motion[]>
  const skip = new Set(exclude)
  // (tests.json has a _doc string beside the lists)
  const tests = Object.fromEntries(Object.entries(all).map(([template, list]) => [template, Array.isArray(list) ? list.filter(t => !skip.has(t.id)) : list]))
  const file = path.join(WORKSPACE, 'library/manifest.json')
  if (!extended || !existsSync(file)) return tests
  const catalog = JSON.parse(readFileSync(file, 'utf8')) as { clips: CatalogClip[] }
  tests.human = extendTests(all.human ?? [], catalog.clips, skip)
  return tests
}
