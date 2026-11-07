<script lang="ts">
  import type { Snippet } from 'svelte'
  interface Props { tone?: 'muted' | 'info' | 'warn' | 'error' | 'ok', testid?: string, children: Snippet }
  let { tone = 'muted', testid, children }: Props = $props()
</script>

<div class="note {tone}" data-testid={testid} role={tone === 'error' ? 'alert' : undefined}>{@render children()}</div>

<style>
  .note { padding: 8px 10px; border-radius: var(--r-1); background: var(--bg-2); color: var(--text-2); font-size: 12px; line-height: 1.4; }
  .info { color: var(--accent-strong); background: var(--accent-soft); }
  .warn { color: var(--warn); }
  .error { color: var(--danger); background: var(--danger-soft); }
  .ok { color: var(--ok); }
</style>
