import type { LibraryIndexRow } from '../../../server/library.ts'

export type LibrarySort = 'name' | 'length' | 'recent' | 'used'
export type LibraryGroup = 'none' | 'category' | 'source'
export interface ViewState {
  query: string, sort: LibrarySort, direction: 'asc' | 'desc', group: LibraryGroup,
  category: string[], source: string[], rig: string, loop: 'any' | 'loop' | 'oneshot',
  inPlace: 'any' | 'in-place' | 'root-motion', used: 'any' | 'used' | 'unused', tags: string[],
  view: 'grid' | 'list', collapsed: string[]
}
export type Row = { group: LibraryGroup, key: string, label: string, n: number } | { clip: LibraryIndexRow }
export const defaultView = (): ViewState => ({ query: '', sort: 'name', direction: 'asc', group: 'none', category: [], source: [], rig: 'human', loop: 'any', inPlace: 'any', used: 'any', tags: [], view: 'grid', collapsed: [] })
const compare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare

/** Filter, rank and group without mutating the supplied catalog. */
export function viewOf (index: readonly LibraryIndexRow[], uses: Readonly<Record<string, number>>, state: ViewState): Row[] {
  const terms = state.query.toLowerCase().trim().split(/\s+/).filter(Boolean)
  const starts = terms.map(t => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const scored: Array<{ clip: LibraryIndexRow, rank: number }> = []
  for (const c of index) {
    const count = uses[c.id] ?? 0
    if ((state.rig && state.rig !== 'all' && c.rig !== state.rig) || (state.category.length && !state.category.includes(c.category)) ||
      (state.source.length && !state.source.includes(c.source)) || (state.loop === 'loop' && !c.loop) || (state.loop === 'oneshot' && c.loop) ||
      (state.inPlace === 'in-place' && !c.inPlace) || (state.inPlace === 'root-motion' && c.inPlace) ||
      (state.used === 'used' && !count) || (state.used === 'unused' && count > 0) || !state.tags.every(t => c.tags.includes(t))) continue
    const names = `${c.name}\n${c.description ?? ''}\n${c.id}`.toLowerCase()
    const all = `${names}\n${c.tags.join('\n')}\n${c.category}\n${c.source}`.toLowerCase()
    if (!terms.every(t => all.includes(t))) continue
    const rank = starts.every(re => re.test(names)) ? 0 : terms.every(t => names.includes(t)) ? 1 : 2
    scored.push({ clip: c, rank })
  }
  const sign = state.direction === 'asc' ? 1 : -1
  scored.sort((a, b) => {
    const x = a.clip; const y = b.clip
    const order = state.sort === 'length' ? x.duration - y.duration : state.sort === 'recent' ? x.addedAt - y.addedAt : state.sort === 'used' ? (uses[x.id] ?? 0) - (uses[y.id] ?? 0) : compare(x.name, y.name)
    return (terms.length ? a.rank - b.rank : 0) || sign * order || compare(x.name, y.name) || compare(x.id, y.id)
  })
  if (state.group === 'none') return scored.map(({ clip }) => ({ clip }))
  const groups = new Map<string, LibraryIndexRow[]>()
  for (const { clip } of scored) {
    const key = clip[state.group]
    const list = groups.get(key) ?? []
    list.push(clip); groups.set(key, list)
  }
  const rows: Row[] = []
  for (const [key, clips] of [...groups].sort(([a], [b]) => compare(a, b))) {
    rows.push({ group: state.group, key, label: key, n: clips.length })
    if (!state.collapsed.includes(key)) rows.push(...clips.map(clip => ({ clip })))
  }
  return rows
}
