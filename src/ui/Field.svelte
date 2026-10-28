<script lang="ts">
  import type { Snippet } from 'svelte'

  // A labelled control: the label (and a hint under it) on the left and the control on the right, or above it with
  // `stack`. A single control is labelled by nesting it; a group of them (a Segmented, a row of buttons) says `group`.
  interface Props { label: string, hint?: string, error?: string | null, stack?: boolean, group?: boolean, children: Snippet }
  let { label, hint, error = null, stack = false, group = false, children }: Props = $props()
  const id = $props.id()
</script>

<svelte:element this={group ? 'div' : 'label'} class="field" class:stack role={group ? 'group' : undefined} aria-labelledby={group ? `${id}-label` : undefined}>
  <span class="text">
    <span class="label" id="{id}-label">{label}</span>
    {#if hint}<span class="hint">{hint}</span>{/if}
  </span>
  <span class="control">{@render children()}</span>
  {#if error}<span class="error" role="alert">{error}</span>{/if}
</svelte:element>

<style>
  .field { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 4px 12px; }
  .field.stack { grid-template-columns: minmax(0, 1fr); gap: 5px; }
  .text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .label { color: var(--text-2); font-size: 12.5px; }
  .hint { color: var(--text-3); font-size: 11.5px; }
  .control { display: flex; align-items: center; justify-content: flex-end; gap: 6px; min-width: 0; }
  .stack .control { justify-content: flex-start; }
  .error { grid-column: 1 / -1; color: var(--danger); font-size: 11.5px; }
</style>
