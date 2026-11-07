<script lang="ts">
  import { untrack } from 'svelte'
  import type { LibraryIndexRow } from '../../../server/library.ts'
  import { api, type LibraryClip } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { library } from '../../state/library.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import SearchBox from '../../ui/SearchBox.svelte'
  import Chips from '../../ui/Chips.svelte'
  import Note from '../../ui/Note.svelte'
  import VirtualList from '../../ui/VirtualList.svelte'
  import LibraryCard from './LibraryCard.svelte'
  import LibraryRow from './LibraryRow.svelte'
  import { viewOf, type Row, type ViewState } from './libraryView.ts'

  const open = $derived(app.drawer === 'library')
  const options = $derived(library.options)
  const rows = $derived(library.rows)
  const count = $derived(viewOf(library.index, library.uses, { ...options, query: library.query, rig: library.rig, collapsed: [] }).filter(r => 'clip' in r).length)
  const categories = $derived([...new Set(library.index.map(c => c.category))].sort().map(v => ({ value: v, label: v })))
  const sources = $derived([...new Set(library.index.map(c => c.source))].sort().map(v => ({ value: v, label: v })))
  const rigs = $derived([...new Set(library.index.map(c => c.rig))].sort())
  const tags = $derived([...new Set(library.index.flatMap(c => c.tags))].sort().map(v => ({ value: v, label: v })))
  const set = (change: Partial<ViewState>): void => { library.setViewOptions(change) }
  $effect(() => { if (open) { const rig = app.selected?.skeleton.template ?? 'human'; untrack(() => library.setRig(rig)) } })
  $effect(() => { if (open) void slots.load(app.selected?.id ?? null) })
  $effect(() => { if (open) return () => animator.cancelSprites() })

  // The compact index deliberately omits animation metadata. Resolve a full clip only when it is played or kept.
  const full = new Map<string, Promise<LibraryClip>>()
  function resolve (clip: LibraryIndexRow): Promise<LibraryClip> {
    let result = full.get(clip.id)
    if (!result) {
      result = (async () => {
        let page = 0
        while (true) {
          const data = await api.library({ q: clip.name, rig: clip.rig, page, size: 96 })
          const found = data.clips.find(c => c.id === clip.id)
          if (found) return found
          if (++page >= data.pages) throw new Error(`Clip ${clip.name} could not be found`)
        }
      })().catch(error => { full.delete(clip.id); app.toast('error', String(error)); throw error })
      full.set(clip.id, result)
    }
    return result
  }
  const header = (row: Row): boolean => 'group' in row
  function collapse (key: string): void { set({ collapsed: options.collapsed.includes(key) ? options.collapsed.filter(k => k !== key) : [...options.collapsed, key] }) }
</script>

<Drawer testid="lib-drawer" {open} onclose={() => { app.drawer = null }} title="Library" scrim={false} width="min(560px, 94%)">
  <div class="library">
    <div class="controls">
      <div class="search"><SearchBox value={library.query} label="Search clips" placeholder="Search walk, sword, idle…" testid="lib-search" onchange={v => library.setQuery(v)} /><span data-testid="lib-count">{count.toLocaleString()} clips</span></div>
      <div class="selects">
        <label>Sort <select aria-label="Sort clips" value={options.sort} onchange={e => set({ sort: e.currentTarget.value as ViewState['sort'] })}><option value="name">Name</option><option value="length">Length</option><option value="recent">Recent</option><option value="used">Used</option></select></label>
        <button aria-label="Sort direction" onclick={() => set({ direction: options.direction === 'asc' ? 'desc' : 'asc' })}>{options.direction === 'asc' ? '↑' : '↓'}</button>
        <label>Group <select aria-label="Group clips" value={options.group} onchange={e => set({ group: e.currentTarget.value as ViewState['group'], collapsed: [] })}><option value="none">None</option><option value="category">Category</option><option value="source">Source</option></select></label>
        <label>Rig <select aria-label="Clip rig" value={library.rig} onchange={e => { library.rig = e.currentTarget.value }}><option value="all">All</option>{#each rigs as rig (rig)}<option value={rig}>{rig}</option>{/each}</select></label>
        <button aria-pressed={options.view === 'grid'} onclick={() => set({ view: 'grid' })}>Grid</button><button aria-pressed={options.view === 'list'} onclick={() => set({ view: 'list' })}>List</button>
      </div>
      <div class="selects">
        <label>Loop <select aria-label="Loop filter" value={options.loop} onchange={e => set({ loop: e.currentTarget.value as ViewState['loop'] })}><option value="any">Any</option><option value="loop">Loops</option><option value="oneshot">One shot</option></select></label>
        <label>Movement <select aria-label="Movement filter" value={options.inPlace} onchange={e => set({ inPlace: e.currentTarget.value as ViewState['inPlace'] })}><option value="any">Any</option><option value="in-place">In place</option><option value="root-motion">Root motion</option></select></label>
        <label>Use <select aria-label="Use filter" value={options.used} onchange={e => set({ used: e.currentTarget.value as ViewState['used'] })}><option value="any">Any</option><option value="used">Used</option><option value="unused">Unused</option></select></label>
      </div>
      <details><summary>Categories, sources and tags</summary>
        <Chips label="Categories" options={categories} value={options.category} onchange={v => set({ category: v })} />
        <Chips label="Sources" options={sources} value={options.source} onchange={v => set({ source: v })} />
        <Chips label="Tags" options={tags} value={options.tags} onchange={v => set({ tags: v })} />
      </details>
      {#if slots.armed}<Note tone="info">Filling {slots.armed.name}: press a clip's button.</Note>{/if}
      {#if library.error}<Note tone="error">{library.error}</Note>{/if}
    </div>
    <VirtualList items={rows} rowHeight={options.view === 'list' ? 30 : 200} headerHeight={30} minColumnWidth={options.view === 'grid' ? 145 : 0} isHeader={header} testid="lib-scroll">
      {#snippet children(group, columns)}
        {#if 'group' in group[0]}
          {@const h = group[0]}
          <button class="group" data-testid="lib-group" data-id={h.key} aria-expanded={!options.collapsed.includes(h.key)} onclick={() => collapse(h.key)}>{h.label} ({h.n})</button>
        {:else}
          <div class="cliprow" style:grid-template-columns="repeat({columns}, minmax(0, 1fr))">
            {#each group as row ('clip' in row ? row.clip.id : row.key)}
              {#if 'clip' in row}
                {#if options.view === 'grid'}<LibraryCard clip={row.clip} character={app.selected} {resolve} />
                {:else}<LibraryRow clip={row.clip} character={app.selected} uses={library.uses[row.clip.id] ?? 0} {resolve} />{/if}
              {/if}
            {/each}
          </div>
        {/if}
      {/snippet}
    </VirtualList>
  </div>
</Drawer>

<style>
  .library { height: 100%; min-height: 0; display: flex; flex-direction: column; }
  .controls { flex: none; padding: 8px 12px; border-bottom: 1px solid var(--line); display: grid; gap: 7px; }
  .search { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 8px; font-size: 12px; color: var(--text-3); }
  .selects { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  label { color: var(--text-3); font-size: 11px; }
  select, .selects button { height: 25px; border: 1px solid var(--line-strong); border-radius: 5px; background: var(--bg-2); color: var(--text-1); font-size: 11px; }
  .selects button[aria-pressed='true'] { border-color: var(--accent); color: var(--accent-strong); }
  details { font-size: 11px; color: var(--text-3); } summary { cursor: pointer; } details :global(.chips) { margin-top: 5px; }
  .group { width: 100%; height: 30px; text-align: left; padding: 0 10px; background: var(--bg-2); border: 0; color: var(--text-1); font-size: 12px; }
  .cliprow { display: grid; height: 100%; gap: 4px; padding: 0 4px; box-sizing: border-box; overflow: hidden; }
</style>
