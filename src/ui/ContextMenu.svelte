<script lang="ts">
  import { onMount, tick } from 'svelte'
  import type { MenuItem } from './contextmenu.ts'

  let { items, x, y, close }: { items: MenuItem[], x: number, y: number, close: () => void } = $props()
  let root: HTMLDivElement
  let left = $state(x)
  let top = $state(y)
  let expanded = $state.raw<MenuItem[]>([])

  onMount(() => {
    const rect = root.getBoundingClientRect()
    left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8))
    top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8))
    root.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')?.focus()
  })

  function choose (item: MenuItem): void {
    if (item.disabled) return
    if (item.children !== undefined) {
      expanded = expanded.includes(item) ? expanded.filter(i => i !== item) : [...expanded, item]
      return
    }
    close()
    item.run()
  }

  function key (event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'ArrowRight') {
      const button = event.target as HTMLElement
      if (button.getAttribute('aria-haspopup') !== 'menu') return
      event.preventDefault()
      button.click()
      void tick().then(() => { button.parentElement?.querySelector<HTMLButtonElement>('.submenu button:not(:disabled)')?.focus() })
      return
    }
    if (event.key === 'ArrowLeft') {
      const parent = (event.target as HTMLElement).closest('.submenu')?.parentElement
      if (parent === undefined || parent === null) return
      event.preventDefault()
      const button = parent.querySelector<HTMLButtonElement>(':scope > button')
      button?.click()
      button?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const current = event.target as HTMLElement
    const menu = current.closest('[role="menu"]')
    if (menu === null) return
    const buttons = [...menu.querySelectorAll<HTMLButtonElement>(':scope > .item > button:not(:disabled)')]
    if (buttons.length === 0) return
    event.preventDefault()
    const at = buttons.indexOf(current as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next].focus()
  }
</script>

{#snippet entries(list: MenuItem[])}
  {#each list as item (item.label)}
    <div class="item">
      <button type="button" role="menuitem" disabled={item.disabled} class:danger={item.danger}
        aria-haspopup={item.children === undefined ? undefined : 'menu'} aria-expanded={item.children === undefined ? undefined : expanded.includes(item)}
        onclick={() => { choose(item) }}>
        <span>{item.label}</span>
        {#if item.keys}<kbd>{item.keys}</kbd>{/if}
        {#if item.children !== undefined}<span aria-hidden="true">›</span>{/if}
      </button>
      {#if item.children !== undefined && expanded.includes(item)}
        <div class="submenu" role="menu" aria-label={item.label}>{@render entries(item.children)}</div>
      {/if}
    </div>
  {/each}
{/snippet}

<div bind:this={root} class="menu" class:flip={left + 400 > window.innerWidth} role="menu" aria-label="Actions" style:left="{left}px" style:top="{top}px" onkeydown={key}>
  {@render entries(items)}
</div>

<style>
  .menu, .submenu { position: fixed; z-index: 1000; min-width: 180px; padding: 4px; border: 1px solid var(--line-strong); border-radius: var(--r-2); background: var(--bg-2); box-shadow: var(--shadow-pop); }
  .submenu { position: absolute; top: -5px; left: calc(100% - 2px); }
  .flip .submenu { left: auto; right: calc(100% - 2px); }
  .item { position: relative; }
  button { display: flex; width: 100%; gap: 12px; align-items: center; padding: 6px 8px; border: 0; border-radius: var(--r-1); background: transparent; color: var(--text-1); text-align: left; font: inherit; font-size: 12px; }
  button > span:first-child { flex: 1; }
  button:hover:not(:disabled), button:focus-visible { background: var(--bg-4); outline: none; }
  button:disabled { opacity: .45; }
  button.danger { color: var(--danger); }
  kbd { color: var(--text-3); font: inherit; }
</style>
