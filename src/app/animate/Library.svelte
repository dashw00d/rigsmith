<script lang="ts">
  import { onMount } from 'svelte'
  import { ChevronLeft, ChevronRight, LibraryBig, Search, X } from '@lucide/svelte'
  import { app } from '../../state/app.svelte.ts'
  import { animator } from '../../state/animator.svelte.ts'
  import { library } from '../../state/library.svelte.ts'
  import LibraryCard from './LibraryCard.svelte'

  let search = $state(library.query)
  let grid: HTMLDivElement

  onMount(() => () => { animator.cancelSprites() })

  // Show clips for the selected character's skeleton (humanoid or a creature template).
  $effect(() => { library.setRig(app.selected?.template ?? 'human') })

  const total = $derived(library.data?.categories.reduce((n, c) => n + c.count, 0) ?? 0)
  const pages = $derived(library.data?.pages ?? 1)
  const inSet = $derived(new Set(app.selected?.animations.map(a => a.clipId) ?? []))

  function go (page: number): void {
    animator.cancelSprites()
    library.go(page)
    grid?.scrollTo({ top: 0 })
  }

  function pageList (current: number, count: number): Array<number | null> {
    if (count <= 7) return Array.from({ length: count }, (_, i) => i)
    const set = new Set([0, count - 1, current - 1, current, current + 1].filter(p => p >= 0 && p < count))
    const sorted = [...set].sort((a, b) => a - b)
    const out: Array<number | null> = []
    sorted.forEach((p, i) => { if (i > 0 && p - sorted[i - 1] > 1) out.push(null); out.push(p) })
    return out
  }

  function onKey (e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return
    if (e.key === 'PageDown' || (e.key === 'ArrowRight' && e.altKey)) { e.preventDefault(); go(library.page + 1) }
    if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && e.altKey)) { e.preventDefault(); go(library.page - 1) }
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="library">
  <header>
    <div class="title">
      <h2>Library</h2>
      <span class="faint">{total.toLocaleString()} animations</span>
    </div>
    <label class="search">
      <Search size={14} />
      <input placeholder="Search walk, sword, idle…" bind:value={search} oninput={() => library.setQuery(search)} />
      {#if search}<button class="clear" aria-label="Clear search" onclick={() => { search = ''; library.setQuery('') }}><X size={13} /></button>{/if}
    </label>
  </header>

  {#if library.data?.catalog}
    <p class="coverage faint">
      {#if library.data.catalog.complete}
        Mixamo collection complete · {library.data.catalog.motionCount.toLocaleString()} motions + {library.data.catalog.poseCount.toLocaleString()} poses
      {:else}
        Mixamo collection · {library.data.catalog.converted.toLocaleString()} of {library.data.catalog.count.toLocaleString()} clips
      {/if}
    </p>
  {/if}

  <div class="chips" role="tablist" aria-label="Categories">
    <button role="tab" aria-selected={library.category === '' && library.source === ''} class:active={library.category === '' && library.source === ''} onclick={() => { library.source = ''; library.setCategory('') }}>
      All <span>{total.toLocaleString()}</span>
    </button>
    <!-- (the clips made here: the animation editor's, the scripted ones) -->
    <button role="tab" aria-selected={library.source === 'custom'} class:active={library.source === 'custom'} class="custom" onclick={() => library.setSource(library.source === 'custom' ? '' : 'custom')}>
      Custom <span>{(library.data?.custom ?? 0).toLocaleString()}</span>
    </button>
    {#each library.data?.categories ?? [] as category (category.id)}
      {#if category.count > 0}
        <button role="tab" aria-selected={library.category === category.id} class:active={library.category === category.id} onclick={() => library.setCategory(category.id)}>
          {category.label} <span>{category.count.toLocaleString()}</span>
        </button>
      {/if}
    {/each}
  </div>

  <div class="grid-wrap" bind:this={grid}>
    {#if library.error}
      <div class="empty"><p class="muted">{library.error}</p></div>
    {:else if library.data !== null && library.data.total === 0}
      <div class="empty">
        <LibraryBig size={22} />
        {#if total === 0}
          <strong>No animations available</strong>
          <p class="faint">Choose another collection or import animations.</p>
        {:else}
          <strong>No matches</strong>
          <p class="faint">Try another word or category.</p>
        {/if}
      </div>
    {:else}
      <div class="grid" class:dim={library.loading}>
        {#each library.data?.clips ?? [] as clip (clip.id)}
          <LibraryCard {clip} added={inSet.has(clip.id)} playing={animator.current?.clipId === clip.id} />
        {/each}
      </div>
    {/if}
  </div>

  {#if pages > 1}
    <footer>
      <span class="faint range">
        {(library.page * (library.data?.pageSize ?? 24) + 1).toLocaleString()}–{Math.min((library.page + 1) * (library.data?.pageSize ?? 24), library.data?.total ?? 0).toLocaleString()}
        of {(library.data?.total ?? 0).toLocaleString()}
      </span>
      <nav class="pager" aria-label="Pages">
        <button aria-label="Previous page" disabled={library.page === 0} onclick={() => go(library.page - 1)}><ChevronLeft size={15} /></button>
        {#each pageList(library.page, pages) as p}
          {#if p === null}<span class="gap">…</span>
          {:else}<button class:active={p === library.page} onclick={() => go(p)}>{p + 1}</button>{/if}
        {/each}
        <button aria-label="Next page" disabled={library.page >= pages - 1} onclick={() => go(library.page + 1)}><ChevronRight size={15} /></button>
      </nav>
    </footer>
  {/if}
</div>

<style>
  .library { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px 8px 16px; }
  .title { display: flex; align-items: baseline; gap: 8px; white-space: nowrap; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .title span { font-size: 12px; }
  .coverage { margin: 0; padding: 0 16px 8px; font-size: 11px; }
  .search {
    flex: 1;
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
  .chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 2px 14px 10px 16px; border-bottom: 1px solid var(--line); }
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
  .grid-wrap { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 16px 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(124px, 1fr)); gap: 10px; transition: opacity var(--med); }
  .grid.dim { opacity: 0.55; }
  .empty { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; text-align: center; color: var(--text-2); }
  .empty p { margin: 0; max-width: 280px; font-size: 12.5px; }
  footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 14px 10px 16px; border-top: 1px solid var(--line); }
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
