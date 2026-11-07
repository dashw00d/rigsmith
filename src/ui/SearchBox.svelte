<script lang="ts">
  import { Search, X } from '@lucide/svelte'

  interface Props {
    value?: string
    label?: string
    placeholder?: string
    size?: 'sm' | 'md'
    disabled?: boolean
    testid?: string
    onchange?: (value: string) => void
  }
  let { value = $bindable(''), label = 'Search', placeholder = 'Search', size = 'md', disabled = false, testid, onchange }: Props = $props()
  let input: HTMLInputElement | undefined = $state()
  function clear (): void { value = ''; onchange?.(value); input?.focus() }
</script>

<div class="search {size}" class:disabled>
  <Search size={14} aria-hidden="true" />
  <input bind:this={input} data-testid={testid} type="search" aria-label={label} {placeholder} {disabled} bind:value
    oninput={(event) => onchange?.(event.currentTarget.value)} />
  {#if value !== '' && !disabled}<button type="button" aria-label="Clear {label.toLowerCase()}" onclick={clear}><X size={13} /></button>{/if}
</div>

<style>
  .search { display: flex; align-items: center; gap: 6px; height: 28px; min-width: 0; padding: 0 7px; border: 1px solid var(--line-strong); border-radius: var(--r-1); background: var(--bg-1); color: var(--text-3); }
  .search.sm { height: 24px; font-size: 12px; }
  .search:focus-within { border-color: var(--accent); }
  .disabled { opacity: .5; }
  input { flex: 1; min-width: 0; width: 100%; padding: 0; border: 0; background: transparent; color: var(--text-1); }
  input:focus { outline: none; }
  input::-webkit-search-cancel-button { display: none; }
  input::placeholder { color: var(--text-4); }
  button { display: grid; place-items: center; padding: 0; border: 0; background: transparent; color: var(--text-3); }
  button:hover { color: var(--text-1); }
</style>
