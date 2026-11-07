<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props { title?: string, action?: Snippet, children: Snippet, flush?: boolean, testid?: string }
  let { title, action, children, flush = false, testid }: Props = $props()
</script>

<section data-testid={testid ?? (title ? `section-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}` : undefined)} class:flush>
  {#if title || action}
    <header>
      {#if title}<h3>{title}</h3>{/if}
      {#if action}<div class="action">{@render action()}</div>{/if}
    </header>
  {/if}
  {@render children()}
</section>

<style>
  section { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
  section.flush { padding: 0; }
  section:last-child { border-bottom: 0; }
  header { display: flex; align-items: center; justify-content: space-between; min-height: 20px; }
  h3 { margin: 0; font-size: 11px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--text-3); }
  .action { display: flex; gap: 4px; }
</style>
