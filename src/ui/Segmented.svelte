<script lang="ts" generics="T extends string">
  import type { Component } from 'svelte'
  import { tooltip } from './tooltip.ts'

  interface Option { value: T, label: string, icon?: Component, hint?: string }
  interface Props { options: Option[], value: T, size?: 'sm' | 'md', iconsOnly?: boolean, label?: string, onchange?: (value: T) => void, testid?: string }

  let { options, value = $bindable(), size = 'md', iconsOnly = false, label, onchange, testid }: Props = $props()

  function onKey (event: KeyboardEvent, index: number): void {
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % options.length
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = options.length - 1
    else return
    event.preventDefault()
    value = options[next].value
    onchange?.(value)
    const group = (event.currentTarget as HTMLElement).parentElement
    group?.querySelectorAll('button')[next]?.focus()
  }
</script>

<div data-testid={testid} class="seg {size}" role="radiogroup" aria-label={label}>
  {#each options as option, index (option.value)}
    <button
      role="radio"
      aria-checked={value === option.value}
      aria-label={option.label}
      tabindex={value === option.value ? 0 : -1}
      class:active={value === option.value}
      use:tooltip={iconsOnly ? option.label : option.hint}
      onclick={() => { value = option.value; onchange?.(option.value) }}
      onkeydown={(event) => onKey(event, index)}
    >
      {#if option.icon}<option.icon size={14} strokeWidth={2} />{/if}
      {#if !iconsOnly}<span>{option.label}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .seg {
    display: inline-flex;
    padding: 2px;
    gap: 2px;
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--r-2);
  }
  button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 10px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--text-2);
    font-weight: 500;
    transition: background var(--fast), color var(--fast);
  }
  .sm button { height: 22px; padding: 0 8px; font-size: 12px; }
  button:hover { color: var(--text-1); }
  button.active { background: var(--bg-4); color: var(--text-1); box-shadow: 0 1px 2px rgb(0 0 0 / 40%); }
</style>
