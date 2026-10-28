<script lang="ts" generics="T extends string">
  import { ChevronDown } from '@lucide/svelte'

  // One of a list. Options with a `group` are gathered under it, in the order the groups first appear. A null value
  // (nothing chosen yet) shows the placeholder.
  interface Option { value: T, label: string, disabled?: boolean, group?: string }
  interface Props {
    options: Option[]
    value: T | null
    onchange?: (value: T) => void
    placeholder?: string
    /** Its accessible name when no Field labels it. */
    label?: string
    disabled?: boolean
    size?: 'sm' | 'md'
    width?: string
  }
  let { options, value = $bindable(), onchange, placeholder, label, disabled = false, size = 'md', width }: Props = $props()

  const groups = $derived.by(() => {
    const out: Array<{ label: string | null, options: Option[] }> = []
    for (const option of options) {
      const name = option.group ?? null
      let group = out.find(g => g.label === name)
      if (group === undefined) out.push(group = { label: name, options: [] })
      group.options.push(option)
    }
    return out
  })
</script>

{#snippet list (items: Option[])}
  {#each items as option (option.value)}
    <option value={option.value} disabled={option.disabled}>{option.label}</option>
  {/each}
{/snippet}

<span class="select {size}" class:disabled style:width>
  <select
    aria-label={label}
    {disabled}
    value={value ?? ''}
    onchange={(event) => { const next = event.currentTarget.value as T; value = next; onchange?.(next) }}
  >
    {#if value === null || placeholder !== undefined}<option value="" disabled>{placeholder ?? ''}</option>{/if}
    {#each groups as group (group.label)}
      {#if group.label === null}{@render list(group.options)}{:else}<optgroup label={group.label}>{@render list(group.options)}</optgroup>{/if}
    {/each}
  </select>
  <ChevronDown size={13} aria-hidden="true" />
</span>

<style>
  .select { position: relative; display: inline-flex; align-items: center; min-width: 0; max-width: 100%; }
  select {
    appearance: none;
    width: 100%;
    min-width: 0;
    height: 28px;
    padding: 0 26px 0 8px;
    border-radius: var(--r-1);
    border: 1px solid var(--line-strong);
    background: var(--bg-2);
    text-overflow: ellipsis;
    cursor: pointer;
    transition: border-color var(--fast), background var(--fast);
  }
  select:hover:not(:disabled) { background: var(--bg-3); }
  select:focus, select:focus-visible { outline: none; border-color: var(--accent); }
  .sm select { height: 24px; font-size: 12px; padding: 0 22px 0 6px; }
  .select :global(svg) { position: absolute; right: 8px; pointer-events: none; color: var(--text-3); }
  .sm :global(svg) { right: 6px; }
  .disabled { opacity: 0.5; }
  .disabled select { cursor: default; }
  option, optgroup { background: var(--bg-2); color: var(--text-1); }
</style>
