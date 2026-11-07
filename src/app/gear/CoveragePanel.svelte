<script lang="ts">
  import { coverage } from '../../state/coverage.svelte.ts'
  import Note from '../../ui/Note.svelte'
  import Section from '../../ui/Section.svelte'
  const data = $derived(coverage.data)
</script>
{#if coverage.on}
  <Section title="Coverage" testid="coverage-section">
    <Note>Green: bare · amber: partial · red: hidden. Percent is the largest single piece's share, not a union.</Note>
    {#if data === null}<Note>Load a skinned body to see its regions.</Note>{:else}
      <div class="regions">
        {#each data.regions as region (region.region)}
          <button data-testid="coverage-region" data-id={region.region} data-state={region.state} aria-label="{data.names[region.region]}: {Math.round(region.pct)}% {region.state}"
            onmouseenter={() => { coverage.hover = region.region }} onmouseleave={() => { coverage.hover = null }}
            onfocus={() => { coverage.hover = region.region }} onblur={() => { coverage.hover = null }}>
            <span class="dot {region.state}"></span><span>{data.names[region.region]}</span><span>{Math.round(region.pct)}%</span>
          </button>
        {/each}
      </div>
    {/if}
  </Section>
{/if}
<style>
  .regions { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 3px; }
  button { display: flex; align-items: center; gap: 5px; border: 0; border-radius: 4px; padding: 4px; background: var(--bg-2); color: var(--text-2); font-size: 11px; text-align: left; }
  button:hover, button:focus-visible { background: var(--bg-3); color: var(--text-1); }
  button span:nth-child(2) { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .dot { width: 8px; height: 8px; flex: none; border-radius: 50%; background: #35b871; }
  .dot.partial { background: #ecae37; } .dot.hidden { background: #e45252; }
</style>
