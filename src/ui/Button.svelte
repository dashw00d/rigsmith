<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { HTMLButtonAttributes } from 'svelte/elements'

  interface Props extends HTMLButtonAttributes {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    icon?: boolean
    block?: boolean
    loading?: boolean
    children: Snippet
  }

  let { variant = 'secondary', size = 'md', icon = false, block = false, loading = false, children, disabled, ...rest }: Props = $props()
</script>

<button class="btn {variant} {size}" class:icon class:block class:loading disabled={disabled || loading} {...rest}>
  {#if loading}<span class="spinner" aria-hidden="true"></span>{/if}
  {@render children()}
</button>

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 7px;
    height: 30px;
    padding: 0 12px;
    border-radius: var(--r-2);
    border: 1px solid transparent;
    font-weight: 500;
    letter-spacing: 0.005em;
    white-space: nowrap;
    transition: background var(--fast), border-color var(--fast), color var(--fast), transform var(--fast), box-shadow var(--fast);
    user-select: none;
  }
  .btn:active:not(:disabled) { transform: translateY(1px); }
  .btn:disabled { opacity: 0.45; cursor: default; }
  .sm { height: 26px; padding: 0 9px; font-size: 12px; border-radius: var(--r-1); }
  .lg { height: 38px; padding: 0 18px; font-size: 13.5px; }
  .icon { width: 30px; padding: 0; }
  .icon.sm { width: 26px; }
  .block { width: 100%; }

  .primary {
    background: var(--accent);
    color: var(--accent-ink);
    box-shadow: 0 1px 0 rgb(255 255 255 / 25%) inset, 0 6px 20px -8px rgb(142 162 255 / 60%);
  }
  .primary:hover:not(:disabled) { background: var(--accent-strong); }
  .secondary { background: var(--bg-3); border-color: var(--line-strong); color: var(--text-1); }
  .secondary:hover:not(:disabled) { background: var(--bg-4); }
  .ghost { background: transparent; color: var(--text-2); }
  .ghost:hover:not(:disabled) { background: var(--bg-3); color: var(--text-1); }
  .danger { background: transparent; color: var(--danger); border-color: rgb(242 119 122 / 30%); }
  .danger:hover:not(:disabled) { background: var(--danger-soft); }

  .spinner {
    width: 12px;
    height: 12px;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
