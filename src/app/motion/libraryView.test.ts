import { describe, expect, it } from 'vitest'
import type { LibraryIndexRow } from '../../../server/library.ts'
import { defaultView, viewOf, type ViewState } from './libraryView.ts'
const clip = (id: string, extra: Partial<LibraryIndexRow> = {}): LibraryIndexRow => ({ id, name: id, category: 'walk', source: 'mixamo', rig: 'human', duration: 1, loop: true, inPlace: true, tags: [], url: id, addedAt: 1, ...extra })
const index = [clip('Walk', { duration: 3, addedAt: 3 }), clip('Moonwalk', { category: 'dance', duration: 1, addedAt: 2, loop: false, inPlace: false, source: 'custom', tags: ['spin'] }), clip('Left', { tags: ['walk'], duration: 2 })]
const ids = (changes: Partial<ViewState> = {}) => viewOf(index, { Walk: 2 }, { ...defaultView(), ...changes }).flatMap(r => 'clip' in r ? [r.clip.id] : [])
describe('library view', () => {
  it('sorts by name, length, recent and use in either direction', () => {
    expect(ids()).toEqual(['Left', 'Moonwalk', 'Walk'])
    expect(ids({ sort: 'length' })).toEqual(['Moonwalk', 'Left', 'Walk'])
    expect(ids({ sort: 'recent', direction: 'desc' })).toEqual(['Walk', 'Moonwalk', 'Left'])
    expect(ids({ sort: 'used', direction: 'desc' })[0]).toBe('Walk')
  })
  it('filters and ranks query word starts ahead of substrings and tags', () => {
    expect(ids({ query: 'walk' })).toEqual(['Walk', 'Moonwalk', 'Left'])
    expect(ids({ category: ['dance'], source: ['custom'], loop: 'oneshot', inPlace: 'root-motion', used: 'unused', tags: ['spin'] })).toEqual(['Moonwalk'])
    expect(ids({ rig: 'horse' })).toEqual([])
    expect(ids({ used: 'used', loop: 'loop', inPlace: 'in-place' })).toEqual(['Walk'])
  })
  it('groups and collapses category and source', () => {
    for (const group of ['category', 'source'] as const) {
      const rows = viewOf(index, {}, { ...defaultView(), group })
      expect(rows.filter(r => 'group' in r)).toHaveLength(2)
      const header = rows.find(r => 'group' in r)!
      if ('group' in header) expect(viewOf(index, {}, { ...defaultView(), group, collapsed: [header.key] }).length).toBe(rows.length - header.n)
    }
  })
  it('processes 2500 clips within budget', () => {
    const rows = Array.from({ length: 2500 }, (_, i) => clip(`Clip ${i}`))
    const start = performance.now(); expect(viewOf(rows, {}, defaultView())).toHaveLength(2500)
    expect(performance.now() - start).toBeLessThan(100)
  })
})

it('finds a clip by its variant or uncertain candidate name', () => {
  const rows = [clip('walk', { variant: 'long stride', candidates: [{ name: 'march', description: 'military pace' }] })]
  for (const query of ['stride', 'march', 'military']) {
    expect(viewOf(rows, {}, { ...defaultView(), query }).flatMap(row => 'clip' in row ? [row.clip.id] : [])).toEqual(['walk'])
  }
})
