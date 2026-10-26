<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Box, Bone, Focus, Grid2x2, Palette, ScanEye } from '@lucide/svelte'
  import * as THREE from 'three'
  import { app } from '../state/app.svelte.ts'
  import { viewer } from '../state/viewer.svelte.ts'
  import { prettyBone, side } from '../engine/mixamo.ts'
  import type { DisplayMode } from '../engine/CharacterView.ts'
  import type { Joints } from '../engine/JointEditor.ts'
  import Segmented from '../ui/Segmented.svelte'
  import { tooltip } from '../ui/tooltip.ts'
  import Timeline from './animate/Timeline.svelte'
  import { animator } from '../state/animator.svelte.ts'
  import { outfit } from '../state/outfit.svelte.ts'
  import { painter } from '../state/painter.svelte.ts'
  import MaskPainter from './texture/MaskPainter.svelte'
  import MarkerBoard from './rig/MarkerBoard.svelte'
  import { markerBoard } from '../state/markers.svelte.ts'
  import ScaleRoom from './export/ScaleRoom.svelte'
  import { scaleRoom } from '../state/scaleroom.svelte.ts'
  import { paint } from '../state/paint.svelte.ts'

  let container: HTMLDivElement

  onMount(() => viewer.attach(container))
  // (the stage rests while the marker board or the scale room covers it)
  $effect(() => {
    const on = (markerBoard.open && app.step === 'rig') || scaleRoom.open
    if (viewer.stage !== null) viewer.stage.covered = on
    // (markers go on the body at rest: a clip playing stops)
    if (markerBoard.open && app.step === 'rig') untrack(() => { if (animator.current !== null) animator.stop() })
  })

  $effect(() => {
    // Re-sync whenever the selected character (or its files/status) or the step changes.
    const c = app.selected
    void c?.revision
    void c?.status
    void c?.props
    void c?.garments
    void c?.mount
    void outfit.fitting
    void viewer.sync(c, app.step)
  })

  // (the 3D joint editor shows the joints as saved: placed by markers, reset, or edited from the CLI)
  $effect(() => {
    const joints = app.selected?.joints
    void viewer.editor
    untrack(() => { viewer.followJoints(joints as Joints | undefined) })
  })

  const modes: Array<{ value: DisplayMode, label: string, icon: typeof Box }> = [
    { value: 'shaded', label: 'Shaded', icon: Palette },
    { value: 'clay', label: 'Clay', icon: Box },
    { value: 'weights', label: 'Weights', icon: Grid2x2 },
    { value: 'xray', label: 'X-ray', icon: ScanEye },
  ]
  let mode = $state<DisplayMode>(viewer.mode)
  $effect(() => { mode = viewer.mode })

  const label = $derived.by(() => {
    void viewer.frame
    const name = viewer.hoveredJoint ?? viewer.selectedJoint
    if (name === null || viewer.editor === null || viewer.stage === null) return null
    const p = viewer.editor.position(name)
    if (p === null) return null
    const s = viewer.stage.project(new THREE.Vector3(p.x, p.y, p.z))
    return { name, x: s.x, y: s.y, side: side(name) }
  })

  const job = $derived(app.selected === null ? undefined : app.jobFor(app.selected.id))
</script>

<div class="viewport" bind:this={container}>
  <div class="vignette" aria-hidden="true"></div>

  {#if app.selected}
    <div class="toolbar">
      <Segmented options={modes} bind:value={mode} size="sm" iconsOnly onchange={(m) => viewer.setMode(m)} />
      {#if viewer.character?.skeleton}
        <button class="tool" class:on={viewer.skeleton} onclick={() => viewer.setSkeleton(!viewer.skeleton)} use:tooltip={'Show bones'}><Bone size={14} /></button>
      {/if}
      <button class="tool" onclick={() => viewer.focus()} use:tooltip={'Frame character (F)'}><Focus size={14} /></button>
    </div>
    <div class="caption">
      <span class="name">{app.selected.name}</span>
      {#if app.selected.stats}
        <span class="faint mono">{app.selected.stats.triangles.toLocaleString()} tris · {app.selected.stats.height.toFixed(2)} m</span>
      {/if}
    </div>
  {/if}

  {#if label}
    <div class="joint-label {label.side}" style="transform: translate({label.x}px, {label.y}px)">
      {prettyBone(label.name)}{#if label.side !== 'center'}<span class="faint"> · {label.side}</span>{/if}
    </div>
  {/if}

  {#if app.step === 'animate' || app.step === 'export' || app.step === 'outfit' || (app.step === 'rig' && animator.current?.test === true)}<Timeline />{/if}
  {#if painter.active && app.step === 'texture'}<MaskPainter />{/if}
  {#if scaleRoom.open && app.selected && viewer.character && scaleRoom.unit && scaleRoom.entry}
    {#key `${app.selected.id}|${scaleRoom.unit}|${scaleRoom.companion}`}
      <ScaleRoom view={viewer.character} unit={scaleRoom.unit} entry={scaleRoom.entry} companion={scaleRoom.companion} />
    {/key}
  {/if}
  {#if markerBoard.open && app.step === 'rig' && app.selected && viewer.character && markerBoard.set && markerBoard.parents && markerBoard.setName}
    {#key `${app.selected.id}|${markerBoard.setName}`}
      <MarkerBoard character={app.selected} view={viewer.character} set={markerBoard.set} setName={markerBoard.setName} parents={markerBoard.parents} />
    {/key}
  {/if}

  {#if animator.error}<div class="busy error">{animator.error}</div>{/if}

  {#if job || viewer.loading || animator.loading || outfit.busy || painter.busy || markerBoard.busy || scaleRoom.busy || paint.busyText}
    <div class="busy">
      <div class="ring"></div>
      <span>{job ? job.message : viewer.loading ? 'Loading model' : markerBoard.busy ?? scaleRoom.busy ?? paint.busyText ?? painter.busy ?? (outfit.busy ? 'Fitting clothes' : 'Retargeting animation')}</span>
      {#if job?.status === 'running'}<div class="bar"><div style="width: {Math.round(job.progress * 100)}%"></div></div>{/if}
    </div>
  {/if}

  {#if !app.selected}
    <div class="hello">
      <h1>Drop a character to begin</h1>
      <p class="muted">Raw meshes get rigged automatically. Rigged Mixamo characters go straight to animation.</p>
    </div>
  {/if}
</div>

<svelte:window onkeydown={(e) => { if (e.key === 'f' && !(e.target instanceof HTMLInputElement)) viewer.focus() }} />

<style>
  .viewport {
    position: absolute;
    inset: 0;
    background: radial-gradient(120% 90% at 50% 18%, #1b2030 0%, #12151c 45%, #0b0c10 100%);
    overflow: hidden;
  }
  .vignette { position: absolute; inset: 0; pointer-events: none; box-shadow: inset 0 0 160px rgb(0 0 0 / 55%); }
  .toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 6px; align-items: center; z-index: 2; }
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
  .caption { position: absolute; left: 16px; bottom: 14px; display: flex; flex-direction: column; gap: 2px; pointer-events: none; }
  .caption .name { font-size: 15px; font-weight: 600; letter-spacing: -0.01em; }
  .caption .mono { font-size: 11px; }
  .joint-label {
    position: absolute;
    left: 0;
    top: 0;
    margin: -34px 0 0 12px;
    padding: 4px 8px;
    border-radius: 6px;
    background: var(--bg-2);
    box-shadow: var(--shadow-pop);
    font-size: 11.5px;
    font-weight: 550;
    pointer-events: none;
    white-space: nowrap;
    border-left: 3px solid var(--side-center);
  }
  .joint-label.left { border-left-color: var(--side-left); }
  .joint-label.right { border-left-color: var(--side-right); }
  .busy {
    position: absolute;
    z-index: 10;
    left: 50%;
    top: 12px;
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
  }
  .ring { width: 14px; height: 14px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
  .busy.error { color: var(--danger); }
  .busy .bar { width: 80px; height: 3px; background: var(--bg-4); border-radius: 2px; overflow: hidden; }
  .busy .bar div { height: 100%; background: var(--accent); transition: width var(--med); }
  .hello { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; pointer-events: none; gap: 6px; }
  .hello h1 { margin: 0; font-size: 22px; font-weight: 600; letter-spacing: -0.02em; }
  .hello p { margin: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
