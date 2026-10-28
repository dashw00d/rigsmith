<script lang="ts">
  // The bundled catalog of weapons, shields and tools (src/engine/props.ts), opened over the viewport from the Gear
  // step. Picking one adds it as gear on its usual bone, placed as the catalog places it (gear.addCatalog: one gear.add).
  import { Plus } from '@lucide/svelte'
  import { phaseOf } from '../../model/select.ts'
  import { CATALOG, catalogPreview } from '../../engine/props.ts'
  import { app } from '../../state/app.svelte.ts'
  import { gear } from '../../state/gear.svelte.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import EmptyState from '../../ui/EmptyState.svelte'

  const categories = [...new Set(CATALOG.map(p => p.category))]
  let category = $state(categories[0])
  const items = $derived(CATALOG.filter(p => p.category === category))
  const character = $derived(app.selected)
  const rigged = $derived(character !== null && phaseOf(character).phase === 'rigged')
  // (what it has from the catalog already: marked, and can be added again)
  const has = $derived(new Set(character?.gear.flatMap(g => (g.catalog === undefined ? [] : [g.catalog])) ?? []))
  let adding = $state<string | null>(null)

  async function add (file: string): Promise<void> {
    if (character === null || adding !== null) return
    adding = file
    try {
      await gear.addCatalog(character, file)
    } finally {
      adding = null
    }
  }
</script>

<Drawer open={app.drawer === 'catalog'} onclose={() => app.toggleDrawer('catalog')} title="Catalog" scrim={false}>
  {#if character === null}
    <EmptyState title="No character" body="Pick a character to give it gear." compact />
  {:else}
    <div class="chips" role="tablist" aria-label="Category">
      {#each categories as c (c)}
        <button role="tab" aria-selected={category === c} class:active={category === c} onclick={() => { category = c }}>{c}</button>
      {/each}
    </div>
    <div class="grid-wrap">
      {#if !rigged}
        <p class="hint">It shows on {character.name} once it is rigged.</p>
      {/if}
      <div class="grid">
        {#each items as item (item.file)}
          <button class="item" class:on={has.has(item.file)} disabled={adding !== null} onclick={() => add(item.file)}
            title={has.has(item.file) ? `${item.name}: ${character.name} has one; add another` : `Add ${item.name}`}>
            <span class="thumb"><img src={catalogPreview(item.file)} alt="" loading="lazy" /><span class="plus"><Plus size={14} /></span></span>
            <span class="name">{item.name}</span>
          </button>
        {/each}
      </div>
    </div>
  {/if}
</Drawer>

<style>
  .chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 12px 14px 10px 16px; border-bottom: 1px solid var(--line); }
  .chips button { height: 26px; padding: 0 10px; border-radius: 13px; border: 1px solid var(--line-strong); background: transparent; color: var(--text-2); font-size: 12px; font-weight: 500; }
  .chips button:hover { color: var(--text-1); }
  .chips button.active { background: var(--text-1); color: var(--bg-0); border-color: var(--text-1); }
  .grid-wrap { padding: 12px 14px 16px 16px; }
  .hint { margin: 0 0 10px; font-size: 12.5px; color: var(--text-3); }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 10px; }
  .item { display: flex; flex-direction: column; padding: 0; border-radius: var(--r-2); border: 1px solid var(--line); background: var(--bg-2); overflow: hidden; text-align: left; transition: border-color var(--fast), transform var(--fast); }
  .item:hover:not(:disabled) { border-color: var(--line-strong); transform: translateY(-1px); }
  .item:disabled { opacity: 0.6; cursor: progress; }
  .item.on { border-color: rgb(95 211 154 / 50%); }
  .thumb { position: relative; aspect-ratio: 1; background: radial-gradient(circle at 50% 40%, #262c3c, #14171e 75%); display: grid; place-items: center; }
  .thumb img { width: 82%; height: 82%; object-fit: contain; }
  .plus { position: absolute; right: 6px; top: 6px; width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: rgb(10 11 14 / 70%); opacity: 0; transition: opacity var(--fast); }
  .item:hover .plus, .item:focus-visible .plus { opacity: 1; }
  .name { padding: 7px 8px 8px; font-size: 12px; font-weight: 550; }
</style>
