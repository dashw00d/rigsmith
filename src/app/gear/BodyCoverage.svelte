<script lang="ts">
  import type { Gear } from '../../model/types.ts'
  import { coverage } from '../../state/coverage.svelte.ts'
  import Note from '../../ui/Note.svelte'
  let { piece }: { piece: Gear } = $props()
  const data = $derived(coverage.data)
  const regions = $derived(coverage.piece(piece.id))
</script>
<div class="coverage" data-testid="coverage-piece" data-id={piece.id}>
  <strong>Body hidden</strong>
  {#if regions === null || data === null}
    <Note>Coverage is available when a skin piece that hides the body is fitted.</Note>
  {:else}
    <div class="regions">
      {#each regions as region (region.region)}
        <button data-testid="coverage-piece-region" data-id={region.region} data-state={region.state} aria-label="{data.names[region.region]}: {Math.round(region.pct)}% {region.state}"
          onmouseenter={() => { coverage.hover = region.region }} onmouseleave={() => { coverage.hover = null }}
          onfocus={() => { coverage.hover = region.region }} onblur={() => { coverage.hover = null }}>
          <span>{data.names[region.region]}</span><span>{Math.round(region.pct)}%{region.state === 'hidden' ? ' · hidden' : ''}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
<style>
  .coverage { display: flex; flex-direction: column; gap: 4px; }
  strong { font-size: 12px; color: var(--text-2); }
  .regions { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 3px; }
  button { display: flex; justify-content: space-between; gap: 5px; border: 0; border-radius: 4px; padding: 4px; background: var(--bg-2); color: var(--text-2); text-align: left; font-size: 11px; }
  button:hover, button:focus-visible { background: var(--bg-3); color: var(--text-1); }
</style>
