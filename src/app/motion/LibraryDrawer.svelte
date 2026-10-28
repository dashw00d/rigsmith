<script lang="ts">
  // The clip library (server/library.ts), over the viewport's left edge while app.drawer is 'library' (toggled from the
  // Motion step). Clips are for the selected character's skeleton (the human's, or its creature template's); a card
  // previews on the character, its round button fills the armed slot or keeps it as a trial. No scrim: the character
  // stays in view while clips are tried.
  import { untrack } from 'svelte'
  import { ChevronLeft, ChevronRight, LibraryBig, Search, X } from '@lucide/svelte'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { library } from '../../state/library.svelte.ts'
  import { slots } from '../../state/slots.svelte.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import Button from '../../ui/Button.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'
  import LibraryCard from './LibraryCard.svelte'

  const open = $derived(app.drawer === 'library')
  let search = $state(library.query)
  let grid = $state<HTMLDivElement>()

  // (the selected character's skeleton; another one starts from no filters)
  $effect(() => {
    if (!open) return
    const rig = app.selected?.skeleton.template ?? 'human'
    untrack(() => { library.setRig(rig) })
  })
  // (its game slot names, so a card knows a slot from a trial)
  $effect(() => {
    if (open) void slots.load(app.selected?.id ?? null)
  })
  $effect(() => {
    // (a search typed elsewhere, or the filters reset with another rig)
    search = library.query
  })
  $effect(() => {
    if (!open) return
    return () => { animator.cancelSprites() }
  })

  const data = $derived(library.data)
  const pages = $derived(data?.pages ?? 1)
  const count = $derived.by(() => {
    if (data === null) return ''
    const all = data.all.toLocaleString()
    return library.filtered ? `${data.total.toLocaleString()} of ${all}` : `${all} clips`
  })
  const armed = $derived(slots.armed)

  function go (page: number): void {
    animator.cancelSprites()
    library.go(page)
    grid?.scrollTo({ top: 0 })
  }

  function pageList (current: number, total: number): Array<number | null> {
    if (total <= 7) return Array.from({ length: total }, (_, i) => i)
    const set = new Set([0, total - 1, current - 1, current, current + 1].filter(p => p >= 0 && p < total))
    const sorted = [...set].sort((a, b) => a - b)
    const out: Array<number | null> = []
    sorted.forEach((p, i) => { if (i > 0 && p - sorted[i - 1] > 1) out.push(null); out.push(p) })
    return out
  }

  function onKey (e: KeyboardEvent): void {
    if (!open || e.defaultPrevented || (e.target instanceof Element && e.target.closest('input, select, textarea, button, a, summary, [contenteditable]'))) return
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && e.altKey)) { e.preventDefault(); go(library.page + 1) }
    if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); go(library.page - 1) }
  }

  function clearFilters (): void {
    search = ''
    library.resetFilters()
  }
</script>

<svelte:window onkeydown={onKey} />

<Drawer {open} onclose={() => { app.drawer = null }} title="Library" scrim={false} width="min(440px, 92%)">
  <div class="library">
    <header>
      <span class="count faint">{count}</span>
      <label class="search">
        <Search size={14} />
        <input aria-label="Search clips" placeholder="Search walk, sword, idle…" bind:value={search} oninput={() => library.setQuery(search)} />
        {#if search}<button class="clear" aria-label="Clear search" onclick={() => { search = ''; library.setQuery('') }}><X size={13} /></button>{/if}
      </label>
    </header>

    {#if data?.catalog}
      <p class="coverage faint">
        {#if data.catalog.complete}
          Mixamo collection complete · {data.catalog.motionCount.toLocaleString()} motions + {data.catalog.poseCount.toLocaleString()} poses
        {:else}
          Mixamo collection · {data.catalog.converted.toLocaleString()} of {data.catalog.count.toLocaleString()} clips
        {/if}
      </p>
    {/if}

    <div class="filters">
      <div class="chips" role="group" aria-label="Clip source">
        <button aria-pressed={library.source === ''} class:active={library.source === ''} onclick={() => library.setSource('')}>All clips</button>
        <button aria-pressed={library.source === 'custom'} class:active={library.source === 'custom'} onclick={() => library.setSource('custom')}>Made here <span>{(data?.custom ?? 0).toLocaleString()}</span></button>
      </div>
      <select aria-label="Clip category" value={library.category} onchange={(e) => library.setCategory(e.currentTarget.value)}>
        <option value="">All categories</option>
        {#each data?.categories ?? [] as category (category.id)}
          {#if category.count > 0 || category.id === library.category}<option value={category.id}>{category.label} ({category.count.toLocaleString()})</option>{/if}
        {/each}
      </select>
    </div>

    {#if armed !== null}
      <p class="armed">Filling <strong>{armed.name}</strong>: press a card's button. <button class="link" onclick={() => slots.arm(null)}>Stop</button></p>
    {/if}

    <div class="grid-wrap" bind:this={grid}>
      {#if library.error}
        <EmptyState icon={LibraryBig} title="The library didn't load" body={library.error}>
          {#snippet action()}<Button size="sm" onclick={() => library.load()}>Retry</Button>{/snippet}
        </EmptyState>
      {:else if data !== null && data.total === 0}
        {#if data.all === 0}
          <EmptyState icon={LibraryBig} title="No clips for this skeleton" body="Clips made in the animation editor for it show here." />
        {:else}
          <EmptyState icon={LibraryBig} title="No matches" body="Try another word or category.">
            {#snippet action()}<Button size="sm" onclick={clearFilters}>Clear filters</Button>{/snippet}
          </EmptyState>
        {/if}
      {:else}
        <div class="grid" class:dim={library.loading}>
          {#each data?.clips ?? [] as clip (clip.id)}
            <LibraryCard {clip} character={app.selected} />
          {/each}
        </div>
      {/if}
    </div>

    {#if pages > 1 && data !== null}
      <footer>
        <span class="faint range">
          {(library.page * data.pageSize + 1).toLocaleString()}–{Math.min((library.page + 1) * data.pageSize, data.total).toLocaleString()}
          of {data.total.toLocaleString()}
        </span>
        <nav class="pager" aria-label="Pages">
          <button aria-label="Previous page" disabled={library.page === 0} onclick={() => go(library.page - 1)}><ChevronLeft size={15} /></button>
          {#each pageList(library.page, pages) as p, i (p ?? `gap-${i}`)}
            {#if p === null}<span class="gap">…</span>
            {:else}<button class:active={p === library.page} aria-current={p === library.page ? 'page' : undefined} onclick={() => go(p)}>{p + 1}</button>{/if}
          {/each}
          <button aria-label="Next page" disabled={library.page >= pages - 1} onclick={() => go(library.page + 1)}><ChevronRight size={15} /></button>
        </nav>
      </footer>
    {/if}
  </div>
</Drawer>

<style>
  .library { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 2px 14px 8px 16px; }
  .count { font-size: 12px; white-space: nowrap; }
  .coverage { margin: 0; padding: 0 16px 8px; font-size: 11px; }
  .search {
    flex: 1;
    min-width: 150px;
    max-width: 280px;
    display: flex;
    align-items: center;
    gap: 7px;
    height: 30px;
    padding: 0 8px 0 10px;
    border-radius: var(--r-2);
    background: var(--bg-2);
    border: 1px solid var(--line-strong);
    color: var(--text-3);
    transition: border-color var(--fast);
  }
  .search:focus-within { border-color: var(--accent); color: var(--text-2); }
  .search input { flex: 1; min-width: 0; border: 0; outline: none; background: transparent; color: var(--text-1); }
  .clear { border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; padding: 2px; }
  .filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 2px 14px 10px 16px; border-bottom: 1px solid var(--line); }
  .filters select { flex: 1; min-width: 130px; width: 0; height: 28px; padding: 0 6px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--bg-2); font-size: 12px; }
  .chips { display: flex; gap: 5px; }
  .chips button {
    height: 26px;
    padding: 0 10px;
    border-radius: 13px;
    border: 1px solid var(--line-strong);
    background: transparent;
    color: var(--text-2);
    font-size: 12px;
    font-weight: 500;
    transition: all var(--fast);
  }
  .chips button span { color: var(--text-3); margin-left: 3px; font-size: 11px; }
  .chips button:hover { color: var(--text-1); border-color: var(--text-4); }
  .chips button.active { background: var(--text-1); color: var(--bg-0); border-color: var(--text-1); }
  .chips button.active span { color: var(--bg-4); }
  .armed { margin: 0; padding: 7px 16px; font-size: 12px; background: var(--accent-soft); color: var(--text-1); border-bottom: 1px solid var(--line); }
  .link { border: 0; background: transparent; color: var(--accent-strong); padding: 0; font-size: inherit; margin-left: 4px; }
  .grid-wrap { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 16px 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 10px; transition: opacity var(--med); }
  .grid.dim { opacity: 0.55; }
  footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px 10px 16px; border-top: 1px solid var(--line); }
  .range { font-size: 12px; white-space: nowrap; }
  .pager { display: flex; align-items: center; gap: 2px; }
  .pager button {
    min-width: 28px;
    height: 28px;
    padding: 0 6px;
    border-radius: var(--r-1);
    border: 0;
    background: transparent;
    color: var(--text-2);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    display: grid;
    place-items: center;
  }
  .pager button:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .pager button.active { background: var(--accent-soft); color: var(--accent-strong); }
  .pager button:disabled { opacity: 0.3; cursor: default; }
  .gap { color: var(--text-3); padding: 0 4px; }
</style>
