<script lang="ts" generics="T extends string">
  import type { Component, Snippet } from 'svelte'

  // Tabs over one panel (`children`, the chosen tab's content, rendered by the caller). The arrow keys, Home and End
  // move between tabs and choose them.
  interface Tab { id: T, label: string, icon?: Component, count?: number | string, disabled?: boolean }
  interface Props { tabs: Tab[], value: T, onchange?: (value: T) => void, label?: string, size?: 'sm' | 'md', children?: Snippet }
  let { tabs, value = $bindable(), onchange, label, size = 'md', children }: Props = $props()
  const id = $props.id()

  // (the tab the keyboard lands on: the chosen one, else the first that can be)
  const current = $derived(tabs.some(t => t.id === value && t.disabled !== true) ? value : tabs.find(t => t.disabled !== true)?.id)

  function choose (tab: T): void {
    if (tab === value) return
    value = tab
    onchange?.(tab)
  }

  function onkeydown (event: KeyboardEvent): void {
    const open = tabs.filter(t => t.disabled !== true)
    const at = open.findIndex(t => t.id === current)
    let next: number
    if (event.key === 'ArrowRight') next = (at + 1) % open.length
    else if (event.key === 'ArrowLeft') next = (at - 1 + open.length) % open.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = open.length - 1
    else return
    event.preventDefault()
    choose(open[next].id)
    const list = (event.currentTarget as HTMLElement)
    list.querySelector<HTMLElement>(`[data-tab="${CSS.escape(open[next].id)}"]`)?.focus()
  }
</script>

<div class="tabs {size}">
  <div class="list" role="tablist" aria-label={label} tabindex="-1" {onkeydown}>
    {#each tabs as tab (tab.id)}
      <button
        type="button"
        role="tab"
        id="{id}-{tab.id}"
        data-tab={tab.id}
        aria-selected={tab.id === value}
        aria-controls={children ? `${id}-panel` : undefined}
        tabindex={tab.id === current ? 0 : -1}
        disabled={tab.disabled}
        class:active={tab.id === value}
        onclick={() => { choose(tab.id) }}
      >
        {#if tab.icon}<tab.icon size={14} strokeWidth={2} />{/if}
        <span>{tab.label}</span>
        {#if tab.count !== undefined}<span class="count">{tab.count}</span>{/if}
      </button>
    {/each}
  </div>
  {#if children}
    <div class="panel" role="tabpanel" id="{id}-panel" aria-labelledby="{id}-{value}">{@render children()}</div>
  {/if}
</div>

<style>
  .tabs { display: flex; flex-direction: column; min-height: 0; }
  .list { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--line); overflow-x: auto; scrollbar-width: none; }
  .list:focus { outline: none; }
  button {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 34px;
    padding: 0 10px;
    border: 0;
    background: transparent;
    color: var(--text-3);
    font-weight: 550;
    box-shadow: inset 0 -2px 0 transparent;
    transition: color var(--fast), box-shadow var(--fast);
  }
  .sm button { height: 28px; padding: 0 8px; font-size: 12px; }
  button:hover:not(:disabled) { color: var(--text-1); }
  button.active { color: var(--text-1); box-shadow: inset 0 -2px 0 var(--accent); }
  button:disabled { opacity: 0.4; cursor: default; }
  button:focus-visible { outline-offset: -2px; }
  .count { font-size: 11px; color: var(--text-3); background: var(--bg-3); border-radius: 8px; padding: 0 6px; }
  .panel { flex: 1; min-height: 0; }
</style>
