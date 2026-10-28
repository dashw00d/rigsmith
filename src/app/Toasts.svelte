<script lang="ts">
  // The short messages in the corner (app.toast): what finished, what failed. Raised above the dock under the
  // viewport (the timeline) while it shows.
  import { CircleAlert, CircleCheck, Info, X } from '@lucide/svelte'
  import { app } from '../state/app.svelte.ts'
</script>

<div class="toasts" aria-live="polite">
  {#each app.toasts as toast (toast.id)}
    <div class="toast {toast.kind}" role={toast.kind === 'error' ? 'alert' : undefined}>
      {#if toast.kind === 'ok'}<CircleCheck size={15} />{:else if toast.kind === 'error'}<CircleAlert size={15} />{:else}<Info size={15} />{/if}
      <span>{toast.text}</span>
      <button aria-label="Dismiss" onclick={() => { app.dismiss(toast.id) }}><X size={13} /></button>
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; bottom: calc(var(--playback-dock-height, 0px) + 24px); right: 12px; max-width: calc(100% - 24px); display: flex; flex-direction: column; gap: 8px; z-index: 100; pointer-events: none; }
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
    pointer-events: auto;
  }
  .toast span { flex: 1; min-width: 0; overflow-wrap: anywhere; white-space: pre-line; }
  .toast button { display: grid; place-items: center; flex: none; width: 18px; height: 18px; padding: 0; border: 0; border-radius: 4px; background: transparent; color: var(--text-3); }
  .toast button:hover { background: var(--bg-4); color: var(--text-1); }
  .toast :global(svg) { flex: none; margin-top: 1px; }
  .ok :global(svg) { color: var(--ok); }
  .error :global(svg) { color: var(--danger); }
  .info :global(svg) { color: var(--accent); }
  @keyframes in { from { opacity: 0; transform: translateY(8px); } }
</style>
