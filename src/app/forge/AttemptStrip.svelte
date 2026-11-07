<script lang="ts">
  // A card's attempts, oldest first, numbered as the 1-4 keys pick them (finished ones only): the one picked marked,
  // a stale one flagged with why, a failed one with what went wrong. Clicking a finished one picks it.
  import type { StageView } from '../../../server/forge/types.ts'
  import { forge } from '../../state/forge.svelte.ts'
  import { tooltip } from '../../ui/tooltip.ts'

  interface Props { item: string, stage: string, view: StageView }
  let { item, stage, view }: Props = $props()

  const done = $derived(view.attempts.filter(a => a.status === 'done'))
</script>

{#if view.attempts.length > 0}
  <ol class="strip" aria-label="Attempts">
    {#each view.attempts as a (a.id)}
      {@const n = done.indexOf(a) + 1}
      {@const picked = view.selected?.attempt === a.id}
      <li>
        <button class="chip {a.status}" class:picked class:stale={a.stale.length > 0} disabled={a.status !== 'done'}
          aria-pressed={picked}
          use:tooltip={`${a.id}${a.seed !== undefined ? ` · seed ${a.seed}` : ''}: ${a.status === 'done' ? (a.stale.length > 0 ? `stale (${a.stale.join('; ')})` : picked ? 'picked' : `pick it${n <= 9 ? ` (${n})` : ''}`) : a.error ?? a.status}`}
          onclick={() => { void forge.pick(item, stage, a.id) }}>
          {a.status === 'done' ? n : a.status === 'interrupted' ? '…' : '×'}
        </button>
      </li>
    {/each}
  </ol>
{/if}

<style>
  .strip { display: flex; flex-wrap: wrap; gap: 3px; margin: 0; padding: 0; list-style: none; }
  .chip {
    min-width: 20px; height: 18px; padding: 0 4px; border: 1px solid var(--line-strong); border-radius: 4px;
    background: var(--bg-3); color: var(--text-2); font: 600 10.5px/1 var(--mono); cursor: pointer;
  }
  .chip:hover:not(:disabled) { color: var(--text-1); border-color: var(--accent); }
  .chip.picked { background: var(--accent); border-color: transparent; color: var(--accent-ink); }
  .chip.stale:not(.picked) { border-color: var(--warn); }
  .chip.stale.picked { background: var(--warn); }
  .chip.failed, .chip.cancelled { color: var(--danger); border-color: var(--danger-soft); cursor: default; }
  .chip.interrupted { color: var(--text-3); cursor: default; }
</style>
