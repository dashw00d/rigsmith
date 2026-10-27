<script lang="ts">
  import { ChevronLeft, ChevronRight, FlipHorizontal2, Footprints, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward } from '@lucide/svelte'
  import { animator } from '../../state/animator.svelte.ts'
  import { clipEdit } from '../../state/clipedit.svelte.ts'
  import { tooltip } from '../../ui/tooltip.ts'
  import { allowsShortcut } from '../../ui/shortcuts.ts'

  let scrubbing = $state(false)
  let dock = $state<HTMLDivElement>()
  let wasPlaying = false
  const fps = 30
  const at = $derived(animator.duration > 0 ? (animator.loop && animator.playing ? animator.time % animator.duration : Math.min(Math.max(animator.time, 0), animator.duration)) : 0)
  const progress = $derived(animator.duration > 0 ? at / animator.duration : 0)
  const frames = $derived(Math.max(1, Math.round(animator.duration * fps)))
  const frame = $derived(Math.min(frames, Math.floor(progress * frames + 1e-6)))
  const busy = $derived(clipEdit.busy !== null || animator.loading)
  const speeds = $derived([...new Set([0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, animator.speed])].sort((a, b) => a - b))

  // Keep notifications above the playback dock as its rows wrap or keyframes appear.
  $effect(() => {
    const node = dock
    if (!node) return
    const update = (): void => { document.documentElement.style.setProperty('--playback-dock-height', `${node.offsetHeight}px`) }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--playback-dock-height') }
  })

  function seek (time: number): void {
    animator.setPlaying(false)
    animator.seek(clipEdit.snapTime(Math.max(0, Math.min(animator.duration, time))))
  }

  function seekFrame (value: number): void {
    if (Number.isFinite(value)) seek(Math.max(0, Math.min(frames, Math.round(value))) / frames * animator.duration)
  }

  function seekFrom (e: PointerEvent, bar: HTMLElement): void {
    const r = bar.getBoundingClientRect()
    if (r.width > 0) seek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * animator.duration)
  }

  function finishScrub (): void {
    if (!scrubbing) return
    scrubbing = false
    if (wasPlaying) animator.setPlaying(true)
  }

  function togglePlay (): void {
    if (!animator.playing && at >= animator.duration) animator.seek(0)
    animator.setPlaying(!animator.playing)
    if (!animator.playing && clipEdit.active) animator.seek(clipEdit.snapTime(animator.time))
  }

  function jumpKey (direction: number): void {
    const keys = clipEdit.phases.filter(k => direction > 0 ? Math.round(k * frames) > frame : Math.round(k * frames) < frame)
    const next = direction > 0 ? keys[0] : keys.at(-1)
    if (next !== undefined) seek(next * animator.duration)
  }

  function sliderKey (e: KeyboardEvent): void {
    if (busy) return
    const amount = e.shiftKey ? 10 : 1
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') seekFrame(frame - amount)
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') seekFrame(frame + amount)
    else if (e.key === 'Home') seek(0)
    else if (e.key === 'End') seek(animator.duration)
    else if (e.key === ' ') togglePlay()
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  function onKey (e: KeyboardEvent): void {
    if (!allowsShortcut(e) || animator.current === null || busy) return
    if (e.key === ' ') { e.preventDefault(); togglePlay() }
    if (e.key === ',' || e.key === '.') {
      e.preventDefault()
      seekFrame(frame + (e.key === '.' ? 1 : -1))
    }
  }
</script>

<svelte:window onkeydown={onKey} onblur={finishScrub} />

{#if animator.current}
  <div class="timeline" aria-label="Animation playback" bind:this={dock}>
    <div class="heading">
      <span class="name" title={animator.current.name}>{animator.current.name}</span>
      <label class="readout mono"><span class="sr-only">Frame</span><input aria-label="Frame" type="number" min="0" max={frames} step="1" value={frame} disabled={busy} onchange={(e) => seekFrame(e.currentTarget.valueAsNumber)} /><span class="faint">/ {frames}</span></label>
    </div>
    <div class="bar" role="slider" tabindex="0" aria-label="Animation frame" aria-valuemin="0" aria-valuemax={frames} aria-valuenow={frame} aria-valuetext={`Frame ${frame} of ${frames}`} aria-disabled={busy}
      onkeydown={sliderKey}
      onpointerdown={(e) => { if (busy || e.button !== 0) return; e.preventDefault(); scrubbing = true; wasPlaying = animator.playing; e.currentTarget.setPointerCapture(e.pointerId); seekFrom(e, e.currentTarget) }}
      onpointermove={(e) => { if (scrubbing) seekFrom(e, e.currentTarget) }}
      onpointerup={finishScrub} onpointercancel={finishScrub} onlostpointercapture={finishScrub}>
      <div class="fill" style:width={`${progress * 100}%`}></div>
      <div class="knob" style:left={`${progress * 100}%`}></div>
    </div>
    {#if clipEdit.active && clipEdit.phases.length > 0}
      <div class="keys" role="group" aria-label="Keyframes">
        {#each clipEdit.phases as u (u)}
          <button class="key" class:mine={clipEdit.selectedPhases.some(x => Math.abs(x - u) < 1e-4)} style:left={`${u * 100}%`} aria-label={`Key at frame ${Math.round(u * frames)}`} disabled={busy} onclick={() => seek(u * animator.duration)} use:tooltip={`Key at frame ${Math.round(u * frames)}`}></button>
        {/each}
      </div>
    {/if}
    <div class="controls">
      <div class="transport" role="group" aria-label="Transport">
        <button disabled={busy} onclick={() => seek(0)} aria-label="First frame" use:tooltip={'First frame'}><SkipBack size={14} /></button>
        <button disabled={busy || frame === 0} onclick={() => seekFrame(frame - 1)} aria-label="Previous frame" use:tooltip={'Previous frame (,)'}><StepBack size={14} /></button>
        <button class="play" disabled={busy} onclick={togglePlay} aria-label={animator.playing ? 'Pause' : 'Play'} use:tooltip={animator.playing ? 'Pause (Space)' : 'Play (Space)'}>
          {#if animator.playing}<Pause size={15} />{:else}<Play size={15} />{/if}
        </button>
        <button disabled={busy || frame === frames} onclick={() => seekFrame(frame + 1)} aria-label="Next frame" use:tooltip={'Next frame (.)'}><StepForward size={14} /></button>
        <button disabled={busy} onclick={() => seek(animator.duration)} aria-label="Last frame" use:tooltip={'Last frame'}><SkipForward size={14} /></button>
      </div>
      <div class="flags" role="group" aria-label="Playback options">
        <button class:on={animator.loop} disabled={busy} aria-label="Loop" aria-pressed={animator.loop} onclick={() => { if (clipEdit.active) clipEdit.setLoop(!animator.loop); else animator.setLoop(!animator.loop) }} use:tooltip={'Loop playback'}><Repeat size={14} /></button>
        <button class:on={animator.inPlace} disabled={clipEdit.active || busy} aria-pressed={animator.inPlace} onclick={() => { animator.inPlace = !animator.inPlace; void animator.refresh() }} use:tooltip={clipEdit.active ? 'Finish editing to change In place' : 'In place: remove root motion'} aria-label="In place"><Footprints size={14} /></button>
        <button class:on={animator.mirror} disabled={clipEdit.active || busy} aria-pressed={animator.mirror} onclick={() => { animator.mirror = !animator.mirror; void animator.refresh() }} use:tooltip={clipEdit.active ? 'Finish editing to change Mirror' : 'Mirror left/right'} aria-label="Mirror left/right"><FlipHorizontal2 size={14} /></button>
        <select class="mono" value={String(animator.speed)} disabled={busy} onchange={(e) => animator.setSpeed(Number(e.currentTarget.value))} aria-label="Playback speed">
          {#each speeds as s}<option value={String(s)}>{s}×</option>{/each}
        </select>
      </div>
    </div>
    {#if clipEdit.active && clipEdit.phases.length > 0}
      <div class="key-nav">
        <button disabled={busy || !clipEdit.phases.some(u => Math.round(u * frames) < frame)} onclick={() => jumpKey(-1)} aria-label="Previous key"><ChevronLeft size={12} /> Previous key</button>
        <span class="faint">{clipEdit.phases.length} keyed frames</span>
        <button disabled={busy || !clipEdit.phases.some(u => Math.round(u * frames) > frame)} onclick={() => jumpKey(1)} aria-label="Next key">Next key <ChevronRight size={12} /></button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .timeline { position: absolute; left: 50%; bottom: 12px; transform: translateX(-50%); width: min(720px, calc(100% - 24px)); display: flex; flex-direction: column; gap: 5px; padding: 10px 12px; border-radius: 12px; background: var(--overlay); backdrop-filter: blur(10px); border: 1px solid var(--line-strong); box-shadow: 0 10px 40px rgb(0 0 0 / 40%); z-index: 3; }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 12px; }
  .name { min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .readout { display: flex; align-items: center; gap: 5px; flex: none; }
  .readout input { width: 46px; height: 24px; padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg-2); text-align: right; appearance: textfield; }
  .readout input::-webkit-inner-spin-button { appearance: none; }
  .bar { position: relative; height: 18px; cursor: pointer; touch-action: none; margin: 0 5px; }
  .bar::before, .fill { content: ''; position: absolute; left: 0; right: 0; top: 8px; height: 3px; border-radius: 2px; background: var(--bg-4); pointer-events: none; }
  .fill { right: auto; background: var(--accent); }
  .knob { position: absolute; top: 4px; width: 11px; height: 11px; margin-left: -5.5px; border-radius: 50%; background: var(--text-1); box-shadow: 0 1px 4px rgb(0 0 0 / 50%); pointer-events: none; }
  .keys { position: relative; height: 12px; margin: -2px 5px 1px; }
  .key { position: absolute; top: 1px; width: 10px; height: 10px; margin-left: -5px; padding: 0; border: 1px solid rgb(0 0 0 / 50%); background: var(--warn, #f5c45e); transform: rotate(45deg); border-radius: 1px; }
  .key.mine { background: #ff7ab8; }
  .controls, .transport, .flags { display: flex; gap: 2px; align-items: center; }
  .controls { justify-content: space-between; flex-wrap: wrap; gap: 6px; }
  .transport, .flags { flex: none; }
  .controls button { width: 26px; height: 28px; border-radius: 6px; border: 0; background: transparent; color: var(--text-3); display: grid; place-items: center; }
  .controls button:hover:not(:disabled) { color: var(--text-1); background: var(--bg-3); }
  .controls button.on { color: var(--accent-strong); }
  .controls .play { width: 32px; height: 32px; margin: 0 2px; border-radius: 50%; background: var(--text-1); color: var(--bg-0); }
  .controls .play:hover:not(:disabled) { background: #fff; color: var(--bg-0); }
  button:disabled { opacity: 0.35; cursor: default; }
  select { width: 62px; height: 26px; margin-left: 4px; border-radius: 6px; border: 1px solid var(--line-strong); background: var(--bg-2); font-size: 11px; }
  .key-nav { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 10px; }
  .key-nav button { display: flex; align-items: center; gap: 2px; padding: 2px 0; border: 0; background: transparent; color: var(--text-2); font-size: inherit; }
  @container (max-width: 370px) { .controls { justify-content: center; } }
</style>
