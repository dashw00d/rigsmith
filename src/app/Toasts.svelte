<script lang="ts">
  import { CircleAlert, CircleCheck, Info } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class="toast {toast.kind}">
      {#if toast.kind === 'ok'}<CircleCheck size={15} />{:else if toast.kind === 'error'}<CircleAlert size={15} />{:else}<Info size={15} />{/if}
      <span>{toast.text}</span>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; bottom: 18px; right: 18px; display: flex; flex-direction: column; gap: 8px; z-index: 100; }
  .toast {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    max-width: 380px;
    padding: 10px 14px;
    border-radius: var(--r-2);
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    animation: in var(--med) var(--ease);
  }
  .toast :global(svg) { flex: none; margin-top: 1px; }
  .ok :global(svg) { color: var(--ok); }
  .error :global(svg) { color: var(--danger); }
  .info :global(svg) { color: var(--accent); }
  @keyframes in { from { opacity: 0; transform: translateY(8px); } }
</style>
