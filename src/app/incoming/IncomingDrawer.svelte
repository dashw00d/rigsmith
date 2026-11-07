<script lang="ts">
  import { app } from '../../state/app.svelte.ts'
  import { incoming } from '../../state/incoming.svelte.ts'
  import Drawer from '../../ui/Drawer.svelte'
  import Note from '../../ui/Note.svelte'
  import PartCard from './PartCard.svelte'
  $effect(() => { if (app.drawer === 'incoming') { void app.selectedId; void incoming.refresh() } })
</script>
<Drawer testid="incoming-drawer" open={app.drawer === 'incoming'} onclose={() => { app.drawer = null }} title="Incoming" scrim={false}>
  <div class="packages">
    {#if incoming.error}<Note tone="error">{incoming.error}</Note>{/if}
    {#if incoming.packages.length === 0}<Note>No deliveries yet.</Note>{/if}
    {#each incoming.packages as pkg (pkg.id)}
      <section data-testid="incoming-package" data-id={pkg.id}>
        <h3>{pkg.id}</h3><p>{pkg.tool} · {pkg.at}</p>
        {#each pkg.parts as part (part.id)}<PartCard {part} packageId={pkg.id} />{/each}
      </section>
    {/each}
  </div>
</Drawer>
<style>
  .packages { display: grid; gap: 16px; padding: 12px; } section { display: grid; gap: 6px; } h3, p { margin: 0; } h3 { font-size: 13px; } p { font-size: 11px; color: var(--text-3); }
</style>
