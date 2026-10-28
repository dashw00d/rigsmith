<script lang="ts">
  // Projection painting (src/state/painter.svelte.ts): mask the area on the model, capture the views that see it, have
  // each view repainted (Codex, or an image of your own per view), preview the result on the model, and keep it as a
  // new repaint layer. Earlier captures open again from the one list at the bottom.
  import { ArrowLeftRight, Brush, Camera, Check, Eraser, FolderOpen, Hand, ImageUp, Minus, Paintbrush, Plus, Sparkles, WandSparkles, X } from '@lucide/svelte'
  import { paintTarget } from '../../engine/projection.ts'
  import { phaseOf } from '../../model/select.ts'
  import { api, fileUrl, type Character, type Job, type Projection } from '../../state/api.ts'
  import { app } from '../../state/app.svelte.ts'
  import { painter, type PaintTool } from '../../state/painter.svelte.ts'
  import { viewer } from '../../state/viewer.svelte.ts'
  import Button from '../../ui/Button.svelte'
  import IconButton from '../../ui/IconButton.svelte'
  import Segmented from '../../ui/Segmented.svelte'
  import Toggle from '../../ui/Toggle.svelte'
  import { ago, paintBlock } from './text.ts'

  let { character }: { character: Character } = $props()

  const active = (j: Job): boolean => j.status === 'queued' || j.status === 'running'
  const phase = $derived(phaseOf(character, app.jobFor(character.id)).phase)
  const mine = $derived(painter.active && painter.characterId === character.id)
  const shown = $derived(viewer.shownId === character.id ? viewer.character : null)
  const blocked = $derived(paintBlock(character, phase, shown === null ? 'loading' : paintTarget(shown) === null ? 'no-texture' : 'ok'))
  const codex = $derived(app.jobs.find(j => j.characterId === character.id && j.kind === 'codex' && active(j)))
  const capture = $derived(painter.capture)
  const info = $derived(capture !== null && painter.info?.id === capture.id ? painter.info : null)
  const capturing = $derived(painter.busy !== null && /^(Finding|Capturing)/.test(painter.busy))

  // ---- the mask tools ----
  const tools: Array<{ value: PaintTool, label: string, hint: string, icon: typeof Brush }> = [
    { value: 'smart', label: 'Smart brush', hint: 'Smart brush: only the colour where the stroke starts (Alt-drag removes)', icon: Sparkles },
    { value: 'wand', label: 'Select by colour', hint: 'Select by colour: click a surface (Shift-click adds, Alt-click removes)', icon: WandSparkles },
    { value: 'brush', label: 'Brush', hint: 'Brush (Alt-drag erases)', icon: Brush },
    { value: 'erase', label: 'Eraser', hint: 'Eraser', icon: Eraser },
    { value: 'navigate', label: 'Camera only', hint: 'Camera only: every drag turns the camera', icon: Hand },
  ]
  const help: Record<PaintTool, string> = {
    smart: 'Scrub over what you want: only that colour takes it, over the surface (not across to a sleeve close by). Hold Alt while dragging to remove.',
    wand: 'Click a surface to take all of it of that colour, across seams. Hold Shift to add to the mask, Alt to remove from it.',
    brush: 'Paints exactly where you drag, over the surface. Hold Alt while dragging to erase.',
    erase: 'Removes from the mask where you drag.',
    navigate: 'Drag anywhere to turn the camera. The mask stays on the model.',
  }

  // ---- results ----
  let picker = $state<HTMLInputElement>()
  let pickFor = 0
  function pick (n: number): void {
    pickFor = n
    picker?.click()
  }
  function picked (): void {
    const file = picker?.files?.[0]
    if (picker !== undefined) picker.value = ''
    if (file !== undefined && pickFor > 0) void painter.useFile(character, pickFor, file)
  }
  /** Views showing what was sent rather than their result. */
  let sent = $state<Record<number, boolean>>({})
  $effect(() => { void capture?.id; sent = {} })

  const projection = (file: string, version: string | number): string | null =>
    capture === null ? null : fileUrl(character, `projections/${capture.id}/${file}`, version)

  // ---- earlier captures ----
  let more = $state(false)
  const earlier = $derived(painter.capturesOf === character.id ? painter.captures.filter(c => c.id !== capture?.id) : [])
  const listed = $derived(more ? earlier : earlier.slice(0, 5))
  function captureState (c: Projection): string {
    if (c.ready) return 'Results in · preview'
    return c.painted > 0 ? `${c.painted} of ${c.views} painted` : 'Waiting for results'
  }
  // (the list's labels change as results come in: read again now and then while it shows)
  $effect(() => {
    const id = character.id
    if (painter.active) return
    void painter.loadCaptures(id)
    const t = setInterval(() => { void painter.loadCaptures(id) }, 10_000)
    return () => { clearInterval(t) }
  })
</script>

{#if !mine}
  <p class="faint small">Mask an area on the model and have it repainted: the views that see it are found for you, each is repainted (by Codex, or with images of your own), and the new paint is projected back from all of them, blended where they meet.</p>
  <Button variant="primary" block disabled={blocked !== null || painter.busy !== null} onclick={() => { painter.start(character) }}><Paintbrush size={15} /> Start painting</Button>
  {#if blocked !== null}<p class="faint small">{blocked}</p>{/if}
{:else}
  {#if painter.problem !== null}
    <p class="error small" role="alert">{painter.problem}</p>
  {:else if !painter.attached}
    <p class="faint small">Waiting for the model to load…</p>
  {/if}
  <ol class="steps">
    <li class:done={painter.hasMask}>
      <strong>1 · Mask the area</strong>
      <Segmented options={tools} value={painter.tool} iconsOnly label="Mask tool" onchange={(t) => { painter.tool = t }} />
      <p class="faint small">{help[painter.tool]}</p>
      {#if painter.tool === 'smart' || painter.tool === 'brush' || painter.tool === 'erase'}
        <label class="slider"><span class="faint">Size</span><input type="range" min="8" max="200" bind:value={painter.brush} /><span class="mono faint">{painter.brush}</span></label>
      {/if}
      {#if painter.tool === 'smart' || painter.tool === 'wand'}
        <label class="slider"><span class="faint">Tolerance</span><input type="range" min="0" max="1" step="0.01" bind:value={painter.tolerance} /><span class="mono faint">{Math.round(painter.tolerance * 100)}</span></label>
      {/if}
      {#if painter.tool === 'wand'}
        <Toggle label="Only joined to the click" hint="Off: every surface of that colour on the model" bind:checked={painter.contiguous} />
      {/if}
      <p class="faint small">Drag off the model to turn the camera; right-drag pans, the wheel zooms.</p>
      <div class="mask-tools">
        <IconButton label="Shrink the mask" size="sm" variant="secondary" disabled={!painter.hasMask || painter.previewing} onclick={() => { painter.growMask(-3) }}><Minus size={13} /></IconButton>
        <IconButton label="Grow the mask" size="sm" variant="secondary" disabled={!painter.hasMask || painter.previewing} onclick={() => { painter.growMask(3) }}><Plus size={13} /></IconButton>
        <IconButton label="Invert the mask" size="sm" variant="secondary" disabled={painter.previewing} onclick={() => { painter.invertMask() }}><ArrowLeftRight size={13} /></IconButton>
        <Button size="sm" variant="ghost" disabled={!painter.hasMask || painter.previewing} onclick={() => { painter.clearMask() }}><X size={13} /> Clear</Button>
      </div>
      {#if painter.previewing}<p class="faint small">The mask is hidden while a result shows: Discard it, or capture again to paint on top of it.</p>{/if}
    </li>

    <li class:done={capture !== null}>
      <strong>2 · Describe and capture</strong>
      <textarea rows="3" placeholder="What to paint, e.g. a deep purple priest's stole with gold embroidery" bind:value={painter.notes}></textarea>
      <Button block loading={capturing} disabled={!painter.hasMask || !painter.attached || (painter.busy !== null && !capturing)} onclick={() => { void painter.captureViews(character) }}>
        {#if !capturing}<Camera size={14} />{/if} {capturing ? painter.busy : capture === null ? 'Find views and capture' : 'Capture again'}
      </Button>
      <p class="faint small">The notes go into the request when you capture: change them, then capture again to ask differently.</p>
    </li>

    {#if capture !== null}
      <li class:done={info?.ready === true}>
        <strong>3 · Paint the views</strong>
        <p class="faint small">Each view is what its camera saw, the area to repaint lit up: what Codex is given. A result shows in its place once it is in{capture.views.length > 1 ? '; every view needs one' : ''}.</p>
        <div class="views">
          {#each capture.views as v, i (i)}
            {@const n = i + 1}
            {@const r = info?.results[i] ?? null}
            {@const fresh = r !== null && r.fresh}
            <figure>
              <button class="shot" disabled={!fresh} onclick={() => { sent = { ...sent, [n]: !sent[n] } }} aria-label={fresh ? (sent[n] ? 'Show its result' : 'Show what was sent') : `View ${n}`}>
                {#if r !== null && r.fresh && !sent[n]}
                  <img src={projection(r.file, Math.round(r.at))} alt="View {n}'s result" />
                {:else}
                  <img src={projection(`view-${n}-flat.png`, capture.id)} alt="View {n} as captured" />
                  <img class="mask" src={projection(`view-${n}-mask.png`, capture.id)} alt="" />
                {/if}
              </button>
              <figcaption>
                <span class="line">
                  <span>{n} · {v.name}</span>
                  <span class:ok={fresh} class="faint">{fresh ? 'painted' : r !== null ? 'older than the ask' : 'waiting'}</span>
                </span>
                <Button size="sm" variant="ghost" onclick={() => { pick(n) }}><ImageUp size={13} /> Use an image…</Button>
              </figcaption>
            </figure>
          {/each}
        </div>
        <input bind:this={picker} type="file" accept="image/png,image/jpeg,image/webp" hidden onchange={picked} />
        <Button variant="primary" block loading={codex !== undefined} disabled={codex !== undefined} onclick={() => { void painter.askCodex(character) }}>
          {#if codex === undefined}<Sparkles size={14} />{/if} {codex === undefined ? (info?.ready === true ? 'Paint them again with Codex' : 'Paint with Codex') : codex.status === 'queued' ? 'Codex is queued' : codex.message || 'Codex is painting'}
        </Button>
        {#if codex !== undefined}
          <Button size="sm" variant="ghost" onclick={() => { void app.cancelJob(codex.id) }}><X size={13} /> Stop Codex</Button>
        {/if}
        {#if painter.pollError !== null}
          <p class="error small" role="alert">{painter.pollError}</p>
        {:else if info !== null && !info.ready}
          <p class="faint small">{info.painted} of {info.views} view{info.views === 1 ? '' : 's'} painted. The preview shows once every view has its result{info.requestedAt !== null ? ' (results from before the last ask to Codex don\'t count)' : ''}.</p>
        {/if}
        {#if info !== null}
          <div class="folder">
            <Button size="sm" variant="ghost" onclick={() => { void api.openFolder(info.path).catch((e: unknown) => { app.toast('error', (e as Error).message) }) }}><FolderOpen size={13} /> Open folder</Button>
            <span class="faint mono path" title={info.path}>{info.path}</span>
          </div>
        {/if}
      </li>
    {/if}

    {#if painter.previewing || painter.stacked > 0}
      <li>
        <strong>4 · Keep it?</strong>
        {#if painter.stacked > 0}
          <p class="faint small">{painter.stacked} earlier result{painter.stacked === 1 ? '' : 's'} under {painter.previewing ? 'this one' : 'what you paint next'}, not kept yet. Keep makes each a layer.</p>
        {:else}
          <p class="faint small">The result shows on the model. Keep makes it a new repaint layer on top (undoable).</p>
        {/if}
        <div class="row">
          <Button variant="primary" loading={painter.busy?.startsWith('Keeping') === true} disabled={painter.busy !== null && !painter.busy.startsWith('Keeping')} onclick={() => { void painter.keep(character) }}>
            <Check size={14} /> {painter.unsaved === 1 ? 'Keep as a new layer' : `Keep as ${painter.unsaved} layers`}
          </Button>
          {#if painter.previewing}<Button variant="ghost" onclick={() => { painter.discard() }}><X size={14} /> Discard{painter.stacked > 0 ? ' this one' : ''}</Button>{/if}
          {#if painter.stacked > 0}<Button variant="ghost" onclick={() => { painter.discardAll() }}><X size={14} /> Discard all</Button>{/if}
        </div>
      </li>
    {/if}
  </ol>
{/if}

{#if earlier.length > 0}
  <div class="captures">
    <span class="faint small">Earlier captures{painter.previewing ? ': opening one keeps the result shown and adds its result on top' : ''}</span>
    {#each listed as c (c.id)}
      <button class="capture" disabled={blocked !== null || painter.busy !== null} onclick={() => { void painter.resume(character, c.id) }}>
        <span class="what">{ago(c.createdAt)} · {c.views} view{c.views === 1 ? '' : 's'}{c.notes !== '' ? ` · ${c.notes}` : ''}</span>
        <span class:ready={c.ready}>{captureState(c)}</span>
      </button>
    {/each}
    {#if earlier.length > 5}
      <button class="link faint small" onclick={() => { more = !more }}>{more ? 'Fewer' : `All ${earlier.length}`}</button>
    {/if}
  </div>
{/if}

{#if mine}
  <Button size="sm" variant="ghost" onclick={() => { void painter.done() }}>Done painting</Button>
{/if}

<style>
  .small { font-size: 12px; margin: 0; }
  .error { color: var(--danger); }
  .ok { color: var(--ok); }
  .steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
  .steps li { display: flex; flex-direction: column; gap: 8px; padding-left: 10px; border-left: 2px solid var(--line-strong); }
  .steps li.done { border-left-color: var(--ok); }
  .steps strong { font-weight: 600; }
  .slider { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .slider > span:first-child { width: 62px; }
  .slider input { flex: 1; accent-color: var(--accent); }
  .mask-tools { display: flex; gap: 4px; align-items: center; }
  textarea { resize: vertical; border-radius: var(--r-1); border: 1px solid var(--line-strong); background: var(--bg-1); padding: 7px 9px; color: inherit; font: inherit; }
  textarea:focus { outline: none; border-color: var(--accent); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; }
  .views { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  figure { margin: 0; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
  .shot { position: relative; padding: 0; border: 1px solid var(--line); border-radius: var(--r-1); background: var(--bg-2); overflow: hidden; aspect-ratio: 1; cursor: default; }
  .shot:not(:disabled) { cursor: pointer; }
  .shot img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  /* (white where it repaints: lights that part of the view up, leaves the rest as it is) */
  .shot img.mask { mix-blend-mode: screen; opacity: 0.55; }
  figcaption { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; font-size: 11.5px; }
  figcaption .line { display: flex; justify-content: space-between; gap: 4px; align-self: stretch; }
  .folder { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .path { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .captures { display: flex; flex-direction: column; gap: 4px; margin-top: 4px; }
  .capture { display: flex; justify-content: space-between; gap: 8px; padding: 6px 8px; border-radius: var(--r-1); border: 1px solid var(--line); background: var(--bg-2); font-size: 12px; color: var(--text-2); text-align: left; }
  .capture:hover:not(:disabled) { border-color: var(--line-strong); color: var(--text-1); }
  .capture .what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .capture .ready { color: var(--ok); flex: none; }
  .link { align-self: flex-start; background: none; border: none; padding: 0; text-decoration: underline; cursor: pointer; }
</style>
