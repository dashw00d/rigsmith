<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import { keyLabel, onShortcuts, shortcuts } from './shortcuts.ts'
  import type { HTMLButtonAttributes } from 'svelte/elements'
  import { tooltip } from './tooltip.ts'

  // A button that is only an icon: `label` is its name for screen readers and its tooltip (or `hint`, when the
  // tooltip should say more). `active` makes it a toggle (aria-pressed).
  interface Props extends HTMLButtonAttributes {
    label: string
    hint?: string
    variant?: 'ghost' | 'secondary' | 'danger'
    size?: 'sm' | 'md'
    active?: boolean
    keys?: string
    children: Snippet
  }
  let { label, hint, variant = 'ghost', size = 'md', active, type = 'button', keys, children, ...rest }: Props = $props()
  let shortcutsVersion = $state(0)
  onMount(() => onShortcuts(() => { shortcutsVersion++ }))
  const keyText = $derived.by(() => {
    void shortcutsVersion
    const shortcut = shortcuts().find(s => s.id === keys)
    return shortcut === undefined ? '' : keyLabel(shortcut.keys).join(' ')
  })
</script>

<button {type} class="icon-button {variant} {size}" class:active aria-label={label} aria-pressed={active} use:tooltip={hint ?? label} {...rest}>
  {@render children()}
  {#if keyText !== ''}<kbd aria-hidden="true">{keyText}</kbd>{/if}
</button>

<style>
  .icon-button {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    padding: 0;
    border: 1px solid transparent;
    border-radius: var(--r-2);
    background: transparent;
    color: var(--text-2);
    transition: background var(--fast), color var(--fast), border-color var(--fast);
  }
  .icon-button:has(kbd) { width: auto; padding: 0 5px; display: inline-flex; gap: 4px; align-items: center; }
  kbd { padding: 1px 3px; border: 1px solid currentColor; border-radius: 3px; opacity: .65; font: inherit; font-size: 10px; line-height: 1; }
  .sm { width: 24px; height: 24px; border-radius: var(--r-1); }
  .icon-button:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .secondary { background: var(--bg-3); border-color: var(--line-strong); }
  .secondary:hover:not(:disabled) { background: var(--bg-4); }
  .danger:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger); }
  .active, .active:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent-strong); }
  .icon-button:disabled { opacity: 0.4; cursor: default; }
</style>
