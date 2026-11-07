<script lang="ts" generics="T">
  import type { Snippet } from 'svelte'

  interface Props {
    items: readonly T[]
    rowHeight: number
    /** Zero for a single column; otherwise the minimum width of a grid card. */
    minColumnWidth?: number
    headerHeight?: number
    isHeader?: (item: T) => boolean
    children: Snippet<[T[], number]>
    testid?: string
  }
  let { items, rowHeight, minColumnWidth = 0, headerHeight = rowHeight, isHeader = () => false, children, testid }: Props = $props()
  let width = $state(0)
  let height = $state(0)
  let scrollTop = $state(0)
  let container: HTMLDivElement
  const columns = $derived(minColumnWidth > 0 ? Math.max(1, Math.floor(width / minColumnWidth)) : 1)
  const rows = $derived.by(() => {
    const result: T[][] = []
    let pending: T[] = []
    for (const item of items) {
      if (isHeader(item)) {
        if (pending.length) result.push(pending)
        pending = []
        result.push([item])
      } else {
        pending.push(item)
        if (pending.length === columns) { result.push(pending); pending = [] }
      }
    }
    if (pending.length) result.push(pending)
    return result
  })
  const offsets = $derived.by(() => {
    const out = [0]
    for (const row of rows) out.push(out[out.length - 1] + (isHeader(row[0]) ? headerHeight : rowHeight))
    return out
  })
  const total = $derived(offsets[offsets.length - 1])
  const first = $derived(Math.max(0, offsets.findIndex((v, i) => i < rows.length && offsets[i + 1] > scrollTop) - 2))
  const last = $derived.by(() => { const i = offsets.findIndex(v => v >= scrollTop + height); return Math.min(rows.length, (i < 0 ? rows.length : i) + 2) })
  $effect(() => {
    if (!container) return
    const observer = new ResizeObserver(entries => {
      const rect = entries[0]?.contentRect
      if (rect) { width = rect.width; height = rect.height }
    })
    observer.observe(container)
    width = container.clientWidth; height = container.clientHeight
    return () => observer.disconnect()
  })
  // Filtering or collapsing can shrink the content while scrolled near the end.
  $effect(() => {
    const max = Math.max(0, total - height)
    if (scrollTop > max && container) { container.scrollTop = max; scrollTop = max }
  })
</script>

<div class="viewport" bind:this={container} data-testid={testid} onscroll={(e) => { scrollTop = e.currentTarget.scrollTop }}>
  <div class="space" style:height="{total}px">
    {#each rows.slice(first, last) as row, offset (first + offset)}
      <div class="row" style:height="{offsets[first + offset + 1] - offsets[first + offset]}px" style:top="{offsets[first + offset]}px">
        {@render children(row, columns)}
      </div>
    {/each}
  </div>
</div>

<style>
  .viewport { flex: 1; min-height: 0; overflow: auto; }
  .space { position: relative; }
  .row { position: absolute; inset-inline: 0; box-sizing: border-box; }
</style>
