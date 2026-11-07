<script module lang="ts">
  // Drafts survive collapsing the editor or switching layers/characters within the session.
  const maskDrafts = new Map<string, { canvas: HTMLCanvasElement, file: string, baseMask: string | undefined }>()
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import type { Character, ClothLayer } from '../../model/types.ts'
  import { call } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { assets } from '../../state/assets.svelte.ts'
  import Button from '../../ui/Button.svelte'

  let { character, layer }: { character: Character, layer: ClothLayer } = $props()
  let canvas: HTMLCanvasElement
  let mask: HTMLCanvasElement | undefined
  let source: ImageBitmap | undefined
  let ready = $state(false)
  let busy = $state(false)
  let dirty = $state(false)
  let mode = $state<'brush' | 'erase'>('brush')
  let size = $state(128)
  let pointer: number | null = null
  let previous: { x: number, y: number } | null = null
  let turn = 0
  let open = $state(false)
  let loadedKey = ''
  let loadedFile = ''
  let loadedMask: string | undefined
  const loadKey = $derived(JSON.stringify([character.id, layer.id, layer.file, layer.cut?.mask ?? null]))

  async function bitmap (url: string): Promise<ImageBitmap> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Image HTTP ${response.status}`)
    return await createImageBitmap(await response.blob(), { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
  }

  async function load (id: string, layerId: string, file: string, maskFile: string | undefined, token: number): Promise<void> {
    ready = false
    try {
      const url = assets.asset(id, file); const maskUrl = assets.asset(id, maskFile)
      if (url === null) throw new Error('No cloth image')
      const [image, saved] = await Promise.all([bitmap(url), maskUrl === null ? Promise.resolve(undefined) : bitmap(maskUrl)])
      if (token !== turn) { image.close(); saved?.close(); return }
      if (saved !== undefined && (saved.width !== image.width || saved.height !== image.height)) { image.close(); saved.close(); throw new Error('Mask dimensions differ from the cloth image') }
      source?.close(); source = image
      const key = JSON.stringify([id, layerId]); const draft = maskDrafts.get(key)
      if (draft !== undefined && (draft.file !== file || draft.canvas.width !== image.width || draft.canvas.height !== image.height)) {
        saved?.close(); app.toast('error', 'The cloth image changed; the unsaved mask remains in this session.')
        return
      }
      const next = draft?.canvas ?? document.createElement('canvas')
      if (draft === undefined) {
        next.width = image.width; next.height = image.height
        const ctx = next.getContext('2d')!
        ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, next.width, next.height)
        if (saved !== undefined) ctx.drawImage(saved, 0, 0)
      }
      saved?.close()
      loadedKey = key; loadedFile = file; loadedMask = draft === undefined ? maskFile : draft.baseMask
      mask = next; canvas.width = image.width; canvas.height = image.height
      dirty = draft !== undefined; ready = true; draw()
    } catch (error) { if (token === turn) app.toast('error', `Cloth mask: ${(error as Error).message}`) }
  }

  $effect(() => {
    const key = loadKey
    if (!open) { ready = false; source?.close(); source = undefined; mask = undefined; return }
    const [id, layerId, file, saved] = JSON.parse(key) as [string, string, string, string | null]
    const token = ++turn
    untrack(() => { void load(id, layerId, file, saved ?? undefined, token) })
    return () => { turn++ }
  })
  onDestroy(() => { turn++; source?.close() })

  function draw (): void {
    if (source === undefined || mask === undefined) return
    const ctx = canvas.getContext('2d')!
    ctx.globalCompositeOperation = 'source-over'; ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(source, 0, 0)
    ctx.globalCompositeOperation = 'multiply'; ctx.drawImage(mask, 0, 0); ctx.globalCompositeOperation = 'source-over'
  }
  function at (event: PointerEvent): { x: number, y: number } {
    const rect = canvas.getBoundingClientRect()
    return { x: (event.clientX - rect.left) / rect.width * canvas.width, y: (event.clientY - rect.top) / rect.height * canvas.height }
  }
  function paint (point: { x: number, y: number }): void {
    if (mask === undefined) return
    const ctx = mask.getContext('2d')!
    ctx.strokeStyle = mode === 'brush' ? '#000' : '#fff'; ctx.fillStyle = ctx.strokeStyle
    ctx.lineWidth = size; ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    if (previous === null) { ctx.beginPath(); ctx.arc(point.x, point.y, size / 2, 0, Math.PI * 2); ctx.fill() }
    else { ctx.beginPath(); ctx.moveTo(previous.x, previous.y); ctx.lineTo(point.x, point.y); ctx.stroke() }
    previous = point; dirty = true
    const existing = maskDrafts.get(loadedKey)
    maskDrafts.set(loadedKey, { canvas: mask, file: loadedFile, baseMask: existing === undefined ? loadedMask : existing.baseMask })
    draw()
  }
  function start (event: PointerEvent): void {
    if (!ready || busy || event.button !== 0) return
    event.preventDefault(); canvas.focus(); pointer = event.pointerId; previous = null
    canvas.setPointerCapture(event.pointerId); paint(at(event))
  }
  function move (event: PointerEvent): void { if (event.pointerId === pointer) { event.preventDefault(); paint(at(event)) } }
  function stop (event: PointerEvent): void { if (event.pointerId === pointer) { pointer = null; previous = null } }

  async function save (): Promise<void> {
    if (mask === undefined || !dirty || busy) return
    const id = character.id; const layerId = layer.id; const key = JSON.stringify([id, layerId]); const draft = maskDrafts.get(key)
    if (draft === undefined || key !== loadedKey) return
    busy = true
    try {
      const live = app.byId(id); const current = live?.look.cloth?.find(l => l.id === layerId)
      if (live === null || live === undefined || current === undefined) throw new Error('Cloth layer no longer exists')
      if (current.file !== draft.file || current.cut?.mask !== draft.baseMask) throw new Error('The image or saved mask changed; the unsaved strokes are still available')
      const png = await new Promise<Blob>((resolve, reject) => draft.canvas.toBlob(blob => { if (blob === null) reject(new Error('Could not encode PNG')); else resolve(blob) }, 'image/png'))
      const result = await call<{ path: string }>('PUT', `/api/characters/${encodeURIComponent(id)}/look/cloth/${encodeURIComponent(layerId)}/mask`, png, { 'Content-Type': 'image/png' })
      const latest = app.byId(id); const layerNow = latest?.look.cloth?.find(l => l.id === layerId)
      if (latest === null || latest === undefined || layerNow === undefined || layerNow.file !== draft.file || layerNow.cut?.mask !== draft.baseMask) throw new Error('The image or saved mask changed; the unsaved strokes are still available')
      if (await app.do(id, { type: 'look.cloth.update', id: layerId, patch: { cut: { ...layerNow.cut, mask: result.path } } }) === null) throw new Error('Could not attach mask')
      if (maskDrafts.get(key) === draft) maskDrafts.delete(key)
      if (loadedKey === key) dirty = false
    } catch (error) { app.toast('error', `Save cloth mask: ${(error as Error).message}`) } finally { busy = false }
  }

</script>

<details class="mask-editor" ontoggle={(event) => { open = event.currentTarget.open }}>
  <summary data-testid="look-mask-open">UV brush mask</summary>
  <div class="controls">
    <Button size="sm" aria-pressed={mode === 'brush'} onclick={() => { mode = 'brush' }}>Brush</Button>
    <Button size="sm" aria-pressed={mode === 'erase'} onclick={() => { mode = 'erase' }}>Erase</Button>
    <label>Size <input type="range" min="4" max="512" step="4" bind:value={size} aria-label="Brush size" /> <output>{size}px</output></label>
    <Button size="sm" variant="primary" disabled={!ready || !dirty || busy} onclick={() => { void save() }}>Save mask</Button>
  </div>
  <canvas bind:this={canvas} data-testid="look-mask-canvas" tabindex="0" aria-label="Cloth UV mask" onpointerdown={start} onpointermove={move} onpointerup={stop} onpointercancel={stop}></canvas>
  {#if ready}<span data-testid="look-mask-ready" class="hint">Black hides cloth; white restores it. Save to apply.</span>{:else}<span class="hint">Loading UV image…</span>{/if}
</details>

<style>
  .mask-editor { color: var(--text-2); font-size: 11px; }
  .controls { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin: 6px 0; }
  label { display: flex; align-items: center; gap: 4px; }
  input { width: 90px; }
  canvas { display: block; width: 100%; max-width: 360px; height: auto; background: var(--bg-2); cursor: crosshair; touch-action: none; }
  .hint { display: block; margin-top: 4px; color: var(--text-3); }
</style>
