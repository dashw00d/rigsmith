// @vitest-environment node
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { optimizerExclude, trainedIds } from '../../server/skinopt.ts'
import { type CatalogClip, extendTests, type Motion } from './deformation.ts'

const CATEGORIES = ['locomotion', 'combat', 'jump', 'crouch-prone', 'work', 'dance', 'sit-lie', 'climb']
const id = (category: string, i: number): string => `mixamo-${category}-${String(i).padStart(2, '0')}`

/** A library: `n` clips in each spread category and in 'idle', plus clips the spread never takes. */
function library (n = 12, extra: Motion[] = []): CatalogClip[] {
  const clips: CatalogClip[] = []
  for (const category of [...CATEGORIES, 'idle']) {
    for (let i = 0; i < n; i++) clips.push({ id: id(category, i), name: `${category} ${i}`, category, source: 'mixamo-catalog' })
  }
  clips.push({ id: 'mixamo-locomotion-dup', name: 'dup', category: 'locomotion', source: 'mixamo-catalog', duplicateOf: id('locomotion', 0) })
  clips.push({ id: 'custom-walk', name: 'mine', category: 'locomotion', source: 'custom' })
  for (const t of extra) clips.push({ ...t, category: 'gesture', source: 'mixamo-catalog' })
  return clips
}

const base: Motion[] = [{ id: 'mixamo-t1', name: 'T1' }, { id: 'mixamo-t2', name: 'T2' }]
const ids = (set: Motion[]): string[] => set.map(t => t.id)

describe('the deformation tests with the library spread', () => {
  it('without exclusions: the tests, then a third and two thirds of the way through each category', () => {
    const set = extendTests(base, library(12, base))
    expect(ids(set)).toEqual([...ids(base), ...CATEGORIES.flatMap(c => [id(c, 4), id(c, 8)])])
  })

  it('a clip left out is swapped for another of its category', () => {
    const set = extendTests(base, library(), [id('locomotion', 4)])
    // (locomotion has 11 clips left: the third and two thirds of the way through are its 03 and 08)
    expect(ids(set).slice(2, 4)).toEqual([id('locomotion', 3), id('locomotion', 8)])
    expect(set).toHaveLength(18)
  })

  it('a test left out is made up from the library, halfway through the first category', () => {
    const set = extendTests(base, library(), ['mixamo-t1'])
    expect(set).toHaveLength(18)
    expect(ids(set)).not.toContain('mixamo-t1')
    expect(set.at(-1)!.id).toBe(id('locomotion', 6))
  })

  it('takes clips of other categories when its own run out', () => {
    const left = [...ids(base).slice(0, 1), ...[0, 1].flatMap(i => [id('locomotion', i), id('combat', i)])]
    const idle = [2, 3, 4, 5, 6, 7].map(i => ({ id: id('idle', i), name: `idle ${i}`, category: 'idle', source: 'mixamo-catalog' }))
    const set = extendTests(base, [...library(2), ...idle], left)
    expect(set).toHaveLength(2 + 8 * 2)
    expect(ids(set).filter(x => left.includes(x))).toEqual([])
    expect(ids(set).slice(-5)).toEqual([0, 1, 2, 3, 4].map(i => id('idle', i)))
  })

  it('never takes duplicates or clips from outside the catalog', () => {
    const set = extendTests(base, library(1), CATEGORIES.map(c => id(c, 0)))
    expect(ids(set)).not.toContain('mixamo-locomotion-dup')
    expect(ids(set)).not.toContain('custom-walk')
    expect(new Set(ids(set)).size).toBe(set.length)
  })
})

describe('the check after the pose optimizer (PLAN §4 bug 7)', () => {
  const root = path.join(import.meta.dirname, '..', '..')
  const tests = (JSON.parse(readFileSync(path.join(root, 'static/templates/tests.json'), 'utf8')) as { human: Motion[] }).human
  const holdout = (JSON.parse(readFileSync(path.join(root, 'tools/skin_opt/holdout.json'), 'utf8')) as { clips: string[] }).clips

  it('never scores a clip the optimizer trained on, and keeps the set\'s size', () => {
    const catalog = library(30, tests)
    const unseen = extendTests(tests, catalog)
    // The slots' clips (one of them a spread clip), the Skin step's tests, and a draw from the library (every third
    // clip that isn't held out, the spread's picks among them), as pose_set.ts trains on them.
    const always = trainedIds([id('locomotion', 10), 'mixamo-Idle'], tests, holdout)
    const drawn = catalog.filter((c, i) => i % 3 === 0 && !holdout.includes(c.id)).map(c => c.id)
    const posed = [...always, ...drawn]
    const set = extendTests(tests, catalog, optimizerExclude(always, posed))
    const trained = new Set([...always, ...posed])
    expect(ids(set).filter(x => trained.has(x))).toEqual([])
    expect(set).toHaveLength(unseen.length)
    expect(new Set(ids(set)).size).toBe(set.length)
    // (the held-out tests are never trained on, so they stay)
    for (const t of tests.filter(t => holdout.includes(t.id))) expect(ids(set)).toContain(t.id)
    // (and the ones trained on were there before: the exclusion did something)
    expect(ids(unseen).some(x => trained.has(x))).toBe(true)
  })
})
