<script lang="ts">
  import { onMount } from 'svelte'
  import { painter } from '../../state/painter.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'

  let canvas: HTMLCanvasElement
  let drawing = false
  let erasing = false
  let last: { x: number, y: number } | null = null
  let cursor = $state<{ x: number, y: number } | null>(null)
  let frame = 0

  onMount(() => {
    const resize = (): void => {
      const r = canvas.parentElement!.getBoundingClientRect()
      const w = Math.round(r.width)
      const h = Math.round(r.height)
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        painter.ensureMask(w, h)
        redraw()
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(canvas.parentElement!)
    resize()
    return () => {
      observer.disconnect()
      if (viewer.stage !== null) viewer.stage.controls.enabled = true
    }
  })

  // Navigating moves the camera (which invalidates a screen-space mask), so it's a separate tool.
  $effect(() => {
    if (viewer.stage !== null) viewer.stage.controls.enabled = painter.tool === 'navigate'
  })

  $effect(() => {
    void painter.maskVersion
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(redraw)
  })

  /** Tinted fill plus a bright outline, so it's obvious exactly what will be repainted. */
  function redraw (): void {
    const mask = painter.maskData
    if (canvas === undefined || mask === null || painter.maskWidth !== canvas.width) return
    const w = canvas.width
    const h = canvas.height
    const ctx = canvas.getContext('2d')!
    const image = ctx.createImageData(w, h)
    const d = image.data
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 0) continue
      const x = i % w
      const edge = (x > 0 && mask[i - 1] === 0) || (x < w - 1 && mask[i + 1] === 0) || (i >= w && mask[i - w] === 0) || (i < mask.length - w && mask[i + w] === 0)
      d[i * 4] = edge ? 233 : 142
      d[i * 4 + 1] = edge ? 238 : 162
      d[i * 4 + 2] = 255
      d[i * 4 + 3] = edge ? 255 : 105
    }
    ctx.putImageData(image, 0, 0)
  }

  function point (e: PointerEvent): { x: number, y: number } {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  function apply (x: number, y: number, first: boolean): void {
    const tool = painter.tool
    if (tool === 'brush' || tool === 'erase') {
      // Interpolate dabs so fast strokes stay continuous.
      const from = last ?? { x, y }
      const steps = Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (painter.brush / 4)))
      for (let s = 1; s <= steps; s++) painter.dab(from.x + ((x - from.x) * s) / steps, from.y + ((y - from.y) * s) / steps, tool === 'erase' || erasing ? 0 : 1)
    } else if (tool === 'smart') {
      const from = last ?? { x, y }
      const steps = first ? 1 : Math.max(1, Math.ceil(Math.hypot(x - from.x, y - from.y) / (painter.brush / 3)))
      for (let s = 1; s <= steps; s++) {
        painter.smartDab(from.x + ((x - from.x) * s) / steps, from.y + ((y - from.y) * s) / steps, erasing ? 0 : 1, first && s === 1)
      }
    }
    last = { x, y }
  }
</script>

<canvas
  bind:this={canvas}
  class:interactive={painter.tool !== 'navigate'}
  class:hidden={painter.tool === 'navigate' || painter.previewing}
  class:wand={painter.tool === 'wand'}
  onpointerdown={(e) => {
    if (painter.tool === 'navigate' || e.button !== 0) return
    const p = point(e)
    if (painter.tool === 'wand') {
      painter.wand(p.x, p.y, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace')
      return
    }
    drawing = true
    erasing = e.altKey
    last = null
    canvas.setPointerCapture(e.pointerId)
    apply(p.x, p.y, true)
  }}
  onpointermove={(e) => { const p = point(e); cursor = p; if (drawing) apply(p.x, p.y, false) }}
  onpointerup={() => { drawing = false; last = null }}
  onpointerleave={() => { cursor = null }}
></canvas>
{#if cursor && (painter.tool === 'brush' || painter.tool === 'erase' || painter.tool === 'smart')}
  <div class="cursor" class:smart={painter.tool === 'smart'} style="left: {cursor.x}px; top: {cursor.y}px; width: {painter.brush}px; height: {painter.brush}px"></div>
{/if}

<style>
  canvas { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; image-rendering: pixelated; }
  canvas.interactive { pointer-events: auto; cursor: none; }
  canvas.wand { cursor: crosshair; }
  canvas.hidden { opacity: 0; }
  .cursor { position: absolute; z-index: 2; transform: translate(-50%, -50%); border-radius: 50%; border: 1.5px solid var(--text-1); box-shadow: 0 0 0 1px rgb(0 0 0 / 50%); pointer-events: none; }
  .cursor.smart::after { content: ''; position: absolute; left: 50%; top: 50%; width: 4px; height: 4px; margin: -2px; border-radius: 50%; background: var(--text-1); }
</style>
