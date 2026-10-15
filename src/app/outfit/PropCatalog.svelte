<script lang="ts">
  import { Plus } from '@lucide/svelte'
  import { app } from '../../state/app.svelte.ts'
  import { outfit } from '../../state/outfit.svelte.ts'
  import { CATALOG, catalogPreview } from '../../engine/props.ts'

  const categories = [...new Set(CATALOG.map(p => p.category))]
  let category = $state('Swords')
  const items = $derived(CATALOG.filter(p => p.category === category))
  const rigged = $derived(app.selected?.status === 'rigged')
  const attached = $derived(new Set(outfit.props.map(p => p.ref)))
</script>

<div class="catalog">
  <header>
    <h2>Props</h2>
    <span class="faint">{CATALOG.length} items</span>
  </header>
  <div class="chips" role="tablist">
    {#each categories as c}
      <button role="tab" aria-selected={category === c} class:active={category === c} onclick={() => { category = c }}>{c}</button>
    {/each}
  </div>
  <div class="grid-wrap">
    {#if !rigged}
      <p class="faint hint">Rig the character first; props attach to its bones.</p>
    {/if}
    <div class="grid">
      {#each items as item (item.file)}
        <button class="item" class:on={attached.has(`catalog:${item.file}`)} disabled={!rigged} onclick={() => outfit.add(item.file)} title="Add {item.name}">
          <div class="thumb"><img src={catalogPreview(item.file)} alt="" loading="lazy" /><span class="plus"><Plus size={14} /></span></div>
          <span class="name">{item.name}</span>
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  .catalog { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  header { display: flex; align-items: baseline; gap: 8px; padding: 14px 16px 8px; }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  header span { font-size: 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 14px 10px 16px; border-bottom: 1px solid var(--line); }
  .chips button { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line-strong); background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; }
  .chips button:hover { color: var(--text-1); }
  .chips button.active { background: var(--text-1); color: var(--bg-0); border-color: var(--text-1); }
  .grid-wrap { flex: 1; min-height: 0; overflow: auto; padding: 12px 14px 16px 16px; }
  .hint { margin: 0 0 10px; font-size: 12.5px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
  .item { display: flex; flex-direction: column; padding: 0; border-radius: var(--r-2); border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; text-align: left; transition: border-color var(--fast), transform var(--fast); }
  .item:hover:not(:disabled) { border-color: var(--line-strong); transform: translateY(-1px); }
  .item:disabled { opacity: 0.5; cursor: default; }
  .item.on { border-color: rgb(95 211 154 / 50%); }
  .thumb { position: relative; aspect-ratio: 1; background: radial-gradient(circle at 50% 40%, #262c3c, #14171e 75%); display: grid; place-items: center; }
  .thumb img { width: 82%; height: 82%; object-fit: contain; }
  .plus { position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: rgb(10 11 14 / 70%); opacity: 0; transition: opacity var(--fast); }
  .item:hover .plus { opacity: 1; }
  .name { padding: 7px 8px 8px; font-size: 12px; font-weight: 550; }
</style>
