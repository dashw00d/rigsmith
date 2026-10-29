<script lang="ts">
  // The viewport: the stage (src/state/viewer.svelte.ts puts the selected character on it), the display mode, bones and
  // framing tools, the one busy pill (the character's job, app.busy, a model loading), why a model didn't load, and
  // whatever overlays the areas registered (viewer.setOverlay): over the stage, or docked under it (the timeline). It
  // knows nothing of the areas themselves.
  import { onMount } from 'svelte'
  import { Bone, Box, Focus, Grid2x2, Palette, RefreshCw, ScanEye, TriangleAlert } from '@lucide/svelte'
  import { heightOf, phaseOf } from '../model/select.ts'
  import type { DisplayMode } from '../engine/CharacterView.ts'
  import { app } from '../state/app.svelte.ts'
  import { viewer } from '../state/viewer.svelte.ts'
  import { timeline } from '../state/timeline.svelte.ts'
  import Segmented from '../ui/Segmented.svelte'
  import { allowsShortcut } from '../ui/shortcuts.ts'
  import { tooltip } from '../ui/tooltip.ts'
  import { shownFile } from './status.ts'

  let container = $state<HTMLDivElement | null>(null)
  let dock = $state<HTMLDivElement | null>(null)

  onMount(() => (container === null ? undefined : viewer.attach(container)))

  const modes: Array<{ value: DisplayMode, label: string, icon: typeof Box }> = [
    { value: 'shaded', label: 'Shaded', icon: Palette },
    { value: 'clay', label: 'Clay', icon: Box },
    { value: 'weights', label: 'Weights', icon: Grid2x2 },
    { value: 'xray', label: 'X-ray', icon: ScanEye },
  ]

  const c = $derived(app.selected)
  const job = $derived(c === null ? undefined : app.jobFor(c.id))
  const phase = $derived(c === null ? null : phaseOf(c, job))
  const nothingToShow = $derived(c !== null && shownFile(c) === undefined)
  const over = $derived(viewer.overlays.filter(([, o]) => o.dock !== 'bottom'))
  const docked = $derived(viewer.overlays.filter(([, o]) => o.dock === 'bottom'))
  const blocked = $derived(viewer.overlays.some(([, o]) => o.blocksInput === true))
  // (the stage's own tools hide under an overlay that covers it: the marker board, the scale room)
  const covered = $derived(viewer.overlays.some(([, o]) => o.covers === true))
  const busy = $derived.by(() => {
    if (job !== undefined && job.status === 'running') return { text: job.message || job.label, progress: job.progress }
    if (app.busy !== null) return { text: app.busy, progress: null }
    if (viewer.loading) return { text: 'Loading model', progress: null }
    if (job !== undefined) return { text: 'Queued', progress: null }
    return null
  })

  // (the toasts sit above the dock while it shows)
  $effect(() => {
    const node = dock
    if (node === null) return
    const root = document.documentElement
    const update = (): void => { root.style.setProperty('--playback-dock-height', `${node.offsetHeight}px`) }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => { observer.disconnect(); root.style.removeProperty('--playback-dock-height') }
  })

  function onkeydown (e: KeyboardEvent): void {
    // (over the timeline, F fits the clip instead: src/app/steps/MotionPanel.svelte)
    if (e.key.toLowerCase() === 'f' && allowsShortcut(e) && app.selected !== null && !timeline.hovered) viewer.focus()
  }
</script>

<svelte:window {onkeydown} />

<div class="frame">
  <div class="viewport" class:blocked bind:this={container}>
    <div class="vignette" aria-hidden="true"></div>

    {#if c !== null && !nothingToShow && !covered}
      <div class="toolbar">
        <Segmented options={modes} value={viewer.mode} size="sm" iconsOnly label="Display mode" onchange={(m) => { viewer.setMode(m) }} />
        {#if viewer.character?.skeleton}
          <button class="tool" class:on={viewer.skeleton} aria-label="Show bones" aria-pressed={viewer.skeleton} onclick={() => { viewer.setSkeleton(!viewer.skeleton) }} use:tooltip={'Show bones'}><Bone size={14} /></button>
        {/if}
        <button class="tool" aria-label="Frame the character" onclick={() => { viewer.focus() }} use:tooltip={'Frame the character (F)'}><Focus size={14} /></button>
      </div>
      <div class="caption">
        <span class="name">{c.name}</span>
        {#if c.source.stats}
          <span class="faint mono">{c.source.stats.triangles.toLocaleString()} tris · {heightOf(c).toFixed(2)} m</span>
        {/if}
      </div>
    {/if}

    <!-- (each overlay places itself in the viewport, as its own component says; a covering one hides the stage) -->
    {#each over as [key, o] (key)}
      {@const Overlay = o.component}
      <Overlay {...o.props ?? {}} />
    {/each}

    {#if viewer.loadError !== null && c !== null}
      <div class="load-error" role="alert">
        <TriangleAlert size={15} />
        <span>{viewer.loadError}</span>
        <button class="retry" onclick={() => { viewer.reload() }}><RefreshCw size={12} /> Try again</button>
      </div>
    {:else if busy !== null}
      <div class="busy" role="status">
        <div class="ring"></div>
        <span>{busy.text}</span>
        {#if busy.progress !== null}<div class="bar"><div style:width="{Math.round(busy.progress * 100)}%"></div></div>{/if}
      </div>
    {/if}

    {#if c === null}
      <div class="hello">
        <h1>Drop a character to begin</h1>
        <p class="muted">FBX, GLB, OBJ, DAE or a Tripo ZIP. Meshes get a rig made here; rigged characters are converted onto it.</p>
      </div>
    {:else if nothingToShow && phase !== null && phase.phase !== 'importing'}
      <div class="hello">
        <h1>{phase.phase === 'animation-only' ? 'An animation file' : phase.phase === 'error' ? 'Nothing to show' : 'No model yet'}</h1>
        <p class="muted">{phase.phase === 'animation-only' ? 'It has motion but no model to show.' : phase.phase === 'error' ? (c.error ?? phase.label) : 'Import it again from the Import step.'}</p>
      </div>
    {/if}
  </div>
  {#if docked.length > 0}
    <div class="dock" bind:this={dock}>
      {#each docked as [key, o] (key)}
        {@const Docked = o.component}
        <Docked {...o.props ?? {}} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .frame { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .viewport {
    position: relative;
    flex: 1;
    min-height: 0;
    background: radial-gradient(120% 90% at 50% 18%, #1b2030 0%, #12151c 45%, #0b0c10 100%);
    overflow: hidden;
    container-type: size;
    user-select: none;
  }
  .dock { flex: none; position: relative; min-height: 0; border-top: 1px solid var(--line); background: var(--bg-1); }
  .vignette { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 160px rgb(0 0 0 / 55%); }
  /* (the stage's own canvas only, a direct child (Stage appends it here): an overlay's canvases, like the scale room's,
     keep their input) */
  .blocked > :global(canvas) { pointer-events: none; }
  .toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 6px; align-items: center; z-index: 4; }
  .tool {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border-radius: var(--r-2);
    border: 1px solid var(--line);
    background: var(--bg-1);
    color: var(--text-2);
  }
  .tool:hover { color: var(--text-1); }
  .tool.on { color: var(--accent-strong); border-color: rgb(142 162 255 / 40%); background: var(--accent-soft); }
  .caption { position: absolute; left: 16px; right: 16px; top: 52px; display: flex; flex-direction: column; gap: 2px; pointer-events: none; z-index: 1; }
  .caption .name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .caption .mono { font-size: 11px; }
  .busy, .load-error {
    position: absolute;
    z-index: 10;
    left: 50%;
    top: 100px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 14px;
    border-radius: 20px;
    background: var(--overlay);
    backdrop-filter: blur(8px);
    border: 1px solid var(--line-strong);
    font-weight: 500;
    max-width: calc(100% - 24px);
    width: max-content;
    font-size: 12px;
  }
  .load-error { color: var(--danger); border-color: rgb(242 119 122 / 35%); border-radius: var(--r-3); }
  .load-error span { overflow-wrap: anywhere; }
  .load-error :global(svg) { flex: none; }
  .retry { flex: none; display: flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--bg-2); color: var(--text-1); font-size: 11.5px; }
  .retry:hover { border-color: var(--accent); }
  .ring { flex: none; width: 14px; height: 14px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .busy .bar { flex: none; width: 80px; height: 3px; background: var(--bg-4); border-radius: 2px; overflow: hidden; }
  .busy .bar div { height: 100%; background: var(--accent); transition: width var(--med); }
  .hello { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; pointer-events: none; gap: 6px; padding: 24px; }
  .hello h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .hello p { margin: 0; max-width: 460px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @container (max-height: 380px) { .caption { display: none; } .busy, .load-error { top: 48px; } }
</style>
