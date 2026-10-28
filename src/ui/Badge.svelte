<script lang="ts">
  import type { Snippet } from 'svelte'

  // A short status word. The tones match select.phaseOf's (plus accent); `dot` puts a light before it (busy pulses).
  interface Props { tone?: 'muted' | 'accent' | 'ok' | 'warn' | 'error' | 'busy', dot?: boolean, children: Snippet }
  let { tone = 'muted', dot = false, children }: Props = $props()
</script>

<span class="badge {tone}">
  {#if dot}<i aria-hidden="true"></i>{/if}
  {@render children()}
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    height: 20px;
    padding: 0 8px;
    border-radius: 10px;
    font-size: 11.5px;
    font-weight: 550;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    background: var(--bg-3);
    color: var(--text-2);
  }
  i { flex: none; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .accent, .busy { background: var(--accent-soft); color: var(--accent-strong); }
  .ok { background: var(--ok-soft); color: var(--ok); }
  .warn { background: var(--warn-soft); color: var(--warn); }
  .error { background: var(--danger-soft); color: var(--danger); }
  .busy i { animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 50% { opacity: 0.3; } }
</style>
