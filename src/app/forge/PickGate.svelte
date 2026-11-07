<script lang="ts">
  // A pick gate opened big: every finished attempt of the stage side by side, numbered as the 1-9 keys pick them.
  // Picking one closes it; Escape closes it without.
  import { X } from '@lucide/svelte'
  import type { SetView } from '../../../server/forge/types.ts'
  import { forge } from '../../state/forge.svelte.ts'
  import IconButton from '../../ui/IconButton.svelte'
  import { thumbOf } from './board.ts'

  interface Props { set: SetView, item: string, stage: string, onclose: () => void }
  let { set, item, stage, onclose }: Props = $props()

  const view = $derived(set.items.find(i => i.id === item)?.stages.find(s => s.id === stage))
  const done = $derived(view?.attempts.filter(a => a.status === 'done') ?? [])
  const name = $derived(set.items.find(i => i.id === item)?.name ?? item)

  async function choose (attempt: string): Promise<void> {
    await forge.pick(item, stage, attempt)
    onclose()
  }

  function onkeydown (e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); onclose(); return }
    const n = Number(e.key)
    if (Number.isInteger(n) && n >= 1 && n <= done.length) { e.preventDefault(); e.stopPropagation(); void choose(done[n - 1].id) }
  }
</script>

<svelte:window onkeydown={onkeydown} />

<div class="gate" role="dialog" aria-modal="true" aria-label="Pick one: {name}">
  <header>
    <h2>Pick one · {name}</h2>
    <IconButton label="Close" hint="Close (Esc)" size="sm" onclick={onclose}><X size={15} /></IconButton>
  </header>
  <div class="grid">
    {#each done as a, i (a.id)}
      {@const thumb = thumbOf(a)}
      <button class="choice" class:picked={view?.selected?.attempt === a.id} onclick={() => { void choose(a.id) }}>
        {#if thumb !== null}<img src={forge.fileUrl(item, stage, a.id, thumb)} alt="{a.id}" />{:else}<span class="none">{a.outputs.length} files</span>{/if}
        <span class="label"><kbd>{i + 1}</kbd> {a.id}{a.seed !== undefined ? ` · seed ${a.seed}` : ''}{a.stale.length > 0 ? ' · stale' : ''}</span>
      </button>
    {/each}
  </div>
</div>

<style>
  .gate { position: absolute; inset: 24px; z-index: 50; display: flex; flex-direction: column; background: var(--bg-1); border-radius: var(--r-3); box-shadow: var(--shadow-pop); }
  header { display: flex; align-items: center; justify-content: space-between; height: 44px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--line); }
  h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .grid { flex: 1; min-height: 0; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; padding: 16px; }
  .choice { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: var(--r-2); background: var(--bg-2); color: var(--text-2); cursor: pointer; }
  .choice:hover { border-color: var(--accent); color: var(--text-1); }
  .choice.picked { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  img { width: 100%; aspect-ratio: 3 / 1; object-fit: contain; background: var(--bg-0); border-radius: var(--r-1); }
  .none { padding: 40px 0; color: var(--text-4); }
  .label { font-size: 12px; text-align: left; }
  kbd { padding: 0 5px; border: 1px solid var(--line-strong); border-radius: 4px; font: 600 11px var(--mono); }
</style>
