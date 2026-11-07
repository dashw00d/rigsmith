<script lang="ts">
  // A stage of the set's pipeline: its name, its gate and what it asks of the GPU, and a card per item.
  import { Cpu } from '@lucide/svelte'
  import type { ForgeStage, SetView } from '../../../server/forge/types.ts'
  import { forge } from '../../state/forge.svelte.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import ItemCard from './ItemCard.svelte'

  interface Props { set: SetView, stage: ForgeStage, index: number, onpick: (item: string, stage: string) => void }
  let { set, stage, index, onpick }: Props = $props()

  const GATES: Record<string, string> = { pick: 'Pick', approve: 'Approve', align: 'Align (Gear step)', mask: 'Mask' }
</script>

<section class="column" aria-label={stage.label}>
  <header>
    <span class="label">{stage.label}</span>
    {#if stage.gate !== undefined}<span class="gate" use:tooltip={'A person decides here before the stages after it run'}>{GATES[stage.gate]}</span>{/if}
    {#if stage.gpu !== undefined}<span class="gpu" use:tooltip={`Waits its turn on the GPU: ${(stage.gpu.vram / 1024).toFixed(1)} GB (${stage.gpu.family})`}><Cpu size={12} /></span>{/if}
  </header>
  <div class="cards">
    {#each set.items as item, i (item.id)}
      {@const view = item.stages.find(s => s.id === stage.id)}
      {#if view !== undefined}
        <ItemCard {item} {stage} {view} focused={forge.focus?.item === i && forge.focus?.stage === index}
          onfocus={() => { forge.focus = { item: i, stage: index } }} onpick={() => { onpick(item.id, stage.id) }} />
      {/if}
    {/each}
  </div>
</section>

<style>
  .column { flex: none; width: 200px; display: flex; flex-direction: column; min-height: 0; }
  header { flex: none; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 4px; font-size: 12px; }
  .label { font-weight: 650; }
  .gate { padding: 1px 6px; border-radius: 8px; background: var(--accent-soft); color: var(--accent); font-size: 10.5px; font-weight: 600; }
  .gpu { display: inline-flex; color: var(--text-3); }
  .cards { flex: 1; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px 4px 12px; }
</style>
