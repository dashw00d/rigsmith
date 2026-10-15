<script lang="ts">
  import type { Snippet } from 'svelte'
  import { onMount } from 'svelte'

  interface Props { onclose: () => void, children: Snippet, width?: number, align?: 'left' | 'right' }
  let { onclose, children, width = 280, align = 'left' }: Props = $props()
  let node: HTMLDivElement

  onMount(() => {
    const away = (e: PointerEvent): void => {
      if (!node.contains(e.target as Node) && !(node.parentElement?.contains(e.target as Node) ?? false)) onclose()
    }
    const key = (e: KeyboardEvent): void => { if (e.key === 'Escape') onclose() }
    setTimeout(() => window.addEventListener('pointerdown', away))
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', away); window.removeEventListener('keydown', key) }
  })
</script>

<div class="pop {align}" style="width: {width}px" bind:this={node}>
  {@render children()}
</div>

<style>
  .pop {
    position: absolute;
    top: calc(100% + 8px);
    z-index: 50;
    background: var(--bg-2);
    border-radius: var(--r-3);
    box-shadow: var(--shadow-pop);
    overflow: hidden;
    animation: pop-in var(--med) var(--ease);
  }
  .right { right: 0; }
  .left { left: 0; }
  @keyframes pop-in { from { opacity: 0; transform: translateY(-4px) scale(0.98); } }
</style>
