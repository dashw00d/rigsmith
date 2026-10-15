<script lang="ts">
  import { onDestroy } from 'svelte'
  import { Brush, Camera, Check, Eraser, FolderOpen, Hand, Paintbrush, RotateCcw, Sparkles, Wand, WandSparkles, X, Minus, Plus, ArrowLeftRight } from '@lucide/svelte'
  import { painter, type PaintTool } from '../../state/painter.svelte.ts'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { api, fileUrl, type Character } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import Section from '../../ui/Section.svelte'

  let { character }: { character: Character } = $props()

  const job = $derived(app.jobFor(character.id))
  const busy = $derived(job?.kind === 'texture')
  const filled = $derived(character.texture?.filled === true)
  const images = $derived(character.texture?.images ?? [])
  const coverage = $derived(images.reduce((m, i) => Math.max(m, i.coverage), 0))

  async function fill (): Promise<void> {
    try { await api.fillTexture(character.id) } catch (e) { app.toast('error', (e as Error).message) }
  }

  let tool = $state<PaintTool>(painter.tool)
  $effect(() => { tool = painter.tool })
  const tools: Array<{ value: PaintTool, label: string, icon: typeof Brush }> = [
    { value: 'smart', label: 'Smart brush: stays on the surface you start on and stops at edges (Alt to remove)', icon: Sparkles },
    { value: 'wand', label: 'Select region: click a surface (Shift adds, Alt removes)', icon: WandSparkles },
    { value: 'brush', label: 'Brush (Alt to erase)', icon: Brush },
    { value: 'erase', label: 'Eraser', icon: Eraser },
    { value: 'navigate', label: 'Move camera (clears the mask)', icon: Hand },
  ]
  const toolHelp: Record<PaintTool, string> = {
    smart: 'Scrub over what you want. It follows that color and stops at seams, creases and silhouettes. Alt-drag removes.',
    wand: 'Click a surface to select all of it up to its edges. Shift-click adds, Alt-click removes.',
    brush: 'Paints exactly where you drag. Alt-drag erases.',
    erase: 'Removes from the mask.',
    navigate: 'Orbit and zoom to frame the area. Moving the camera clears the mask, so frame first.',
  }
  const codexJob = $derived(job?.kind === 'codex' ? job : undefined)
  let resultInput = $state<HTMLInputElement>()
  onDestroy(() => { if (painter.active) painter.stop() })

  let captures = $state<Array<{ id: string, createdAt: number, hasResult: boolean }>>([])
  $effect(() => {
    void character.id
    void painter.capture
    void api.projections(character.id).then(list => { captures = list }, () => { captures = [] })
  })
  function ago (t: number): string {
    const m = Math.round((Date.now() - t) / 60000)
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`
  }

  async function revert (): Promise<void> {
    try { await api.revertTexture(character.id) } catch (e) { app.toast('error', (e as Error).message) }
  }
</script>

<Section title="Unpainted areas">
  <p class="faint small">AI texture generators leave magenta where they couldn't see the surface. Filling paints those spots from nearby colors on the model (in 3D, so UV seams don't bleed).</p>
  {#if character.texture && !busy}
    {#if filled}
      <div class="ok">
        <Sparkles size={14} />
        <span>Filled {(coverage * 100).toFixed(1)}% of the texture</span>
      </div>
      {#each images.filter(i => i.mask) as image}
        <figure>
          <img src={fileUrl(character, `textures/${image.mask}`)} alt="Filled areas in UV space" />
          <figcaption class="faint">Filled areas (texture layout)</figcaption>
        </figure>
      {/each}
    {:else if coverage < 0.0005}
      <div class="ok"><Sparkles size={14} /><span>No unpainted areas found</span></div>
    {/if}
  {/if}
  <div class="actions">
    {#if filled || character.texture?.painted}
      <Button variant="ghost" onclick={revert} disabled={busy}><RotateCcw size={14} /> Restore original texture</Button>
    {:else}
      <Button variant="primary" block loading={busy} onclick={fill}>{#if !busy}<Wand size={15} />{/if} {busy ? job?.message : 'Find and fill holes'}</Button>
    {/if}
  </div>
</Section>

<Section title="Projection painting">
  {#if !painter.active}
    <p class="faint small">Frame an area, paint a mask over it, and let Codex repaint it. The new paint is projected back onto the texture: only what this view sees, blended at the edges.</p>
    <Button variant="primary" block disabled={character.status !== 'rigged' && character.kind !== 'mesh'} onclick={() => painter.start()}><Paintbrush size={15} /> Start painting</Button>
    {#if captures.length > 0}
      <div class="captures">
        <span class="faint small">Earlier captures</span>
        {#each captures.slice(0, 5) as c (c.id)}
          <button class="capture" onclick={() => painter.resume(character, c.id)}>
            <span>{ago(c.createdAt)}</span>
            <span class:ready={c.hasResult}>{c.hasResult ? 'Result ready · preview' : 'Waiting for result'}</span>
          </button>
        {/each}
      </div>
    {/if}
  {:else}
    <ol class="steps">
      <li class:done={painter.hasMask}>
        <strong>1 · Mask the area</strong>
        <Segmented options={tools} bind:value={tool} iconsOnly onchange={(t) => { painter.tool = t }} />
        <p class="faint small">{toolHelp[tool]}</p>
        {#if tool === 'smart' || tool === 'brush' || tool === 'erase'}
          <label class="brush"><span class="faint">Size</span><input type="range" min="8" max="200" bind:value={painter.brush} /><span class="mono faint">{painter.brush}</span></label>
        {/if}
        {#if tool === 'smart' || tool === 'wand'}
          <label class="brush"><span class="faint">Tolerance</span><input type="range" min="0" max="1" step="0.01" bind:value={painter.tolerance} /><span class="mono faint">{Math.round(painter.tolerance * 100)}</span></label>
        {/if}
        {#if tool === 'wand'}
          <Toggle label="Contiguous" hint="Off: select every matching color in view" bind:checked={painter.contiguous} />
        {/if}
        <div class="mask-tools">
          <button onclick={() => painter.growMask(-2)} title="Shrink mask"><Minus size={13} /></button>
          <button onclick={() => painter.growMask(2)} title="Grow mask"><Plus size={13} /></button>
          <button onclick={() => painter.invertMask()} title="Invert mask"><ArrowLeftRight size={13} /></button>
          <button onclick={() => painter.clearMask()} title="Clear mask"><X size={13} /> Clear</button>
        </div>
      </li>
      <li class:done={painter.capture !== null}>
        <strong>2 · Describe and capture</strong>
        <textarea rows="3" placeholder="e.g. a deep purple priest's stole with gold embroidery" bind:value={painter.notes}></textarea>
        <Button block loading={painter.busy === 'Capturing the view'} disabled={!painter.hasMask} onclick={() => painter.captureView(character)}><Camera size={14} /> Capture view</Button>
      </li>
      {#if painter.capture}
        <li class:done={painter.resultReady}>
          <strong>3 · Paint result.png</strong>
          <Button variant="primary" block loading={codexJob !== undefined} onclick={() => painter.askCodex(character)}>
            {#if codexJob === undefined}<Sparkles size={14} />{/if} {codexJob?.message ?? 'Generate with Codex'}
          </Button>
          <div class="row">
            <Button size="sm" variant="ghost" onclick={() => api.openFolder(painter.capture!.folder)}><FolderOpen size={13} /> Open folder</Button>
            <Button size="sm" variant="ghost" onclick={() => resultInput?.click()}>Use an image…</Button>
          </div>
          <input bind:this={resultInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onchange={() => { const f = resultInput?.files?.[0]; if (f) void painter.useFile(character, f); if (resultInput) resultInput.value = '' }} />
          <p class="faint small mono path">{painter.capture.folder}</p>
          {#if !painter.resultReady}<p class="faint small">Waiting for result.png in that folder…</p>{/if}
        </li>
      {/if}
      {#if painter.previewing}
        <li>
          <strong>4 · Keep it?</strong>
          <div class="row">
            <Button variant="primary" loading={painter.busy === 'Saving the texture'} onclick={() => painter.keep(character)}><Check size={14} /> Keep</Button>
            <Button variant="ghost" onclick={() => painter.discard()}><X size={14} /> Discard</Button>
          </div>
        </li>
      {/if}
    </ol>
    <Button size="sm" variant="ghost" onclick={() => painter.stop()}>Done painting</Button>
  {/if}
</Section>

<style>
  .small { font-size: 12px; margin: 0; }
  .ok { display: flex; gap: 8px; align-items: center; color: var(--ok); font-weight: 500; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  figure img { width: 100%; max-width: 100%; min-width: 0; aspect-ratio: 1; border-radius: var(--r-2); background: #000; image-rendering: pixelated; border: 1px solid var(--line); }
  figcaption { font-size: 11.5px; }
  .actions { display: flex; }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .steps li { display: flex; flex-direction: column; gap: 8px; padding-left: 10px; border-left: 2px solid var(--line-strong); }
  .steps li.done { border-left-color: var(--ok); }
  .steps strong { font-weight: 600; }
  .brush { display: flex; align-items: center; gap: 8px; }
  .brush > span:first-child { width: 62px; }
  .mask-tools { display: flex; gap: 4px; }
  .mask-tools button { height: 26px; min-width: 30px; padding: 0 8px; display: inline-flex; gap: 4px; align-items: center; justify-content: center; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-2); font-size: 12px; }
  .mask-tools button:hover { color: var(--text-1); }
  .brush input { flex: 1; accent-color: var(--accent); }
  textarea { resize: vertical; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-1); padding: 7px 9px; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 6px; justify-content: space-between; }
  .path { word-break: break-all; font-size: 11px; }
  .captures { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .capture { display: flex; justify-content: space-between; padding: 6px 8px; border-radius: var(--r-1); border: 1px solid var(--line); background: var(--bg-2); font-size: 12px; color: var(--text-2); }
  .capture:hover { border-color: var(--line-strong); color: var(--text-1); }
  .capture .ready { color: var(--ok); }
</style>
