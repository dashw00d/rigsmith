<script lang="ts">
  import type { Snippet } from 'svelte'
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
    children: Snippet
  }
  let { label, hint, variant = 'ghost', size = 'md', active, type = 'button', children, ...rest }: Props = $props()
</script>

<button {type} class="icon-button {variant} {size}" class:active aria-label={label} aria-pressed={active} use:tooltip={hint ?? label} {...rest}>
  {@render children()}
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
  .sm { width: 24px; height: 24px; border-radius: var(--r-1); }
  .icon-button:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .secondary { background: var(--bg-3); border-color: var(--line-strong); }
  .secondary:hover:not(:disabled) { background: var(--bg-4); }
  .danger:hover:not(:disabled) { background: var(--danger-soft); color: var(--danger); }
  .active, .active:hover:not(:disabled) { background: var(--accent-soft); color: var(--accent-strong); }
  .icon-button:disabled { opacity: 0.4; cursor: default; }
</style>
