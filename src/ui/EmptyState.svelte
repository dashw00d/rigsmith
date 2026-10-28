<script lang="ts">
  import type { Component, Snippet } from 'svelte'

  // What a list or panel shows when there is nothing in it yet: what would be here, and how to get it there.
  interface Props { icon?: Component, title: string, body?: string, action?: Snippet, compact?: boolean }
  let { icon: Icon, title, body, action, compact = false }: Props = $props()
</script>

<div class="empty" class:compact>
  {#if Icon}<div class="glyph"><Icon size={compact ? 16 : 20} /></div>{/if}
  <strong>{title}</strong>
  {#if body}<p>{body}</p>{/if}
  {#if action}<div class="action">{@render action()}</div>{/if}
</div>

<style>
  .empty { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 28px 18px; text-align: center; }
  .compact { padding: 14px 12px; gap: 4px; }
  .glyph { width: 44px; height: 44px; border-radius: 50%; display: grid; place-items: center; background: var(--bg-3); color: var(--text-2); margin-bottom: 4px; }
  .compact .glyph { width: 32px; height: 32px; margin-bottom: 2px; }
  strong { font-weight: 600; }
  p { margin: 0; max-width: 240px; color: var(--text-3); font-size: 12px; }
  .action { margin-top: 6px; }
</style>
